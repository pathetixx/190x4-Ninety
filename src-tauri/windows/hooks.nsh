; hooks.nsh — pre-install / pre-uninstall actions для Ninety.
; Подключается через bundle.windows.nsis.installerHooks в tauri.conf.json.
;
; Зачем нужно: TUN-режим работает через Windows Service NinetyTunnelService,
; который держит файл ninety-tunnel-svc.exe залоченным. Без остановки сервиса
; апдейт упадёт на "файл занят другим процессом".
;
; Аналог inno_setup.sas:69-77 из Hiddify (taskkill + net stop + sc delete).

!macro NSIS_HOOK_PREINSTALL
  DetailPrint "Останавливаем NinetyTunnelService (если установлен)..."
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
  DetailPrint "Останавливаем NinetyTunnelService..."
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
