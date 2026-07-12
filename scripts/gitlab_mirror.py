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
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

PKG = "ninety"
PLATFORM = "windows-x86_64"
METADATA_NAME = "latest.json"


class MirrorError(RuntimeError):
    pass


def package_url(api: str, project_id: str, version: str, filename: str) -> str:
    api = api.rstrip("/")
    parts = [project_id, PKG, version, filename]
    project, package, release, name = [urllib.parse.quote(p, safe="") for p in parts]
    return f"{api}/projects/{project}/packages/generic/{package}/{release}/{name}"


def sha256_hex(body: bytes) -> str:
    return hashlib.sha256(body).hexdigest()


def validate_metadata(data: object, expected_version: str, expected_url: str) -> dict:
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
    return data


def validate_metadata_bytes(body: bytes, expected_version: str, expected_url: str) -> dict:
    try:
        data = json.loads(body.decode("utf-8-sig"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise MirrorError(f"скачанный latest.json повреждён: {exc}") from exc
    return validate_metadata(data, expected_version, expected_url)


def gitlab_metadata(source: dict, version: str, installer_url: str) -> dict:
    data = copy.deepcopy(source)
    platforms = data.get("platforms")
    platform = platforms.get(PLATFORM) if isinstance(platforms, dict) else None
    if not isinstance(platform, dict) or not str(platform.get("signature", "")).strip():
        raise MirrorError("невозможно создать GitLab metadata без updater signature")
    data["version"] = version
    platform["url"] = installer_url
    validate_metadata(data, version, installer_url)
    return data


class GitLabClient:
    def __init__(self, api: str, project_id: str, token: str):
        self.api = api.rstrip("/")
        self.project_id = project_id
        self.token = token

    def url(self, version: str, filename: str) -> str:
        return package_url(self.api, self.project_id, version, filename)

    def download(self, version: str, filename: str) -> bytes | None:
        req = urllib.request.Request(self.url(version, filename), method="GET")
        try:
            with urllib.request.urlopen(req, timeout=180) as response:
                if response.status != 200:
                    raise MirrorError(
                        f"GitLab download {filename}: HTTP {response.status}"
                    )
                return response.read()
        except urllib.error.HTTPError as exc:
            if exc.code == 404:
                return None
            raise MirrorError(f"GitLab download {filename}: HTTP {exc.code}") from exc

    def upload(self, version: str, filename: str, body: bytes, content_type: str) -> None:
        req = urllib.request.Request(
            self.url(version, filename),
            data=body,
            method="PUT",
            headers={"PRIVATE-TOKEN": self.token, "Content-Type": content_type},
        )
        try:
            with urllib.request.urlopen(req, timeout=180) as response:
                if response.status not in (200, 201):
                    raise MirrorError(
                        f"GitLab upload {filename}: HTTP {response.status}"
                    )
        except urllib.error.HTTPError as exc:
            raise MirrorError(f"GitLab upload {filename}: HTTP {exc.code}") from exc

    def verify_blob(self, version: str, filename: str, expected: bytes) -> bytes:
        expected_size = len(expected)
        expected_sha = sha256_hex(expected)
        for attempt in range(6):
            downloaded = self.download(version, filename)
            if downloaded is not None:
                if len(downloaded) != expected_size:
                    raise MirrorError(
                        f"GitLab {filename}: размер {len(downloaded)}, ожидался {expected_size}"
                    )
                actual_sha = sha256_hex(downloaded)
                if actual_sha != expected_sha:
                    raise MirrorError(
                        f"GitLab {filename}: SHA-256 {actual_sha}, ожидался {expected_sha}"
                    )
                return downloaded
            if attempt < 5:
                time.sleep(2)
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
        self.upload(version, filename, body, content_type)
        return self.verify_blob(version, filename, body)

    def promote_stable(self, body: bytes) -> bytes:
        current = self.download("stable", METADATA_NAME)
        if current == body:
            return current
        self.upload("stable", METADATA_NAME, body, "application/json")
        return self.verify_blob("stable", METADATA_NAME, body)


def promote_release(
    client: GitLabClient,
    source_metadata: dict,
    installer_name: str,
    installer_body: bytes,
    signature_body: str,
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

    installer_url = client.url(version, installer_name)
    data = gitlab_metadata(source_metadata, version, installer_url)
    metadata_body = json.dumps(data, ensure_ascii=False, indent=2).encode("utf-8")

    client.ensure_immutable(
        version, installer_name, installer_body, "application/octet-stream"
    )
    client.verify_blob(version, installer_name, installer_body)

    downloaded_versioned = client.ensure_immutable(
        version, METADATA_NAME, metadata_body, "application/json"
    )
    validate_metadata_bytes(downloaded_versioned, version, installer_url)

    downloaded_stable = client.promote_stable(metadata_body)
    validate_metadata_bytes(downloaded_stable, version, installer_url)
    return installer_url


def main() -> int:
    api = os.environ.get("GITLAB_API", "https://gitlab.com/api/v4")
    project_id = os.environ.get("GITLAB_PROJECT_ID")
    token = os.environ.get("GITLAB_TOKEN")
    if not project_id or not token:
        raise MirrorError("нужны GITLAB_PROJECT_ID и GITLAB_TOKEN")

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

    client = GitLabClient(api, project_id, token)
    installer_url = promote_release(
        client,
        source_metadata,
        installer.name,
        installer.read_bytes(),
        signature.read_text(encoding="utf-8"),
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
