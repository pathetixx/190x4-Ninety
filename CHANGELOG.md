# Ninety — журнал изменений

Журнал начинается с **v0.1.56** — перехода на semver (до неё был счётчик `alphaNN`). Тексты дословно совпадают с заметками релизов, которые приходят в окно обновления (OTA); свежая версия — сверху.

## v0.2.13 — 2026-07-13

- Removed synchronous WinINet settings refresh from the critical shutdown path; Windows proxy notifications now run in a coalesced background worker and can no longer hold disconnect or profile switching for 25–30 seconds.
- Runtime shutdown now reports per-stage timings for process termination, Windows proxy handling, and final confirmation, while cleanup failures are identified correctly as disconnect errors instead of start failures.
- Синхронное обновление WinINet убрано из критического пути остановки: оповещения Windows о системном прокси теперь выполняются в объединяемом фоновом потоке и больше не могут задерживать отключение или смену профиля на 25–30 секунд.
- Остановка runtime теперь возвращает отдельные замеры завершения процессов, обработки системного прокси и финального подтверждения, а ошибки очистки корректно показываются как ошибки отключения, а не запуска.

## v0.2.12 — 2026-07-12

- Runtime shutdown now verifies process exit and port release in one fast parallel barrier instead of stacking sequential timeouts that could delay disconnect and profile switching for nearly 30 seconds.
- In-flight xray, protocol-sidecar, sing-box, and Clash readiness stages are now cancelled promptly when a newer disconnect or reconnect intent arrives, while verified cleanup and race protection remain enforced.
- Остановка runtime теперь параллельно подтверждает завершение процессов и освобождение портов вместо сложения последовательных тайм-аутов, которые могли задерживать отключение и смену профиля почти на 30 секунд.
- Незавершённые этапы запуска xray, протокольных клиентов, sing-box и Clash теперь быстро отменяются новым намерением отключения или реконнекта, при этом подтверждённая очистка и защита от гонок сохранены.

## v0.2.11 — 2026-07-12

- The active-connection toggle now shows a distinct "Disconnecting" state while Ninety verifies process shutdown and port release, instead of incorrectly appearing to reconnect.
- Connection arbitration and verified runtime cleanup remain unchanged, preserving safe subsequent reconnects.
- Переключатель активного соединения теперь показывает отдельное состояние «Отключение…», пока Ninety подтверждает завершение процессов и освобождение портов, вместо ошибочного «Подключение…».
- Арбитраж подключения и подтверждённая очистка runtime не изменены, поэтому последующее подключение остаётся защищено от гонок.

## v0.2.10 — 2026-07-12

- Fixed the Connect button: the toggle mistook its own in-flight request for backend activity, so every click on an idle app routed to disconnect and the VPN could never start.
- A failed final runtime readiness check now reports a start error and returns to idle instead of leaving the UI stuck on "Connecting".
- Исправлена кнопка подключения: переключатель принимал собственный незавершённый запрос за активность backend, поэтому каждый клик в выключенном состоянии уходил в отключение и VPN не мог запуститься.
- Провал финальной проверки готовности runtime теперь показывает ошибку запуска и возвращает в выключенное состояние вместо вечного «Подключение…».

## v0.2.9 — 2026-07-12

- Reconnect requests now use latest-wins arbitration, while user disconnect and OTA stop intents cancel stale reconnects safely.
- Fixed reconnect progress toasts getting stuck and added regression coverage for reconnect races and final runtime/UI state.
- Запросы реконнекта теперь разрешаются по latest-wins, а ручное отключение и остановка перед OTA безопасно отменяют устаревшие операции.
- Исправлено зависание тоста применения настроек; добавлены регрессионные проверки гонок реконнекта и согласованности финального состояния runtime/UI.

## v0.2.8 — 2026-07-12

- Fixed the Windows DPI session-exclusion path and guaranteed empty managed endpoint lists before winws starts.
- Serialized startup reconcile/autoconnect and guarded user intents against a running backend, duplicate starts, and stale reconnects.
- Added a reviewed SourceForge fallback for the Flowseal DPI channel with exact-version hashes, archive safety guards, and signed service data.
- Исправлен путь session exclusion для Windows DPI; перед запуском winws гарантированно создаются пустые managed-списки endpoint'ов.
- Reconcile и autoconnect теперь выполняются последовательно, а пользовательские intent'ы защищены от уже работающего backend, двойного старта и устаревшего реконнекта.
- Для DPI-канала Flowseal добавлен проверяемый SourceForge fallback с хэшами exact-version архивов, защитой распаковки и подписанными service-файлами.

## v0.2.7 — 2026-07-12

- Runtime identity now adopts the backend process generation and rejects stale Clash, traffic, quality, and DPI operations across reconnects.
- Shutdown waits for explicit child-process exit acknowledgements; startup reconcile and OTA recovery now handle relaunch failures with controlled cleanup.
- Live Kill Switch changes confirm WFP state and roll back the setting when protection cannot be armed or disarmed.
- Runtime identity теперь принимает реальное поколение процесса от backend и отбрасывает устаревшие операции Clash, трафика, качества и DPI после реконнектов.
- Остановка ждёт явного подтверждения завершения child-процессов; startup reconcile и OTA recovery теперь обрабатывают ошибки relaunch через контролируемую очистку.
- Изменения Kill Switch в активной сессии подтверждают состояние WFP и откатывают настройку, если защиту не удалось включить или снять.

## v0.2.6 — 2026-07-12

