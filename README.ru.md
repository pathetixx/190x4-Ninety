<div align="center">

![Ninety](./docs/banner.png)

[![Release](https://img.shields.io/github/v/release/pathetixx/190x4-Ninety?label=release&color=C0304A)](https://github.com/pathetixx/190x4-Ninety/releases)
[![Build](https://img.shields.io/github/actions/workflow/status/pathetixx/190x4-Ninety/build.yml?event=push&label=build)](https://github.com/pathetixx/190x4-Ninety/actions)
[![Platform](https://img.shields.io/badge/platform-Windows%2010%2F11-1d1d24)](#установка)
[![License](https://img.shields.io/badge/license-MIT-6B6B72)](./LICENSE)

# Ninety

**Desktop-клиент для Windows на Tauri 2 и Rust вокруг sing-box, WARP, правил маршрутизации и диагностики соединения.**

[Сайт](https://pathetixx.github.io/190x4-Ninety/) · [Скачать](https://github.com/pathetixx/190x4-Ninety/releases) · **Русский** · [English](./README.md) · [Журнал изменений](./CHANGELOG.md) · [Безопасность](./SECURITY.md)

</div>

---

![Главная](./docs/home.png)

## Зачем нужен Ninety?

Ninety — нативный desktop-клиент для Windows вокруг экосистемы sing-box, Tauri 2 и Rust. Он собирает в одном интерфейсе подписки, одиночные профили, WARP, TUN-режим, правила маршрутизации, DPI-инструменты, логи, управление из трея и реальную диагностику качества канала.

Идея проекта — не быть тонкой оболочкой над `config.json`. Ninety относится к подключению как к состоянию продукта: безопасно запускает и останавливает вспомогательные движки, возвращает системный прокси Windows назад, показывает фактически выбранную ноду, чистит временные конфиги, шифрует чувствительное локальное состояние там, где это возможно, и даёт понятную диагностику вместо абстрактного статуса «подключено».

> Ninety — сетевой клиент, а не гарантия анонимности. Приватность зависит от сервера, провайдера, конфигурации и окружения Windows.

## Главное

| Область | Что делает Ninety |
| --- | --- |
| **Режимы подключения** | Локальный прокси, системный прокси Windows и полноценный **VPN · TUN**. TUN запрашивает UAC только когда это нужно; приложение может запускаться elevated при входе в систему. |
| **Источники** | Импорт подписок, одиночных ссылок и TrustTunnel `.toml` endpoint-файлов. Есть импорт из буфера и опциональные deep links. |
| **Управление нодами** | Сетка серверов с флагами, живой проверкой задержки, авто-выбором, переключением из трея и отображением фактически выбранной ноды. |
| **Протоколы** | VLESS, VMess, Trojan, Shadowsocks, Hysteria2, TUIC, NaiveProxy, TrustTunnel и WARP/WireGuard. |
| **Мосты** | XHTTP через xray-core; NaiveProxy и TrustTunnel через локальные SOCKS-sidecar'ы; sing-box остаётся центральным роутером. |
| **Маршрутизация** | Обход LAN, региональные правила, пользовательские правила по доменам/IP/процессам, блок-листы рекламы/malware/phishing и монитор соединений. |
| **Качество канала** | Смотрит не только на ping, а на реальный throughput. Может перепроверить, сменить ноду, включить маскировку, пересканировать WARP или предложить реконнект. |
| **DPI-инструменты** | Отдельный экран для DPI-совместимости, обновление стратегий/списков, cleanup драйвера и автоматическое исключение адресов VPN-нод. |
| **Приватность** | Без рекламы и встроенной аналитики, безопасный дефолт логов, DPAPI-шифрование WARP/backup-состояния, очистка runtime-конфигов. |
| **Desktop UX** | Трей, автообновления, восстановление сессии после обновления, темы, onboarding, 15 языков и RTL-вёрстка для فارسی / العربية. |

## Скриншоты

| Ноды | Профили |
|------|---------|
| ![Ноды](./docs/nodes.png) | ![Профили](./docs/profiles.png) |
| **DPI-инструменты** | **Настройки** |
| ![DPI-инструменты](./docs/dpi.png) | ![Настройки](./docs/settings.png) |
| **Логи** | **Качество канала** |
| ![Логи](./docs/logs.png) | ![Качество канала](./docs/quality.png) |

## Поддерживаемые протоколы и транспорты

**Протоколы:** VLESS · VMess · Trojan · Shadowsocks · Hysteria2 · TUIC · NaiveProxy · TrustTunnel · WARP/WireGuard

**Транспорты и опции:** Reality · TLS с uTLS-отпечатками · XHTTP · WebSocket · gRPC · HTTP/2 · TCP · TLS-фрагментация · padding · mixed-case SNI · mux

NaiveProxy и TrustTunnel обслуживаются собственными клиентами через локальные SOCKS-мосты. XHTTP при необходимости уходит через xray-core. Для пользователя это всё равно один источник и одно состояние подключения.

## Установка

Скачайте свежий установщик из [**Releases**](https://github.com/pathetixx/190x4-Ninety/releases):

- `.exe` — NSIS-установщик.
- `.msi` — MSI-пакет.

Требования: **Windows 10 / 11 x64**.

Обновления приходят внутри приложения. Когда VPN уже подключён, проверка и скачивание обновлений могут идти через активный туннель.

## Быстрый старт

1. Откройте Ninety и нажмите **+**.
2. Вставьте ссылку на подписку или одиночный конфиг (`vless://`, `vmess://`, `trojan://`, `hysteria2://`, `tuic://`, `naive+https://`, `tt://` и т.д.).
3. Выберите режим:
   - **Системный прокси** — режим по умолчанию, без прав администратора, подходит для браузеров и многих desktop-приложений.
   - **Прокси** — локальный SOCKS/HTTP на `127.0.0.1`; приложения настраиваются вручную.
   - **VPN · TUN** — направляет системный трафик через туннель и требует elevated-запуска.
4. Нажмите на центральный диск для подключения. Повторный клик отключает.

Если что-то не работает, сначала откройте **Логи**. Экран логов сделан для диагностики старта, мостов и маршрутизации без ручного поиска файлов в папках приложения.

## Документация

Пользовательские разделы:

- [Modes](./docs/modes.md) — Proxy, System proxy, VPN · TUN, WARP-only, DPI tools и kill switch.
- [Troubleshooting](./docs/troubleshooting.md) — практичные проверки, какие логи собрать и что нельзя публиковать.
- [Privacy](./docs/privacy.md) — локальные данные, чувствительные поля, логи, WARP-состояние и ограничения.
- [Routing](./docs/routing.md) — LAN bypass, региональные правила, пользовательские правила, DNS и монитор соединений.

Проектные разделы:

- [Architecture](./docs/architecture.md) — frontend, Rust backend, sidecar'ы, updater и CI-подготовка движков.
- [Security](./SECURITY.md) — сообщения об уязвимостях и чувствительных проблемах.
- [Contributing](./CONTRIBUTING.md) — ожидания к issues и PR.

Для разработки релизов:

- [Releasing](./RELEASING.md) — релизный ритуал, annotated tags, draft releases и OTA-правила.

## Безопасность и приватность

Ninety открыт по исходникам, но он управляет сильными сетевыми компонентами.

- Импортированные профили и подписки могут содержать креды.
- Логи и скриншоты нужно очищать перед публичными reports.
- WARP-ключи и backup состояния используют Windows DPAPI там, где это поддержано бэкендом.
- TUN-режим, DPI-инструменты и kill switch меняют сетевое состояние системы. Перед включением проверьте настройки.
- Ninety — сетевой клиент, а не гарантия анонимности.

Подробнее см. [Privacy](./docs/privacy.md), для уязвимостей — [SECURITY.md](./SECURITY.md).

## Архитектура

В общих чертах Ninety — это Tauri WebView UI, который общается с Rust backend через Tauri commands/events. Бэкенд управляет sing-box, sidecar'ами, WARP/WireGuard state, системным прокси Windows, TUN, kill switch, updater, логами и cleanup.

Полный обзор: [Architecture](./docs/architecture.md).

## Сборка из исходников

Нужно:

- Rust stable.
- Node.js 18 или новее.
- MSVC build tools.
- Windows-окружение для полноценной Tauri-сборки.

```powershell
npm install
npm run tauri dev
npm run tauri build
```

Движки (`sing-box`, `xray-core`, NaiveProxy, TrustTunnel) и `wintun.dll` подтягиваются в CI. См. [`.github/workflows/build.yml`](./.github/workflows/build.yml).

Обычные проверки для разработки:

```powershell
npm run lint
npm test
```

Тяжёлые Rust/Tauri-проверки ожидаются в Windows CI, если у вас нет подготовленной локальной Windows-машины.

## Карта репозитория

```text
src/                  Фронтенд: экраны, стили, i18n, config builder
src-tauri/src/        Rust-бэкенд и интеграция с Windows
src-tauri/dpi/        DPI-стратегии, списки и runtime-ресурсы
docs/                 Скриншоты и изображения проекта
site/                 Сайт для GitHub Pages
tests/                JavaScript unit-тесты
.github/workflows/    Сборка, проверки и релизная автоматизация
```

## Участие в проекте

Баг-репорты, воспроизводимые кейсы, правки документации и аккуратные pull request'ы приветствуются. Перед PR прочитайте [CONTRIBUTING.md](./CONTRIBUTING.md).

При репорте багов подключения никогда не вставляйте публично приватные ссылки подписок, токены, UUID, private keys или полные экспортированные конфиги.

## Поддержать проект

Ninety развивается на энтузиазме. Если он оказался полезен, можно поддержать разработку:

**TON**

```text
UQC21op6_5Qgsw0i7TQvh12XBex9I5bqmPeMNuJ20INdjtg7
```

**USDT · TRC20**

```text
TGbdvr1gSYgQciFNRjwdmAmCbNLjK9wgJR
```

Спасибо 🖤

## Лицензия

[MIT](./LICENSE)
