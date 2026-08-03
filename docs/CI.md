# CI и security-gates

## Обязательные проверки для PR и `main`

Перед слиянием должны быть зелёными следующие статус-проверки:

- `Checks / js-tests` — JS-тесты, coverage-gate, синхронизация версий и pinning Actions;
- `Checks / js-lint` — ESLint;
- `Checks / rust-tests` — `cargo test`, `cargo fmt --check`, `cargo clippy -D warnings` на Windows;
- `Security / npm audit` — npm advisory audit с порогом `high`;
- `Security / RustSec and cargo-deny` — RustSec и `deny.toml`;
- `Security / CodeQL JavaScript` — SAST для frontend;
- `Security / Go sidecar dependency audit` — govulncheck для pinned sing-box и Xray.

`Checks` запускается для pull request и push в `main`. `Security` дополнительно
запускается по понедельникам по расписанию и вручную. Результат scheduled-run
нельзя оставлять без внимания: изменения advisory database должны приводить к
отдельному исправлению или явно оформленному исключению в policy.

## Права и публикация

`Checks`, `Security` и проверочная часть `Build Ninety` имеют глобальное
`contents: read`; их checkout использует `persist-credentials: false`.
`build-windows` также только собирает и отдаёт артефакты. В workflow `Build
Ninety` единственный job с `contents: write` — `release-on-tag`, который
запускается только после успешного `build-windows` на semver-теге и занимается
зеркалами, GitHub Release и проверкой OTA. Отдельные служебные workflow проекта
(`dpi-channel`, `engine-watch`, `launch-polish`) сохраняют свои узкие write-права
для публикации канала, создания PR или обновления issue/release.

SBOM CycloneDX генерируется на build-run и прикладывается к релизу как
`sbom-ninety.cdx.json`. Coverage-gate для выбранного security-critical модуля
(`src/lib/deeplink.js`) задаёт минимумы: lines 80%, functions 80%, branches 70%.
`Checks / js-tests` также сохраняет `coverage/lcov.info` как artifact на 14 дней.

## Ручные Windows-сценарии перед выпуском

Автоматические Rust-тесты проверяют чистые функции, а проверка реального
Authenticode-цепочки требует Windows. Перед первым релизом с Protected Browser
нужно вручную пройти следующие сценарии на тестовой машине:

- неподписанный `mullvadbrowser.exe` в пользовательской папке не появляется как
  доступный и не запускается;
- копия EXE в junction/reparse-пути не проходит проверку;
- штатно установленный Mullvad Browser с действующей цепочкой и publisher
  `Mullvad VPN AB` определяется и запускается только после активного TUN;
- подмена файла после проверки статуса блокируется повторной проверкой прямо
  перед запуском;
- отключение сети/отозванный сертификат даёт общее сообщение «защищённый
  браузер не найден или не прошёл проверку подписи», без пути и внутренних
  ошибок в UI.

Для profile-store перед первым выпуском также проверить на тестовом профиле:

- первый запуск переносит профиль, подписку, active source и remembered node в
  `profile-store.v1`, после успешного read-back legacy-ключи WebView исчезают;
- повреждение primary загружает валидный `.bak`, а stale `expectedRevision`
  отклоняется без перезаписи;
- Portable без passphrase оставляет legacy fallback и не создаёт новый
  plaintext backend-файл; после задания passphrase профильный envelope читается
  после перезапуска/переноса папки на другой тестовый ПК;
- кнопка очистки удаляет `profile-store.v1`, `.bak`, legacy backup и recovery
  snapshot, после чего старые профили не возвращаются при следующем запуске.