- Hardened Windows proxy, autostart, sidecar logging, and backend read limits for more predictable long-running sessions.
- Added stable release qualification checks, immutable GitHub Actions pinning, and safer OTA promotion metadata refreshes.
- Fixed Windows test expectations and Clippy issues required by the release gate.
- Усилены прокси и автозапуск в Windows, изоляция логов sidecar и ограничения чтения backend для стабильной долгой работы.
- Добавлены проверки квалификации стабильного релиза, контроль неизменяемых SHA для GitHub Actions и безопасное обновление метаданных OTA.
- Исправлены проверки Windows и замечания Clippy, блокировавшие релизный gate.

## v0.2.5 — 2026-07-11

- The active profile or subscription is now preserved reliably across an OTA restart, including when WebView storage must be restored.
- Refined Shiro Light with a cleaner white surface, lighter HUD treatment, and calmer telemetry without light-theme glitch artifacts.
- The Appearance settings section now clearly describes language and theme selection.

- Активный профиль или подписка теперь надёжно сохраняется при OTA-перезапуске, включая сценарий восстановления хранилища WebView.
- Тема Shiro Light получила более чистую белую поверхность, лёгкий HUD и спокойную телеметрию без глитч-артефактов светлой темы.
- В разделе «Оформление» теперь явно указаны выбор языка и темы.

## v0.2.4 — 2026-07-10

- Updated Tauri, Windows platform bindings, networking and archive dependencies; adapted WARP key generation for the current cryptography API.
- GitHub Actions are now pinned to immutable commit hashes and release checks validate that pinning automatically.
- DPI strategy-channel signing now uses a dedicated key. This release accepts both the dedicated and previous key during the safe migration period.
- Обновлены Tauri, Windows-привязки, сетевые и архивные зависимости; генерация WARP-ключа адаптирована к актуальному криптографическому API.
- GitHub Actions закреплены на неизменяемые SHA-коммиты, а релизные проверки автоматически контролируют это правило.
- Для подписи канала DPI-стратегий теперь используется отдельный ключ. В этом релизе для безопасного перехода принимаются и новый, и прежний ключи.


## v0.2.3 — 2026-07-09

- Background subscription refresh now respects per-subscription auto-update switches while manual refresh still updates every subscription.
- Adding multiple protocol links now imports them as a list instead of treating the whole multi-line paste as one config.
- Manual subscription refresh intervals are preserved across server header updates, with explicit auto/manual interval state.
- Numeric settings now clamp invalid, empty, below-min, and above-max values in JavaScript.
- Refresh-all subscription feedback now reports full success, partial failures, and full failures separately.
- Theme metadata now lives in a shared registry used by Settings and onboarding.
- Added Shiro Light, Sakura Haze, Midnight Indigo, Amber Glass, Glacier, and Ronin Violet themes.
- CSS surfaces now use semantic overlay, shine, and shadow tokens so light themes render cleanly.

- Фоновое обновление подписок теперь уважает switch автообновления у каждой подписки, а ручное обновление по-прежнему обновляет все подписки.
- Вставка нескольких protocol-ссылок теперь импортируется списком, а не ошибочно считается одним config.
- Ручной интервал обновления подписки больше не перезаписывается серверным header после refresh.
- Числовые настройки теперь клампятся в JavaScript при пустых, некорректных и выходящих за min/max значениях.
- «Обновить все подписки» теперь отдельно показывает полный успех, частичные ошибки и полный провал.
- Метаданные тем вынесены в общий registry для Settings и onboarding.
- Добавлены темы Shiro Light, Sakura Haze, Midnight Indigo, Amber Glass, Glacier и Ronin Violet.
- CSS surfaces переведены на semantic overlay, shine и shadow tokens, чтобы светлые темы выглядели аккуратно.


## v0.2.2 — 2026-07-08

- Added an in-app confirmation modal before clearing profiles, subscriptions, active selection, traffic history, WARP/quality/Wi-Fi history, and encrypted backup state from Settings -> General.
- The sensitive-data cleanup button no longer performs destructive reset on the first click; cleanup runs only after explicit confirmation.

- Добавлено встроенное окно подтверждения перед очисткой профилей, подписок, активного выбора, истории трафика, истории WARP/качества/Wi-Fi и encrypted backup в «Настройки -> Общие».
- Кнопка очистки чувствительных данных больше не делает destructive reset по первому клику: очистка запускается только после явного подтверждения.


## v0.2.1 — 2026-07-08

- Added an explicit sensitive-data cleanup action in Settings -> General: it stops VPN/DPI, removes profiles, subscriptions, active selection, traffic history, WARP/quality/Wi-Fi history, and clears the encrypted state backup.
- State backup now keeps only restorable Ninety settings instead of preserving temporary traffic, update, WARP, quality, and Wi-Fi runtime keys.
- DPI strategy channel downloads now enforce size limits for text, signatures, and zip bundles, and IP set entries reject malformed CIDR values more strictly.
- Profile/subscription/settings rendering now escapes more dynamic text and attributes, reducing frontend injection risk from imported data.
- Protocol link parsers and URL helpers were split into smaller tested modules without changing the public import flow.
- Release CI now runs Rust clippy before the heavy Windows engine build.
- Fixed the 32x32 Windows icon asset format.

