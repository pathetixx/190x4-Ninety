# Ninety — журнал изменений

Журнал начинается с **v0.1.56** — перехода на semver (до неё был счётчик `alphaNN`). Тексты дословно совпадают с заметками релизов, которые приходят в окно обновления (OTA); свежая версия — сверху.

## v0.4.4

## English

- The server list no longer stalls the window while measurements arrive. Each incoming measurement used to tear the whole list down and build it again — about five thousand elements on a subscription of a few hundred servers — and that is what you felt as stutter, both during "Re-measure all" and in the background. Rows are now reused: only the two cells that changed are replaced.
- Measurements arriving in the background no longer reshuffle the list. The order holds until you ask for a new one — by clicking a column, searching, grouping, or entering the screen again — so rows no longer move out from under the cursor while you are reading them. The numbers still update in place.

## Русский

- Список серверов больше не подвешивает окно, пока приходят замеры. Каждый пришедший замер пересобирал список целиком — на подписке в несколько сотен серверов это около пяти тысяч элементов, — и именно это ощущалось рывками: и во время «Измерить все», и в фоне. Теперь строки переиспользуются, заменяются только те две ячейки, что изменились.
- Фоновые замеры больше не переставляют список. Порядок держится, пока вы не попросите другой — кликом по столбцу, поиском, группировкой или повторным входом на экран, — и строки не уезжают из-под курсора, пока вы их читаете. Цифры при этом обновляются на месте.

## v0.4.3 — 2026-08-26

## English

- "Re-measure all" no longer freezes the window for seconds. Every result that came back rebuilt the entire server list — every row, flag and graph of it — and results now arrive several times a second. Only the two cells that actually changed are redrawn.
- The list also keeps the order it had when the run started, instead of resorting itself on every result. Rows no longer jump out from under the cursor mid-run; the final order is applied once, when the run finishes.

## Русский

- «Измерить все» больше не подвешивает окно на несколько секунд. Каждый пришедший результат пересобирал весь список серверов целиком — все строки, флаги и графики, — а результаты теперь приходят по нескольку раз в секунду. Перерисовываются только те две ячейки, что действительно изменились.
- Список к тому же держит порядок, который был на момент запуска, вместо того чтобы пересортировываться на каждом замере. Строки больше не выпрыгивают из-под курсора посреди прогона, а итоговый порядок применяется один раз — по завершении.

## v0.4.2 — 2026-08-26

## English

- The "best measured" line and the order of the server list no longer treat delays left over from an earlier session as if they were current. A server that does not answer right now cannot be offered as the best one, and its old number sorts below the servers that do answer — it is still shown, dimmed, because it says what that server used to do.
- When a connection through a server fails, that server is measured again straight away instead of waiting for the next scheduled check. It returns to the running as soon as it works again, and stays out of it while it does not — answering a check is not enough on its own, since a server can pass the check and still refuse to carry traffic.
- Measuring the servers is quicker. Most of the wait was never the servers that answer — it was the ones that never will, waited on a handful at a time. They are now waited on in far larger batches, so a run over a few hundred servers takes well under a minute instead of several, both for Re-measure all and for the checks the app makes on its own. Re-measure all also starts with the servers that were fastest last time, so the top of the list fills in first.

## Русский

- Строка «лучший по замерам» и порядок списка серверов больше не считают задержки из прошлой сессии свежими. Сервер, который сейчас не отвечает, не может быть предложен как лучший, а его старая цифра уходит ниже тех, кто отвечает, — она по-прежнему видна, приглушённо, потому что говорит, каким этот сервер был раньше.
- Если соединение через сервер не удалось, он перемеряется сразу, а не ждёт очередной плановой проверки. Он возвращается в выбор, как только снова заработает, и не участвует в нём, пока не работает: одной пройденной проверки мало — сервер может отвечать на проверку и всё равно не пропускать трафик.
- Замеры серверов идут заметно быстрее. Почти всё время прогона занимали не те серверы, что отвечают, а те, что не ответят никогда, — и ждали их по нескольку штук за раз. Теперь их ждут куда большими пачками: прогон по нескольким сотням серверов укладывается меньше чем в минуту вместо нескольких — и для кнопки «Измерить все», и для проверок, которые приложение делает само. «Измерить все» вдобавок начинает с тех серверов, что были быстрыми в прошлый раз, поэтому верх списка заполняется первым.

## v0.4.1 — 2026-08-26

## English

- Auto no longer gets stuck on the first server of a subscription. It chooses by measured delay, but those delays were measured once, when the connection came up, and were never refreshed; each failed connection dropped one more of them, and once none were left Auto held the first server in the list even when that server answered nothing. The app now keeps the measurements current by itself, and a server that fails to carry traffic steps out of the running for a while instead of being picked again straight away.
- The servers screen counted responding servers from measurements saved earlier, so the number was settled in the first session and never recalculated — not even by Re-measure all. It now counts what has just been confirmed, shows how far a measurement run has got, and dims delays left over from an earlier session, so a server that has since died no longer reads as a healthy one.
- In the recommendations, the line naming the server Auto is on showed the winner of the app's own rating rather than the server the traffic actually goes through. The two could disagree for hours.
- The tray icon could stay grey and say disconnected while the VPN was up, and only restarting the app put it right.
- On subscriptions with hundreds of servers the tray menu lists the current server, your favourites and the head of the list, and says how many more are waiting on the Servers screen.
- Delays measured from the app and delays the core measures on its own now use the same test address, so the two numbers can be compared.
- The connection test interval in settings finally does what it says: server checks really do repeat on it.
- The core was updated to sing-box 1.13.19.
- Wording: the app no longer speaks about itself in the first person.

## Русский

- «Авто» больше не залипает на первом сервере подписки. Он выбирает по замеренной задержке, но замеры делались один раз, при подключении, и дальше не обновлялись; каждое неудачное соединение убирало ещё один, а когда не оставалось ни одного, «Авто» держал первый сервер списка, даже если тот не отвечал вовсе. Теперь приложение обновляет замеры само, а сервер, через который не удалось пройти трафику, на время выбывает из выбора вместо того, чтобы выбираться снова тут же.
- Экран «Серверы» считал отвечающие серверы по ранее сохранённым замерам, поэтому число определялось в первую сессию и больше не пересчитывалось — даже кнопкой «Измерить все». Теперь считается то, что подтверждено сейчас, во время прогона виден его ход, а задержки, оставшиеся с прошлой сессии, показаны приглушённо: умерший сервер больше не выглядит живым.
- В рекомендациях строка о том, на каком сервере стоит «Авто», называла победителя собственного рейтинга приложения, а не сервер, через который реально идёт трафик. Расходиться они могли часами.
- Значок в трее мог оставаться серым и сообщать «отключено» при работающем VPN — помогал только перезапуск приложения.
- На подписках в сотни серверов меню в трее показывает текущий сервер, избранные и начало списка, а также сообщает, сколько ещё осталось на экране «Серверы».
- Задержки, которые меряет приложение, и задержки, которые ядро меряет само, теперь измеряются до одного адреса — их наконец можно сравнивать.
- Интервал проверки соединения в настройках наконец делает то, что обещает: проверки серверов действительно повторяются с ним.
- Ядро обновлено до sing-box 1.13.19.
- Формулировки: приложение больше не говорит о себе от первого лица.

## v0.4.0 — 2026-08-23

## English

- WireGuard and AmneziaWG profiles can be added. Paste the contents of a `.conf` file into the same field you use for links: it becomes an ordinary profile, appears in the server list, takes part in Auto and shows its ping. For AmneziaWG the traffic masking written in the file is kept, so a paid profile behaves the way it does in the client you brought it from.
- If the file contains lines the app does not carry over — a DNS line, for example — it says so right after the import instead of leaving you to find out later that the profile behaves differently here.
- A WireGuard profile can be copied back out as a `.conf` from its menu, to move it to another device or another app.
- Standalone configs can be deleted all at once: the group header now has a Delete all button, which asks for confirmation and leaves subscriptions untouched.
- WARP masking traffic did not leave the computer in the shape it was meant to: the first bytes of every masking packet were cut off, and the packet size setting was off by nine bytes. Both fixed.

## Русский

- Профили WireGuard и AmneziaWG теперь можно добавлять. Вставьте содержимое файла `.conf` в то же поле, куда вставляете ссылки: получится обычный профиль — он виден в списке серверов, участвует в «Авто» и показывает пинг. Для AmneziaWG сохраняется маскировка трафика, записанная в файле, поэтому платный профиль ведёт себя так же, как в клиенте, откуда вы его принесли.
- Если в файле есть строки, которые приложение не переносит — например, строка DNS, — оно скажет об этом сразу после импорта, а не оставит вас выяснять позже, почему профиль ведёт себя иначе.
- Профиль WireGuard можно скопировать обратно в виде `.conf` из его меню — чтобы перенести на другое устройство или в другое приложение.
- Отдельные конфиги можно удалить все сразу: в заголовке группы появилась кнопка «Удалить все» — она переспрашивает и не трогает подписки.
- Маскировочный трафик WARP уходил с компьютера не в том виде, в каком задумано: у каждого маскировочного пакета обрезались первые байты, а настройка размера пакета промахивалась на девять байт. Исправлено.

## v0.3.8 — 2026-08-14

## English

- Picking another server now takes effect at once. The app confirmed the choice, but the connections that were already open kept running through the previous server, so a site that checks your address still showed the old country until you turned the VPN off and on again. Those connections are now closed, so everything moves to the server you picked. Whatever you have excluded from the tunnel is left running.
- The same applies to the server list, to the tray menu and to the automatic switch the app makes when a server starts performing badly.
- The core was updated to sing-box 1.13.18.

## Русский

- Выбор другого сервера применяется сразу. Приложение подтверждало выбор, но уже открытые соединения продолжали идти через прежний сервер — сайт проверки адреса показывал прежнюю страну, пока вы не выключите и не включите VPN заново. Теперь такие соединения закрываются, и всё уходит на выбранный сервер. То, что вы исключили из туннеля, продолжает работать.
- Это работает и в списке серверов, и в меню в трее, и при автоматической смене сервера, когда текущий начинает работать плохо.
- Ядро обновлено до sing-box 1.13.18.

## v0.3.7 — 2026-08-14

## English

- More node types connect: AnyTLS, Hysteria v1 and SOCKS are supported, and transports that used to be quietly simplified to a plain connection are now passed on exactly as the subscription describes them. Nodes on the newer Xray transport name no longer disappear from the list either.
- Servers whose parameters a panel writes in a different but equally valid form — the flow value and the TLS fingerprint — are accepted instead of being dropped.
- Your own routing rules work as written. A rule with an address such as `192.168.001.100` used to be handed to the core as typed and could take the whole connection down; and a personal rule for Discord was silently overridden by the built-in Discord split, so the rule existed, showed as enabled and did nothing.
- Link handlers can be turned on again. The switch in settings never took effect: the app was asking for schemes the system side did not know, and the request stopped at the first one.
- Clicking the same invite link a second time works without restarting the app, and importing a list of links now says how many entries were skipped instead of dropping them silently.
- Security: the decision to run with administrator rights, and the paths to the Windows system folders, no longer come from environment variables that any account can rewrite. On a machine where someone had set them, the app could be pointed at a file of their choosing and run it with the rights it holds.
- Security: every line written into the system hosts file is now checked before it is applied.
- Security: if the Windows protected store is unavailable, node passwords and keys are no longer mirrored into the app's ordinary storage in plain text — the app reports the failure instead.
- "Reset WARP" now removes all of its files. It stopped at the first one it could not delete, which left the private key on disk, and the app kept reading it.
- The connection-quality indicator no longer stays on "Excellent" when it has stopped measuring because the PC is under load. It says that measurement is paused.
- DPI bypass: a strategy that has disappeared from the channel no longer stays in the interface showing one name while the engine starts another, and "Apply" after auto-pick no longer leaves the bypass switched off while the app shows it as running.
- "Clear sensitive data" no longer brings the deleted data back on the next start, and a failed state backup or a failed profile-store write is now visible in the app instead of only in a developer console.
- An update check that runs while the network is changing says there is no update only when there is none; it no longer turns "nothing new" into "could not check".
- Installer: reinstalling over an existing copy with a downloaded setup.exe no longer cancels itself, the final screen after uninstalling says the app was removed rather than deployed, and the downgrade guard now also works in silent mode.
- Interface: the portable-storage section, three later settings sections and the confirmation dialog are translated in all 15 languages; labels on accent buttons are readable in light themes; and right-to-left languages mirror the whole interface, including the back arrow and the active menu item.
- The stop log now names which component failed to exit, instead of reporting the same verdict for all three.
- Privacy: the document describing what Ninety connects to now also names the Discord checks that DPI auto-pick makes from your real address.

