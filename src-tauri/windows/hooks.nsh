; hooks.nsh — pre-install / pre-uninstall actions для Ninety.
; Подключается через bundle.windows.nsis.installerHooks в tauri.conf.json.
;
; Зачем нужно: перед апдейтом/удалением гасим запущенные процессы Ninety и
; ядра (sing-box.exe, xray.exe) — иначе NSIS падает на "файл занят".
;
; NinetyTunnelService — ЛЕГАСИ: до alpha55 TUN работал через эту службу.
; С Throne-style элевацией служба больше не ставится, но у апгрейдящихся с
; alpha54- она ещё установлена — поэтому здесь её принудительно сносим
; (sc stop + delete + taskkill ninety-tunnel-svc.exe). После одного апдейта
; на машине не остаётся ни службы, ни её бинаря.

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
  ; Сам kernel-драйвер WinDivert после kill winws остаётся загружен и держит
  ; WinDivert64.sys залоченным → снимаем службу. Основную выгрузку делает аппа из
  ; Rust (dpi_unload_driver) ДО загрузки апдейта; под perUser-инсталлером прав на
  ; sc может не быть — здесь это подстраховка (имя WinDivert/WinDivert14).
  nsExec::Exec '"$SYSDIR\sc.exe" stop WinDivert'
  Pop $0
  nsExec::Exec '"$SYSDIR\sc.exe" stop WinDivert14'
  Pop $0
  nsExec::Exec '"$SYSDIR\sc.exe" delete WinDivert'
  Pop $0
  nsExec::Exec '"$SYSDIR\sc.exe" delete WinDivert14'
  Pop $0
  ; Monkey — наш переименованный вариант драйвера WinDivert (см. dpi.rs bin_dir).
  nsExec::Exec '"$SYSDIR\sc.exe" stop Monkey'
  Pop $0
  nsExec::Exec '"$SYSDIR\sc.exe" delete Monkey'
  Pop $0
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
  nsExec::Exec '"$SYSDIR\sc.exe" stop WinDivert'
  Pop $0
  nsExec::Exec '"$SYSDIR\sc.exe" stop WinDivert14'
  Pop $0
  nsExec::Exec '"$SYSDIR\sc.exe" delete WinDivert'
  Pop $0
  nsExec::Exec '"$SYSDIR\sc.exe" delete WinDivert14'
  Pop $0
  ; Monkey — наш переименованный вариант драйвера WinDivert (см. dpi.rs bin_dir).
  nsExec::Exec '"$SYSDIR\sc.exe" stop Monkey'
  Pop $0
  nsExec::Exec '"$SYSDIR\sc.exe" delete Monkey'
  Pop $0
!macroend