- Добавлена явная очистка чувствительных данных в «Настройки -> Общие»: она останавливает VPN/DPI, удаляет профили, подписки, активный выбор, историю трафика, историю WARP/качества/Wi-Fi и чистит encrypted state backup.
- State backup теперь сохраняет только восстанавливаемые настройки Ninety, без временных ключей трафика, обновлений, WARP, качества и Wi-Fi runtime.
- Загрузки канала DPI-стратегий теперь ограничены по размеру для текста, подписей и zip-бандлов, а IP set строже отбрасывает некорректные CIDR-значения.
- Рендер профилей, подписок и настроек теперь экранирует больше динамического текста и атрибутов, снижая риск frontend injection через импортированные данные.
- Парсеры VPN-ссылок и URL-helper'ы вынесены в меньшие тестируемые модули без изменения публичного import flow.
- Release CI теперь запускает Rust clippy перед тяжёлой Windows-сборкой движков.
- Исправлен формат 32x32 Windows icon asset.


## v0.2.0 — 2026-07-08

- Hardened runtime cleanup and sidecar startup so invalid sidecar config can no longer leave xray running.
- VPN · TUN and Kill Switch now cover both short and Tauri target-suffixed engine process names, preventing sidecar traffic loops in installed builds.
- Cancelling the UAC prompt when switching to TUN now restores the previous mode instead of leaving TUN saved.
- Subscription refreshes now keep the privacy-safe default: if refresh through the tunnel fails, Ninety no longer retries directly unless explicitly allowed in Settings.
- Port validation is now consistent across all supported link parsers, and DNS address parsing handles bracketed IPv6 plus ambiguous raw IPv6 safely.
- Stale runtime configs with node credentials are purged on app startup after crashes or power loss.
- Release CI now runs frontend lint, frontend tests, and Rust tests before the heavy engine build, with Windows-safe test discovery and Tauri sidecar placeholders for Rust tests.

- Усилен cleanup и запуск sidecar'ов: битый JSON sidecar'ов больше не оставляет уже запущенный xray живым.
- VPN · TUN и Kill Switch теперь покрывают и короткие, и Tauri target-suffixed имена процессов движков, чтобы sidecar'ы не петляли в установленной сборке.
- При отмене UAC во время перехода в TUN прежний режим возвращается обратно, вместо сохранённого TUN.
- Обновление подписок теперь по умолчанию приватное: если обновить через туннель не удалось, Ninety не повторяет запрос напрямую без явного разрешения в настройках.
- Валидация портов унифицирована во всех поддерживаемых парсерах ссылок, а DNS-адреса безопасно обрабатывают IPv6 в скобках и неоднозначный raw IPv6.
- Stale runtime-конфиги с кредами нод чистятся при старте приложения после crash/power loss.
- Release CI теперь запускает frontend lint, frontend tests и Rust tests до тяжёлой сборки движков, с Windows-safe поиском тестов и Tauri placeholder'ами sidecar'ов для Rust-тестов.


## v0.1.100 — 2026-07-08

- Fixed the early Rust test step in release CI: temporary sidecar placeholders are created before `cargo test`, then replaced by the real verified engine binaries later in the build.

- Исправлен ранний шаг Rust-тестов в release CI: перед `cargo test` создаются временные placeholder sidecar'ы, а позже сборка заменяет их реальными проверенными бинарниками движков.


## v0.1.99 — 2026-07-08

- Fixed the frontend test runner on Windows CI: tests are now enumerated by a small Node script instead of relying on shell glob expansion.

- Исправлен запуск frontend-тестов в Windows CI: список тестов теперь собирает маленький Node-скрипт, а не shell glob.


## v0.1.98 — 2026-07-08

- Fixed a startup cleanup edge case: invalid sidecar JSON can no longer leave an already-started xray process running.
- VPN · TUN and Kill Switch now cover both short and Tauri target-suffixed engine process names, preventing sidecar traffic loops in installed builds.
- Cancelling the UAC prompt when switching to TUN now restores the previous mode instead of leaving TUN saved.
- Subscription refreshes now keep the privacy-safe default: if refresh through the tunnel fails, Ninety no longer retries directly unless explicitly allowed in Settings.
- Port validation is now consistent across all supported link parsers, and DNS address parsing handles bracketed IPv6 plus ambiguous raw IPv6 safely.
- Stale runtime configs with node credentials are purged on app startup after crashes or power loss.
- CI now runs frontend lint, frontend tests, and Rust tests before the heavy engine build.

- Исправлен крайний случай cleanup: битый JSON sidecar'ов больше не оставляет уже запущенный xray живым.
- VPN · TUN и Kill Switch теперь покрывают и короткие, и Tauri target-suffixed имена процессов движков, чтобы sidecar'ы не петляли в установленной сборке.
- При отмене UAC во время перехода в TUN прежний режим возвращается обратно, вместо сохранённого TUN.
- Обновление подписок теперь по умолчанию приватное: если обновить через туннель не удалось, Ninety не повторяет запрос напрямую без явного разрешения в настройках.
- Валидация портов унифицирована во всех поддерживаемых парсерах ссылок, а DNS-адреса безопасно обрабатывают IPv6 в скобках и неоднозначный raw IPv6.
- Stale runtime-конфиги с кредами нод чистятся при старте приложения после crash/power loss.
- CI теперь запускает frontend lint, frontend tests и Rust tests до тяжёлой сборки движков.


## v0.1.97 — 2026-07-07

- Fixed: in WARP direct mode, custom routing rules set to "Through VPN" and remote rule-set downloads now go through WARP instead of bypassing it.
- WARP direct mode can now connect without an imported profile or subscription when WARP is registered.
- Routing rules now reject malformed IPv6 values more strictly.
- Added optional VPN link handler registration for quick imports, including `vless://`, `vmess://`, `ss://`, `trojan://`, `hysteria2://`, `tuic://`, `sub://`, `tt://`, and Naive links.

