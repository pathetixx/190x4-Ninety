; hooks.nsh — pre-install / pre-uninstall actions для Ninety.
; Подключается через bundle.windows.nsis.installerHooks в tauri.conf.json.
;
; Зачем нужно: перед апдейтом/удалением гасим запущенные процессы Ninety, ядра и
; sidecar-клиенты (sing-box/xray/naive/TrustTunnel), а также снимаем kernel-
; драйвер WinDivert/Monkey — иначе NSIS падает на "файл занят".
;
; ВАЖНО про драйвер: WinDivert64.sys/Monkey64.sys лежат В каталоге установки, и
; пока драйвер загружен в ядро, этот .sys залочен и его не перезаписать/удалить.
; Снять kernel-службу можно ТОЛЬКО с админ-правами, а инсталлятор/деинсталлятор
; может работать в per-user режиме без elevation, и обычный `sc stop` тогда
; падает с Access Denied. Поэтому драйвер снимаем штатно из самой аппы
; (full_unload при выходе/перед OTA — там она elevated), а здесь — gated UAC как
; подстраховка: поднимаем права ТОЛЬКО если одна из наших/legacy-служб реально
; зарегистрирована (после штатного выхода Ninety их нет → лишний UAC не дёргаем).
;
; NinetyTunnelService — ЛЕГАСИ: до alpha55 TUN работал через эту службу. С
; Throne-style элевацией служба больше не ставится, но у апгрейдящихся с alpha54-
; она ещё установлена — поэтому здесь её принудительно сносим.

; Снятие kernel-драйвера и legacy-службы одним elevated-вызовом, но только когда
; хотя бы одна из них реально зарегистрирована. `sc query` прав не требует:
; код 0 = служба есть. Проверяем и WinDivert14: старый код удалял его только
; попутно и пропускал случай, когда осталась только эта служба. Метка с
; ${__LINE__} — уникальна на каждую вставку макроса.
!macro NinetyPrivilegedCleanup UNIQ
  Push $R0
  Push $0
  StrCpy $R0 "0"
  nsExec::Exec '"$SYSDIR\sc.exe" query WinDivert'
  Pop $0
  StrCmp $0 "0" 0 +2
    StrCpy $R0 "1"
  nsExec::Exec '"$SYSDIR\sc.exe" query WinDivert14'
  Pop $0
  StrCmp $0 "0" 0 +2
    StrCpy $R0 "1"
  nsExec::Exec '"$SYSDIR\sc.exe" query Monkey'
  Pop $0
  StrCmp $0 "0" 0 +2
    StrCpy $R0 "1"
  nsExec::Exec '"$SYSDIR\sc.exe" query NinetyTunnelService'
  Pop $0
  StrCmp $0 "0" 0 +2
    StrCpy $R0 "1"
  StrCmp $R0 "1" 0 ninety_drv_done_${UNIQ}
    DetailPrint "Очищаем системные компоненты Ninety (нужны права администратора)..."
    ; Каждый sc.exe задан абсолютным путём: elevated cmd не должен искать
    ; подменённый sc.cmd/sc.bat в каталоге, откуда пользователь запустил Setup.
    ExecShellWait "runas" "$SYSDIR\cmd.exe" '/d /s /c ""$SYSDIR\sc.exe" stop NinetyTunnelService & "$SYSDIR\sc.exe" delete NinetyTunnelService & "$SYSDIR\sc.exe" stop WinDivert & "$SYSDIR\sc.exe" delete WinDivert & "$SYSDIR\sc.exe" stop WinDivert14 & "$SYSDIR\sc.exe" delete WinDivert14 & "$SYSDIR\sc.exe" stop Monkey & "$SYSDIR\sc.exe" delete Monkey"' SW_HIDE
  ninety_drv_done_${UNIQ}:
  Pop $0
  Pop $R0
!macroend

!macro NSIS_HOOK_PREINSTALL
  DetailPrint "Подготовка к установке: завершаем компоненты Ninety..."
  nsExec::Exec '"$SYSDIR\taskkill.exe" /F /IM ninety-tunnel-svc.exe'
  Pop $0
  nsExec::Exec '"$SYSDIR\taskkill.exe" /F /IM Ninety.exe'
  Pop $0
  nsExec::Exec '"$SYSDIR\taskkill.exe" /F /IM sing-box.exe'
  Pop $0
  ; two-core: xray-sidecar лочит xray.exe — без остановки апдейт падает на
  ; "файл занят другим процессом".
  nsExec::Exec '"$SYSDIR\taskkill.exe" /F /IM xray.exe'
  Pop $0
  nsExec::Exec '"$SYSDIR\taskkill.exe" /F /IM naive.exe'
  Pop $0
  nsExec::Exec '"$SYSDIR\taskkill.exe" /F /IM trusttunnel_client.exe'
  Pop $0
  ; DPI-обход: winws.exe лочит свой бинарь и драйвер WinDivert — гасим перед
  ; апдейтом, иначе NSIS падает на "файл занят".
  nsExec::Exec '"$SYSDIR\taskkill.exe" /F /IM winws.exe'
  Pop $0
  ; Дать winws отпустить handle к \\.\WinDivert до того, как будем снимать драйвер.
  Sleep 1000
  ; Легаси-службу и драйверы чистим одним gated UAC. На актуальной установке,
  ; которая штатно остановила DPI перед OTA, это тихий no-op.
  !insertmacro NinetyPrivilegedCleanup "pre"
  Sleep 500
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  DetailPrint "Завершаем компоненты Ninety..."
  nsExec::Exec '"$SYSDIR\taskkill.exe" /F /IM ninety-tunnel-svc.exe'
  Pop $0
  nsExec::Exec '"$SYSDIR\taskkill.exe" /F /IM Ninety.exe'
  Pop $0
  nsExec::Exec '"$SYSDIR\taskkill.exe" /F /IM sing-box.exe'
  Pop $0
  nsExec::Exec '"$SYSDIR\taskkill.exe" /F /IM xray.exe'
  Pop $0
  nsExec::Exec '"$SYSDIR\taskkill.exe" /F /IM naive.exe'
  Pop $0
  nsExec::Exec '"$SYSDIR\taskkill.exe" /F /IM trusttunnel_client.exe'
  Pop $0
  nsExec::Exec '"$SYSDIR\taskkill.exe" /F /IM winws.exe'
  Pop $0
  ; Дать winws отпустить handle к \\.\WinDivert до снятия драйвера.
  Sleep 1000
  ; Легаси-служба и драйверы — тот же gated cleanup, что перед обновлением.
  !insertmacro NinetyPrivilegedCleanup "un"
  Sleep 500
  ; Подстраховка на случай, если драйвер всё же не выгрузился (UAC отклонён и т.п.):
  ; .sys залочен → удалить сейчас нельзя. Помечаем на снос при перезагрузке, чтобы
  ; каталог установки не оставался «грязным» после деинсталляции.
  Delete /REBOOTOK "$INSTDIR\dpi\bin\WinDivert64.sys"
  Delete /REBOOTOK "$INSTDIR\dpi\bin-monkey\Monkey64.sys"
!macroend