## Русский

- Подключается больше типов нод: поддержаны AnyTLS, Hysteria v1 и SOCKS, а транспорты, которые раньше молча упрощались до обычного соединения, теперь передаются ровно так, как их описывает подписка. Ноды на новом имени транспорта Xray тоже перестали пропадать из списка.
- Серверы, у которых панель пишет параметры в другой, но столь же корректной форме — значение flow и отпечаток TLS, — принимаются, а не отбрасываются.
- Собственные правила маршрутизации работают так, как записаны. Правило с адресом вида `192.168.001.100` уходило в ядро как есть и могло положить всё подключение, а личное правило для Discord молча перекрывалось встроенным разделением Discord: правило было, показывалось включённым и не делало ничего.
- Обработчики ссылок снова включаются. Переключатель в настройках не срабатывал вообще: приложение запрашивало схемы, которых системная часть не знала, и запрос обрывался на первой же.
- Повторный клик по той же ссылке-приглашению работает без перезапуска приложения, а импорт списка ссылок теперь говорит, сколько записей пропущено, вместо того чтобы молча их выбросить.
- Безопасность: решение о запуске с правами администратора и пути к системным папкам Windows больше не берутся из переменных окружения, которые может переписать любая учётная запись. На машине, где их подменили, приложение можно было направить на чужой файл и запустить его с теми правами, которые у приложения есть.
- Безопасность: каждая строка, которая пишется в системный файл hosts, проверяется перед применением.
- Безопасность: если защищённое хранилище Windows недоступно, пароли и ключи нод больше не дублируются в обычное хранилище приложения открытым текстом — вместо этого приложение сообщает об отказе.
- «Сбросить WARP» удаляет все свои файлы. Раньше сброс останавливался на первом же файле, который не удалось удалить, — приватный ключ оставался на диске, и приложение продолжало его читать.
- Индикатор качества канала больше не держит «Отлично», когда измерения остановлены из-за нагрузки на компьютер. Он так и говорит: замеры на паузе.
- Обход DPI: стратегия, исчезнувшая из канала, больше не остаётся в интерфейсе под одним именем, пока движок запускает другую, а «Применить» после авто-подбора больше не оставляет обход выключенным при включённом виде в приложении.
- «Очистить конфиденциальные данные» больше не возвращает удалённое при следующем запуске, а сбой резервной копии состояния и сбой записи в хранилище профилей теперь видны в приложении, а не только в консоли разработчика.
- Проверка обновления во время смены сети говорит «обновления нет» только тогда, когда его действительно нет, и больше не превращает «ничего нового» в «не удалось проверить».
- Установщик: переустановка поверх уже стоящей копии скачанным setup.exe больше не отменяет сама себя, финальный экран после удаления сообщает, что приложение удалено, а не развёрнуто, и запрет отката на старую версию теперь работает и в тихом режиме.
- Интерфейс: раздел portable-хранилища, три поздних раздела настроек и диалог подтверждения переведены на все 15 языков; подписи на акцентных кнопках читаются в светлых темах; языки с письмом справа налево зеркалят весь интерфейс, включая стрелку «назад» и активный пункт меню.
- В журнале остановки видно, какой именно компонент не завершился, — раньше все три получали один и тот же вердикт.
- Приватность: документ о том, куда обращается Ninety, теперь называет и проверки Discord, которые авто-подбор DPI делает с вашего реального адреса.

## v0.3.6 — 2026-08-13

## English

- A single broken server no longer takes down the whole subscription. If a panel hands out a server whose parameters the core refuses, the core used to fail to start at all — the subscription could not be selected, and none of its hundreds of servers worked. Such servers are now left out, the rest connect as usual, and the app says how many were skipped.
- Servers whose key is written in a different, equally valid encoding now work instead of being lost. Previously they were among the ones that broke the start.
- A subscription saved before this release is repaired on its own: you do not need to add the link again, and the server count on its card now shows what actually goes to the core.
- Large subscriptions no longer freeze the window. With a few hundred servers, switching to a subscription or opening the server list locked the interface for about ten seconds each time; that work is now roughly twenty times cheaper, and a server list that is not on screen is not rebuilt at all.
- Adding a subscription no longer switches to it. The subscription is simply added — when to move to it is your decision, and a live connection is no longer interrupted by an import.
- Deleting a subscription or a profile now asks for confirmation. The delete item sits next to "Refresh", and the link and collected measurements could not be brought back.

## Русский

- Один битый сервер больше не роняет всю подписку. Если панель отдаёт сервер с параметрами, которых ядро не принимает, ядро вообще не запускалось: подписку нельзя было выбрать, и не работал ни один из её сотен серверов. Теперь такие серверы исключаются, остальные подключаются как обычно, а приложение говорит, сколько пропущено.
- Серверы, у которых ключ записан в другой, но столь же корректной форме, теперь работают, а не теряются. Раньше именно они и ломали запуск.
- Подписка, сохранённая до этого обновления, чинится сама: добавлять ссылку заново не нужно, а счётчик серверов на карточке показывает то, что действительно уходит в ядро.
- Большие подписки больше не подвешивают окно. На нескольких сотнях серверов переключение на подписку и открытие списка серверов каждый раз замораживали интерфейс примерно на десять секунд; теперь эта работа примерно в двадцать раз дешевле, а список серверов, которого нет на экране, вообще не пересобирается.
- Добавление подписки больше не переключает на неё. Подписка просто добавляется — когда на неё перейти, решаете вы, и импорт больше не рвёт живое соединение.
- Удаление подписки или профиля теперь спрашивает подтверждение. Пункт удаления стоит рядом с «Обновить», а ссылку и накопленные замеры вернуть было неоткуда.

## v0.3.5 — 2026-08-12

## English

- Settings no longer reconnect when nothing was changed. Clicking into a text or number field and clicking away restarted the connection, even if the value was left exactly as it was.
- DNS is chosen from a list instead of being typed from memory. Remote DNS offers Cloudflare, Google, Quad9 and AdGuard over DoH and DoT; direct DNS offers the system resolver and plain or encrypted servers that work before the tunnel is up. Any other address can still be entered by hand.
- A DNS address that is written incorrectly is refused right there in the settings, with a line saying what is wrong. Until now it was accepted, saved, and broke the connection later, when the reason was no longer obvious.
- The system resolver is gone from the Remote DNS list: through it queries leave the tunnel and the provider sees all of them. It can still be set by hand, and the warning stays.
- Auto-pick of a strategy gives a stable answer. Two runs a few minutes apart could report 2 of 20 and then 10 of 20 on the same connection: when the engine lost the race for its driver between runs, a perfectly good strategy was written off. The engine now gets a second attempt, strategies whose engine never came up are counted and named separately instead of being reported as not working, and the run keeps its own log next to the others, so a result can be checked rather than guessed at.
- Auto-pick checks Discord, not only YouTube. On connections where YouTube opens but Discord does not, it used to approve strategies that leave Discord blocked. All checks now run for every strategy, and a strategy that opens some of them is reported as partial instead of being lumped in with the ones that open nothing.
- The delay shown next to the recommendation is the delay of a single check again, not the sum of all of them.
- "Recommended" on the strategy card now marks what auto-pick actually measured on your connection and says so. It used to be pinned to one profile regardless of any measurement. Until the first run it marks the default profile, as before.
- The auto-pick description says what really happens: which services are checked, that experimental profiles are excluded, and that the run is unavailable in VPN · TUN mode, where every check would go through the tunnel.
- The EXP profile explains itself — that it is experimental, that auto-pick never tries it, and that it is worth checking by hand. Its description also no longer names a strategy version that has since moved on.
- Lists for the system hosts entry and for the service mode now update together with the rest of the bypass data instead of staying behind on an older set.

## Русский

- Настройки больше не переподключают VPN, когда ничего не менялось. Достаточно было щёлкнуть в текстовое или числовое поле и щёлкнуть мимо — соединение перезапускалось, даже если значение осталось прежним.
- DNS выбирается из списка, а не вписывается по памяти. Для DNS через VPN — Cloudflare, Google, Quad9 и AdGuard по DoH и DoT; для прямого DNS — системный резолвер и обычные или шифрованные серверы, которые работают ещё до поднятия туннеля. Любой другой адрес по-прежнему можно ввести вручную.
- Неправильно записанный адрес DNS отклоняется прямо в настройках, со строкой о том, что не так. Раньше он спокойно сохранялся и ломал подключение позже, когда связь с причиной уже терялась.
- Из списка DNS через VPN убран системный резолвер: через него запросы уходят мимо туннеля и провайдер видит их все. Вписать его вручную по-прежнему можно, предупреждение остаётся.
- Авто-подбор стратегии даёт устойчивый ответ. Два прогона с разницей в несколько минут на одном и том же интернете могли показать 2 из 20, а затем 10 из 20: если движок проигрывал гонку за свой драйвер между прогонами, вполне рабочая стратегия записывалась в нерабочие. Теперь у движка есть вторая попытка, стратегии с незапустившимся движком считаются и называются отдельно, а не выдаются за неработающие, и у прогона появился собственный журнал рядом с остальными — результат можно проверить, а не додумывать.
- Авто-подбор проверяет Discord, а не только YouTube. На интернете, где YouTube открывается, а Discord нет, он раньше одобрял стратегии, с которыми Discord остаётся заблокированным. Теперь все проверки проходят для каждой стратегии, а та, что открыла часть из них, так и подписана — вместо того чтобы попасть в одну кучу с теми, что не открыли ничего.
- Задержка рядом с рекомендацией снова означает задержку одной проверки, а не сумму всех.
- «Рекоменд.» на карточке стратегии теперь отмечает то, что авто-подбор реально намерил на вашем интернете, и прямо об этом говорит. Раньше метка была прибита к одному профилю независимо от замеров. До первого прогона она, как и прежде, отмечает профиль по умолчанию.
- Описание авто-подбора говорит, что происходит на самом деле: какие сервисы проверяются, что экспериментальные профили в подбор не входят и что в режиме VPN · TUN подбор недоступен — там все проверки ушли бы через туннель.
- Профиль EXP объясняет сам себя: что он экспериментальный, что авто-подбор его не пробует и что его стоит проверить вручную. Из описания заодно убрана версия набора стратегий, которая давно сменилась.
- Списки для записи в системный hosts и для сервисного режима обновляются вместе с остальными данными обхода, а не отстают на более старый набор.

## v0.3.4 — 2026-08-12

## English

- Discord voice works again with the DPI bypass on. Joining a channel left the ping stuck at thousands of milliseconds on every strategy, because the bypass was quietly skipping voice traffic — it only ever handled the parts of Discord that carry a site address. Text, the app itself and everything else kept working, which is why it looked like the strategies were fine. This affected users whose VPN server is set by name rather than by address, and it started with v0.3.0.
- The game filter works again — extra traffic for games was being skipped for the same reason.
- Protecting the connection to your own VPN server from the bypass now really works. It was set up by server name, and that name never appears in the traffic Ninety sends, so the protection could not match anything. Ninety now looks the address up and protects that.
- "Discord outside the tunnel" now keeps voice outside the tunnel too. The setting only moved the parts of Discord that carry a site address, while voice went through the VPN — the opposite of what the setting promises.
- Auto-pick of a strategy now measures what it claims to. After the first working strategy every following one reused an already open connection, so almost everything came back as passed and the recommendation was close to random. Each strategy is now checked from scratch, Discord is checked before YouTube, a strategy whose engine failed to start is no longer counted as working, and the run refuses to start in VPN · TUN mode, where every check would go through the tunnel anyway.
- Auto-pick puts the bypass back the way it found it. The run stops the bypass to test strategies one by one, and afterwards it stayed off while the app still showed it as running.

## Русский