- Исправлено: в WARP direct пользовательские правила «Через VPN» и загрузка удалённых rule-set'ов теперь идут через WARP, а не обходят его.
- WARP direct теперь может подключаться без импортированного профиля или подписки, если WARP уже зарегистрирован.
- Правила маршрутизации теперь строже отбрасывают некорректные IPv6-значения.
- Добавлена опциональная регистрация VPN-ссылок для быстрого импорта, включая `vless://`, `vmess://`, `ss://`, `trojan://`, `hysteria2://`, `tuic://`, `sub://`, `tt://` и Naive-ссылки.


## v0.1.96 — 2026-07-07

- Fixed: system proxy mode now restores the previous proxy bypass list (`ProxyOverride`) instead of leaving Ninety's own bypass list behind.
- DPI strategy channel updates are applied more safely: required lists and `.bin` payloads are copied first, errors are no longer ignored, and `strategies.json` is replaced last.
- Fixed: IPv6 VPN node exclusions for DPI bypass now use `/128` instead of `/32`.
- Hardened WARP/DPI settings rendering and removed a stray binary NUL byte from the routing monitor source file.
- Release builds now install npm dependencies with `npm ci` for lockfile-based reproducibility.

- Исправлено: режим системного прокси теперь восстанавливает прежний список исключений (`ProxyOverride`), а не оставляет после себя список Ninety.
- Обновления канала DPI-стратегий применяются безопаснее: нужные списки и `.bin`-файлы копируются первыми, ошибки больше не игнорируются, а `strategies.json` заменяется последним.
- Исправлено: IPv6-ноды в исключениях DPI-обхода теперь получают `/128`, а не `/32`.
- Усилена защита рендера настроек WARP/DPI и убран бинарный NUL-байт из исходника монитора маршрутизации.
- Релизные сборки теперь ставят npm-зависимости через `npm ci` для воспроизводимости по lockfile.


## v0.1.95 — 2026-07-05

- Fixed: the WARP toggle in the mode popover and in Settings → WARP now stay in sync; the popover row also hints that it is the same setting.
- Toggles now work from the keyboard (Tab, then Space/Enter) and are visible to screen readers; a settings row with a single toggle reacts to a click anywhere in the row.
- Fixed: renaming or deleting a subscription while a background update was running could silently undo the change; "update all subscriptions" now runs in parallel and is faster.

- Исправлено: переключатель WARP в поповере режима и в «Настройки → WARP» теперь синхронны; в поповере добавлена подсказка, что это одна и та же настройка.
- Тумблеры теперь работают с клавиатуры (Tab, затем Space/Enter) и видимы скринридерам; строка настройки с одним тумблером реагирует на клик в любом месте строки.
- Исправлено: переименование или удаление подписки во время фонового обновления могло молча откатиться; «обновить все подписки» теперь выполняется параллельно и быстрее.


## v0.1.94 — 2026-07-05

**What's new**

- DPI bypass host/ipset updates are now signature-verified before they touch your system.
- New "App names in the monitor" toggle (Routing) — leave it on for per-app labels in the connection monitor, or turn it off to reduce per-connection overhead.
- Kill switch now arms and disarms instantly, without reconnecting the tunnel.
- Internal refactor and added tests for stability.

**Что нового**

- Обновления hosts/ipset для DPI-обхода теперь проверяются по подписи перед применением.
- Новый переключатель «Имена приложений в мониторе» («Маршрутизация») — оставьте включённым для подписей приложений в мониторе соединений или выключите, чтобы снизить нагрузку.
- Kill switch включается и выключается мгновенно, без переподключения туннеля.
- Внутренний рефакторинг и новые тесты ради стабильности.


## v0.1.93 — 2026-07-05

#### English

- DPI bypass: the strategy‑set update check and channel sync now run through the active tunnel (with a direct fallback), so updates work from restricted networks where the update channel is blocked directly.
- More resilient core control: an internal lock error can no longer wedge later actions (connect/disconnect, mode switch).
- Security hardening: system utilities are now invoked by absolute path.

#### Русский

- DPI‑обход: проверка и обновление набора стратегий теперь идут через активный туннель (с прямым фолбэком) — работают из сетей с блокировками, где канал недоступен напрямую.
- Устойчивее управление ядром: внутренняя ошибка блокировки больше не «залипает» на последующих действиях (подключение/отключение, смена режима).
- Усиление безопасности: системные утилиты вызываются по абсолютному пути.


## v0.1.92 — 2026-07-04

Fixes: Naive and TrustTunnel nodes now work in VPN (TUN) mode, plus privacy and reliability improvements.

- Naive and TrustTunnel nodes now work in VPN (TUN) mode — their traffic used to loop inside the tunnel and never reach the server.
- A failed connection attempt no longer leaves helper processes running in the background.
- Privacy: the default log level is now "warn" — visited domains are no longer written to engine logs. Existing installs are switched automatically; pick "info" in Settings if you need detailed logs for debugging.
- Subscription updates now reject insecure redirects that would expose the subscription link.

---

Исправления: ноды Naive и TrustTunnel теперь работают в режиме VPN (TUN), плюс улучшения приватности и стабильности.

- Ноды Naive и TrustTunnel теперь работают в режиме VPN (TUN) — раньше их трафик зацикливался внутри туннеля и не доходил до сервера.
- Неудачная попытка подключения больше не оставляет вспомогательные процессы работать в фоне.
- Приватность: уровень логов по умолчанию теперь «warn» — посещаемые домены больше не пишутся в логи движка. Существующие установки переключаются автоматически; для отладки можно выбрать «info» в настройках.
- Обновление подписок теперь отклоняет небезопасные редиректы, раскрывающие ссылку подписки.


