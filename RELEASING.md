# Релиз Ninety

Единый счётчик — **semver** в `src-tauri/tauri.conf.json`. Тег = `vX.Y.Z`
(например `v0.1.56`). Схема `v0.1.0-alphaNN` устарела с 0.1.56 — больше не
используем.

**Никакого «alpha» в заголовке релиза и нигде в метаданных.** Заголовок =
`Ninety vX.Y.Z`, чисто. Фаза проекта (alpha) — наше внутреннее знание, юзера она
бесит. `prerelease` тоже **false** (см. ниже почему).

## Шаги

1. Бамп версии в **4 файлах** (одно значение):
   - `src-tauri/Cargo.toml` → `version`
   - `src-tauri/Cargo.lock` → пакет `ninety` → `version`
   - `src-tauri/tauri.conf.json` → `version`
   - `package.json` → `version`
2. Коммит в `main`, push.
3. Тег **обязательно аннотированный**, сообщение тега = заметки релиза. Push
   тега запускает релизную сборку:
   ```
   git tag -a v0.1.56 -m "Что нового в этой версии…"
   git push origin v0.1.56
   ```
   > **Почему -a с заметками (критично для OTA).** Шаг "Generate latest.json"
   > берёт `notes` для `latest.json` (= changelog в OTA-окне) с приоритетом из
   > **аннотации тега**, тело релиза — лишь фолбэк. Лёгкий `git tag v0.1.56`
   > (без -a) даёт `%(contents)` = сообщение коммита (напр. «v0.1.80») → именно
   > оно уедет в OTA вместо changelog'а. Сообщение тега и `--notes` draft'а
   > (шаг 4) должны совпадать.

   > Сразу тег + релиз, **без** предварительного `workflow_dispatch` «на проверку»
   > — даже когда менялся Rust. Релизный билд сам и есть проверка компиляции;
   > красный → fix-forward следующим тегом. Две компиляции = пустая трата
   > раннер-минут. (`workflow_dispatch` оставлен в триггерах только для ad-hoc
   > отладки CI, не для релизного ритуала.)
4. **Сразу** создать GitHub Release **как DRAFT** с заголовком и заметками
   (тем же текстом, что в аннотации тега — это тело страницы релиза и фолбэк):
   ```
   gh release create v0.1.56 --draft --title "Ninety v0.1.56" --notes "…"
   ```
   **Заголовок указываем сами** (без «alpha»!): softprops при публикации draft'а
   имя НЕ перезаписывает (проверено на 0.1.60 — без --title вышло голое
   «v0.1.56»).

   > **Почему DRAFT (критично для OTA).** Updater-эндпоинт —
   > `releases/latest/download/latest.json`, редирект на релиз с бейджем
   > **Latest**. Если создать релиз сразу published, он мгновенно становится
   > Latest, а `latest.json`-ассет появится только через ~12 мин (когда CI
   > закончит) → всё это время `/latest/latest.json` отдаёт **404** → у ВСЕХ
   > апдейтер молчит «обновлений нет». Драфт исключён из Latest: пока идёт билд,
   > `/latest/` указывает на ПРЕДЫДУЩИЙ рабочий релиз (OTA жива), а CI-шаг
   > "Release on tag" (softprops, `draft:false` по умолчанию) публикует draft
   > вместе с ассетами в самом конце → переключение без слепой зоны. Бонус:
   > упавший билд оставляет draft неопубликованным — OTA не ломается вообще.
5. Дождаться зелёного рана (`gh run watch`). CI сам публикует draft + грузит
   ассеты. Проверить: релиз стал published и Latest, есть
   `Ninety_X.Y.Z_x64-setup.exe` (+`.sig`), `.msi`, `latest.json` с верной
   `version`/подписью, и `curl -sIL .../releases/latest/download/latest.json`
   даёт 302→200 (не 404).

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