- Голос в Discord снова работает при включённом DPI-обходе. При заходе в канал пинг застревал на нескольких тысячах миллисекунд, и так на каждой стратегии: обход молча пропускал голосовой трафик мимо себя и обрабатывал только те части Discord, в которых есть адрес сайта. Текст, само приложение и всё остальное при этом работали — поэтому казалось, что со стратегиями всё в порядке. Задевало тех, у кого сервер VPN задан именем, а не адресом; появилось в v0.3.0.
- Снова работает игровой фильтр — дополнительный обход для игр пропускался по той же причине.
- Защита соединения с вашим VPN-сервером от обхода теперь действительно работает. Она была настроена по имени сервера, а это имя в отправляемом трафике не появляется, так что защищать ей было нечего. Теперь Ninety определяет адрес сервера и защищает его.
- «Discord мимо туннеля» уводит мимо туннеля и голос. Раньше настройка уводила только те части Discord, в которых есть адрес сайта, а голос шёл через VPN — то есть ровно наоборот тому, что настройка обещает.
- Авто-подбор стратегии наконец измеряет то, что заявляет. После первой сработавшей стратегии все следующие пользовались уже открытым соединением, поэтому «проходило» почти всё, а рекомендация была почти случайной. Теперь каждая стратегия проверяется с нуля, Discord проверяется раньше YouTube, стратегия с не запустившимся движком больше не считается рабочей, а сам прогон не начинается в режиме VPN · TUN, где все проверки всё равно ушли бы через туннель.
- Авто-подбор возвращает обход в то состояние, в котором его застал. Прогон выключает обход, чтобы перебирать стратегии по одной, и после него обход оставался выключенным, хотя приложение показывало его работающим.

## v0.3.3 — 2026-08-11

## English

- The installer can be used again. Choosing the install location buried the wizard under an endless stream of "Distribution corrupted: invalid opcode" boxes that appeared faster than they could be dismissed, and there was no way past that screen. Unattended updates were never affected — they skip those pages.
- Installation now finishes. Once the files were written the wizard stopped on a full progress bar with nothing to press: the button that completes it was hidden and never came back. It is there again, and the bar states the finished value instead of stopping at 99%.
- Russian labels on the installer buttons are readable. "Далее", "Установить", "Отмена", "Изменить" and the window controls had turned into rows of empty boxes.
- On the licence page the reading position marker sits on its track, and the track can be dragged with the mouse — until now the licence could only be moved with the keyboard.
- The finish page offers its options again: run Ninety and add a desktop shortcut were pushed off the right edge as unreadable slivers.
- The Start menu page now looks like the rest of the installer instead of a stock white wizard page.
- A long server name is no longer cut short on the main screen when there is room for it.
- The licences of the components shipped with Ninety are installed alongside the app.

## Русский

- Установщиком снова можно пользоваться. На выборе места установки окно заваливало бесконечным потоком ошибок «Дистрибутив поврежден: недопустимый код» — они появлялись быстрее, чем закрывались, и пройти этот экран было нельзя. Автоматических обновлений это не касалось: они эти страницы пропускают.
- Установка доходит до конца. После записи файлов мастер замирал на заполненной шкале, и нажать было нечего: кнопка, которая его завершает, оказывалась скрытой и не возвращалась. Теперь она на месте, а шкала показывает завершённое значение вместо 99%.
- Русские надписи на кнопках установщика читаются. «Далее», «Установить», «Отмена», «Изменить» и кнопки окна до этого были рядами пустых квадратов.
- На странице лицензии указатель позиции стоит на своей дорожке, а саму дорожку можно тянуть мышью — до сих пор лицензия листалась только с клавиатуры.
- Финальная страница снова предлагает свои настройки: «Запустить Ninety» и «Добавить ярлык на рабочий стол» уезжали за правый край нечитаемыми полосками.
- Страница выбора папки в меню «Пуск» больше не выглядит стоковым белым окном посреди установщика.
- Длинное имя сервера на главном экране больше не обрезается, когда для него есть место.
- Лицензии компонентов, которые поставляются с Ninety, теперь ставятся вместе с приложением.

## v0.3.2 — 2026-08-10

## English

- "Nodes" is now "Servers", and the screen was rebuilt around reading it quickly. Instead of cards there is a dense list: country, name, address, transport and latency line up in columns, so a long list can be scanned by eye. Any column sorts, including across countries — you can line up every server by latency or by transport at once, regardless of where it is.
- Search over servers. It covers the name, the address, the transport and the country, and it says how many of the whole list matched.
- Servers can be grouped by country or shown as one flat list. In the flat list sorting applies to everything at once; grouped by country, each country carries its own best latency.
- Favourite servers. The star pins a server to the top of the list, and favourites are kept per subscription, so two subscriptions do not mix.
- Recommendations appear right after the first measurement pass and explain themselves: lowest latency, steady channel, resilient transport. "Auto" shows which server it would pick. The scoring uses only the measurements the app has taken itself — the panel explaining it says so plainly, and before the first pass it says there is nothing to score yet rather than inventing a ranking.
- A spread graph per server. The app now keeps the history of its own probes, so the line shows whether a server holds a steady latency or jumps around — the engine itself only ever reports the last result.
- Before the first measurement the screen says so and offers to measure, instead of showing a list of dashes.
- The list is fully keyboard-driven: arrows move between servers, Enter selects, F toggles the favourite. Pressing Enter on the star or on the row menu no longer switches the server by accident.
- Profiles were rebuilt to match: one row per profile, with traffic, expiry and server count where they can be compared at a glance. Clicking anywhere on the row activates the profile.
- Adding a profile is now a single field. Paste a subscription link, a protocol link, a list of configs or the contents of a .toml — the type is recognised as you type and shown right there; nothing has to be chosen by hand. Name and auto-update moved under an "advanced" line, out of the way.
- The interface of all this speaks all 15 languages, not just Russian and English.

## Русский

- «Ноды» стали «Серверами», а сам раздел перестроен под быстрое чтение. Вместо карточек — плотный список: страна, имя, адрес, транспорт и задержка стоят по столбцам, и длинный список можно просматривать глазами. Сортировка работает по любому столбцу, в том числе поперёк стран: можно выстроить все серверы по задержке или по транспорту сразу, независимо от того, где они находятся.
- Поиск по серверам. Ищет по имени, адресу, транспорту и стране и показывает, сколько из всего списка подошло.
- Серверы можно группировать по странам или показать одним сплошным списком. В сплошном сортировка действует на всё сразу, в группировке у каждой страны своя лучшая задержка.
- Избранные серверы. Звезда поднимает сервер наверх списка, и избранное хранится отдельно для каждой подписки — две подписки не перемешиваются.
- Рекомендации появляются сразу после первого прохода замеров и объясняют себя: самая низкая задержка, ровный канал, устойчивый транспорт. «Авто» показывает, какой сервер выбрал бы он. Оценка строится только на замерах, которые приложение сделало само, — об этом прямо написано в поясняющей панели, а до первого прохода она честно говорит, что оценивать нечего, вместо выдуманного рейтинга.
- График разброса у каждого сервера. Приложение теперь хранит историю собственных замеров, поэтому линия показывает, держит ли сервер ровную задержку или скачет, — сам движок сообщает только последний результат.
- До первого замера раздел так и говорит и предлагает замерить, а не показывает список прочерков.
- Списком можно управлять с клавиатуры: стрелки ходят между серверами, Enter выбирает, F ставит звезду. Enter на звезде или на меню строки больше не переключает сервер по случайности.
- Раздел «Профили» перестроен так же: одна строка на профиль, а трафик, срок и число серверов стоят там, где их можно сравнить взглядом. Нажатие в любом месте строки делает профиль активным.
- Добавление профиля свелось к одному полю. Вставьте ссылку на подписку, ссылку протокола, список конфигов или содержимое .toml — тип распознаётся по мере ввода и показывается тут же, выбирать его руками не нужно. Название и автообновление ушли под строку «дополнительно», чтобы не мешать.
- Всё это говорит на всех 15 языках, а не только на русском и английском.

## v0.3.1 — 2026-08-09

## English

- Nodes with non-Latin names and passwords arrive intact. In VMess and Shadowsocks links the name used to turn into mojibake, and a password with non-Latin characters was mangled byte by byte — the node then failed authentication without a word.
- TUIC nodes with a self-signed certificate connect. The link says the certificate is not to be verified; the app simply did not read that field.
- VMess nodes that use the xhttp transport work. They were assembled as a different protocol, so both engines started, the interface showed a connection, and the node stayed dead.
- NaiveProxy nodes addressed by IPv6 connect — the address for the client was built without brackets and could not be parsed.
- Routing rules keep national domains. A rule for a .рф address — and for any other non-Latin or digit-bearing zone — silently disappeared on save. "Keyword" now accepts a word instead of demanding a full domain, which is what that mode is for.
- The active server is excluded from the blocking bypass before the connection starts, not after it succeeds: the very first handshake with a new server is no longer mangled. A server whose name consists of hex letters is no longer mistaken for an address, which used to leave the previous server excluded instead of the current one.
- Portable: changing the storage passphrase re-encrypts everything it protects. Profiles, the recovery copy and the WARP registration used to stay locked under the old passphrase and became unreachable. A wrong passphrase is now rejected on entry instead of quietly starting a second key.
- Settings come back when the browser-engine storage is wiped but the profiles survive. The connection mode, strict tunnel, kill switch, routing rules, bypass settings and theme were silently replaced by defaults — including on autostart.
- Strict mode refuses a node whose separate download channel is given by name rather than by address. That name was resolved through the system DNS, outside the tunnel.
- A subscription refreshed through the tunnel no longer asks the system DNS for the panel address: the refresh works where DNS is blocked, and the panel is not exposed to the provider.
- Declining the administrator prompt at startup switches to system proxy mode. The app used to stay in TUN, which cannot work without those rights, so the autostart ended in silence or in a second prompt.
- An update restores the connection even when it was still coming up at the moment the update started.
- Profiles survive damage better: a corrupt file no longer overwrites the only good backup, and a node added in the first moments after launch no longer disappears.
- The window no longer freezes while saving in a Portable build protected by a passphrase.
- The blocking bypass is steadier: toggling "Discord past the VPN" twice in a row no longer leaves it switched off, and turning it off while its lists are updating no longer reports an error that did not happen.
- Smaller fixes: the DNS watchdog no longer overwrites an address you have just set by hand; the local proxy port and the control port can no longer be given the same value, which used to fail with no explanation; the channel indicator says the computer is busy instead of freezing on its last measurement; and traffic is counted per source instead of being pooled together.

## Русский

- Узлы с не-латинскими именами и паролями приезжают целыми. В ссылках VMess и Shadowsocks имя превращалось в крякозябры, а пароль с не-латинскими символами перевирался побайтово — после этого узел не проходил проверку пароля и молчал о причине.
- Узлы TUIC с самоподписанным сертификатом подключаются. В ссылке написано, что сертификат проверять не нужно, — приложение просто не читало это поле.
- Работают узлы VMess с транспортом xhttp. Раньше они собирались как другой протокол: оба движка запускались, интерфейс показывал подключение, а узел был мёртв.
- Подключаются узлы NaiveProxy с адресом IPv6 — адрес для клиента собирался без скобок и не разбирался.
- Правила маршрутизации сохраняют национальные домены. Правило для адреса в зоне .рф — как и для любой другой не-латинской зоны или зоны с цифрой — молча пропадало при сохранении. «Ключевое слово» теперь принимает слово, а не требует полный домен, ради чего этот режим и нужен.
- Активный сервер исключается из обхода блокировок до начала подключения, а не после его успеха: первое же соединение с новым сервером больше не портится. Сервер, чьё имя состоит из hex-букв, больше не принимается за адрес — из-за этого в исключениях оставался предыдущий сервер вместо текущего.
- Портативная версия: смена пароля хранилища перешифровывает всё, что им защищено. Раньше профили, резервная копия и регистрация WARP оставались под старым паролем и становились недоступны. Неверный пароль теперь отклоняется при вводе, а не заводит молча второй ключ.
- Настройки возвращаются, если хранилище браузерного движка стёрли, а профили уцелели. Режим подключения, строгий туннель, kill switch, правила маршрутизации, настройки обхода и тема молча заменялись значениями по умолчанию — в том числе при автозапуске.
- Строгий режим отклоняет узел, у которого отдельный канал загрузки задан именем, а не адресом. Это имя резолвилось через системный DNS, мимо туннеля.
- Обновление подписки через туннель больше не спрашивает адрес панели у системного DNS: обновление работает там, где DNS блокируют, и сама панель не показывается провайдеру.
- Отказ от запроса прав администратора при запуске переводит в режим системного прокси. Раньше приложение оставалось в TUN, который без этих прав не работает, и автозапуск заканчивался тишиной или вторым запросом.
- Обновление приложения возвращает соединение, даже если в момент запуска обновления оно ещё только устанавливалось.
- Профили лучше переживают повреждения: испорченный файл больше не затирает единственную рабочую копию, а узел, добавленный в первые мгновения после запуска, не исчезает.
- Окно не подвисает при сохранении в портативной версии, защищённой паролем.
- Обход блокировок устойчивее: двойное переключение «Discord мимо VPN» больше не оставляет его выключенным, а выключение обхода во время обновления его списков больше не показывает ошибку, которой не было.
- Мелочи: сторож DNS больше не перетирает адрес, который вы только что задали вручную; порт локального прокси и порт панели управления больше нельзя сделать одинаковыми — раньше это давало отказ без объяснения; индикатор канала сообщает, что компьютер загружен, вместо того чтобы замереть на прошлом измерении; трафик считается по каждому источнику отдельно.

