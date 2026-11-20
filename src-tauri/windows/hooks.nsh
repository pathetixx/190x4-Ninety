; hooks.nsh — pre-install / pre-uninstall actions для Ninety.
; Подключается через bundle.windows.nsis.installerHooks в tauri.conf.json.
;
; Зачем нужно: перед апдейтом/удалением гасим запущенные процессы Ninety, ядра и
; sidecar-клиенты (sing-box/xray/naive/TrustTunnel), а также снимаем kernel-
; драйвер WinDivert/Monkey — иначе NSIS падает на "файл занят".
;
; Завершаем ТОЛЬКО процессы с именами наших бинарников, чей образ лежит внутри
; $INSTDIR. Прежний `taskkill /IM` убивал одноимённые процессы чужих программ:
; xray.exe/sing-box.exe у v2rayN, winws.exe у zapret/Flowseal.
;
; Системный прокси: штатный выход Ninety (RunEvent::Exit → vpn::force_cleanup)
; возвращает прокси Windows, а принудительное завершение — нет. Поэтому ДО
; завершения процессов повторяем логику proxy_win.rs::set_system_proxy(false),
; иначе после удаления/переустановки браузеры остаются на мёртвом порту. Хук
; работает от пользователя, запустившего (де)инсталлятор: HKCU — его куст.
;
; ВАЖНО про драйвер: WinDivert64.sys/Monkey64.sys лежат В каталоге установки, и
; пока драйвер загружен в ядро, этот .sys залочен и его не перезаписать/удалить.
; Снять kernel-службу можно ТОЛЬКО с админ-правами, а инсталлятор/деинсталлятор
; может работать в per-user режиме без elevation, и обычный `sc stop` тогда
; падает с Access Denied. Поэтому драйвер снимаем штатно из самой аппы
; (full_unload при выходе/перед OTA — там она elevated), а здесь — gated UAC как
; подстраховка: поднимаем права ТОЛЬКО если есть что снимать — legacy-служба
; или служба драйвера, чей ImagePath указывает внутрь $INSTDIR. Службу WinDivert
; регистрируют и другие программы (zapret, Flowseal) — чужую не трогаем.
;
; NinetyTunnelService — ЛЕГАСИ: до alpha55 TUN работал через эту службу. С
; Throne-style элевацией служба больше не ставится, но у апгрейдящихся с alpha54-
; она ещё установлена — поэтому здесь её принудительно сносим.

; Перебор процессов читает PROCESSENTRY32W через System::Call; разметка ниже
; рассчитана на 32-битный NSIS (Tauri собирает x86-unicode). На 64-битном
; th32DefaultHeapID выравнивается до 8 байт, и поля поехали бы молча.
!if ${NSIS_PTR_SIZE} != 4
  !error "hooks.nsh: разметка PROCESSENTRY32W рассчитана на 32-битный NSIS"
!endif
; sizeof(PROCESSENTRY32W) в 32-битном процессе: 9 полей по 4 байта + 260 WCHAR.
!define NINETY_PROCESSENTRY32W_SIZE 556

; Должны совпадать с константами proxy_win.rs (сверяет check-installer.mjs).
!define NINETY_INET_SETTINGS_KEY "Software\Microsoft\Windows\CurrentVersion\Internet Settings"
!define NINETY_STATE_KEY "Software\Ninety"
!define NINETY_PROXY_OVERRIDE "localhost;127.*;10.*;172.16.*;172.17.*;172.18.*;172.19.*;172.20.*;172.21.*;172.22.*;172.23.*;172.24.*;172.25.*;172.26.*;172.27.*;172.28.*;172.29.*;172.30.*;172.31.*;192.168.*;<local>"
!define NINETY_PROXY_OVERRIDE_LOOPBACK "localhost;127.*"
!define NINETY_LEGACY_PROXY_SERVER "127.0.0.1:7890"
!define NINETY_AUTOSTART_TASK "Ninety"
; Длиннее NSIS из реестра не читает: такая строка может оказаться обрезанной.
!define /math NINETY_REG_STR_LIMIT ${NSIS_MAX_STRLEN} - 1

!macro NinetyQueueOwnedDriver PREFIX SERVICE
  Push "${SERVICE}"
  Call ${PREFIX}NinetyQueueOwnedDriver
