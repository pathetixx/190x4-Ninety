# Релиз Ninety

Единый счётчик — **semver** в `src-tauri/tauri.conf.json`. Тег = `vX.Y.Z`
(например `v0.1.56`). Схема `v0.1.0-alphaNN` устарела с 0.1.56 — больше не
используем. «Alpha»-статус живёт в названии релиза/заметках, **не** во флаге
prerelease (см. ниже почему).

## Шаги

1. Бамп версии в **4 файлах** (одно значение):
   - `src-tauri/Cargo.toml` → `version`
   - `src-tauri/Cargo.lock` → пакет `ninety` → `version`
   - `src-tauri/tauri.conf.json` → `version`
   - `package.json` → `version`
2. Коммит в `main`, push.
3. Тег и push тега — **это запускает релизную сборку**:
   ```
   git tag v0.1.56
   git push origin v0.1.56
   ```
   > Сразу тег + релиз, **без** предварительного `workflow_dispatch` «на проверку»
   > — даже когда менялся Rust. Релизный билд сам и есть проверка компиляции;
   > красный → fix-forward следующим тегом. Две компиляции = пустая трата
   > раннер-минут. (`workflow_dispatch` оставлен в триггерах только для ad-hoc
   > отладки CI, не для релизного ритуала.)
4. **Сразу** создать GitHub Release с заметками — чтобы CI успел вшить их в
   `latest.json` (шаг "Generate latest.json" тянет body уже существующего релиза):
   ```
   gh release create v0.1.56 --title "Ninety v0.1.56" --notes "…"
   ```
5. Дождаться зелёного рана (`gh run watch`) и проверить ассеты релиза:
   `Ninety_X.Y.Z_x64-setup.exe` (+`.sig`), `.msi`, `latest.json` с верной
   `version` и подписью.

## Почему prerelease: false (не трогать)

Updater-эндпоинт (`tauri.conf.json`) —
`https://github.com/pathetixx/190x4-Ninety/releases/latest/download/latest.json`.
Это редирект на релиз с бейджем **Latest**, а GitHub исключает из Latest всё
помеченное prerelease. Если выставить `prerelease: true`, `/releases/latest/`
начнёт отдавать старый `latest.json` → OTA сломается. Поэтому в `build.yml`
жёстко `prerelease: false` + `make_latest: "true"`.

## Версия vs тег у клиента

Апдейтер сравнивает установленную версию с полем `version` в `latest.json`
(оно берётся из `tauri.conf.json`), а **не** с именем тега. Имя тега —
только git-указатель и контейнер релиза с ассетами.