## v0.3.0 — 2026-08-07

## English

- Ninety has moved to its own core. It used to run a third-party build of sing-box that had fallen half a year behind the original; the core is now built from our branch of the current 1.13.16, and the engine for xhttp nodes was updated to 26.7.28. The exact core version is shown in "About".
- The "Add extra bytes" and "Vary the case of the site name" switches in the blocking bypass section now actually do something. The previous core did not understand that setting and silently ignored it: the switch looked enabled while the server received exactly what it would have without it. They are still not applied to Reality nodes, where they break the connection.
- The "Register" button in the WARP section works with providers that do not let requests reach Cloudflare directly. Before it silently did nothing, and WARP stayed out of reach for everyone without a registration from an earlier version. After a successful registration the button disappears; entering a WARP+ key brings it back.
- Excluding the active server from the blocking bypass finally takes effect. It used to apply only to the last part of the strategy, while the connection to the server runs through a different one — the protection looked enabled and did nothing.
- The connection comes up even when a provider cuts off encrypted DNS as a class rather than one address at a time. Plain name servers now sit below the encrypted ones: less private, but much harder to kill.
- Country site lists are taken from their original source. In the previous mirror the Turkish list mistakenly held Russian government domains, and the Belarusian one did not exist at all — the app had been downloading a file that was never there. Ready-made country lists now cover Russia, China and Iran; for Turkey and Belarus, routing by top-level domain remains.
- When a configuration is exported, nodes that only work through the built-in bridge are skipped with a message saying how many and why. They used to drop out silently and the exported file came out incomplete.
- Settings section names and every hint were rewritten in plain language. "TLS fragmentation" became "Bypass blocking by domain", "Multiplexer" became "Combining connections", and the descriptions lost the terms that told nothing to the person deciding whether to flip a switch.
- The log no longer reports as tunnel errors the disconnects caused by a program on the same computer — a browser or a game that closed a connection early.
- The tray icon tooltip is no longer cut off in the middle.

## Русский

- Ninety перешёл на собственное ядро. Раньше использовалась чужая сборка sing-box, которая отстала от оригинала на полгода; теперь ядро собирается из нашей ветки актуальной версии 1.13.16, а движок для xhttp-узлов обновлён до 26.7.28. Точная версия ядра видна в разделе «О программе».
- Переключатели «Добавлять лишние байты» и «Менять регистр в имени сайта» в разделе обхода блокировок теперь действительно работают. Прежнее ядро эту настройку не понимало и молча игнорировало: переключатель стоял включённым, а к серверу уходило то же самое, что и без него. К узлам Reality эти два приёма по-прежнему не применяются — там они ломают соединение.
- Кнопка «Зарегистрировать» в разделе WARP работает у провайдеров, которые не пропускают запросы к Cloudflare напрямую. Раньше она молча ничего не делала, и WARP оставался недоступен всем, у кого не было регистрации с прошлых версий. После успешной регистрации кнопка исчезает; вернуть её можно, введя ключ WARP+.
- Исключение активного сервера из обхода блокировок наконец действует. Раньше оно применялось только к последней части стратегии, а соединение с сервером идёт через другую — защита выглядела включённой и при этом не работала.
- Подключение поднимается даже тогда, когда провайдер отрезает шифрованный DNS целиком, а не по одному адресу. Ниже шифрованных серверов имён добавлены обычные: они менее скрытны, зато живучее.
- Списки сайтов по странам берутся из первоисточника. В прежнем зеркале турецкий список по ошибке содержал российские государственные домены, а белорусского не существовало вовсе — приложение качало файл, которого там никогда не было. Готовые страновые списки теперь есть для России, Китая и Ирана; для Турции и Беларуси остаётся отправка по домену верхнего уровня.
- При выгрузке конфигурации узлы, работающие только через встроенный мост, пропускаются с сообщением, сколько их и почему. Раньше они молча выпадали, и выгруженный файл оказывался неполным.
- Названия разделов настроек и все подсказки переписаны обычным языком. Вместо «TLS-фрагментация» — «Обход блокировки по домену», вместо «Мультиплексор» — «Объединение соединений»; из описаний ушли термины, которые ничего не говорили тому, кто решает, включать переключатель или нет.
- В журнале больше не показываются как ошибки туннеля обрывы, которые устроила программа на этом же компьютере — браузер или игра, закрывшая соединение раньше времени.
- Подсказка значка в трее больше не обрезается на середине.

## v0.2.60 — 2026-08-05

## English

- If the app terminates abnormally, the system proxy is switched off on the way out. Before that a crash could leave Windows pointing at a port nobody listens on, and the computer stayed without internet until the setting was cleared by hand.
- A connection cancelled halfway now really stops everything it had already started. Engine processes left running and ports still held by them used to make the next attempt fail.
- The connect button can no longer stay blocked for good. If an operation was lost — the window closed or froze at the wrong moment — the lock is released after a minute and a half instead of holding until a restart.
- The window no longer freezes while the app takes stock of itself: reading the connection state, the diagnostics and the kill switch moved off the interface thread. Refreshing all pings with the kill switch on gained the most — that is where the delay was visible.
- The traffic counter stops together with the connection instead of reconnecting to whatever occupies the port afterwards.
- The connection log costs less while it is open: it is not rebuilt every two seconds when nothing has changed, addresses in it are highlighted without breaking the markup, and the file no longer gets tangled when the app and the engine write to it at the same time.
- Opening the routing rules again no longer leaves the previous copy of that screen in memory.
- The DNS check no longer sends requests to service addresses that cannot be a resolver.
- A domain added to the bypass exclusions is checked: a multi-line value can no longer add entries you did not type.
- A failure to switch the system proxy off on exit is recorded in the log instead of being lost silently.
- The blocking bypass engine is updated, and its version is now read from the engine file itself.

## Русский

- При аварийном завершении приложения системный прокси снимается на выходе. Раньше падение могло оставить Windows с настройкой на порт, который никто не слушает, и компьютер оставался без интернета, пока её не уберут вручную.
- Отменённое на полпути подключение действительно останавливает всё, что успело запуститься. Оставшиеся процессы движка и занятые ими порты раньше роняли следующую попытку.
- Кнопка подключения больше не может заблокироваться навсегда. Если операция потерялась — окно закрыли или подвесили в неудачный момент — блокировка снимается через полторы минуты, а не держится до перезапуска.
- Окно больше не подвисает, пока приложение снимает своё состояние: опрос подключения, диагностики и kill switch ушёл с потока интерфейса. Больше всего выиграло обновление всех пингов при включённом kill switch — именно там задержка была заметна.
- Счётчик трафика останавливается вместе с подключением, а не переподключается к тому, что заняло порт после него.
- Открытый журнал подключения обходится дешевле: он не перестраивается каждые две секунды, если ничего не изменилось, адреса в нём подсвечиваются без порчи разметки, а сам файл больше не путается, когда в него пишут приложение и движок одновременно.
- Повторное открытие правил маршрутизации больше не оставляет в памяти прошлую копию этого экрана.
- Проверка DNS больше не отправляет запросы на служебные адреса, которые резолвером быть не могут.
- Домен, добавленный в исключения обхода, проверяется: многострочным значением уже нельзя добавить записи, которых вы не вводили.
- Неудачное снятие системного прокси при выходе попадает в журнал, а не теряется молча.
- Обновлён движок обхода блокировок, а его версия теперь читается из самого файла движка.

## v0.2.59 — 2026-08-04

## English

- A new version is now visible while the window sits in the tray: the tray icon gets a mark, hovering over it or right-clicking checks for an update straight away, and the scheduled check runs every half hour instead of every two hours. Before that a release could stay unnoticed for hours with the window minimised.
- Mullvad Browser is recognised again. Since v0.2.45 the privacy screen said the browser was not found even when it was installed: Ninety demanded a digital signature on a file that Mullvad ships without one. If a found install is still rejected, the screen now says so instead of claiming the browser is missing.
- A TrustTunnel server added from a tt:// link keeps its certificate. Without it the connection failed on the security check, while the same server imported from a .toml file worked.
- The connect button no longer gets stuck on "Disconnecting". If a reconnection arrived at the very moment of a stop, the interface could stay in that state until the next click.
- Escape or a click outside the update window closes it for now instead of hiding that version for good. Only the "Later" button remembers the choice between launches.
- The DPI bypass auto-test no longer freezes the rest of its screen while it runs, and the strategy set cannot be replaced underneath it.
- Updating the hosts list and the ipset database no longer downloads the whole strategy package when the current one is already up to date.
- The connection log keeps to its size limit even while the VPN is off, and the app no longer refuses to start over a missing tray icon.

## Русский

- Новую версию теперь видно, когда окно свёрнуто в трей: на значке появляется метка, наведение на него и правый клик проверяют обновление сразу, а плановая проверка идёт раз в полчаса вместо двух часов. Раньше со свёрнутым окном релиз мог оставаться незамеченным часами.
- Mullvad Browser снова определяется. С версии 0.2.45 раздел «Приватность» писал «не найден» даже на установленном браузере: Ninety требовал цифровую подпись у файла, который Mullvad выпускает без неё. Если найденная установка всё же отклонена, экран теперь так и говорит, а не выдаёт её за отсутствующую.
- Сервер TrustTunnel, добавленный по ссылке tt://, сохраняет свой сертификат. Без него подключение падало на проверке безопасности, тогда как тот же сервер из файла .toml работал.
- Кнопка подключения больше не залипает в состоянии «Отключение». Если переподключение приходило ровно в момент остановки, интерфейс мог остаться в нём до следующего клика.
- Escape и клик мимо окна обновления закрывают его на сейчас, а не прячут эту версию навсегда. Запоминает выбор между запусками только кнопка «Позже».
- Автотест DPI-обхода больше не подвешивает остальную часть своего раздела на время прогона, а набор стратегий нельзя подменить прямо под ним.
- Обновление списка hosts и базы ipset больше не скачивает весь пакет стратегий, если текущий уже актуален.
- Журнал подключения соблюдает свой предел размера и при выключенном VPN, а отсутствие значка в трее больше не мешает приложению запуститься.

## v0.2.58 — 2026-08-04

## English

- The connection log reads as one list again. Lines written by the app itself — mode switches, stops, restarts of the core — had no time and no level of their own and were stuck onto the previous line from the engine. They are now ordinary entries: with a timestamp, with a level, and picked up by the level filter.
- The log no longer fills up with reports about connections that your own programs closed. A browser or a game that drops a connection first is normal and is no longer shown as an error.
- Country lookups that the core makes for itself are hidden from the log together with their responses (the stray "429" and "404" lines). Ninety determines the IP and the country on its own, so those attempts changed nothing.
- Profiles that switch off the server certificate check are marked in the list, with an explanation of what exactly is disabled.
- Fake DNS is applied only in TUN mode. In the proxy modes it used to be written into the configuration as well, where it could break the opening of sites.
- Autostart no longer starts the app with administrator rights when the app lives in a folder any user can write to — a portable copy or an install "for me only". For those copies a TUN connection now asks for the Windows confirmation.
- The system hosts file is edited in place: its access rights and your line endings are preserved, and nothing is left next to it.
- A vless:// link without an identifier is rejected with a clear error instead of being saved as a profile that cannot connect.
- Skipped connection quality checks are recorded in the log, are kept out of the graph, and are not repeated more often than intended.
- A service command-line key can no longer erase saved profiles and the settings backup.