## v0.1.91 — 2026-07-04

New: a privacy setting that stops external IP and country lookups, plus DPI and reliability fixes.

- Privacy: a new setting turns off external IP and country lookups. With it on, Ninety no longer contacts geo services to detect your IP, country and provider, and the IP tile on the home screen stays hidden.
- DPI bypass no longer stops bypass tools that were started outside Ninety — only its own engine is managed.
- Reliability: lighter connection health checks and a size cap on engine logs.

---

Новое: настройка приватности, отключающая запросы IP и страны к внешним сервисам, плюс исправления DPI и стабильности.

- Приватность: новая настройка отключает запросы IP и страны к внешним сервисам. Когда она включена, Ninety не обращается к geo-сервисам для определения IP, страны и провайдера, а плитка IP на главном экране скрыта.
- DPI-обход больше не завершает сторонние инструменты обхода, запущенные вне Ninety, — управляется только собственный движок.
- Стабильность: более лёгкие проверки соединения и ограничение размера логов движка.


## v0.1.90 — 2026-07-04

Fix: no more "sc.exe application error 0xc0000142" on shutdown.

- On PC shutdown Ninety no longer runs the driver-unload command that failed to start during session teardown and popped an error window. The DPI driver is released on reboot anyway; it is still unloaded properly when you quit the app normally or before an update.
- The unload no longer runs on every exit when the DPI bypass was never used this session.

---

Исправление: больше не появляется окно «sc.exe — ошибка приложения 0xc0000142» при выключении ПК.

- При выключении компьютера Ninety больше не запускает команду выгрузки драйвера, которая не могла стартовать в сворачивающейся сессии и показывала окно ошибки. Драйвер DPI-обхода всё равно выгружается при перезагрузке, а при обычном закрытии приложения и перед обновлением он снимается как раньше.
- Выгрузка больше не запускается на каждый выход, если DPI-обход в этой сессии не включался.


## v0.1.89 — 2026-07-04

Update delivery rework.

- Updates now arrive reliably when Ninety starts with Windows or lives in the tray: the check retries until the network is up and also runs when the connection appears, when the window is opened and right after the VPN connects. Background checks run every 2 hours instead of 6.
- With the VPN up, update checks and downloads go through the tunnel — updates reach regions where the update servers are unreachable directly.
- The update downloads while the connection is still alive; the tunnel stops only for the actual install. No more false "connection closed" alerts during an update.
- After an update the app restores your session: the VPN reconnects automatically (previously only the DPI bypass came back).
- The update notification is shown once per version instead of repeating.

---

Переработана доставка обновлений.

- Обновления теперь надёжно доходят при автозапуске с Windows и в трее: проверка повторяется, пока не поднимется сеть, и срабатывает при появлении сети, развороте окна и сразу после подключения VPN. Фоновая проверка — каждые 2 часа вместо 6.
- При поднятом VPN проверка и скачивание обновления идут через туннель — обновления доходят даже там, где серверы обновлений напрямую недоступны.
- Обновление скачивается при живом подключении; туннель останавливается только на время самой установки. Ложных «Соединение закрыто» во время обновления больше нет.
- После обновления приложение само возвращает сессию: VPN переподключается автоматически (раньше возвращался только обход DPI).
- Уведомление об обновлении показывается один раз на версию, без повторов.


## v0.1.88 — 2026-07-03

#### English

- Local secrets are now stored encrypted: WARP keys and the settings backup used to sit on disk as plain text.
- The connection-quality engine now applies what it learned right away — the remembered fix used to be ignored on the first slowdown of each session.
- A WARP+ key of the wrong length now shows a clear error — before, it silently registered plain free WARP while you thought WARP+ was active.
- Adding a subscription over plain http:// now shows a warning: its address and keys travel unencrypted.
- Exit-IP detection is faster and no longer queries several geo services at once.
- The settings backup keeps the previous snapshot as a spare, so a badly timed crash can't wipe it.

#### Русский

- Локальные секреты теперь хранятся в зашифрованном виде: ключи WARP и резервная копия настроек раньше лежали на диске открытым текстом.
- Движок качества связи сразу применяет то, чему научился — раньше запомненное лечение игнорировалось при первом замедлении каждой сессии.
- Ключ WARP+ неверной длины теперь даёт понятную ошибку — раньше молча регистрировался обычный бесплатный WARP, хотя казалось, что WARP+ активен.
- При добавлении подписки по http:// показывается предупреждение: её адрес и ключи идут без шифрования.
- Определение внешнего IP стало быстрее и больше не опрашивает несколько гео-сервисов одновременно.
- Резервная копия настроек держит предыдущий снапшот про запас — сбой в момент записи её больше не стирает.


## v0.1.87 — 2026-07-03

#### English

- DNS failover now actually works. The check that decides whether your direct DNS is alive was speaking the wrong protocol and declared every working DoH resolver dead — that's what spammed the "backup DNS unavailable" message. Fixed, plus it no longer nags on a single hiccup.
- The auto-update interval slider when adding a subscription now applies — before, your choice was ignored and only the panel's own interval was used.
- Fixed servers occasionally showing the wrong country flag (a name like "My Server" could pick up an unrelated flag).

#### Русский

- Резерв DNS теперь реально работает. Проверка, жив ли прямой DNS, говорила по неверному протоколу и считала любой рабочий DoH-резолвер мёртвым — из-за этого и выскакивало уведомление «резервные DNS недоступны». Исправлено, плюс больше не дёргает из-за одиночного сбоя.
- Слайдер интервала автообновления при добавлении подписки теперь применяется — раньше ваш выбор игнорировался и использовался только интервал самой панели.
- Исправлены редкие случаи неверного флага страны у сервера (имя вроде «My Server» могло подхватить чужой флаг).


