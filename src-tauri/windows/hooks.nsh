; hooks.nsh — pre-install / pre-uninstall actions for Ninety.
; Wired via bundle.windows.nsis.installerHooks in tauri.conf.json.
;
; Why it's needed: before an update/uninstall we kill running Ninety processes, cores and
; sidecar clients (sing-box/xray/naive/TrustTunnel), and also remove the WinDivert/Monkey
; kernel driver — otherwise NSIS fails with "file in use".
;
; We terminate ONLY processes with our binaries' names whose image lies inside
; $INSTDIR. The former `taskkill /IM` killed same-named processes of other programs:
; xray.exe/sing-box.exe of v2rayN, winws.exe of zapret/Flowseal.
;
; System proxy: Ninety's regular exit (RunEvent::Exit → vpn::force_cleanup)
; restores the Windows proxy, but a forced termination doesn't. So BEFORE
; terminating the processes we repeat the logic of proxy_win.rs::set_system_proxy(false),
; otherwise after uninstalling/reinstalling browsers stay on a dead port. The hook
; runs as the user who launched the (un)installer: HKCU is their hive.
;
; IMPORTANT about the driver: WinDivert64.sys/Monkey64.sys live IN the install directory, and
; while the driver is loaded in the kernel, this .sys is locked and can't be overwritten/deleted.
; A kernel service can be removed ONLY with admin rights, while the installer/uninstaller
; may run in per-user mode without elevation, and a regular `sc stop` then
; fails with Access Denied. So the driver is removed regularly by the app itself
; (full_unload on exit/before OTA — there it's elevated), and here — a UAC-gated
; safeguard: we elevate ONLY if there's something to remove — a legacy service
; or a driver service whose ImagePath points inside $INSTDIR. The WinDivert service
; is registered by other programs too (zapret, Flowseal) — we don't touch someone else's.
;
; NinetyTunnelService is LEGACY: before alpha55 TUN worked through this service. With
; Throne-style elevation the service is no longer installed, but for those upgrading from alpha54
; and below it's still installed — so here we forcibly remove it.

; Process enumeration reads PROCESSENTRY32W via System::Call; the layout below
; is designed for 32-bit NSIS (Tauri builds x86-unicode). On 64-bit
; th32DefaultHeapID is aligned to 8 bytes, and the fields would silently shift.
!if ${NSIS_PTR_SIZE} != 4
  !error "hooks.nsh: разметка PROCESSENTRY32W рассчитана на 32-битный NSIS"
!endif
; sizeof(PROCESSENTRY32W) in a 32-bit process: 9 fields of 4 bytes + 260 WCHAR.
!define NINETY_PROCESSENTRY32W_SIZE 556

; Must match the proxy_win.rs constants (checked by check-installer.mjs).
!define NINETY_INET_SETTINGS_KEY "Software\Microsoft\Windows\CurrentVersion\Internet Settings"
!define NINETY_STATE_KEY "Software\Ninety"
!define NINETY_PROXY_OVERRIDE "localhost;127.*;10.*;172.16.*;172.17.*;172.18.*;172.19.*;172.20.*;172.21.*;172.22.*;172.23.*;172.24.*;172.25.*;172.26.*;172.27.*;172.28.*;172.29.*;172.30.*;172.31.*;192.168.*;<local>"
!define NINETY_PROXY_OVERRIDE_LOOPBACK "localhost;127.*"
!define NINETY_LEGACY_PROXY_SERVER "127.0.0.1:7890"
!define NINETY_AUTOSTART_TASK "Ninety"
; NSIS doesn't read longer values from the registry: such a string may come out truncated.
!define /math NINETY_REG_STR_LIMIT ${NSIS_MAX_STRLEN} - 1

!macro NinetyQueueOwnedDriver PREFIX SERVICE
  Push "${SERVICE}"
  Call ${PREFIX}NinetyQueueOwnedDriver
!macroend

; The functions are needed by both the installer and the uninstaller (there they must be named
; with the un. prefix), so they're defined twice via a macro. Labels inside functions
; are local — they don't need unique suffixes.
!macro NinetyDefineHookFunctions PREFIX

; Repeating proxy_win.rs::set_system_proxy(false): proxy_recovery_action +
; read_proxy_snapshot + restore_proxy_settings. We touch the Windows proxy only
; if it's provably ours (ProxyEnable=1 and ProxyServer = ActiveProxyServer or
; the historical 127.0.0.1:7890 with a valid snapshot). A proxy the
; user changed themselves stays as is — we only forget our markers.
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

  ; Current settings: $0 ProxyEnable, $1 ProxyServer, $2 ProxyOverride and $3 —
  ; whether it's set at all.
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

  ; Ownership marker: $4 ActiveProxyServer, $5 — whether it's set.
  ClearErrors
  ReadRegStr $4 HKCU "${NINETY_STATE_KEY}" "ActiveProxyServer"
  ${If} ${Errors}
    StrCpy $4 ""
    StrCpy $5 0
  ${Else}
    StrCpy $5 1
  ${EndIf}

  ; Snapshot of the previous settings with the same checks as read_proxy_snapshot:
  ; $6 — valid, $7 SavedProxyEnable, $8/$9 the server and its presence flag, $R0/$R1
  ; the exclusions and their flag. $R5 — the SavedProxyValid value exists (it can be zeroed
  ; without creating the state key anew).
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

  ; $R3 — the current exclusion list is ours (case-sensitive, as in Rust).
  StrCpy $R3 0
  ${If} $3 = 1
    ${If} $2 S== "${NINETY_PROXY_OVERRIDE}"
    ${OrIf} $2 S== "${NINETY_PROXY_OVERRIDE_LOOPBACK}"
      StrCpy $R3 1
    ${EndIf}
  ${EndIf}

  ; $R2 — the proxy_recovery_action action: 0 leave alone, 1 restore the snapshot,
  ; 2 restore the snapshot keeping a foreign exclusion list, 3 only turn off
  ; our proxy (no snapshot or it's damaged). Addresses are compared case-
  ; insensitively, like eq_ignore_ascii_case.
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

  ; A truncated address can't be restored — then we only turn off our proxy.
  ; A truncated exclusion list isn't written: the current one stays.
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
    ; The proxy isn't ours or there's no proof of ownership: we don't touch
    ; the Windows settings, we forget the stale markers (LeaveUntouched in Rust).
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
    ; Dependent values first, ProxyEnable last: it's the commit marker
    ; that WinINet sees (restore_proxy_settings).
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
  ; Markers are removed only after a successful write: otherwise the next Ninety launch
  ; (recover_stale_system_proxy) can still finish the restore.
  ${If} $R6 = 0
    WriteRegDWORD HKCU "${NINETY_STATE_KEY}" "SavedProxyValid" 0
    DeleteRegValue HKCU "${NINETY_STATE_KEY}" "ActiveProxyServer"
  ${EndIf}
  ; INTERNET_OPTION_SETTINGS_CHANGED (39) and INTERNET_OPTION_REFRESH (37): without
  ; them already running browsers keep going to the old port.
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

; Terminates Ninety processes from $INSTDIR. The parameter on the stack: 1 — only the main
; exe, 0 — all our binaries. The name cuts off other programs, the image path —
; same-named copies outside the install directory (the same barrier as
; dpi.rs::kill_stray_winws). No PowerShell/WMI: a CIM query takes seconds to start
; and with a hung WMI waits without a timeout — the Rust code already dropped it.
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
  ; An empty directory or a drive root is no reason to enumerate processes.
  IntCmp $R9 4 ninety_stop_done ninety_stop_done
  ; TH32CS_SNAPPROCESS
  System::Call 'kernel32::CreateToolhelp32Snapshot(i 2, i 0) p .r0'
  ${If} $0 = 0
  ${OrIf} $0 = -1
    Goto ninety_stop_done
  ${EndIf}
  ; PROCESSENTRY32W; the first field dwSize must hold the structure size.
  System::Call '*(i ${NINETY_PROCESSENTRY32W_SIZE}, i, i, p, i, i, i, i, i, &w260) p .r1'
  ${If} $1 = 0
    System::Call 'kernel32::CloseHandle(p r0)'
    Goto ninety_stop_done
  ${EndIf}
  System::Call 'kernel32::Process32FirstW(p r0, p r1) i .r2'
  ${DoWhile} $2 <> 0
    ; $3 — PID, $4 — the image name without the path.
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
          ; A prefix with a trailing "\" is the directory boundary: ...\Ninety-old\ doesn't match.
          StrCpy $9 $7 $R9
          ${If} $9 == $R8
            DetailPrint "Завершаем $7"
            System::Call 'kernel32::TerminateProcess(p r6, i 1) i .r8'
            ; Wait for the exit: the image and handles are released only after it.
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

; Appends to $R0 (the NinetyPrivilegedCleanup accumulator) the removal of the driver service
; if its ImagePath (like \??\C:\...\dpi\bin\WinDivert64.sys) lies inside
; $INSTDIR. The same criterion as dpi.rs::remember_owned_driver_services.
Function ${PREFIX}NinetyQueueOwnedDriver
  Exch $R1
  Push $R2
  Push $R3
  ; An empty directory or a drive root: the "\" prefix would match \SystemRoot\...
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

; Removing the kernel driver and the legacy service with one elevated call — only when
; there's something to remove. `sc query` and reading ImagePath don't require rights.
Function ${PREFIX}NinetyPrivilegedCleanup
  Push $R0
  Push $0
  StrCpy $R0 ""
  nsExec::Exec '"$SYSDIR\sc.exe" query NinetyTunnelService'
  Pop $0
  ${If} $0 == "0"
    StrCpy $R0 '"$SYSDIR\sc.exe" stop NinetyTunnelService & "$SYSDIR\sc.exe" delete NinetyTunnelService'
  ${EndIf}
  ; We check WinDivert14 too: the old code removed it only incidentally and
  ; missed the case when only this service remained.
  !insertmacro NinetyQueueOwnedDriver "${PREFIX}" "WinDivert"
  !insertmacro NinetyQueueOwnedDriver "${PREFIX}" "WinDivert14"
  !insertmacro NinetyQueueOwnedDriver "${PREFIX}" "Monkey"
  ${If} $R0 != ""
    DetailPrint "Очищаем системные компоненты Ninety (нужны права администратора)..."
    ; Each sc.exe is given by an absolute path: the elevated cmd must not look for
    ; a swapped sc.cmd/sc.bat in the directory the user launched Setup from.
    ExecShellWait "runas" "$SYSDIR\cmd.exe" '/d /s /c "$R0"' SW_HIDE
  ${EndIf}
  Pop $0
  Pop $R0
FunctionEnd

!macroend

!insertmacro NinetyDefineHookFunctions ""
!insertmacro NinetyDefineHookFunctions "un."

; The shared part of the hooks. The order matters:
;  1. the proxy — before terminating processes (otherwise it stays on a dead port);
;  2. the main exe first: a live Ninety would restart a killed engine;
;  3. the proxy once more — a live Ninety could have reinstalled it after noticing the loss
;     of the proxy between steps 1 and 2. The repeat is idempotent;
;  4. the driver — after winws: it holds a handle to \\.\WinDivert.
!macro NinetyStopRuntime PREFIX
  Call ${PREFIX}NinetyRestoreSystemProxy
  Push 1
  Call ${PREFIX}NinetyStopInstalledProcesses
  Push 0
  Call ${PREFIX}NinetyStopInstalledProcesses
  Call ${PREFIX}NinetyRestoreSystemProxy
  ; Let winws release the handle to \\.\WinDivert before we remove the driver.
  Sleep 1000
  ; On a current installation that properly stopped DPI before OTA, this is a silent
  ; no-op: there are no services pointing into $INSTDIR anymore.
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
  ; A safeguard in case the driver still didn't unload (UAC declined, etc.):
  ; the .sys is locked → it can't be deleted now. We mark it for deletion on reboot so that
  ; the install directory doesn't stay "dirty" after uninstalling.
  Delete /REBOOTOK "$INSTDIR\dpi\bin\WinDivert64.sys"
  Delete /REBOOTOK "$INSTDIR\dpi\bin-monkey\Monkey64.sys"
!macroend

; ── User integration (uninstaller only) ─────────────────────
; What Ninety creates after installation: the autostart task in
; Task Scheduler and the VPN link handlers in HKCU. Called from the Uninstall section
; only on an actual removal — not on OTA and not on a reinstall.

; The installed copy's autostart task (proxy_win.rs::task_name). The portable copy's
; task isn't touched: it has its own name and its own owner. Best-effort: the task
; was created by an elevated schtasks, and without rights it can't be deleted — the error is ignored.
Function un.NinetyRemoveAutostartTask
  Push $0
  Push $1
  ; The task name doesn't depend on the directory. If a live copy remains in another installation
  ; context (per-user ↔ per-machine), the task may be its.
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

; Repeating url_handler.rs::unregister_url_handler for this installation's exe: the scheme
; is removed only if its command points to $INSTDIR\Ninety.exe; the previous
; owner (the backup register_url_handler made before the
; takeover) is restored. Stack: the scheme, then the same in upper case.
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
          ; A truncated command or our own isn't restored — the scheme is simply removed.
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
    ; The backup is erased only after a successful write, as in Rust.
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
  ; Schemes = url_handler.rs::SUPPORTED_SCHEMES (checked by check-installer.mjs).
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
  ; On a per-machine install the deep-link plugin adds ninety:// to HKCU on every
  ; launch, while the template removes only the registration from SHCTX (HKLM).
  !insertmacro NinetyRemoveLinkHandler "ninety" "NINETY"
  DeleteRegKey /ifempty HKCU "${NINETY_STATE_KEY}\UrlHandlers"
FunctionEnd