!macroend

; Функции нужны и установщику, и деинсталлятору (там они обязаны называться
; с префиксом un.), поэтому определяются макросом дважды. Метки внутри функций
; локальны — уникальные суффиксы им не нужны.
!macro NinetyDefineHookFunctions PREFIX

; Повтор proxy_win.rs::set_system_proxy(false): proxy_recovery_action +
; read_proxy_snapshot + restore_proxy_settings. Прокси Windows трогаем, только
; если он доказанно наш (ProxyEnable=1 и ProxyServer = ActiveProxyServer либо
; исторический 127.0.0.1:7890 при валидном снапшоте). Прокси, который
; пользователь сменил сам, остаётся как есть — забываем лишь наши маркеры.
Function ${PREFIX}NinetyRestoreSystemProxy
  Push $0
  Push $1
  Push $2
  Push $3
  Push $4
  Push $5
  Push $6
  Push $7
  Push $8
  Push $9
  Push $R0
  Push $R1
  Push $R2
  Push $R3
  Push $R4
  Push $R5
  Push $R6

  ; Текущие настройки: $0 ProxyEnable, $1 ProxyServer, $2 ProxyOverride и $3 —
  ; задан ли он вообще.
  ClearErrors
  ReadRegDWORD $0 HKCU "${NINETY_INET_SETTINGS_KEY}" "ProxyEnable"
  ${If} ${Errors}
    StrCpy $0 0
  ${EndIf}
  ClearErrors
  ReadRegStr $1 HKCU "${NINETY_INET_SETTINGS_KEY}" "ProxyServer"
  ${If} ${Errors}
    StrCpy $1 ""
  ${EndIf}
  ClearErrors
  ReadRegStr $2 HKCU "${NINETY_INET_SETTINGS_KEY}" "ProxyOverride"
  ${If} ${Errors}
    StrCpy $2 ""
    StrCpy $3 0
  ${Else}
    StrCpy $3 1
  ${EndIf}

  ; Маркер владения: $4 ActiveProxyServer, $5 — задан ли он.
  ClearErrors
  ReadRegStr $4 HKCU "${NINETY_STATE_KEY}" "ActiveProxyServer"
  ${If} ${Errors}
    StrCpy $4 ""
    StrCpy $5 0
  ${Else}
    StrCpy $5 1
  ${EndIf}

  ; Снапшот прежних настроек с теми же проверками, что read_proxy_snapshot:
  ; $6 — валиден, $7 SavedProxyEnable, $8/$9 сервер и признак наличия, $R0/$R1
  ; исключения и признак. $R5 — значение SavedProxyValid есть (его можно обнулить,
  ; не создавая ключ состояния заново).
  StrCpy $6 0
  StrCpy $R5 0
  StrCpy $8 ""
  StrCpy $R0 ""
  ClearErrors
  ReadRegDWORD $R2 HKCU "${NINETY_STATE_KEY}" "SavedProxyValid"
  IfErrors ninety_snapshot_done
  StrCpy $R5 1
  IntCmp $R2 1 0 ninety_snapshot_done ninety_snapshot_done
  ReadRegDWORD $7 HKCU "${NINETY_STATE_KEY}" "SavedProxyEnable"
  IfErrors ninety_snapshot_done
  IntCmpU $7 1 0 0 ninety_snapshot_done
  ReadRegDWORD $9 HKCU "${NINETY_STATE_KEY}" "SavedProxyServerPresent"
  IfErrors ninety_snapshot_done
  IntCmpU $9 1 0 0 ninety_snapshot_done
  ReadRegDWORD $R1 HKCU "${NINETY_STATE_KEY}" "SavedProxyOverridePresent"
  IfErrors ninety_snapshot_done
  IntCmpU $R1 1 0 0 ninety_snapshot_done
  ${If} $9 = 1
    ReadRegStr $8 HKCU "${NINETY_STATE_KEY}" "SavedProxyServer"
    IfErrors ninety_snapshot_done
  ${EndIf}
  ${If} $R1 = 1
    ReadRegStr $R0 HKCU "${NINETY_STATE_KEY}" "SavedProxyOverride"
    IfErrors ninety_snapshot_done
  ${EndIf}
  StrCpy $6 1
  ninety_snapshot_done:

  ; $R3 — текущий список исключений наш (с учётом регистра, как в Rust).
  StrCpy $R3 0
  ${If} $3 = 1
    ${If} $2 S== "${NINETY_PROXY_OVERRIDE}"
    ${OrIf} $2 S== "${NINETY_PROXY_OVERRIDE_LOOPBACK}"
      StrCpy $R3 1
    ${EndIf}
  ${EndIf}

  ; $R2 — действие proxy_recovery_action: 0 не трогать, 1 вернуть снапшот,
  ; 2 вернуть снапшот, сохранив чужой список исключений, 3 только выключить
  ; наш прокси (снапшота нет или он повреждён). Адреса сравниваются без учёта
  ; регистра, как eq_ignore_ascii_case.
  StrCpy $R2 0
  ${If} $5 = 1
    ${If} $0 = 1
    ${AndIf} $1 == $4
      ${If} $6 <> 1
        StrCpy $R2 3
      ${ElseIf} $R3 = 1
        StrCpy $R2 1
      ${Else}
        StrCpy $R2 2
      ${EndIf}
    ${EndIf}
  ${ElseIf} $6 = 1
    ${If} $0 = 1
    ${AndIf} $R3 = 1
    ${AndIf} $1 == "${NINETY_LEGACY_PROXY_SERVER}"
      StrCpy $R2 1
    ${EndIf}
  ${EndIf}

  ; Обрезанный адрес вернуть нельзя — тогда только выключаем наш прокси.
  ; Обрезанный список исключений не пишем: остаётся текущий.
  ${If} $R2 = 1
  ${OrIf} $R2 = 2
    StrLen $R4 $8
    ${If} $R4 >= ${NINETY_REG_STR_LIMIT}
      StrCpy $R2 3
    ${ElseIf} $R2 = 1
      StrLen $R4 $R0
      ${If} $R4 >= ${NINETY_REG_STR_LIMIT}
        StrCpy $R2 2
      ${EndIf}
    ${EndIf}
  ${EndIf}

  ${If} $R2 = 0
    ; Прокси не наш либо доказательств владения нет: настройки Windows не
    ; трогаем, устаревшие маркеры забываем (LeaveUntouched в Rust).
    ${If} $R5 = 1
      WriteRegDWORD HKCU "${NINETY_STATE_KEY}" "SavedProxyValid" 0
    ${EndIf}
    ${If} $5 = 1
      DeleteRegValue HKCU "${NINETY_STATE_KEY}" "ActiveProxyServer"
    ${EndIf}
    Goto ninety_proxy_done
  ${EndIf}

  DetailPrint "Возвращаем прежние настройки прокси Windows..."
  StrCpy $R6 0 ; 1 — запись в реестр не удалась
  ${If} $R2 = 3
    ClearErrors
    WriteRegDWORD HKCU "${NINETY_INET_SETTINGS_KEY}" "ProxyEnable" 0
    ${IfThen} ${Errors} ${|} StrCpy $R6 1 ${|}
  ${Else}
    ; Сначала зависимые значения, ProxyEnable — последним: это commit-маркер,
    ; который видит WinINet (restore_proxy_settings).
    ${If} $9 = 1
      ClearErrors
      WriteRegStr HKCU "${NINETY_INET_SETTINGS_KEY}" "ProxyServer" $8
      ${IfThen} ${Errors} ${|} StrCpy $R6 1 ${|}
    ${Else}
      DeleteRegValue HKCU "${NINETY_INET_SETTINGS_KEY}" "ProxyServer"
    ${EndIf}
    ${If} $R6 = 0
    ${AndIf} $R2 = 1
      ${If} $R1 = 1
        ClearErrors
        WriteRegStr HKCU "${NINETY_INET_SETTINGS_KEY}" "ProxyOverride" $R0
        ${IfThen} ${Errors} ${|} StrCpy $R6 1 ${|}
      ${Else}
        DeleteRegValue HKCU "${NINETY_INET_SETTINGS_KEY}" "ProxyOverride"
      ${EndIf}
    ${EndIf}
    ${If} $R6 = 0
      ClearErrors
      WriteRegDWORD HKCU "${NINETY_INET_SETTINGS_KEY}" "ProxyEnable" $7
      ${IfThen} ${Errors} ${|} StrCpy $R6 1 ${|}
    ${EndIf}
  ${EndIf}
  ; Маркеры снимаем только после успешной записи: иначе следующий запуск Ninety
  ; (recover_stale_system_proxy) ещё сможет довести восстановление до конца.
  ${If} $R6 = 0
    WriteRegDWORD HKCU "${NINETY_STATE_KEY}" "SavedProxyValid" 0
    DeleteRegValue HKCU "${NINETY_STATE_KEY}" "ActiveProxyServer"
  ${EndIf}
  ; INTERNET_OPTION_SETTINGS_CHANGED (39) и INTERNET_OPTION_REFRESH (37): без
  ; них уже запущенные браузеры продолжают ходить на старый порт.
  System::Call 'wininet::InternetSetOptionW(p 0, i 39, p 0, i 0)'
  System::Call 'wininet::InternetSetOptionW(p 0, i 37, p 0, i 0)'

  ninety_proxy_done:
  Pop $R6
  Pop $R5
  Pop $R4
  Pop $R3
  Pop $R2
  Pop $R1
  Pop $R0
  Pop $9
  Pop $8
  Pop $7
  Pop $6
  Pop $5
  Pop $4
  Pop $3
  Pop $2
  Pop $1
  Pop $0