## Русский

- Журнал подключения снова читается одним списком. Строки самого приложения — смена режима, остановки, перезапуски ядра — не имели ни своего времени, ни уровня и прилипали к предыдущей строке движка. Теперь это обычные записи: со временем, с уровнем и с работающим фильтром по уровню.
- Журнал больше не забивается сообщениями о соединениях, которые закрыли ваши же программы. Браузер или игра, оборвавшие соединение первыми, — это норма, и ошибкой это больше не показывается.
- Запросы страны, которые ядро делает для себя, скрыты из журнала вместе с их ответами (одиночные строки «429» и «404»). IP и страну Ninety определяет сам, и на эти попытки ничего не завязано.
- Профили с отключённой проверкой сертификата сервера помечены в списке, с пояснением, что именно отключено.
- Fake DNS применяется только в режиме TUN. В режимах прокси он тоже попадал в конфигурацию, где мог ломать открытие сайтов.
- Автозапуск больше не поднимает приложение с правами администратора, если оно лежит в папке, доступной на запись обычному пользователю, — портативная копия или установка «только для меня». Для таких копий подключение в режиме TUN теперь спрашивает подтверждение Windows.
- Системный файл hosts правится на месте: сохраняются его права доступа и ваши переводы строк, рядом ничего не остаётся.
- Ссылка vless:// без идентификатора отклоняется с понятной ошибкой, а не сохраняется профилем, который не может подключиться.
- Пропущенные проверки качества связи попадают в журнал, не искажают график и не повторяются чаще, чем задумано.
- Служебный ключ командной строки больше не может стереть сохранённые профили и резервную копию настроек.

## v0.2.57 — 2026-08-04

## English

- The connection now restores itself when the core crashes. Previously the tunnel simply closed and had to be started again by hand.
- Under a fully loaded computer (video rendering, a game, a build) the app no longer mistakes a local resource shortage for a network problem and no longer answers it with server switches and reconnects. Network processes also get a higher priority so they are not starved of CPU.
- An available update is visible again while the window sits in the tray: an entry in the tray menu and the version in the icon tooltip. "Later" no longer hides the update for good — it stays available from the tray.
- Profiles and subscriptions now really reach the protected storage. Writing to it did not work and the data stayed in the clear; the first launch of this version migrates it and removes the plain copies.
- Cancelling a connection could leave engine processes running, after which the app refused to connect again.
- Passwords containing a colon in Shadowsocks and TUIC links are read correctly.
- The insecure parameter in Hysteria2 links is no longer ignored.
- Turning the blocking bypass off no longer freezes the window for several seconds.
- vless:// and the other links are released correctly when the app is moved to another folder.
- The update check no longer stays disabled until the app is restarted because of an internal error.

## Русский

- Подключение восстанавливается само, если ядро упало. Раньше туннель просто закрывался и подключаться приходилось вручную.
- Под полной загрузкой компьютера (рендер видео, игра, сборка проекта) приложение больше не принимает нехватку ресурсов компьютера за проблему сети и не лечит её сменой сервера и переподключением. Сетевым процессам поднят приоритет, чтобы им хватало процессора.
- Обновление снова заметно, когда окно свёрнуто в трей: пункт в меню трея и версия в подсказке при наведении на иконку. «Позже» больше не прячет обновление насовсем — оно остаётся доступным в трее.
- Профили и подписки действительно попадают в защищённое хранилище. Запись в него не работала, и данные оставались в открытом виде; при первом запуске этой версии они переносятся, а открытые копии удаляются.
- Отмена подключения могла оставить рабочие процессы запущенными — после этого приложение отказывалось подключаться снова.
- Пароли с двоеточием в ссылках Shadowsocks и TUIC читаются корректно.
- Параметр insecure в ссылках Hysteria2 больше не игнорируется.
- Выключение обхода блокировок больше не подвешивает окно на несколько секунд.
- Ссылки vless:// и остальные освобождаются корректно, если приложение переместили в другую папку.
- Проверка обновлений больше не выключается до перезапуска приложения из-за внутренней ошибки.

## v0.2.56 — 2026-08-03

## English

- Switching the connection mode or changing a setting while the VPN is on no longer ends with "Could not disconnect / network cleanup was not confirmed". The reconnect used to lose ownership of the operation the moment the old connection was stopped, so the new one was refused before it could start. Automatic recovery after a core failure was failing for the same reason and now goes through as well.
- The connection log no longer fills up with availability reports for servers you are not connected through. Only the active server is shown; the full log file on disk is unchanged and "Copy" still returns all of it.
- Release notes in the update window are shown as clean text instead of raw markup.

## Русский

- Смена режима подключения и изменение настроек при включённом VPN больше не заканчиваются ошибкой «Не удалось отключить / Очистка сетевых компонентов не подтверждена». Переподключение теряло право на операцию сразу после остановки прежнего соединения, и новое отклонялось, не успев начаться. По той же причине не срабатывало автоматическое восстановление после сбоя ядра — теперь оно тоже проходит.
- Журнал подключения больше не забивается отчётами о доступности серверов, через которые вы не подключены. Показывается только активный сервер; сам файл журнала на диске не изменился, и кнопка «Копировать» по-прежнему отдаёт его целиком.
- Заметки к обновлению в окне обновления показываются обычным текстом, без символов разметки.

## v0.2.55 — 2026-08-03

## English

- The connection log now records why a reconnect failed and at which stage. Switching the connection mode and automatic reconnects previously left no trace when the new connection could not be brought up, so an error on screen had nothing behind it in the log.
- A stop that was handed over to another operation is recorded as such instead of being reported as an unconfirmed cleanup.

## Русский

- Журнал подключения теперь фиксирует, почему и на каком этапе не удалось переподключиться. Смена режима подключения и автоматические переподключения раньше не оставляли следа, если новое соединение не удавалось поднять, и ошибка на экране ничем не подкреплялась в журнале.
- Остановка, перехваченная другой операцией, записывается именно так, а не выдаётся за неподтверждённую очистку.

## v0.2.54 — 2026-08-03

## English

- Switching the connection mode or the active source no longer cuts other applications off the network while the tunnel is being replaced. The block was applied even when leak protection was turned off.
- IPv6 traffic now goes through the tunnel in TUN mode. Applications that resolve names themselves could previously reach the internet over IPv6 outside the tunnel and expose the real address.
- The connection log now records why a disconnect could not be completed, so a "cleanup not confirmed" message can be traced to the component that held it up.

## Русский

- Переключение режима подключения и смена активного источника больше не отрезают остальные приложения от сети на время замены туннеля. Блокировка ставилась даже при выключенной защите от утечек.
- Трафик IPv6 в режиме TUN теперь идёт через туннель. Приложения с собственным резолвером могли выходить в интернет по IPv6 мимо туннеля и раскрывать реальный адрес.
- Журнал подключения теперь фиксирует, почему не удалось завершить отключение: сообщение о неподтверждённой очистке можно связать с конкретным компонентом.

## v0.2.53 — 2026-08-03

## Русский

- Переключение источника и режимов подключения стало устойчивее после обновления подписки: исчезнувшая запомненная нода сбрасывается только на явный Auto или единственный доступный маршрут, без подмены произвольной нодой.
- Включение System Proxy теперь проверяет актуальную точку runtime и поколение процесса, а выключение не зависит от endpoint.
- Таймаут внешнего geo-сервиса больше не превращается в ложную ошибку подключения.
- Убрано агрессивное автоматическое восстановление dataplane: Ninety больше не перезапускает ту же конфигурацию и не инициирует скрытую смену узла при проблемах соединения; защита WFP, System Proxy и TUN сохранена.

## English

- Source switching and connection modes are more reliable after a subscription refresh: a missing remembered node falls back only to explicit Auto or the sole available route, never to an arbitrary node.
- Enabling System Proxy now validates the current runtime endpoint and process generation, while disabling it no longer depends on an endpoint.
- External geo-service timeouts no longer appear as false connection failures.
- Removed aggressive automatic dataplane recovery: Ninety no longer restarts the same configuration or silently switches nodes when a connection has problems; WFP, System Proxy, and TUN protection remain in place.

## v0.2.52 — 2026-08-03

## Русский

- Переключение активного источника стало стабильнее: Ninety ждёт полной готовности нового runtime и его топологии, корректно переживает задержку URLTest и больше не откатывает рабочее подключение из-за первой неполной проверки.
- Исправлено восстановление выбранного сервера после обновления подписки: старые значения `proxy`/`auto` безопасно приводятся к текущей структуре подписки без неожиданной подмены ручного выбора.
- Мониторинг соединений снова показывает данные Clash без ложных системных соединений; предупреждения об ограничениях внешнего geo-провайдера не выдаются за ошибку подключения.

## English

- Active source switching is more reliable: Ninety waits for the new runtime and its complete topology, handles delayed URLTest convergence, and no longer rolls back a healthy connection because of an incomplete first check.
- Fixed remembered server restoration after subscription updates: legacy `proxy`/`auto` values are safely normalized to the current subscription shape without unexpectedly replacing a manual choice.
- The connection monitor is back to showing Clash connections without misleading OS-only entries; external geo-provider rate limits are kept as non-fatal log noise instead of connection failures.

## v0.2.51 — 2026-08-03

## Русский

- Усилена проверка готовности runtime: proxy endpoint принимается только после подтверждения готовности и привязывается к конкретному поколению runtime.
- Исправлено переключение VPN-источника при активном соединении: успешный reconnect теперь корректно передаёт результат через очередь до проверки dataplane, поэтому рабочий целевой runtime не откатывается ошибочно.
- Добавлены regression-тесты для цепочки reconnect → verifier → rollback и безопасное логирование переключения источника без чувствительных данных.

## English

- Strengthened runtime readiness validation: the proxy endpoint is accepted only after readiness is confirmed and is bound to the specific runtime generation.
- Fixed VPN source switching while already connected: successful reconnects now propagate their result through the queue before dataplane verification, preventing healthy target runtimes from being rolled back incorrectly.
- Added regression coverage for reconnect → verifier → rollback orchestration and privacy-safe source-switch diagnostics.

## v0.2.50 — 2026-08-02

## English

- Improved VPN source switching: readiness checks now use the control API only for control traffic and a dedicated dataplane endpoint for connectivity probes, preventing a healthy new connection from being mistaken for a failure and rolled back.
- Bound health and quality checks to the active runtime generation, so stale probes cannot affect a newer connection; recovery and reconnection now behave more predictably.
- Enabled process lookup by default so application-specific routing works out of the box, while preserving an explicit opt-out.
- Improved update delivery during brief mirror failures by retrying transient transfer errors.

## Русский

- Улучшено переключение VPN-источников: проверки готовности используют Clash API только для управления, а отдельную точку dataplane — для проверки соединения; здоровое новое подключение больше не ошибочно считается сломанным и не откатывается.
- Проверки здоровья и качества привязаны к текущему поколению runtime, поэтому устаревшая проба не влияет на новое подключение; восстановление и реконнекты стали предсказуемее.
- Поиск процессов включён по умолчанию, поэтому маршрутизация по приложениям работает сразу; явное отключение сохранено.
- Доставка обновлений стала устойчивее к кратковременным сбоям зеркала.

## v0.2.49 — 2026-08-02

## Русский

- Устранено последнее предупреждение CodeQL о prototype pollution: запись настроек теперь выполняется только через явный список разрешённых путей, а неизвестные пути отклоняются.
- Усилены проверки безопасности и надёжности перед выпуском; весь security-run проходит зелёным.

## English

- Fixed the final CodeQL prototype-pollution finding: option writes now use an explicit allowlist of supported paths and reject unknown paths.
- Strengthened the pre-release security and reliability checks; the full security run is green.

## v0.2.48 — 2026-08-02

## Русский