## v0.1.86 — 2026-07-03

#### English

- Direct-DNS failover: if the resolver for direct lookups stops responding, Ninety switches to a working backup on its own — sites and the connection keep working when a DoH provider goes down. It also probes before connecting, so a dead resolver no longer blocks the whole start.
- Engine logs no longer grow without bound — each log file is capped, so a retry storm can't fill the disk.
- Faster public-IP detection: providers are queried in parallel, and every IP lookup now goes over HTTPS.
- Kill switch warns when you enable it in Proxy mode (there it blocks everything except apps you pointed at the proxy).

#### Русский

- Резерв direct-DNS: если резолвер для прямых запросов перестаёт отвечать, Ninety сам переключается на рабочий резерв — сайты и подключение продолжают работать, когда DoH-провайдер ложится. Проверка идёт и перед подключением, поэтому мёртвый резолвер больше не блокирует старт целиком.
- Логи движков больше не разрастаются без предела — размер каждого файла ограничен, шторм повторов не забьёт диск.
- Быстрее определение публичного IP: провайдеры опрашиваются параллельно, все запросы IP идут по HTTPS.
- Kill switch предупреждает при включении в режиме «Прокси» (там он блокирует всё, кроме приложений, направленных в прокси).


## v0.1.85 — 2026-07-03

The IP tile now always shows the VPN exit address — in System proxy and VPN · TUN modes it could show your real IP.
IP detection uses several services instead of one, so the tile keeps working when one of them is down.
Kill switch always lets DHCP through — long sessions no longer lose network when the address lease renews.
Kill switch keeps local network devices (printers, NAS, file shares) reachable while active; follows the "Bypass LAN" setting.
Connection config files are removed from disk right after disconnect — previously some remained.

—

Плитка IP теперь всегда показывает адрес выхода VPN — в режимах «Системный прокси» и VPN · TUN она могла показывать ваш реальный IP.
Определение IP идёт через несколько сервисов вместо одного: плитка работает, даже если один из них недоступен.
Kill switch всегда пропускает DHCP — длинные сессии больше не теряют сеть при продлении аренды адреса.
Kill switch не отрезает устройства локальной сети (принтеры, NAS, общие папки); поведение следует настройке «Обход локальной сети».
Файлы конфигурации подключения удаляются с диска сразу после отключения — раньше часть оставалась.


## v0.1.84 — 2026-07-03

Quality check in VPN · TUN mode now measures the tunnel itself, not the direct connection.
Speed auto-repair: the backup-route step works again; repair no longer runs in circles when the probe endpoint is unreachable.
Cancelling mid-connect now takes effect immediately.
Profiles, subscriptions and settings are backed up and restored if local storage is lost.
Subscriptions update through the VPN while it is on, and on the panel's own interval.
Open Wi-Fi auto-protect restores the previous mode once you are back on a safe network.
Turning the system proxy off no longer resets a proxy configured outside Ninety.
Kill switch no longer blocks the app's own service requests.
Temporary files with connection data are removed after stop.

—

Проверка качества связи в режиме VPN · TUN теперь измеряет сам туннель, а не прямое соединение.
Автолечение скорости: заработал шаг подбора резервного маршрута; лечение не гоняется вхолостую, когда проверочный сервер недоступен.
Отмена во время подключения срабатывает сразу.
Профили, подписки и настройки резервируются и восстанавливаются при потере локального хранилища.
Обновление подписок идёт через VPN, когда он включён, и по интервалу панели.
Автозащита на открытом Wi-Fi возвращает прежний режим после возврата в безопасную сеть.
Выключение системного прокси не сбрасывает прокси, настроенный вне Ninety.
Kill switch не блокирует служебные запросы приложения.
Временные файлы с данными подключения удаляются после остановки.


## v0.1.83 — 2026-07-02

#### English
- Connection quality engine: the "Traffic masking" recovery step actually works now — it used to fail silently while still flipping settings; when the window sits in the tray, the speed-up prompt no longer hangs invisibly, a notification is sent instead
- Kill Switch no longer cuts off xhttp / NaiveProxy / TrustTunnel nodes — every engine gets a firewall permit, not just sing-box
- Protocol bridges: a bridge that dies on startup now fails the connection with a clear error instead of reconnecting in an endless loop; bridge ports are picked automatically when the defaults are taken by another app
- Subscriptions: server response is capped at 10 MB
- Deep link ninety://import?url=… works now
- Tray menu and tooltip follow the interface language (all 15)
- Settings and onboarding texts corrected in every language

#### Русский
- Движок качества связи: ступень «Маскировка трафика» теперь реально работает — раньше она молча падала, успевая менять настройки; при окне в трее вопрос об ускорении больше не зависает невидимым — приходит уведомление
- Kill Switch больше не отрезает ноды xhttp / NaiveProxy / TrustTunnel — разрешение в файрволе получают все движки, не только sing-box
- Мосты протоколов: смерть моста на старте даёт понятную ошибку вместо бесконечных переподключений; порты мостов подбираются автоматически, если стандартные заняты другой программой
- Подписки: ответ сервера ограничен 10 МБ
- Deep-link ninety://import?url=… заработал
- Меню трея и подсказка — на языке интерфейса (все 15)
- Уточнены тексты настроек и онбординга на всех языках


## v0.1.82 — 2026-06-29

Снижено потребление процессора на главном экране: анимация HUD переведена на аппаратное ускорение — кольца вращаются без покадровой перерисовки. Сама анимация не изменилась.


