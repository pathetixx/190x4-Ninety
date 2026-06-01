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
  DetailPrint "Сносим легаси-службу NinetyTunnelService (если осталась с alpha54-)..."
  nsExec::Exec '"$SYSDIR\sc.exe" stop NinetyTunnelService'
  Pop $0
  ; sc stop асинхронный — даём время на корректное завершение
  Sleep 1500
  nsExec::Exec '"$SYSDIR\taskkill.exe" /F /IM ninety-tunnel-svc.exe'
  Pop $0
  nsExec::Exec '"$SYSDIR\sc.exe" delete NinetyTunnelService'
  Pop $0
  DetailPrint "Закрываем запущенные процессы Ninety..."
  nsExec::Exec '"$SYSDIR\taskkill.exe" /F /IM Ninety.exe'
  Pop $0
  nsExec::Exec '"$SYSDIR\taskkill.exe" /F /IM sing-box.exe'
  Pop $0
  ; two-core: xray-sidecar лочит xray.exe — без остановки апдейт падает на
  ; "файл занят другим процессом".
  nsExec::Exec '"$SYSDIR\taskkill.exe" /F /IM xray.exe'
  Pop $0
  Sleep 500
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  DetailPrint "Сносим легаси-службу NinetyTunnelService (если осталась)..."
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
!macroend