FunctionEnd

; Завершает процессы Ninety из $INSTDIR. Параметр на стеке: 1 — только главный
; exe, 0 — все наши бинарники. Имя отсекает чужие программы, путь образа —
; одноимённые копии вне каталога установки (тот же барьер, что
; dpi.rs::kill_stray_winws). Без PowerShell/WMI: CIM-запрос стартует секундами
; и при подвисшем WMI ждёт без таймаута — Rust-код от него уже отказался.
Function ${PREFIX}NinetyStopInstalledProcesses
  Exch $R7
  Push $0
  Push $1
  Push $2
  Push $3
  Push $4
  Push $5
  Push $6
  Push $7
  Push $8
  Push $9
  Push $R8
  Push $R9

  StrCpy $R8 "$INSTDIR\"
  StrLen $R9 $R8
  ; Пустой каталог или корень диска — не повод перебирать процессы.
  IntCmp $R9 4 ninety_stop_done ninety_stop_done
  ; TH32CS_SNAPPROCESS
  System::Call 'kernel32::CreateToolhelp32Snapshot(i 2, i 0) p .r0'
  ${If} $0 = 0
  ${OrIf} $0 = -1
    Goto ninety_stop_done
  ${EndIf}
  ; PROCESSENTRY32W; первое поле dwSize обязано хранить размер структуры.
  System::Call '*(i ${NINETY_PROCESSENTRY32W_SIZE}, i, i, p, i, i, i, i, i, &w260) p .r1'
  ${If} $1 = 0
    System::Call 'kernel32::CloseHandle(p r0)'
    Goto ninety_stop_done
  ${EndIf}
  System::Call 'kernel32::Process32FirstW(p r0, p r1) i .r2'
  ${DoWhile} $2 <> 0
    ; $3 — PID, $4 — имя образа без пути.
    System::Call '*$1(i, i, i .r3, p, i, i, i, i, i, &w260 .r4)'
    StrCpy $5 0
    ${If} $4 == "${MAINBINARYNAME}.exe"
      StrCpy $5 1
    ${ElseIf} $R7 <> 1
      ${If} $4 == "sing-box.exe"
      ${OrIf} $4 == "xray.exe"
      ${OrIf} $4 == "naive.exe"
      ${OrIf} $4 == "trusttunnel_client.exe"
      ${OrIf} $4 == "winws.exe"
      ${OrIf} $4 == "ninety-tunnel-svc.exe"
        StrCpy $5 1
      ${EndIf}
    ${EndIf}
    ${If} $5 = 1
      ; PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_TERMINATE | SYNCHRONIZE
      System::Call 'kernel32::OpenProcess(i 0x00101001, i 0, i r3) p .r6'
      ${If} $6 <> 0
        System::Call 'kernel32::QueryFullProcessImageNameW(p r6, i 0, w .r7, *i ${NSIS_MAX_STRLEN} r9) i .r8'
        ${If} $8 <> 0
          ; Префикс с завершающим "\" — граница каталога: ...\Ninety-old\ не подходит.
          StrCpy $9 $7 $R9
          ${If} $9 == $R8
            DetailPrint "Завершаем $7"
            System::Call 'kernel32::TerminateProcess(p r6, i 1) i .r8'
            ; Дождаться выхода: образ и хэндлы отпускаются только после него.
            System::Call 'kernel32::WaitForSingleObject(p r6, i 3000) i .r8'
          ${EndIf}
        ${EndIf}
        System::Call 'kernel32::CloseHandle(p r6)'
      ${EndIf}
    ${EndIf}
    System::Call 'kernel32::Process32NextW(p r0, p r1) i .r2'
  ${Loop}
  System::Free $1
  System::Call 'kernel32::CloseHandle(p r0)'

  ninety_stop_done:
  Pop $R9
  Pop $R8
  Pop $9
  Pop $8
  Pop $7
  Pop $6
  Pop $5
  Pop $4
  Pop $3
  Pop $2
  Pop $1
  Pop $0
  Pop $R7
