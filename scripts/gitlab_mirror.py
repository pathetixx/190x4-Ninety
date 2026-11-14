#!/usr/bin/env python3
"""Безопасное продвижение OTA в GitLab Generic Package Registry.

Порядок намеренно жёсткий: immutable installer -> проверка размера/SHA-256 ->
versioned latest.json -> обратная проверка -> stable/latest.json -> обратная
проверка. GitHub draft публикуется workflow только после успешного завершения
этого скрипта, поэтому основной GitLab endpoint не может остаться старым после
переключения GitHub Latest.
"""

from __future__ import annotations

import copy
import glob
import hashlib
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

PKG = "ninety"
PLATFORM = "windows-x86_64"
# Portable ZIP для обновления из приложения (цель updater-плагина).
PORTABLE_PLATFORM = "windows-x86_64-portable"
METADATA_NAME = "latest.json"
DOWNLOAD_TIMEOUT = 60
UPLOAD_TIMEOUT = 180
REQUEST_ATTEMPTS = 3
RETRY_DELAYS = (2, 5)
RETRYABLE_HTTP_CODES = frozenset({408, 425, 429})


class MirrorError(RuntimeError):
    pass


def package_url(api: str, project_id: str, version: str, filename: str) -> str:
    api = api.rstrip("/")
    parts = [project_id, PKG, version, filename]
    project, package, release, name = [urllib.parse.quote(p, safe="") for p in parts]
    return f"{api}/projects/{project}/packages/generic/{package}/{release}/{name}"


def sha256_hex(body: bytes) -> str:
    return hashlib.sha256(body).hexdigest()


def is_retryable_http(code: int) -> bool:
    return code in RETRYABLE_HTTP_CODES or 500 <= code < 600


def validate_portable(data: dict, expected_url: str) -> None:
    platforms = data.get("platforms")
    platform = platforms.get(PORTABLE_PLATFORM) if isinstance(platforms, dict) else None
    if not isinstance(platform, dict):
        raise MirrorError(f"в latest.json отсутствует платформа {PORTABLE_PLATFORM}")
    signature = platform.get("signature")
    if not isinstance(signature, str) or not signature.strip():
        raise MirrorError("в latest.json отсутствует подпись Portable ZIP")
    if platform.get("url") != expected_url:
        raise MirrorError(
            f"URL Portable {platform.get('url')!r} не совпадает с {expected_url!r}"
        )


def validate_metadata(
    data: object,
    expected_version: str,
    expected_url: str,
    expected_portable_url: str | None = None,
) -> dict:
    if not isinstance(data, dict):
        raise MirrorError("latest.json должен быть JSON-объектом")
    if data.get("version") != expected_version:
        raise MirrorError(
            f"версия latest.json {data.get('version')!r} не совпадает с {expected_version!r}"
        )
    platforms = data.get("platforms")
    platform = platforms.get(PLATFORM) if isinstance(platforms, dict) else None
    if not isinstance(platform, dict):
        raise MirrorError(f"в latest.json отсутствует платформа {PLATFORM}")
    signature = platform.get("signature")
    if not isinstance(signature, str) or not signature.strip():
        raise MirrorError("в latest.json отсутствует подпись updater artifact")
    if platform.get("url") != expected_url:
        raise MirrorError(
            f"URL latest.json {platform.get('url')!r} не совпадает с {expected_url!r}"
        )
    if expected_portable_url is not None:
        validate_portable(data, expected_portable_url)
    return data