## v0.1.81 — 2026-06-29

Установщик теперь предлагает выбор: поставить Ninety «для всех» (в Program Files, с правами администратора) или «только для меня» (как раньше, без прав). Можно указать и папку установки.

Обновление уже установленной версии остаётся на прежнем месте — ничего переносить не нужно.


## v0.1.80 — 2026-06-29

Автозапуск при входе в Windows больше не запрашивает права администратора на каждом включении компьютера — Ninety запускается с нужными правами сразу.

После установки этого обновления подтверждение прав может появиться ещё один раз (перенос настройки автозапуска), дальше — тихо.


## v0.1.79 — 2026-06-27

— Интерфейс на 15 языках: русский, English, فارسی, العربية, 中文, Español, Deutsch, Українська, 日本語, Français, Italiano, Português, 한국어, Polski, Türkçe. Выбор в Настройках → Оформление, применяется без перезапуска.
— Письмо справа налево (RTL) для فارسی и العربية.
— Флаг страны рядом с именем ноды в журнале.


## v0.1.78 — 2026-06-26

- Логи движка теперь читаемые: сняты ANSI-коды и служебные префиксы — и в окне, и в самом файле лога, и при копировании. Имена серверов в строках приведены к человеческому виду.
- Внутренняя стабильность: убраны предупреждения сборки и редкая ошибка инициализации трея при запуске.


## v0.1.77 — 2026-06-25

- Маска на главном экране не смещается при подключении и отключении
- Выбранная тема применяется ко всем всплывающим окнам — модалкам, тостам и меню в трее
- Правила маршрутизации: при обновлении списка процессов отыгрывает анимация загрузки
- Описания режимов подключения переписаны простым языком


## v0.1.76 — 2026-06-25

- Маска на главном экране не смещается при подключении и отключении


## v0.1.75 — 2026-06-25

- Маска на главном экране больше не сплющивается при нажатии
- Полоса подписки показывает остаток срока действия (для безлимитных подписок)


## v0.1.74 — 2026-06-25

- Главный экран подгоняется под размер окна, маска больше не сплющивается, HUD стабилен при переключении DPI-обхода
- TARGET LOCKED на HUD показывает реально выбранный сервер
- Карточка подписки и кнопки приведены к общему стилю экрана
- Обновления приходят через зеркало, GitHub — запасной канал


## v0.1.73 — 2026-06-24

Исправления главного экрана.

- HUD вокруг логотипа читается без наложений и стал крупнее.
- Анимация HUD снова работает.
- Маска больше не сплющивается при нажатии.
- Окно «Качество канала» открывается над панелью и не уезжает за край.
- Активный пункт меню — с акцентной подсветкой.
- В блоке «Сессия» трафик стоит справа от времени.
- Тема Cyan теперь применяется (Настройки → Оформление).


## v0.1.72 — 2026-06-24

Обновлённый главный экран.

- Анимированный HUD вокруг логотипа: кольца, индикатор состояния, часы.
- Новая тема оформления — Cyan (в Настройках → Оформление).
- Переработанная панель состояния: сервер, пинг, качество канала и сессия в одном ряду. Пинг можно перепроверить кликом.
- Текущая скорость теперь в одном месте — в мониторе слева.


## v0.1.71 — 2026-06-23

- Установка поверх работающей версии больше не упирается в занятый файл — переустановка и обновление проходят чисто; при удалении выполняется полная очистка.
- Новая тема оформления «Command Center».
- Индикатор «КАНАЛ» раскрывается в живой график качества связи.
- Защита на чужих Wi-Fi: при подключении к открытой сети можно автоматически включать защищённый режим (в Настройках).
- Аварийная блокировка (Kill Switch, экспериментально): при сбое соединения трафик не уходит в обход (в Настройках).


## v0.1.70 — 2026-06-19

#### DPI-обход

- **Файл hosts** — прописывает рабочие IP для доменов, которые ломает не DPI, а подмена DNS у провайдера: голосовые серверы Discord, веб-Telegram, GitHub. Применение, обновление и сброс выполняются отдельным управляемым блоком, с резервной копией исходного файла и сбросом DNS-кэша.
- **Обновление списка IP (ipset-all)** из репозитория — кнопка в разделе «Режим IPSet».


## v0.1.69 — 2026-06-16

- Обновления доходят даже при заблокированном доступе к GitHub — добавлен запасной канал доставки.
- Если проверку обновлений выполнить не удалось, приложение честно сообщает об этом (раньше показывало «у вас актуальная версия»).
- Актуализирован раздел «О программе».


## v0.1.68 — 2026-06-16

- Монитор соединений: у каждого соединения отображается приложение-владелец.
- Правила маршрутизации: кнопка «Добавить правило» возвращена в шапку — компактная, не на всю ширину.
- Список приложений в правилах обновляется плавно, без рывка интерфейса.


## v0.1.67 — 2026-06-15

#### Монитор соединений
- Имена приложений теперь видны у каждого соединения (раньше были прочерки) — процесс резолвится для всех соединений во всех режимах.
- Раздел соединений переработан: группировка по приложению (иконка, имя, путь, сводка маршрутов, число соединений), раскрытие списка назначений.

#### Правила маршрутизации
- Исправлен зависавший выбор приложения из запущенных.
- «Правила маршрутизации» вынесены в отдельный под-экран в Настройки → Маршрутизация.
- Кнопка «Обновить» в выборе приложений подтверждает, что список перечитан.


## v0.1.66 — 2026-06-15

#### Новое

**Правила маршрутизации**