FunctionEnd

; Дописывает в $R0 (накопитель NinetyPrivilegedCleanup) снятие службы драйвера,
; если её ImagePath (вида \??\C:\...\dpi\bin\WinDivert64.sys) лежит внутри
; $INSTDIR. Тот же критерий, что dpi.rs::remember_owned_driver_services.
Function ${PREFIX}NinetyQueueOwnedDriver
  Exch $R1
  Push $R2
  Push $R3
  ; Пустой каталог или корень диска: префикс "\" совпал бы с \SystemRoot\...
  StrLen $R3 "$INSTDIR\"
  IntCmp $R3 4 ninety_driver_done ninety_driver_done
  ClearErrors
  ReadRegStr $R2 HKLM "SYSTEM\CurrentControlSet\Services\$R1" "ImagePath"
  ${IfNot} ${Errors}
    StrCpy $R3 $R2 1
    ${If} $R3 == "$\""
      StrCpy $R2 $R2 "" 1
    ${EndIf}
    StrCpy $R3 $R2 4
    ${If} $R3 == "\??\"
    ${OrIf} $R3 == "\\?\"
      StrCpy $R2 $R2 "" 4
    ${EndIf}
    StrLen $R3 "$INSTDIR\"
    StrCpy $R2 $R2 $R3
    ${If} $R2 == "$INSTDIR\"
      ${If} $R0 != ""
        StrCpy $R0 "$R0 & "
      ${EndIf}
      StrCpy $R0 '$R0"$SYSDIR\sc.exe" stop $R1 & "$SYSDIR\sc.exe" delete $R1'
    ${EndIf}
  ${EndIf}
  ninety_driver_done:
  Pop $R3
  Pop $R2
  Pop $R1