- Исправлены красные CI-проверки безопасности: обновлены уязвимые зависимости Xray и Hiddify, а Go-аудит теперь сканирует фактически собираемые release entrypoint’ы.
- Синхронизированы security-gates и Windows release-сборка; политика cargo-deny обновлена под текущую версию инструмента.

## English

- Fixed red CI security checks by updating vulnerable Xray and Hiddify dependencies; Go auditing now scans the actual release entrypoints.
- Synchronized security gates with the Windows release build and updated the cargo-deny policy for the current tool version.

## v0.2.47 — 2026-08-02

## Русский

- Исправлены красные Windows-проверки: устранены ошибки Clippy в резервных копиях и проверке подписи браузера.
- RustSec-зависимости обновлены до безопасных версий, включая quick-xml, quinn-proto, anyhow и event-listener.
- Аудит pinned Go-sidecars переведён в режим проверки графа модулей, совместимый с их release build tags.
- RustSec-проверка получила минимальное право на публикацию Check Run.

## English

- Fixed the red Windows checks by resolving Clippy errors in backup validation and browser signature verification.
- Updated RustSec dependencies to safe versions, including quick-xml, quinn-proto, anyhow and event-listener.
- Switched pinned Go-sidecar auditing to module-graph mode, compatible with their release build tags.
- Granted the RustSec job the minimal permission required to publish its Check Run.

## v0.2.46 — 2026-08-02

## Русский

- Профили, подписки и выбранные серверы теперь хранятся в защищённом Rust-хранилище с безопасной миграцией и восстановлением после сбоя.
- В Portable добавлено шифрование данных по паролю; незашифрованное сохранение включается только отдельным подтверждением.
- Усилена защита загрузки подписок: заблокированы локальные и специальные адреса, опасные перенаправления и DNS-подмена.
- Защищённый Mullvad Browser запускается только после проверки подлинной подписи приложения.
- В CI добавлены обязательные проверки безопасности, зависимостей, качества кода и состава релизных артефактов.
- Исправлены неизвестные deep-link-команды, восстановление настроек при сбое IPC и синхронизация версии package-lock в релизном коммите.

## English

- Profiles, subscriptions and remembered servers now use protected Rust-owned storage with safe migration and crash recovery.
- Portable data can now be encrypted with a passphrase; plaintext persistence requires a separate explicit confirmation.
- Subscription downloads now block local and special-purpose addresses, unsafe redirects and DNS rebinding.
- Protected Mullvad Browser launches only after the application signature has been verified.
- CI now enforces security, dependency, code-quality and release-artifact checks.
- Fixed unknown deep-link actions, settings recovery when Rust IPC is unavailable and package-lock version synchronization in release commits.

## v0.2.45 — 2026-08-02

## Русский

- Профили, подписки и выбранные серверы теперь хранятся в защищённом Rust-хранилище с безопасной миграцией и восстановлением после сбоя.
- В Portable добавлено шифрование данных по паролю; незашифрованное сохранение включается только отдельным подтверждением.
- Усилена защита загрузки подписок: заблокированы локальные и специальные адреса, опасные перенаправления и DNS-подмена.
- Защищённый Mullvad Browser запускается только после проверки подлинной подписи приложения.
- В CI добавлены обязательные проверки безопасности, зависимостей, качества кода и состава релизных артефактов.
- Исправлены неизвестные deep-link-команды, согласованность версий и восстановление настроек при сбое IPC.

## English

- Profiles, subscriptions and remembered servers now use protected Rust-owned storage with safe migration and crash recovery.
- Portable data can now be encrypted with a passphrase; plaintext persistence requires a separate explicit confirmation.
- Subscription downloads now block local and special-purpose addresses, unsafe redirects and DNS rebinding.
- Protected Mullvad Browser launches only after the application signature has been verified.
- CI now enforces security, dependency, code-quality and release-artifact checks.
- Fixed unknown deep-link actions, version consistency and settings recovery when Rust IPC is unavailable.

## v0.2.44 — 2026-08-01

## English

- Fixed unstable VPN recovery: after one safe restart Ninety immediately tests alternative servers or reconnects instead of repeatedly retrying an unavailable server.
- Manual profile and server switching now takes priority over automatic recovery and no longer fails because a background restart is still running.
- Connection quality now leaves Checking promptly after a real measurement and reports a failed channel without waiting for the long background interval.
- Engine logs now distinguish planned stops from unexpected crashes, and release publishing preserves bilingual notes end to end.

## Русский

- Исправлено восстановление VPN: после одного безопасного перезапуска Ninety сразу проверяет другие серверы или переподключается, не зацикливаясь на недоступном сервере.
- Ручное переключение профиля или сервера теперь важнее автоматического восстановления и не завершается ошибкой из-за фонового перезапуска.
- Статус канала быстро выходит из «Проверка» после реального измерения и без долгого ожидания показывает обрыв связи.
- В логах плановая остановка больше не выглядит как авария, а заметки обновления сохраняют русский и английский текст.

## v0.2.43 — 2026-08-01

## English

- Added a native Windows VPN dataplane watchdog with real health probes, rolling decisions, guarded recovery and bounded terminal cleanup.
- Separated health and quality monitoring so host CPU, memory, commit and scheduler pressure pauses background quality probes without causing mass node switching.
- Hardened recovery ownership with generation guards, cooldowns, consecutive-success confirmation, manual-disconnect cancellation and fail-closed WFP protection.
- Kept sing-box cache state inside the application data directory instead of the process working directory, and added diagnostics that avoid sensitive VPN configuration data.

## Русский

- Добавлен нативный Windows-watchdog VPN-dataplane с реальными health-probe, rolling-решением, защищённым восстановлением и ограниченной terminal cleanup.
- Разделены health- и quality-мониторинг: давление CPU, памяти, commit и планировщика приостанавливает фоновые quality-probe и не вызывает массовое переключение нод.
- Усилено владение восстановлением: generation guard, cooldown, подтверждение двумя последовательными успехами, отмена при ручном отключении и fail-closed-защита через WFP.
- Кэш sing-box перенесён в каталог данных приложения вместо рабочей директории процесса; диагностические записи не содержат чувствительных данных VPN-конфигурации.

## v0.2.42 — 2026-07-29

## English

- Fixed Strict Tunnel so disabling it reliably restores the previous Proxy, System Proxy or TUN mode; Mullvad Browser now launches correctly as the standard Windows user from elevated TUN sessions.
- Hardened VPN and DPI process lifecycle: reconnects and mode changes wait for confirmed cleanup, repeated cleanup cannot terminate unrelated processes, and a failed DPI stop blocks TUN or restart instead of starting a duplicate bypass engine.
- Connection quality remediation now continues across reconnects, preserves its hourly retry limit, and does not collect local ASN data when diagnostics are disabled.
- Improved privacy and recovery: WARP errors no longer expose server response data, update checks no longer fall back to a direct connection after a tunneled failure, and URL handler backups preserve other installed clients.
- Signed DPI channel updates are now transactional: strategies, lists, payloads, service data and local selections switch as one verified generation, while an interrupted update leaves the previous working set active.

## Русский

- Исправлен «Строгий туннель»: после его выключения надёжно восстанавливается прежний режим «Прокси», «Системный прокси» или TUN; Mullvad Browser теперь корректно запускается от обычного пользователя Windows из TUN-сессии с повышенными правами.
- Усилен жизненный цикл процессов VPN и DPI: переподключение и смена режима дожидаются подтверждённой очистки, повторная очистка не может завершить посторонний процесс, а ошибка остановки DPI блокирует TUN или перезапуск вместо запуска второго движка обхода.
- Восстановление качества соединения теперь продолжается после переподключения, сохраняет часовой лимит повторов и не собирает локальный ASN при отключённой диагностике.
- Улучшены приватность и восстановление: ошибки WARP больше не раскрывают ответ сервера, проверка обновлений не переходит на прямое соединение после ошибки туннеля, а резервная копия обработчика ссылок сохраняет другие установленные клиенты.
- Обновление подписанного DPI-канала стало транзакционным: стратегии, списки, файлы подмены, служебные данные и локальный выбор переключаются одним проверенным поколением, а прерванное обновление оставляет активным прежний рабочий набор.

## v0.2.41 — 2026-07-26

- Ускорен запуск Ninety: тяжёлые служебные операции больше не блокируют первое отображение окна.
- Интерфейс быстрее обновляет состояние подключения, показатели трафика и сведения о серверах после переподключения.
- Исправлены редкие задержки и устаревшие данные после возвращения из трея, смены источника логов и перезапуска VPN.
- Повышена надёжность автозапуска Windows и фонового обновления состояния.
- Ninety now starts faster: heavy maintenance work no longer blocks the first window display.
- The interface updates connection state, traffic figures and server information faster after reconnects.
- Fixed rare delays and stale data after returning from the tray, switching log sources and restarting the VPN.
- Improved the reliability of Windows autostart and background state updates.

## v0.2.40 — 2026-07-26

- Добавлен «Строгий туннель»: Ninety закрепляет один выбранный сервер, направляет DNS сайтов через VPN и отключает прямые исключения, локальную сеть, IPv6, WARP и автоматическую смену сервера; при падении туннеля сессионный защитный фильтр Windows не даёт приложениям незаметно перейти на обычное соединение.
- В разделе «Приватность» появилась интеграция с бесплатным Mullvad Browser: проверка установки, безопасный запуск и страница проверки после подключения VPN · TUN, автоматический запуск по желанию и переход на официальную загрузку.
- Набор DPI-стратегий и списков обновлён до Flowseal 1.10.0; восстановлены автоматические подписанные обновления без переустановки Ninety, а новая стратегия EXP доступна для ручного выбора и исключена из автоподбора.
- В DPI-инструменты добавлены раздельные шаблоны подмены UDP для Discord и игр, а также безопасная очистка кэша Discord и Discord PTB без удаления настроек, истории и личных данных.
- Added Strict Tunnel: Ninety pins one selected server, routes website DNS through the VPN, disables direct exceptions, LAN, IPv6, WARP and automatic server changes, and keeps a session-scoped Windows network guard active if the tunnel fails.
- Added free Mullvad Browser integration to Privacy settings with installation detection, safe launch and browser check after a VPN TUN connection, optional auto-launch and access to the official download.
- Updated DPI strategies and lists to Flowseal 1.10.0 and restored automatic signed updates without reinstalling Ninety; the new EXP strategy remains available manually and is excluded from automatic selection.
- Added separate UDP disguise payload selection for Discord and games, plus safe Discord and Discord PTB cache cleanup without removing settings, history or personal data.

## v0.2.39 — 2026-07-18

- Добавлены четыре премиальные темы оформления: Kintsugi Noir, Aurora Glass, Porcelain Zero и Titanium Signal — с отдельными материалами, цветами, световыми акцентами и превью в настройках внешнего вида.
- Added four premium appearance themes: Kintsugi Noir, Aurora Glass, Porcelain Zero and Titanium Signal, each with distinct materials, colors, light accents and previews in Appearance settings.

## v0.2.38 — 2026-07-18

- Проверка последовательной установки и удаления теперь корректно дожидается завершения короткого служебного хвоста установщика, сохраняя отказ при настоящем параллельном запуске.

## v0.2.37 — 2026-07-18

- Исправлена проверка переносной версии перед публикацией: сценарий теперь использует корректный формат резервной копии настроек и не блокирует выпуск из-за устаревшего тестового snapshot.

## v0.2.36 — 2026-07-18

- Восстановление после неудачного обновления стало фазовым: Ninety перепроверяет состояние VPN и DPI, не перезапускает рабочее соединение без необходимости и подтверждает сохранение журнала восстановления.
- Резервная копия настроек теперь защищена от битых, слишком больших и устаревших записей; после очистки чувствительных данных старые операции сохранения не могут вернуть удалённые профили.
- Усилена защита локальных запросов: системный proxy принимает только loopback-адреса, команды Clash сверяют живое состояние runtime, а ответы ограничены по размеру.
- Проверки качества соединения теперь разрешают только официальный endpoint Cloudflare и безопасные HTTPS-переходы; ответы DNS дополнительно проверяются на соответствие запросу.

## v0.2.35 — 2026-07-17