def validate_metadata_bytes(
    body: bytes,
    expected_version: str,
    expected_url: str,
    expected_portable_url: str | None = None,
) -> dict:
    try:
        data = json.loads(body.decode("utf-8-sig"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise MirrorError(f"скачанный latest.json повреждён: {exc}") from exc
    return validate_metadata(data, expected_version, expected_url, expected_portable_url)


def gitlab_metadata(
    source: dict, version: str, installer_url: str, portable_url: str | None = None
) -> dict:
    data = copy.deepcopy(source)
    platforms = data.get("platforms")
    platform = platforms.get(PLATFORM) if isinstance(platforms, dict) else None
    if not isinstance(platform, dict) or not str(platform.get("signature", "")).strip():
        raise MirrorError("невозможно создать GitLab metadata без updater signature")
    data["version"] = version
    platform["url"] = installer_url
    if portable_url is not None:
        portable = platforms.get(PORTABLE_PLATFORM)
        if not isinstance(portable, dict):
            raise MirrorError(f"в latest.json отсутствует платформа {PORTABLE_PLATFORM}")
        portable["url"] = portable_url
    validate_metadata(data, version, installer_url, portable_url)
    return data


class GitLabClient:
    def __init__(self, api: str, project_id: str, token: str):
        self.api = api.rstrip("/")
        self.project_id = project_id
        self.token = token

    def url(self, version: str, filename: str) -> str:
        return package_url(self.api, self.project_id, version, filename)

    @staticmethod
    def retry_delay(attempt: int) -> int:
        return RETRY_DELAYS[min(attempt, len(RETRY_DELAYS) - 1)]

    def wait_before_retry(self, operation: str, attempt: int, error: Exception) -> None:
        delay = self.retry_delay(attempt)
        print(
            f"GitLab {operation} transient failure ({type(error).__name__}: {error}); "
            f"retrying in {delay}s",
            file=sys.stderr,
        )
        time.sleep(delay)

    def download(self, version: str, filename: str) -> bytes | None:
        for attempt in range(REQUEST_ATTEMPTS):
            req = urllib.request.Request(self.url(version, filename), method="GET")
            try:
                with urllib.request.urlopen(req, timeout=DOWNLOAD_TIMEOUT) as response:
                    if response.status != 200:
                        raise MirrorError(
                            f"GitLab download {filename}: HTTP {response.status}"
                        )
                    return response.read()
            except urllib.error.HTTPError as exc:
                if exc.code == 404:
                    return None
                if not is_retryable_http(exc.code) or attempt == REQUEST_ATTEMPTS - 1:
                    raise MirrorError(
                        f"GitLab download {filename}: HTTP {exc.code}"
                    ) from exc
                self.wait_before_retry(f"download {filename}", attempt, exc)
            except (TimeoutError, urllib.error.URLError, OSError) as exc:
                if attempt == REQUEST_ATTEMPTS - 1:
                    raise MirrorError(
                        f"GitLab download {filename}: {exc}"
                    ) from exc
                self.wait_before_retry(f"download {filename}", attempt, exc)

        raise AssertionError("unreachable")

    def upload(self, version: str, filename: str, body: bytes, content_type: str) -> None:
        for attempt in range(REQUEST_ATTEMPTS):
            req = urllib.request.Request(
                self.url(version, filename),
                data=body,
                method="PUT",
                headers={"PRIVATE-TOKEN": self.token, "Content-Type": content_type},
            )
            try:
                with urllib.request.urlopen(req, timeout=UPLOAD_TIMEOUT) as response:
                    if response.status not in (200, 201):
                        raise MirrorError(
                            f"GitLab upload {filename}: HTTP {response.status}"
                        )
                    return
            except urllib.error.HTTPError as exc:
                if not is_retryable_http(exc.code) or attempt == REQUEST_ATTEMPTS - 1:
                    raise MirrorError(
                        f"GitLab upload {filename}: HTTP {exc.code}"
                    ) from exc
                self.wait_before_retry(f"upload {filename}", attempt, exc)
            except (TimeoutError, urllib.error.URLError, OSError) as exc:
                if attempt == REQUEST_ATTEMPTS - 1:
                    raise MirrorError(f"GitLab upload {filename}: {exc}") from exc
                self.wait_before_retry(f"upload {filename}", attempt, exc)

        raise AssertionError("unreachable")

    def exists(self, url: str) -> bool:
        req = urllib.request.Request(url, method="HEAD")
        try:
            with urllib.request.urlopen(req, timeout=60) as response:
                return response.status == 200
        except urllib.error.HTTPError as exc:
            if exc.code == 404:
                return False
            raise MirrorError(f"GitLab HEAD: HTTP {exc.code}") from exc

    def verify_blob(self, version: str, filename: str, expected: bytes) -> bytes:
        expected_size = len(expected)
        expected_sha = sha256_hex(expected)
        mismatch = None
        for attempt in range(6):
            downloaded = self.download(version, filename)
            if downloaded is not None:
                if len(downloaded) != expected_size:
                    mismatch = (
                        f"GitLab {filename}: размер {len(downloaded)}, ожидался {expected_size}"
                    )
                else:
                    actual_sha = sha256_hex(downloaded)
                    if actual_sha != expected_sha:
                        mismatch = (
                            f"GitLab {filename}: SHA-256 {actual_sha}, ожидался {expected_sha}"
                        )
                    else:
                        return downloaded
                # Чтение сразу после записи может вернуть ПРЕЖНЮЮ копию: stable/
                # перезаписывается каждым релизом, и GitLab отдаёт предыдущую
                # ещё несколько секунд. Раньше это роняло релиз на ровном месте —
                # зеркало уже было верным, а проверка смотрела на устаревший
                # ответ. Поэтому расхождение — повод повторить, а не падать;
                # окончательный вердикт выносим, только исчерпав попытки.
            if attempt < 5:
                time.sleep(2)
        if mismatch:
            raise MirrorError(f"{mismatch} (не сошлось за 6 попыток)")
        raise MirrorError(f"GitLab {filename}: файл не появился после загрузки")

    def ensure_immutable(
        self, version: str, filename: str, body: bytes, content_type: str
    ) -> bytes:
        existing = self.download(version, filename)
        if existing is not None:
            if len(existing) == len(body) and sha256_hex(existing) == sha256_hex(body):
                return existing
            raise MirrorError(
                f"immutable GitLab asset {version}/{filename} уже существует с другим содержимым"
            )
        try:
            self.upload(version, filename, body, content_type)
        except MirrorError as upload_error:
            # A PUT may have reached GitLab even when the runner timed out waiting
            # for its response. Recover the idempotent success before failing.
            try:
                existing = self.download(version, filename)
            except MirrorError:
                raise upload_error
            if existing is not None:
                if len(existing) == len(body) and sha256_hex(existing) == sha256_hex(body):
                    return existing
                raise MirrorError(
                    f"immutable GitLab asset {version}/{filename} уже существует с другим содержимым"
                ) from upload_error
            raise upload_error
        return self.verify_blob(version, filename, body)

    def promote_stable(self, body: bytes) -> bytes:
        current = self.download("stable", METADATA_NAME)
        if current == body:
            return current
        try:
            self.upload("stable", METADATA_NAME, body, "application/json")
        except MirrorError as upload_error:
            # As above, preserve a successful PUT if only its response was lost.
            try:
                current = self.download("stable", METADATA_NAME)
            except MirrorError:
                raise upload_error
            if current == body:
                return current
            raise upload_error
        return self.verify_blob("stable", METADATA_NAME, body)


def promote_release(
    client: GitLabClient,
    source_metadata: dict,
    installer_name: str,
    installer_body: bytes,
    signature_body: str,
    portable: tuple[str, bytes, str] | None = None,
) -> str:
    if not installer_body:
        raise MirrorError("NSIS installer пуст")
    version = source_metadata.get("version")
    if not isinstance(version, str) or not version:
        raise MirrorError("в latest.json отсутствует версия")
    source_platforms = source_metadata.get("platforms")
    source_platform = (
        source_platforms.get(PLATFORM, {})
        if isinstance(source_platforms, dict)
        else {}
    )
    if source_platform.get("signature") != signature_body.strip() or not signature_body.strip():
        raise MirrorError("подпись .sig отсутствует либо не совпадает с latest.json")

    portable_url = None
    if portable is not None:
        portable_name, portable_body, portable_signature = portable
        if not portable_body:
            raise MirrorError("Portable ZIP пуст")
        source_portable = (
            source_platforms.get(PORTABLE_PLATFORM, {})
            if isinstance(source_platforms, dict)
            else {}
        )
        if (
            not portable_signature.strip()
            or source_portable.get("signature") != portable_signature.strip()
        ):
            raise MirrorError("подпись .zip.sig отсутствует либо не совпадает с latest.json")
        portable_url = client.url(version, portable_name)

    installer_url = client.url(version, installer_name)
    data = gitlab_metadata(source_metadata, version, installer_url, portable_url)
    metadata_body = json.dumps(data, ensure_ascii=False, indent=2).encode("utf-8")

    client.ensure_immutable(
        version, installer_name, installer_body, "application/octet-stream"
    )
    client.verify_blob(version, installer_name, installer_body)
    if portable is not None:
        client.ensure_immutable(version, portable[0], portable[1], "application/zip")

    downloaded_versioned = client.ensure_immutable(
        version, METADATA_NAME, metadata_body, "application/json"
    )
    validate_metadata_bytes(downloaded_versioned, version, installer_url, portable_url)

    downloaded_stable = client.promote_stable(metadata_body)
    validate_metadata_bytes(downloaded_stable, version, installer_url, portable_url)
    return installer_url


def rollback_stable(client: GitLabClient, version: str) -> str:
    """Promote already-verified immutable metadata without rebuilding assets."""
    if not re.fullmatch(r"\d+\.\d+\.\d+", version):
        raise MirrorError(f"некорректная rollback-версия {version!r}")
    metadata_body = client.download(version, METADATA_NAME)
    if metadata_body is None:
        raise MirrorError(f"immutable metadata {version}/{METADATA_NAME} не найдена")
    try:
        data = json.loads(metadata_body.decode("utf-8-sig"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise MirrorError(f"immutable metadata {version} повреждена: {exc}") from exc
    platforms = data.get("platforms") if isinstance(data, dict) else None
    platform = platforms.get(PLATFORM) if isinstance(platforms, dict) else None
    installer_url = platform.get("url") if isinstance(platform, dict) else None
    if not isinstance(installer_url, str) or not installer_url:
        raise MirrorError(f"immutable metadata {version} не содержит installer URL")
    installer_name = urllib.parse.unquote(urllib.parse.urlparse(installer_url).path.rsplit("/", 1)[-1])
    expected_url = client.url(version, installer_name)
    validate_metadata(data, version, expected_url)
    if installer_url != expected_url or not client.exists(installer_url):
        raise MirrorError(f"immutable installer {version}/{installer_name} недоступен")
    downloaded_stable = client.promote_stable(metadata_body)
    validate_metadata_bytes(downloaded_stable, version, expected_url)
    return installer_url


def main() -> int:
    api = os.environ.get("GITLAB_API", "https://gitlab.com/api/v4")
    project_id = os.environ.get("GITLAB_PROJECT_ID")
    token = os.environ.get("GITLAB_TOKEN")
    if not project_id or not token:
        raise MirrorError("нужны GITLAB_PROJECT_ID и GITLAB_TOKEN")

    client = GitLabClient(api, project_id, token)
    if len(sys.argv) == 3 and sys.argv[1] == "--rollback":
        installer_url = rollback_stable(client, sys.argv[2])
        print(
            "GitLab OTA rolled back safely: "
            f"{client.url('stable', METADATA_NAME)} -> {installer_url}"
        )
        return 0
    if len(sys.argv) != 1:
        raise MirrorError("usage: gitlab_mirror.py [--rollback X.Y.Z]")

    installers = glob.glob("src-tauri/target/release/bundle/nsis/*-setup.exe")
    if len(installers) != 1:
        raise MirrorError(
            f"ожидался ровно один NSIS installer, найдено: {len(installers)}"
        )
    installer = Path(installers[0])
    signature = Path(f"{installer}.sig")
    if not signature.is_file():
        raise MirrorError(f"updater signature не найдена: {signature}")
    metadata_path = Path(METADATA_NAME)
    if not metadata_path.is_file():
        raise MirrorError(f"metadata не найдена: {metadata_path}")

    try:
        source_metadata = json.loads(metadata_path.read_text(encoding="utf-8-sig"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise MirrorError(f"локальный latest.json повреждён: {exc}") from exc

    portable = None
    has_portable_entry = isinstance(source_metadata.get("platforms"), dict) and (
        PORTABLE_PLATFORM in source_metadata["platforms"]
    )
    if has_portable_entry:
        zips = glob.glob("src-tauri/target/release/portable/*_windows-x64-portable.zip")
        if len(zips) != 1:
            raise MirrorError(f"ожидался ровно один Portable ZIP, найдено: {len(zips)}")
        portable_zip = Path(zips[0])
        portable_sig = Path(f"{portable_zip}.sig")
        if not portable_sig.is_file():
            raise MirrorError(f"подпись Portable ZIP не найдена: {portable_sig}")
        portable = (
            portable_zip.name,
            portable_zip.read_bytes(),
            portable_sig.read_text(encoding="utf-8"),
        )

    installer_url = promote_release(
        client,
        source_metadata,
        installer.name,
        installer.read_bytes(),
        signature.read_text(encoding="utf-8"),
        portable,
    )
    print(
        "GitLab OTA promoted safely: "
        f"{client.url('stable', METADATA_NAME)} -> {installer_url}"
    )
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except MirrorError as exc:
        print(f"GitLab mirror failed: {exc}", file=sys.stderr)
        raise SystemExit(1)