FunctionEnd

; Снятие kernel-драйвера и legacy-службы одним elevated-вызовом — только когда
; есть что снимать. `sc query` и чтение ImagePath прав не требуют.
Function ${PREFIX}NinetyPrivilegedCleanup
  Push $R0
  Push $0
  StrCpy $R0 ""
  nsExec::Exec '"$SYSDIR\sc.exe" query NinetyTunnelService'
  Pop $0
  ${If} $0 == "0"
    StrCpy $R0 '"$SYSDIR\sc.exe" stop NinetyTunnelService & "$SYSDIR\sc.exe" delete NinetyTunnelService'
  ${EndIf}
  ; WinDivert14 проверяем тоже: старый код удалял его только попутно и
  ; пропускал случай, когда осталась только эта служба.
  !insertmacro NinetyQueueOwnedDriver "${PREFIX}" "WinDivert"
  !insertmacro NinetyQueueOwnedDriver "${PREFIX}" "WinDivert14"
  !insertmacro NinetyQueueOwnedDriver "${PREFIX}" "Monkey"
  ${If} $R0 != ""
    DetailPrint "Очищаем системные компоненты Ninety (нужны права администратора)..."
    ; Каждый sc.exe задан абсолютным путём: elevated cmd не должен искать
    ; подменённый sc.cmd/sc.bat в каталоге, откуда пользователь запустил Setup.
    ExecShellWait "runas" "$SYSDIR\cmd.exe" '/d /s /c "$R0"' SW_HIDE
  ${EndIf}
  Pop $0
  Pop $R0