Теперь можно задавать свои правила: домен, IP-адрес или приложение → пустить **Через VPN**, **Напрямую** или **Заблокировать**. Правила работают поверх выбранного региона — точечно, поверх общей базы; порядок в списке задаёт приоритет.

- Приложение можно выбрать из списка запущенных программ, которые сейчас выходят в сеть.
- Вкладка «Соединения» показывает в реальном времени, что и каким маршрутом идёт прямо сейчас.

Настройки → Маршрутизация → «Правила маршрутизации».

#### Исправлено

- Обновление набора способов обхода блокировок больше не зацикливается — кнопка «Обновить» применяет новую версию и не предлагает её повторно.
- Убран повторяющийся флаг сервера в строке статистики.


## v0.1.65 — 2026-06-13

**Качество связи** — новый движок следит за реальной скоростью соединения и, если его начинают замедлять, сам восстанавливает связь: меняет сервер, включает маскировку трафика или подключает запасной канал. Текущее состояние показывает индикатор «КАНАЛ» на главном экране, тонкая настройка — в новом разделе «Качество связи».

**TrustTunnel** — исправлено подключение к серверам: имя SNI и параметры шифрования теперь передаются корректно.

**Безопасность** — укреплена обработка конфигурации.


## v0.1.64 — 2026-06-05

Учёт трафика на главной и в списке профилей теперь показывает реально использованный объём — для подписок без лимита и одиночных нод (hysteria, NaiveProxy, TrustTunnel), где раньше было пусто. Сброс счётчика — в меню профиля.

- TrustTunnel: исправлено подключение — клиент не запускался из-за неполного конфига
- Логи: уровень логов и полное отключение применяются ко всем компонентам, а не только к ядру
- Флаги стран отображаются на главной и в трее для всех протоколов; иконки флагов в трее выровнены
- Настройки: убран раздел регистрации схем ссылок


## v0.1.63 — 2026-06-05

**Трей**
- Значок в трее отражает состояние: отключено / прокси / TUN.
- Подсказка значка показывает текущий режим подключения.

**Логи**
- Фильтр по тексту и по уровню (trace/debug/info/warn/error).
- Переключатель источника: sing-box, xray, naive, trusttunnel, DPI.

**Главная**
- На карточке подписки — кнопка перехода в «Профили».
- Флаги стран теперь отображаются и у нод с полным названием страны.

**Настройки**
- Мультиплексор вынесен в интерфейс.
- Описания разделов выправлены, права администратора показаны в нужном разделе.
- Убран неработавший выбор стратегии балансировщика.


## v0.1.62 — 2026-06-03

#### Новое

**DPI-обход**
- Переключатель «Подменить WinDivert на Monkey» — драйвер обхода грузится под нейтральным именем (служба и файл .sys), функционал не меняется.

**Новые протоколы**
- **NaiveProxy** — добавление ссылкой `naive+https://…`.
- **TrustTunnel** — добавление ссылкой `tt://…` или импортом endpoint-`.toml` (новая плитка «Файл .toml»).

Оба протокола работают через локальный SOCKS-мост (как xhttp), независимо от режима VPN.


## v0.1.61 — 2026-06-03

Автообновление набора стратегий DPI-обхода через подписанный канал — стратегии, списки и payload'ы приезжают без переустановки приложения.

- DPI: стратегии FAKE TLS AUTO больше не падают при включении
- Главная: статус подключения отражает режим — TUNNEL ACTIVE / SYSTEM PROXY / PROXY ACTIVE
- Список нод: кнопка проверки задержки зафиксирована в углу, не уезжает при прокрутке
- Настройки: «Всегда запускать от администратора» перенесён в «Общие»


## v0.1.60 — 2026-06-02

В разделе «О программе» лицензия MIT теперь открывает текст лицензии на GitHub.

Счётчик трафика подписки показывает реальный объём в удобных единицах, а для безлимитных подписок — пометку «безлимит» вместо нулей.


## v0.1.59 — 2026-06-02

Установщик в фирменном стиле 190×4: новые баннер и боковая панель с логотипом.


## v0.1.58 — 2026-06-02

Новый экран «О программе»: паспорт сборки — версия, коммит, ядро, дата, платформа.

Версия и проверка обновлений больше не дублируются в Настройках — только в «О программе».

Уведомление о доступном обновлении приходит, даже когда окно свёрнуто в трей: всплывает оповещение и появляется пункт «Обновить» в меню трея. Фоновая проверка теперь раз в 6 часов, а не только при запуске.

Уведомление о подключении показывает имя выбранного сервера.


## v0.1.57 — 2026-06-02

Правки интерфейса:

- Режим подключения «Системный» переименован в «Системный прокси».
- Уведомление о подключении показывает имя фактически выбранного сервера, а не первый из списка подписки.
- Логи: корректные переносы строк — записи больше не сливаются в сплошной текст.
- Меню в трее: пункт «Подключиться/Отключиться», подменю «DPI-обход» (статус и переключение), флаги стран у серверов.
- Новый раздел настроек «О программе» (версия, репозиторий, лицензия).


## v0.1.56 — 2026-06-02

Трюки TLS перебраны: фрагментация ClientHello больше не роняет VPN при включении (ядро отвергало устаревшее поле конфига). Переезд на актуальную схему — трюки применяются к прокси-подключению.

- Выбор способа фрагментации: по TLS-записям (рекоменд., быстрее) или по TCP-сегментам.
- Padding и mixed-case SNI сохранены, перенесены в per-outbound.

Версионирование приведено к semver: теги теперь vX.Y.Z, счётчик alphaNN больше не используется.