- Manual server choices now survive subscription refreshes when providers change node names or link formatting, including older subscriptions.
- Ninety no longer silently falls back to Auto when a remembered manual server disappears from the subscription.
- Ручной выбор сервера теперь сохраняется после обновления подписки, даже если провайдер меняет имя ноды или формат ссылки; это также работает для старых подписок.
- Если сохранённый вручную сервер действительно исчез из подписки, Ninety больше не переключается молча на «Авто».

## v0.2.34 — 2026-07-17

- Sequential setup and removal operations now hand off cleanly: a new installation briefly waits for the final NSIS cleanup tail, while a genuinely concurrent installer is still rejected before file access.
- The Windows production gate verifies both sides of this lifecycle—the overlapping OTA guard and an immediate clean reinstall after complete removal—alongside rollback and payload integrity.
- Последовательные операции установки и удаления теперь корректно передают управление: новая установка кратко ждёт завершения финальной очистки NSIS, а действительно параллельный установщик по-прежнему отклоняется до обращения к файлам.
- Production-гейт Windows проверяет обе стороны этого сценария: защиту от одновременного OTA-запуска и немедленную чистую переустановку после полного удаления, а также откат и целостность файлов.

## v0.2.33 — 2026-07-17

- The Windows installer and uninstaller now share a valid single-operation guard and fail safely if it cannot be acquired, so a second setup process exits before inspecting or changing installed files.
- The production release gate keeps exercising overlapping OTA installers together with locked-resource rollback, path preservation, payload integrity, application launch and cleanup.
- Установщик и деинсталлятор Windows теперь используют исправную единую блокировку операций и безопасно завершаются, если её нельзя получить; второй процесс установки останавливается до проверки или изменения установленных файлов.
- Production-гейт продолжает проверять одновременный запуск OTA-установщиков вместе с откатом при заблокированном ресурсе, сохранением каталога, целостностью файлов, запуском приложения и очисткой.

## v0.2.32 — 2026-07-16

- Existing AppData, Program Files and custom installations are updated in place; only a genuinely fresh installation defaults to `C:\Program Files\Ninety`, so updates no longer create duplicate copies.
- Setup and removal now reject parallel operations, wait for released file handles and stop before changing anything if a destination remains locked or unwritable; failed resources cannot be skipped.
- The production release gate verifies registered legacy AppData updates, locked-resource rollback, resource integrity, installed-app launch and complete cleanup before publication.
- Существующие установки в AppData, Program Files и выбранных пользователем каталогах обновляются на месте; `C:\Program Files\Ninety` используется по умолчанию только для действительно новой установки, поэтому обновления больше не создают дубликаты.
- Установка и удаление отклоняют параллельные операции, ждут освобождения файлов и прекращают работу до любых изменений, если каталог остаётся заблокированным либо недоступным для записи; пропустить проблемный ресурс нельзя.
- Перед публикацией production-гейт проверяет обновление зарегистрированной старой AppData-установки, откат при заблокированном ресурсе, целостность файлов, запуск установленного приложения и полную очистку.

## v0.2.31 — 2026-07-16

- Existing installations remain in their registered AppData, Program Files or custom directory during updates and reinstalls; only a genuinely fresh installation defaults to `C:\Program Files\Ninety`, preventing duplicate copies.
- Setup and removal are single-operation and fail-safe: Ninety waits for released file handles, rejects parallel installers, disables resource skipping and makes no partial changes when a file remains locked or unwritable.
- Maintenance can safely hand control to the registered uninstaller, while the production release gate verifies legacy AppData OTA in place, locked-resource rollback, complete resource integrity, installed-app launch and cleanup.
- Существующие установки при обновлении и переустановке остаются в зарегистрированном каталоге AppData, Program Files или выбранной пользователем папке; `C:\Program Files\Ninety` используется по умолчанию только для действительно новой установки, поэтому дубликаты не создаются.
- Установка и удаление работают в единственном экземпляре и безопасно прекращаются: Ninety ждёт освобождения файлов, отклоняет параллельный установщик, запрещает пропуск ресурсов и не вносит частичных изменений, если файл остаётся заблокированным либо недоступным для записи.
- Мастер обслуживания безопасно передаёт управление зарегистрированному деинсталлятору, а production-гейт проверяет OTA поверх старой AppData-установки на месте, откат при заблокированном ресурсе, целостность всех ресурсов, запуск приложения и очистку.

## v0.2.30 — 2026-07-16

- Updates and reinstalls now preserve every existing AppData, Program Files or custom installation path; only a genuinely fresh installation defaults to `C:\Program Files\Ninety`, preventing duplicate copies.
- Setup and removal allow only one active operation, wait for the previous Ninety process to release resources, and stop before changing any files when the destination remains locked or unwritable.
- Partial installations are blocked: resources can no longer be skipped after a write failure, and maintenance can safely hand control to the registered uninstaller without deadlocking the operation guard.
- The release gate now exercises the production installer with a registered legacy AppData path, parallel setup rejection, locked-resource rollback, successful OTA in place, complete resource integrity, application launch and cleanup.
- Обновления и переустановка теперь сохраняют существующий каталог AppData, Program Files или выбранный пользователем путь; `C:\Program Files\Ninety` используется по умолчанию только для действительно новой установки, поэтому дубликаты больше не создаются.
- Одновременно разрешена только одна операция установки или удаления; установщик ждёт освобождения ресурсов прежним процессом Ninety и прекращает работу до изменения файлов, если каталог остаётся заблокированным либо недоступным для записи.
- Частичная установка исключена: после ошибки записи ресурсы нельзя пропустить, а мастер обслуживания безопасно передаёт управление зарегистрированному деинсталлятору без взаимной блокировки.
- Релизный гейт теперь проверяет настоящий установщик с зарегистрированным старым путём AppData, запрет параллельного запуска, откат при заблокированном ресурсе, успешное OTA-обновление на месте, целостность всех ресурсов, запуск приложения и очистку.

## v0.2.29 — 2026-07-16

- Existing Ninety installations now stay in their registered AppData, Program Files or custom directory during updates and reinstalls; only a genuinely fresh installation defaults to `C:\Program Files\Ninety`.
- Setup and removal are limited to one active operation, wait briefly for the previous app process to release files, and stop safely before making changes if any destination file remains locked or unwritable.
- Partial installations are no longer possible: locked resources such as country flags cannot be skipped, and no automatic folder migration or duplicate installation is performed.
- The Windows release gate now runs the production installer through clean installation, AppData OTA without duplication, locked-resource rollback, complete flag integrity, installed-app launch and uninstallation before publication.
- Существующие установки Ninety при обновлении и переустановке остаются в своём зарегистрированном каталоге AppData, Program Files или выбранной пользователем папке; `C:\Program Files\Ninety` используется по умолчанию только для действительно новой установки.
- Одновременно разрешена только одна операция установки или удаления; установщик кратко ждёт освобождения файлов прежним процессом и безопасно прекращает работу до любых изменений, если каталог или файл остаётся заблокированным либо недоступным для записи.
- Частичная установка больше невозможна: заблокированные ресурсы, включая флаги стран, нельзя пропустить; автоматический перенос каталога и создание дубликата установки исключены.
- Перед публикацией Windows-релиз теперь проходит реальную чистую установку, OTA поверх AppData без дубля, откат при заблокированном ресурсе, полную проверку целостности флагов, запуск установленного приложения и удаление.

## v0.2.28 — 2026-07-16

- Refined the About identity: the samurai mark is now presented without an app-icon tile, and the brand/version lockup is optically aligned.
- The language selector now offers neutral English and Russian choices; after continuing, the main installer reliably reclaims the foreground without remaining always-on-top.
- The default installation directory is restored to `C:\Program Files\Ninety`; former standard AppData installations migrate there while explicitly chosen custom paths are preserved.
- В разделе «О программе» маска самурая теперь отображается без плитки и рамки, а блок бренда и версии оптически выровнен.
- Выбор языка теперь предлагает нейтральные варианты English и Русский; после продолжения основное окно установщика надёжно возвращается на передний план, не оставаясь постоянно поверх остальных окон.
- Стандартный каталог установки снова `C:\Program Files\Ninety`; прежние стандартные установки в AppData мигрируют туда, а выбранные пользователем нестандартные пути сохраняются.

## v0.2.27 — 2026-07-16

- The Windows installer and uninstaller now use the complete Signal Matrix design across language, account scope, deployment target, license, maintenance and removal screens, with consistent `190X4` stage codes and no stock white controls.
- Added a bilingual pre-install language selector with English as the primary fallback and Russian as the additional language; the custom license reader supports real Page Up/Page Down navigation without a native scrollbar.
- Deployment and removal paths now use custom compact Matrix fields, while localized maintenance and uninstall copy is constrained to its cards without clipping or overflow.
- OTA updates now use a responsive native Windows caption with working minimize and drag behavior while unsafe close/cancel actions remain disabled during file replacement; the refreshed About icon is also used consistently.
- Windows CI now exercises real left-clicks for navigation, selection, folder change, cancellation and window controls, verifies frameless/native dragging, license paging, OTA behavior and the complete uninstall flow, and captures every screen for visual review.
- Установщик и деинсталлятор Windows теперь полностью оформлены в стиле Signal Matrix: выбор языка, область установки, точка развёртывания, лицензия, обслуживание и удаление используют единые коды этапов `190X4` без белых системных элементов.
- Добавлен двуязычный выбор языка до запуска установщика: английский используется как основной резервный язык, русский — как дополнительный; собственный экран лицензии поддерживает реальную навигацию Page Up/Page Down без системной полосы прокрутки.
- Пути установки и удаления отображаются в собственных компактных полях Matrix, а локализованные тексты обслуживания и удаления гарантированно помещаются внутри карточек без обрезания и выхода за границы.
- Окно OTA-обновления получило управляемый системный заголовок Windows с рабочими сворачиванием и перетаскиванием; небезопасные закрытие и отмена остаются заблокированы во время замены файлов, а в разделе «О программе» везде используется обновлённая иконка.
- Windows CI теперь проверяет реальные клики ЛКМ по навигации, вариантам выбора, смене папки, отмене и кнопкам окна, перетаскивание обоих типов окон, перелистывание лицензии, OTA-сценарий и полный цикл удаления, сохраняя все экраны для ручной визуальной проверки.

## v0.2.26 — 2026-07-16

- Исправлены клики мышью в установщике: кнопки установки, навигации, отмены, сворачивания и закрытия снова работают, а окно корректно перетаскивается.
- Переработаны экраны лицензии, области установки, обслуживания и удаления; установщик и деинсталлятор теперь полностью выдержаны в едином стиле Ninety.
- Боковая панель приложения теперь корректно меняет оформление вместе с выбранной темой, включая светлые темы.
- Исправлена загрузка подписанных данных DPI-канала на чистых установках: применение файла hosts, обновление базы IPSet и стратегий больше не ломается при проверке ключа.

## v0.2.25 — 2026-07-15

- Fixed the Kurogane EXE installer in the real elevated update flow: navigation and title-bar controls now use deterministic dark bitmap chrome without white Windows-themed elements.
- Installation progress now follows the native NSIS range through real install and uninstall stages without corrupting installer state, while stale navigation is hidden during active progress.
- The refreshed Ninety icon is reapplied when the native event loop becomes ready and whenever the window is shown, fixing the old icon in taskbar hover thumbnails.
- Installer CI now rejects white chrome and frozen progress, validates window dragging and complete screenshots, keeps preview versions synchronized, and uses a resilient NSIS installation fallback; the `190x4` artwork lockup was also tightened.
- Исправлен установщик Kurogane в реальном elevated-потоке обновления: кнопки навигации и заголовка теперь используют собственную тёмную растровую отрисовку без белых системных элементов Windows.
- Прогресс установки теперь следует внутренней шкале NSIS на реальных этапах установки и удаления без повреждения состояния установщика, а устаревшие кнопки скрываются во время активного прогресса.
- Новая иконка Ninety повторно назначается после готовности нативного цикла событий и при каждом показе окна, исправляя старую иконку в миниатюре при наведении на панель задач.
- CI установщика теперь отклоняет белые элементы и застывший прогресс, проверяет перетаскивание и полнооконные скриншоты, синхронизирует версию preview и использует устойчивую резервную установку NSIS; компоновка `190x4` также стала плотнее.

## v0.2.24 — 2026-07-15