FunctionEnd

!macroend

!insertmacro NinetyDefineHookFunctions ""
!insertmacro NinetyDefineHookFunctions "un."

; Общая часть хуков. Порядок важен:
;  1. прокси — до завершения процессов (иначе он остаётся на мёртвом порту);
;  2. сначала главный exe: живой Ninety перезапустил бы убитый движок;
;  3. прокси ещё раз — живой Ninety мог переустановить его, заметив потерю
;     прокси между шагами 1 и 2. Повтор идемпотентен;
;  4. драйвер — после winws: тот держит handle к \\.\WinDivert.
!macro NinetyStopRuntime PREFIX
  Call ${PREFIX}NinetyRestoreSystemProxy
  Push 1
  Call ${PREFIX}NinetyStopInstalledProcesses
  Push 0
  Call ${PREFIX}NinetyStopInstalledProcesses
  Call ${PREFIX}NinetyRestoreSystemProxy
  ; Дать winws отпустить handle к \\.\WinDivert до того, как будем снимать драйвер.
  Sleep 1000
  ; На актуальной установке, которая штатно остановила DPI перед OTA, это тихий
  ; no-op: служб, указывающих в $INSTDIR, уже нет.
  Call ${PREFIX}NinetyPrivilegedCleanup
  Sleep 500
!macroend

!macro NSIS_HOOK_PREINSTALL
  DetailPrint "Подготовка к установке: завершаем компоненты Ninety..."
  !insertmacro NinetyStopRuntime ""
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  DetailPrint "Завершаем компоненты Ninety..."
  !insertmacro NinetyStopRuntime "un."
  ; Подстраховка на случай, если драйвер всё же не выгрузился (UAC отклонён и т.п.):
  ; .sys залочен → удалить сейчас нельзя. Помечаем на снос при перезагрузке, чтобы
  ; каталог установки не оставался «грязным» после деинсталляции.
  Delete /REBOOTOK "$INSTDIR\dpi\bin\WinDivert64.sys"
  Delete /REBOOTOK "$INSTDIR\dpi\bin-monkey\Monkey64.sys"
!macroend

; ── Пользовательская интеграция (только деинсталлятор) ─────────────────────
; То, что Ninety заводит уже после установки: задача автозапуска в
; Планировщике и обработчики VPN-ссылок в HKCU. Вызывается из секции Uninstall
; только при настоящем удалении — не при OTA и не при переустановке.

; Задача автозапуска установленной копии (proxy_win.rs::task_name). Задачу
; portable-копии не трогаем: у неё своё имя и свой владелец. Best-effort: задачу
; создавал elevated schtasks, и без прав её не удалить — ошибку игнорируем.
Function un.NinetyRemoveAutostartTask
  Push $0
  Push $1
  ; Имя задачи не зависит от каталога. Если в другом контексте установки
  ; (per-user ↔ per-machine) осталась живая копия, задача может быть её.
  ReadRegStr $0 HKLM "${MANUPRODUCTKEY}" ""
  ReadRegStr $1 HKCU "${MANUPRODUCTKEY}" ""
  ${If} $0 != ""
  ${AndIf} $0 != $INSTDIR
  ${AndIf} ${FileExists} "$0\${MAINBINARYNAME}.exe"
    Goto ninety_task_keep
  ${EndIf}
  ${If} $1 != ""
  ${AndIf} $1 != $INSTDIR
  ${AndIf} ${FileExists} "$1\${MAINBINARYNAME}.exe"
    Goto ninety_task_keep
  ${EndIf}
  nsExec::Exec '"$SYSDIR\schtasks.exe" /Delete /TN "${NINETY_AUTOSTART_TASK}" /F'
  Pop $0
  ninety_task_keep:
  Pop $1
  Pop $0
FunctionEnd

!macro NinetyRemoveLinkHandler SCHEME UPPER
  Push "${UPPER}"
  Push "${SCHEME}"
  Call un.NinetyRemoveLinkHandler
!macroend

