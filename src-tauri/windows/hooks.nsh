; hooks.nsh — pre-install / pre-uninstall actions для Ninety.
; Подключается через bundle.windows.nsis.installerHooks в tauri.conf.json.
;
; Зачем нужно: перед апдейтом/удалением гасим запущенные процессы Ninety и ядра
; (sing-box.exe, xray.exe), а также снимаем kernel-драйвер WinDivert/Monkey —
; иначе NSIS падает на "файл занят".
;
; ВАЖНО про драйвер: WinDivert64.sys/Monkey64.sys лежат В каталоге установки, и
; пока драйвер загружен в ядро, этот .sys залочен и его не перезаписать/удалить.
; Снять kernel-службу можно ТОЛЬКО с админ-правами, а инсталлятор/деинсталлятор
; собран как currentUser (ставит в AppData\Local) → он НЕ elevated, и обычный
; `sc stop` падает с Access Denied. Поэтому драйвер снимаем штатно из самой аппы
; (full_unload при выходе/перед OTA — там она elevated), а здесь — gated UAC как
; подстраховка: поднимаем права ТОЛЬКО если служба реально зарегистрирована
; (после штатного выхода Ninety её уже нет → лишний UAC не дёргаем).
;
; NinetyTunnelService — ЛЕГАСИ: до alpha55 TUN работал через эту службу. С
; Throne-style элевацией служба больше не ставится, но у апгрейдящихся с alpha54-
; она ещё установлена — поэтому здесь её принудительно сносим.

; Снятие kernel-драйвера WinDivert/Monkey одним elevated-вызовом, но только когда
; драйвер реально загружен (есть служба). sc query прав не требует: код 0 = служба
; есть. На драйвере `sc stop` синхронный → к delete он уже выгружен, служба-сирота
; не повисает. Метка с ${__LINE__} — уникальна на каждую вставку макроса.
!macro NinetyDriverCleanup
  Push $R0
  Push $0
  StrCpy $R0 "0"
  nsExec::Exec '"$SYSDIR\sc.exe" query WinDivert'
  Pop $0
  StrCmp $0 "0" 0 +2
    StrCpy $R0 "1"
  nsExec::Exec '"$SYSDIR\sc.exe" query Monkey'
  Pop $0
  StrCmp $0 "0" 0 +2
    StrCpy $R0 "1"
  StrCmp $R0 "1" 0 ninety_drv_done_${__LINE__}
    DetailPrint "Снимаем kernel-драйвер WinDivert (нужны права администратора)..."
    ExecShellWait "runas" "$SYSDIR\cmd.exe" '/c sc stop WinDivert & sc delete WinDivert & sc stop WinDivert14 & sc delete WinDivert14 & sc stop Monkey & sc delete Monkey' SW_HIDE
  ninety_drv_done_${__LINE__}:
  Pop $0
  Pop $R0
!macroend

!macro NSIS_HOOK_PREINSTALL
  DetailPrint "Подготовка к установке: завершаем компоненты Ninety..."
  ; Легаси-служба NinetyTunnelService (TUN до alpha55). У давно не обновлявшихся
  ; ещё может быть установлена — тихо сносим, на актуальных версиях это no-op.
  nsExec::Exec '"$SYSDIR\sc.exe" stop NinetyTunnelService'
  Pop $0
  ; sc stop асинхронный — даём время на корректное завершение
  Sleep 1500
  nsExec::Exec '"$SYSDIR\taskkill.exe" /F /IM ninety-tunnel-svc.exe'
  Pop $0
  nsExec::Exec '"$SYSDIR\sc.exe" delete NinetyTunnelService'
  Pop $0
  nsExec::Exec '"$SYSDIR\taskkill.exe" /F /IM Ninety.exe'
  Pop $0
  nsExec::Exec '"$SYSDIR\taskkill.exe" /F /IM sing-box.exe'
  Pop $0
  ; two-core: xray-sidecar лочит xray.exe — без остановки апдейт падает на
  ; "файл занят другим процессом".
  nsExec::Exec '"$SYSDIR\taskkill.exe" /F /IM xray.exe'
  Pop $0
  ; DPI-обход: winws.exe лочит свой бинарь и драйвер WinDivert — гасим перед
  ; апдейтом, иначе NSIS падает на "файл занят".
  nsExec::Exec '"$SYSDIR\taskkill.exe" /F /IM winws.exe'
  Pop $0
  ; Дать winws отпустить handle к \\.\WinDivert до того, как будем снимать драйвер.
  Sleep 1000
  ; Снять kernel-драйвер (gated UAC). В норме OTA уже снял его elevated-аппой
  ; (update-modal → dpi_unload_driver) → служба отсутствует → UAC не появится.
  !insertmacro NinetyDriverCleanup
  Sleep 500
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  DetailPrint "Завершаем компоненты Ninety..."
  ; Легаси-служба (см. PREINSTALL) — тихий no-op на актуальных версиях.
  nsExec::Exec '"$SYSDIR\sc.exe" stop NinetyTunnelService'
  Pop $0
  Sleep 1500
  nsExec::Exec '"$SYSDIR\taskkill.exe" /F /IM ninety-tunnel-svc.exe'
  Pop $0
  nsExec::Exec '"$SYSDIR\sc.exe" delete NinetyTunnelService'
  Pop $0
  nsExec::Exec '"$SYSDIR\taskkill.exe" /F /IM Ninety.exe'
  Pop $0
  nsExec::Exec '"$SYSDIR\taskkill.exe" /F /IM sing-box.exe'
  Pop $0
  nsExec::Exec '"$SYSDIR\taskkill.exe" /F /IM xray.exe'
  Pop $0
  nsExec::Exec '"$SYSDIR\taskkill.exe" /F /IM winws.exe'
  Pop $0
  ; Дать winws отпустить handle к \\.\WinDivert до снятия драйвера.
  Sleep 1000
  ; Фул-очистка: снять kernel-драйвер (gated UAC — поднимется, если аппу убили
  ; taskkill'ом раньше, чем она успела снять драйвер сама).
  !insertmacro NinetyDriverCleanup
  ; Подстраховка на случай, если драйвер всё же не выгрузился (UAC отклонён и т.п.):
  ; .sys залочен → удалить сейчас нельзя. Помечаем на снос при перезагрузке, чтобы
  ; каталог установки не оставался «грязным» после деинсталляции.
  Delete /REBOOTOK "$INSTDIR\dpi\bin\WinDivert64.sys"
  Delete /REBOOTOK "$INSTDIR\dpi\bin-monkey\Monkey64.sys"
!macroend
