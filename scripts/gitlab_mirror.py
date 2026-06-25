#!/usr/bin/env python3
"""Зеркалирование OTA в GitLab generic package registry — РФ-доступный источник.

R2 (`pub-*.r2.dev`) у части РФ-провайдеров режется по хосту → как РФ-fallback не
работает. GitLab (`gitlab.com`) из РФ доступен, публичный проект отдаёт пакеты
АНОНИМНО (проверено). Заливаем тот же .exe (подпись minisign та же → валидна) и
вариант latest.json с url на gitlab-пакет.

Updater-endpoint (стабильный, перезаписываем каждый релиз):
  {API}/projects/{PID}/packages/generic/ninety/stable/latest.json
.exe — под версией (не перезаписывается):
  {API}/projects/{PID}/packages/generic/ninety/{version}/{name}

Запускается в CI после генерации github-latest.json (он в CWD, url там на github —
мы его НЕ клобберим, читаем и делаем свой вариант). Только заливка; скачка анонимна.
Env: GITLAB_TOKEN (GH Secret), GITLAB_PROJECT_ID, GITLAB_API (опц., деф gitlab.com).
"""
import glob
import json
import os
import sys
import urllib.request

API = os.environ.get("GITLAB_API", "https://gitlab.com/api/v4").rstrip("/")
PID = os.environ["GITLAB_PROJECT_ID"]
TOKEN = os.environ["GITLAB_TOKEN"]
PKG = "ninety"  # имя generic-пакета


def pkg_url(version, fname):
    return f"{API}/projects/{PID}/packages/generic/{PKG}/{version}/{fname}"


def put(version, fname, body, content_type):
    url = pkg_url(version, fname)
    req = urllib.request.Request(
        url, data=body, method="PUT",
        headers={"PRIVATE-TOKEN": TOKEN, "Content-Type": content_type},
    )
    with urllib.request.urlopen(req, timeout=180) as r:
        if r.status not in (200, 201):
            sys.exit(f"GitLab upload {fname}: HTTP {r.status}")
    return url


exes = glob.glob("src-tauri/target/release/bundle/nsis/*-setup.exe")
if not exes:
    sys.exit("GitLab mirror: NSIS setup .exe не найден")
exe = exes[0]
name = os.path.basename(exe)

with open("latest.json", encoding="utf-8") as f:
    data = json.load(f)
version = data["version"]

with open(exe, "rb") as f:
    exe_url = put(version, name, f.read(), "application/octet-stream")

data["platforms"]["windows-x86_64"]["url"] = exe_url
body = json.dumps(data, ensure_ascii=False, indent=2).encode("utf-8")
put("stable", "latest.json", body, "application/json")

print(f"GitLab mirror OK: {pkg_url('stable', 'latest.json')} -> {name}")