; Повтор url_handler.rs::unregister_url_handler для exe этой установки: схему
; снимаем, только если её команда указывает на $INSTDIR\Ninety.exe; прежнего
; владельца (резервная копия, которую register_url_handler сделал перед
; захватом) возвращаем. Стек: схема, затем она же в верхнем регистре.
Function un.NinetyRemoveLinkHandler
  Exch $R0
  Exch
  Exch $R1
  Push $R2
  Push $R3
  Push $R4
  Push $R5
  StrCpy $R5 '"$INSTDIR\${MAINBINARYNAME}.exe" "%1"'
  ReadRegStr $R2 HKCU "Software\Classes\$R0\shell\open\command" ""
  ${If} $R2 == $R5
    StrCpy $R4 0
    ClearErrors
    ReadRegDWORD $R2 HKCU "${NINETY_STATE_KEY}\UrlHandlers\$R0" "Saved"
    ${IfNot} ${Errors}
    ${AndIf} $R2 = 1
      ReadRegDWORD $R2 HKCU "${NINETY_STATE_KEY}\UrlHandlers\$R0" "PreviousCommandPresent"
      ${IfNot} ${Errors}
      ${AndIf} $R2 = 1
        ReadRegStr $R3 HKCU "${NINETY_STATE_KEY}\UrlHandlers\$R0" "PreviousCommand"
        ${IfNot} ${Errors}
          ; Обрезанную или нашу же команду не возвращаем — схема просто снимается.
          StrLen $R2 $R3
          ${If} $R2 < ${NINETY_REG_STR_LIMIT}
          ${AndIf} $R3 != $R5
            StrCpy $R4 1
          ${EndIf}
        ${EndIf}
      ${EndIf}
    ${EndIf}
    ClearErrors
    ${If} $R4 = 1
      WriteRegStr HKCU "Software\Classes\$R0" "" "URL:$R1 Protocol"
      WriteRegStr HKCU "Software\Classes\$R0" "URL Protocol" ""
      WriteRegStr HKCU "Software\Classes\$R0\shell\open\command" "" $R3
    ${Else}
      DeleteRegKey HKCU "Software\Classes\$R0"
    ${EndIf}
    ; Резервную копию стираем только после успешной записи, как в Rust.
    ${IfNot} ${Errors}
      DeleteRegKey HKCU "${NINETY_STATE_KEY}\UrlHandlers\$R0"
    ${EndIf}
  ${EndIf}
  Pop $R5
  Pop $R4
  Pop $R3
  Pop $R2
  Pop $R1
  Pop $R0
FunctionEnd

Function un.NinetyRemoveLinkHandlers
  ; Схемы = url_handler.rs::SUPPORTED_SCHEMES (сверяет check-installer.mjs).
  !insertmacro NinetyRemoveLinkHandler "vless" "VLESS"
  !insertmacro NinetyRemoveLinkHandler "vmess" "VMESS"
  !insertmacro NinetyRemoveLinkHandler "ss" "SS"
  !insertmacro NinetyRemoveLinkHandler "trojan" "TROJAN"
  !insertmacro NinetyRemoveLinkHandler "hysteria2" "HYSTERIA2"
  !insertmacro NinetyRemoveLinkHandler "hy2" "HY2"
  !insertmacro NinetyRemoveLinkHandler "hysteria" "HYSTERIA"
  !insertmacro NinetyRemoveLinkHandler "tuic" "TUIC"
  !insertmacro NinetyRemoveLinkHandler "sub" "SUB"
  !insertmacro NinetyRemoveLinkHandler "anytls" "ANYTLS"
  !insertmacro NinetyRemoveLinkHandler "tt" "TT"
  !insertmacro NinetyRemoveLinkHandler "naive+https" "NAIVE+HTTPS"
  !insertmacro NinetyRemoveLinkHandler "naive+quic" "NAIVE+QUIC"
  ; ninety:// на per-machine установке плагин deep-link при каждом запуске
  ; дописывает в HKCU, а шаблон снимает только регистрацию из SHCTX (HKLM).
  !insertmacro NinetyRemoveLinkHandler "ninety" "NINETY"
  DeleteRegKey /ifempty HKCU "${NINETY_STATE_KEY}\UrlHandlers"
FunctionEnd