- The EXE installer shell was fully repaired: stock NSIS chrome was removed, every stage now follows the Kurogane visual system, the window is draggable again, and the red progress indicator and installation percentage update correctly.
- Branded artwork now uses dimensions matched to the real Windows controls, without white gaps, clipping, or incorrect scaling.
- Ninety now assigns the refreshed icon directly to its Windows window so the correct artwork is also used in the taskbar hover thumbnail.
- Полностью исправлена оболочка EXE-установщика: убраны системные элементы NSIS, все этапы оформлены в едином стиле Kurogane, окно снова перетаскивается, а красный прогресс и процент установки обновляются корректно.
- Размеры фирменной графики теперь соответствуют реальному Windows-интерфейсу без белых полей, обрезания и неверного масштабирования.
- Новая иконка Ninety явно назначается самому окну Windows, поэтому она корректно отображается и в миниатюре при наведении на панель задач.

## v0.2.23 — 2026-07-15

- The first-run experience and navigation sidebar were redesigned in the Kurogane Split style with the Ninety samurai artwork, streamlined subscription import, a working skip path, and refreshed Windows/taskbar icons.
- The active profile or subscription, the selected server for every subscription, and the desired DPI state now survive restarts, OTA relaunches, temporary API failures, and storage recovery; cancelling elevation safely rolls back the DPI intent.
- The Windows EXE installer and uninstaller now use a fully custom Kurogane shell with live branded progress, stronger cleanup of engines, sidecars, legacy services and drivers, downgrade protection, and updated component/privacy information.
- Первый запуск и боковая навигация полностью переработаны в стиле Kurogane Split с фирменной маской самурая, упрощённым импортом подписки, рабочим пропуском приветствия и обновлёнными иконками Windows/панели задач.
- Активный профиль или подписка, выбранный сервер для каждой подписки и желаемое состояние DPI теперь сохраняются после перезапуска, OTA-релонча, временных ошибок API и восстановления хранилища; отмена повышения прав безопасно откатывает намерение включить DPI.
- EXE-установщик и деинсталлятор Windows получили полностью собственную оболочку Kurogane с живым брендированным прогрессом, усиленной очисткой движков, sidecar-клиентов, старых служб и драйверов, защитой от downgrade и актуальным описанием компонентов и приватности.

## v0.2.22 — 2026-07-15

- The first-run experience and navigation sidebar were redesigned in the Kurogane Split style with the Ninety samurai artwork, streamlined subscription import, a working skip path, and refreshed Windows/taskbar icons.
- The active profile or subscription, the selected server for every subscription, and the desired DPI state now survive restarts, OTA relaunches, temporary API failures, and storage recovery; cancelling elevation safely rolls back the DPI intent.
- The Windows EXE installer and uninstaller now use a fully custom Kurogane shell with live branded progress, stronger cleanup of engines, sidecars, legacy services and drivers, downgrade protection, and updated component/privacy information.
- Первый запуск и боковая навигация полностью переработаны в стиле Kurogane Split с фирменной маской самурая, упрощённым импортом подписки, рабочим пропуском приветствия и обновлёнными иконками Windows/панели задач.
- Активный профиль или подписка, выбранный сервер для каждой подписки и желаемое состояние DPI теперь сохраняются после перезапуска, OTA-релонча, временных ошибок API и восстановления хранилища; отмена повышения прав безопасно откатывает намерение включить DPI.
- EXE-установщик и деинсталлятор Windows получили полностью собственную оболочку Kurogane с живым брендированным прогрессом, усиленной очисткой движков, sidecar-клиентов, старых служб и драйверов, защитой от downgrade и актуальным описанием компонентов и приватности.

## v0.2.21 — 2026-07-15

- The first-run experience and navigation sidebar were redesigned in the Kurogane Split style with the Ninety samurai artwork, streamlined subscription import, a working skip path, and refreshed Windows/taskbar icons.
- The active profile or subscription, the selected server for every subscription, and the desired DPI state now survive restarts, OTA relaunches, temporary API failures, and storage recovery; cancelling elevation safely rolls back the DPI intent.
- The Windows EXE installer and uninstaller now use a fully custom Kurogane shell with live branded progress, stronger cleanup of engines, sidecars, legacy services and drivers, downgrade protection, and updated component/privacy information.
- Первый запуск и боковая навигация полностью переработаны в стиле Kurogane Split с фирменной маской самурая, упрощённым импортом подписки, рабочим пропуском приветствия и обновлёнными иконками Windows/панели задач.
- Активный профиль или подписка, выбранный сервер для каждой подписки и желаемое состояние DPI теперь сохраняются после перезапуска, OTA-релонча, временных ошибок API и восстановления хранилища; отмена повышения прав безопасно откатывает намерение включить DPI.
- EXE-установщик и деинсталлятор Windows получили полностью собственную оболочку Kurogane с живым брендированным прогрессом, усиленной очисткой движков, sidecar-клиентов, старых служб и драйверов, защитой от downgrade и актуальным описанием компонентов и приватности.

## v0.2.20 — 2026-07-15

- The first-run experience and navigation sidebar were redesigned in the Kurogane Split style with the Ninety samurai artwork, streamlined subscription import, a working skip path, and refreshed Windows/taskbar icons.
- The active profile or subscription, the selected server for every subscription, and the desired DPI state now survive restarts, OTA relaunches, temporary API failures, and storage recovery; cancelling elevation safely rolls back the DPI intent.
- The Windows EXE installer and uninstaller now use a fully custom Kurogane shell with live branded progress, stronger cleanup of engines, sidecars, legacy services and drivers, downgrade protection, and updated component/privacy information.
- Первый запуск и боковая навигация полностью переработаны в стиле Kurogane Split с фирменной маской самурая, упрощённым импортом подписки, рабочим пропуском приветствия и обновлёнными иконками Windows/панели задач.
- Активный профиль или подписка, выбранный сервер для каждой подписки и желаемое состояние DPI теперь сохраняются после перезапуска, OTA-релонча, временных ошибок API и восстановления хранилища; отмена повышения прав безопасно откатывает намерение включить DPI.
- EXE-установщик и деинсталлятор Windows получили полностью собственную оболочку Kurogane с живым брендированным прогрессом, усиленной очисткой движков, sidecar-клиентов, старых служб и драйверов, защитой от downgrade и актуальным описанием компонентов и приватности.

## v0.2.19 — 2026-07-15

- Added a fully self-contained Windows x64 Portable edition: settings, subscriptions, logs, browser data, and connection data stay inside the `NinetyData` folder next to the executable.
- Portable Ninety can be moved between Windows PCs without installation, preserves its data during ZIP updates, uses separate autostart, and downloads updates from the matching GitHub release.
- Добавлена полностью автономная Portable-версия для Windows x64: настройки, подписки, логи, данные интерфейса и подключений хранятся в папке `NinetyData` рядом с приложением.
- Portable Ninety можно переносить между компьютерами без установки; данные сохраняются при обновлении ZIP, автозапуск работает отдельно, а новые версии загружаются со страницы нужного релиза GitHub.

## v0.2.18 — 2026-07-15

- Added a fully self-contained Windows x64 Portable edition: app settings, subscriptions, logs, browser data, and connection data stay inside the `NinetyData` folder next to the executable.
- Portable Ninety can be moved between Windows PCs without installation, keeps its data when a new ZIP is extracted over the existing folder, and uses a separate portable autostart task.
- Updates in Portable mode now open the matching GitHub release for downloading a new ZIP instead of launching the installed-edition updater.
- Добавлена полностью автономная Portable-версия для Windows x64: настройки, подписки, логи, данные интерфейса и подключений хранятся в папке `NinetyData` рядом с приложением.
- Portable Ninety можно переносить между компьютерами без установки; данные сохраняются при распаковке нового ZIP поверх существующей папки, а для автозапуска используется отдельная задача.
- Обновление Portable-версии теперь открывает нужный релиз GitHub для загрузки нового ZIP вместо запуска установщика обычной версии.

## v0.2.17 — 2026-07-13

- Runtime shutdown is now fully retryable: unresolved engine PIDs and occupied ports are retained until physical cleanup is confirmed, while concurrent start/stop calls and late termination events can no longer corrupt the next session.
- DPI shutdown and WinDivert unloading now verify process and service completion with strict shared deadlines; OTA installation and sensitive-data deletion are blocked when cleanup is not confirmed instead of reporting false success.
- Repeated connection clicks no longer launch parallel disconnects, DNS probes obey one global timeout including name resolution, and Clash polling is single-flight to prevent overlapping stale requests.
- Остановка runtime теперь полностью повторяема: незавершённые PID движков и занятые порты сохраняются до физического подтверждения очистки, а параллельные start/stop и поздние события завершения больше не повреждают следующую сессию.
- Остановка DPI и выгрузка WinDivert теперь подтверждают завершение процессов и служб в строгих общих дедлайнах; установка OTA и удаление чувствительных данных блокируются при неподтверждённой очистке вместо ложного успеха.
- Повторные клики подключения больше не запускают параллельные отключения, DNS-пробы соблюдают единый тайм-аут вместе с разрешением имени, а Clash-поллинг выполняется в режиме single-flight без перекрывающихся устаревших запросов.

## v0.2.16 — 2026-07-13

- Runtime shutdown is now fully retryable: unresolved engine PIDs and occupied ports are retained until physical cleanup is confirmed, while concurrent start/stop calls and late termination events can no longer corrupt the next session.
- DPI shutdown and WinDivert unloading now verify process and service completion with strict shared deadlines; OTA installation and sensitive-data deletion are blocked when cleanup is not confirmed instead of reporting false success.
- Repeated connection clicks no longer launch parallel disconnects, DNS probes obey one global timeout including name resolution, and Clash polling is single-flight to prevent overlapping stale requests.
- Остановка runtime теперь полностью повторяема: незавершённые PID движков и занятые порты сохраняются до физического подтверждения очистки, а параллельные start/stop и поздние события завершения больше не повреждают следующую сессию.
- Остановка DPI и выгрузка WinDivert теперь подтверждают завершение процессов и служб в строгих общих дедлайнах; установка OTA и удаление чувствительных данных блокируются при неподтверждённой очистке вместо ложного успеха.
- Повторные клики подключения больше не запускают параллельные отключения, DNS-пробы соблюдают единый тайм-аут вместе с разрешением имени, а Clash-поллинг выполняется в режиме single-flight без перекрывающихся устаревших запросов.

## v0.2.15 — 2026-07-13

- Windows shutdown now verifies terminated engine PIDs directly instead of waiting for delayed log-monitor events, preventing false cleanup failures during disconnect, profile switching, and OTA installation.
- Runtime port release is checked with an immediate bind probe instead of an unbounded TCP connection, eliminating 15–30 second stalls; late termination events from an old runtime can no longer poison the next reconnect, and failed cleanup reports the exact remaining ports and pending events.
- Остановка в Windows теперь проверяет завершение PID сетевых движков напрямую, а не ждёт запаздывающих событий монитора логов — это устраняет ложные ошибки очистки при отключении, смене профиля и установке OTA.
- Освобождение runtime-портов теперь проверяется мгновенной bind-пробой вместо неограниченного TCP-подключения, поэтому зависания на 15–30 секунд исключены; поздние события старого runtime больше не ломают следующий реконнект, а при реальной ошибке диагностика показывает оставшиеся порты и ожидающие события.

## v0.2.14 — 2026-07-13

- Windows shutdown now verifies terminated engine PIDs directly instead of waiting for delayed log-monitor events, preventing false cleanup failures during disconnect, profile switching, and OTA installation.
- Runtime port release is checked with an immediate bind probe instead of an unbounded TCP connection, eliminating 15–30 second stalls; late termination events from an old runtime can no longer poison the next reconnect, and failed cleanup reports the exact remaining ports and pending events.
- Остановка в Windows теперь проверяет завершение PID сетевых движков напрямую, а не ждёт запаздывающих событий монитора логов — это устраняет ложные ошибки очистки при отключении, смене профиля и установке OTA.
- Освобождение runtime-портов теперь проверяется мгновенной bind-пробой вместо неограниченного TCP-подключения, поэтому зависания на 15–30 секунд исключены; поздние события старого runtime больше не ломают следующий реконнект, а при реальной ошибке диагностика показывает оставшиеся порты и ожидающие события.

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
