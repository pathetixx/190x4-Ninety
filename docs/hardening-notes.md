# Ninety hardening notes

Короткая памятка для следующих точечных PR. Здесь нет секретов и нет runtime-данных.

## Sensitive storage

Живые профили и подписки теперь находятся в Rust-owned `profile-store.v1`, а
зашифрованный Rust/DPAPI backup страхует их от потери. Legacy-ключи WebView
удаляются только после успешного read-back/commit; при ошибке миграции они
остаются fallback, чтобы не сломать профили пользователя.

Чувствительные или потенциально чувствительные ключи:

- `ninety.profiles.v1`: одиночные профили, URL/UUID/пароли/ключи нод.
- `ninety.subscriptions.v1`: URL подписок, импортированные профили и их креды.
- `ninety.profiles.active`, `ninety.subscriptions.active`, `ninety.active.kind`: не секреты сами по себе, но привязаны к профилям.
- `ninety.options.v1`: настройки маршрутизации, WARP-режимы, DNS и поведение клиента.
- `ninety.wifi.trusted`, `ninety.wifi.prevMode`: локальные сети и предыдущий режим.
- `ninety.dpi.*`, `ninety.update.resume`: состояние DPI/update, не секреты, но не обязаны жить в backup вечно.
- `ninety.traffic.*`, `ninety.warp.history`, `ninety.quality.profile`: телеметрия/история качества; полезны, но не нужны для восстановления профилей.

Сделано:

- `src/lib/storage-policy.js` централизует `ninety.*` ключи, backup/restore
  фильтр и helper очистки profile/subscription storage.
- `state-backup` больше не сохраняет ephemeral telemetry/history:
  `ninety.traffic.*`, `ninety.sub.*.peakDays`, update resume, WARP history,
  quality profile и Wi-Fi trust/runtime state.
- В `Настройки -> Общие` добавлена явная очистка профилей/подписок: она
  останавливает VPN/DPI, чистит Rust profile-store и legacy localStorage,
  отключает логический DPI autostart и удаляет `state-backup.json/.bak/.tmp`.
  Runtime-
  конфиги `singbox-current.json`, `xray-current.json` и bridge configs удаляет
  уже существующий `stop_singbox`.
- `src-tauri/src/profile_store.rs` валидирует schema/ID/active-ссылки, делает
  ревизионную optimistic-lock запись с `.bak`, fallback на backup и очищает
  временные артефакты.
- `src/lib/profile-store.js` сохраняет синхронный domain-фасад для UI, выполняет
  legacy migration и удаляет чувствительные WebView-ключи только после успешной
  записи Rust.

Остаётся проверить на Windows: DPAPI/portable read-back, повреждение primary с
восстановлением из `.bak`, перенос Portable-папки и downgrade-матрицу. Локальный
VPS намеренно не запускает тяжёлые Rust/Tauri проверки.

## TrustTunnel TOML

Минимально поддерживаемый формат: плоские `key = value`, basic/literal string и
однострочные массивы строк. `certificate` поддержан как строка с escaped `\n`.
Сложные TOML-формы, особенно triple-quoted multiline strings, лучше явно
отклонять до подключения полноценного TOML-парсера.

## `innerHTML` rule

- Статические templates допустимы.
- Enum/constant templates допустимы, если значения приходят из локальных enum.
- Любые profile/subscription/node/server/error strings перед `innerHTML` должны
  идти через `escapeHtml`; атрибуты — через `escapeAttr`.
- URL нельзя считать безопасным только после escaping: нужна отдельная проверка
  схемы/пути.

Быстрый аудит показал уже существующий `src/lib/esc.js`; новые render-функции
должны использовать его вместо ручного экранирования.

## Большие файлы

Не распиливать `src/main.js` и `src/lib/singbox.js` одним PR. Безопасный порядок:

1. `singbox.js`: вынести чистые URL/base64/TOML helpers с тестами.
2. `singbox.js`: вынести protocol parsers без изменения экспортов.
3. `singbox.js`: вынести sidecar/bridge config builders.
4. `singbox.js`: только после этого трогать sing-box/xray config builder.
5. `main.js`: сначала settings wiring и updater flow.
6. `main.js`: затем subscription refresh flow и DPI actions.
7. `main.js`: в последнюю очередь connection lifecycle.

Каждый перенос должен быть механическим и сопровождаться теми же JS-тестами,
без одновременного переименования и изменения поведения.

Сделано:

- Чистые URL/base64 helpers вынесены в `src/lib/url-helpers.js`.
- Protocol parsers вынесены в `src/lib/protocol-parsers.js`; `singbox.js`
  сохраняет старые parser-экспорты фасадом.

## Capabilities

Текущее использование frontend API:

- `core:window:*`: titlebar controls and window dragging.
- `core:path:default`: path helpers used by logs/settings flows.
- `core:event:default`: deep-link, tray and stream listeners.
- `shell:allow-open`: только внешние ссылки About/License.
- `updater:default`: check/download/install update flow.
- `process:default`: restart/relaunch flow.
- `dialog:default`: file/dialog flows.
- `notification:default`: tray/background notifications.
- `deep-link:default`: initial/current deep-link handling.

Дальше можно сужать `dialog`, `notification`, `event` только после отдельного
поиска конкретных команд и проверки на Windows.
