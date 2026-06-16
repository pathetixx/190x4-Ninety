#!/usr/bin/env python3
"""Зеркалирование OTA-артефактов в Cloudflare R2 — РФ-доступный fallback.

GitHub отдаёт релизы с `release-assets.githubusercontent.com`, который режется у
части РФ-провайдеров. R2 (через нейтральный `pub-*.r2.dev`) из РФ доступен и без
egress-платы. Заливаем тот же самый .exe (подпись minisign та же → валидна) и
вариант latest.json с url на r2.dev. Tauri-updater пробует GitHub-endpoint первым,
при провале (РФ-блок) падает на R2.

Запускается в CI после генерации github-варианта latest.json (он уже в CWD).
Креды/настройки — из env (см. шаг build.yml). Только заливка; скачка анонимна.
"""
import glob
import json
import os
import sys

import boto3

pub = os.environ["R2_PUBLIC_URL"].rstrip("/")
bucket = os.environ["R2_BUCKET"]
endpoint = os.environ["R2_ENDPOINT"]

exes = glob.glob("src-tauri/target/release/bundle/nsis/*-setup.exe")
if not exes:
    sys.exit("R2 mirror: NSIS setup .exe не найден")
exe = exes[0]
name = os.path.basename(exe)

# github-вариант latest.json уже сгенерён предыдущим шагом — берём его и меняем
# только url на r2.dev (version/notes/pub_date/signature остаются те же).
with open("latest.json", encoding="utf-8") as f:
    data = json.load(f)
data["platforms"]["windows-x86_64"]["url"] = f"{pub}/{name}"
with open("latest-r2.json", "w", encoding="utf-8") as f:
    json.dump(data, f, ensure_ascii=False, indent=2)

s3 = boto3.client("s3", endpoint_url=endpoint, region_name="auto")
# .exe — версионное имя (не перезаписывается); latest.json — стабильный ключ
# (всегда свежий, на него смотрит endpoint).
s3.upload_file(exe, bucket, name, ExtraArgs={"ContentType": "application/octet-stream"})
s3.upload_file("latest-r2.json", bucket, "latest.json", ExtraArgs={"ContentType": "application/json"})
print(f"R2 mirror OK: {pub}/latest.json -> {name}")
