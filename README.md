<div align="center">

![Ninety](./docs/banner.png)

[![Release](https://img.shields.io/github/v/release/pathetixx/190x4-Ninety?include_prereleases&sort=semver&label=release&color=C0304A)](https://github.com/pathetixx/190x4-Ninety/releases)
[![Build](https://img.shields.io/github/actions/workflow/status/pathetixx/190x4-Ninety/build.yml?branch=main&label=build)](https://github.com/pathetixx/190x4-Ninety/actions)
[![Platform](https://img.shields.io/badge/platform-Windows%2010%2F11-1d1d24)](#установка)
[![License](https://img.shields.io/github/license/pathetixx/190x4-Ninety?color=6B6B72)](./LICENSE)

**VPN-клиент под Windows в эстетике 190x4.**
Лёгкий нативный интерфейс на Tauri 2 поверх движка sing-box: подписки, выбор нод, маршрутизация по регионам, системный прокси и TUN — без браузера, без Electron.

</div>

---

![Главная](./docs/home.png)

## Возможности

- **Подписки и одиночные конфиги** — импорт по URL, из буфера или ссылкой `ninety://`. Авто-обновление по интервалу подписки, QR-экспорт.
- **Выбор ноды** — сетка серверов с флагами и живым пингом; режим **Авто** держит соединение на быстрейшей ноде и переключается сам при росте задержки или таймауте.
- **Три режима подключения** — прокси, системный прокси (без прав администратора) и **TUN** через выделенный Windows-сервис: запрос UAC ровно один раз, дальше подключение без него.
- **Обход блокировок** — фрагментация TLS ClientHello (по TLS-записям или TCP-сегментам) помогает поднять туннель, когда провайдер душит handshake по SNI; плюс встроенный DPI-обход для разблокировки сервисов.
- **Маршрутизация** — обход локальной сети, правила по региону (трафик внутрь страны идёт напрямую), блокировка рекламы и трекеров на уровне DNS и роутинга.
- **WARP** — встроенная регистрация, выбор endpoint'а со сканером и маскировкой трафика; работает как самостоятельный выход или как звено в цепочке.
- **Тонкая настройка** — DNS (remote/direct, fake-DNS), MTU и стек TUN, трюки TLS (фрагментация, padding, mixed-case SNI), тест соединения и интервалы.
- **Автозапуск при входе в систему**, сворачивание в трей, автоматические обновления через GitHub Releases.
- **4 темы** — Kurogane, Synthwave, Matrix, Mono. Весь интерфейс на CSS-переменных.

## Протоколы и транспорты

VLESS · VMess · Trojan · Shadowsocks · Hysteria2 · TUIC
Reality · TLS (uTLS-отпечатки) · XHTTP · WebSocket · gRPC · HTTP/2 · TCP

## Интерфейс

| Ноды | Профили |
|------|---------|
| ![Ноды](./docs/nodes.png) | ![Профили](./docs/profiles.png) |
| **Настройки** | **Логи** |
| ![Настройки](./docs/settings.png) | ![Логи](./docs/logs.png) |

## Установка

Скачайте установщик из [**Releases**](https://github.com/pathetixx/190x4-Ninety/releases) — `.msi` или `.exe` (NSIS).
Обновления приходят внутри приложения и ставятся в один клик.

Требования: Windows 10 / 11 (x64).

## Сборка из исходников

Нужны Rust (stable), Node ≥ 18 и MSVC build tools.

```powershell
npm install
npm run tauri dev     # окно в режиме разработки
npm run tauri build   # релизная сборка → .msi / .exe
```

Движки (sing-box, xray-core) и `wintun.dll` подтягиваются на этапе сборки в CI и не хранятся в репозитории — см. [`.github/workflows/build.yml`](./.github/workflows/build.yml).

## Архитектура

- **Интерфейс** — Tauri 2 (Rust + WebView2), фронтенд на vanilla HTML/CSS/JS без фреймворков и сборщиков.
- **Движок** — sing-box запускается дочерним процессом; транспорт XHTTP обслуживается отдельным ядром xray-core через локальный socks-мост.
- **TUN** — Windows-сервис под LocalSystem, общение по именованному каналу; управляющий API ядра закрыт секретом и слушает только loopback.
- **Подписки и настройки** — в `localStorage`, конфиг для движка собирается на лету под текущий режим и ноду.

## Лицензия

[MIT](./LICENSE)
