; Ninety — Kurogane Split installer shell.
; The NSIS engine keeps ownership of navigation and progress. This layer only
; replaces the window resources, applies the visual system and mirrors progress.

!include LogicLib.nsh
!include nsDialogs.nsh
!include WinMessages.nsh

!define MUI_UI "${__FILEDIR__}\kurogane-ui.exe"
!define MUI_CUSTOMFUNCTION_GUIINIT KuroganeGuiInit
!define MUI_CUSTOMFUNCTION_UNGUIINIT un.KuroganeGuiInit

!define K_COLOR_WINDOW  "0B0B0E"
!define K_COLOR_PANEL   "101014"
!define K_COLOR_FIELD   "17171D"
!define K_COLOR_TEXT    "F1F1F3"
!define K_COLOR_MUTED   "8B8B92"
!define K_COLOR_ACCENT  "FF3654"
!define K_COLOR_BORDER  "37373E"

!define /ifndef PBM_GETPOS      0x0408
!define /ifndef PBM_SETBARCOLOR 0x0409
!define /ifndef PBM_SETBKCOLOR  0x2001
!define /ifndef SC_MINIMIZE     0xF020
!define /ifndef WM_NCLBUTTONDOWN 0x00A1
!define /ifndef HTCAPTION        2

Var KuroganeLeftBitmap
Var KuroganeTitleBitmap
Var KuroganeProgressBitmap
Var KuroganeProgressControl
Var KuroganePercentControl
Var KuroganeStatusControl
Var KuroganePage
Var KuroganeFontTitle
Var KuroganeFontBody
Var KuroganeFontMeta
Var KuroganeFontSteps
Var KuroganeDragWasDown

LangString KStepOptions 1033 "OPTIONS"
LangString KStepInstall 1033 "INSTALL"
LangString KStepDone 1033 "DONE"
LangString KInstallTitle 1033 "Installing Ninety"
LangString KInstallSubtitle 1033 "Preparing a protected connection"
LangString KInstallStatus 1033 "CONFIGURING SECURE COMPONENTS"
LangString KUninstallTitle 1033 "Removing Ninety"
LangString KUninstallSubtitle 1033 "Cleaning application components"
LangString KUninstallStatus 1033 "REMOVING SECURE COMPONENTS"

LangString KStepOptions 1049 "ПАРАМЕТРЫ"
LangString KStepInstall 1049 "УСТАНОВКА"
LangString KStepDone 1049 "ГОТОВО"
LangString KInstallTitle 1049 "Устанавливаем Ninety"
LangString KInstallSubtitle 1049 "Подготавливаем защищённое подключение"
LangString KInstallStatus 1049 "НАСТРАИВАЕМ ЗАЩИЩЁННЫЕ КОМПОНЕНТЫ"
LangString KUninstallTitle 1049 "Удаляем Ninety"
LangString KUninstallSubtitle 1049 "Очищаем компоненты приложения"
LangString KUninstallStatus 1049 "УДАЛЯЕМ ЗАЩИЩЁННЫЕ КОМПОНЕНТЫ"

!macro KuroganeSetText CONTROL TEXT
  GetDlgItem $0 $KuroganePage ${CONTROL}
  ${If} $0 != 0
    SendMessage $0 ${WM_SETTEXT} 0 "STR:${TEXT}"
  ${EndIf}
!macroend

!macro KuroganeApplyFont CONTROL FONT
  GetDlgItem $0 $KuroganePage ${CONTROL}
  ${If} $0 != 0
    SendMessage $0 ${WM_SETFONT} ${FONT} 1
  ${EndIf}
!macroend

!macro KuroganeStyleClass CLASS FOREGROUND BACKGROUND DISABLETHEME
  StrCpy $1 0
  kurogane_${CLASS}_loop:
    FindWindow $0 "${CLASS}" "" $2 $1
    ${If} $0 == 0
      Goto kurogane_${CLASS}_done
    ${EndIf}
    !if "${DISABLETHEME}" == "true"
      System::Call 'uxtheme::SetWindowTheme(p r0, w "", w "")'
    !endif
    SetCtlColors $0 ${FOREGROUND} ${BACKGROUND}
    SendMessage $0 ${WM_SETFONT} $KuroganeFontBody 1
    StrCpy $1 $0
    Goto kurogane_${CLASS}_loop
  kurogane_${CLASS}_done:
!macroend

!macro KuroganeStyleCurrentPageImpl
  FindWindow $KuroganePage "#32770" "" $HWNDPARENT
  StrCpy $2 $KuroganePage
  ${If} $KuroganePage != 0
    SetCtlColors $KuroganePage ${K_COLOR_TEXT} ${K_COLOR_WINDOW}
    !insertmacro KuroganeStyleClass "Static" ${K_COLOR_MUTED} ${K_COLOR_WINDOW} "false"
    !insertmacro KuroganeStyleClass "Button" ${K_COLOR_TEXT} ${K_COLOR_PANEL} "true"
    !insertmacro KuroganeStyleClass "Edit" ${K_COLOR_TEXT} ${K_COLOR_FIELD} "true"
    !insertmacro KuroganeStyleClass "RichEdit20W" ${K_COLOR_TEXT} ${K_COLOR_FIELD} "true"
    !insertmacro KuroganeStyleClass "RichEdit20A" ${K_COLOR_TEXT} ${K_COLOR_FIELD} "true"
  ${EndIf}
!macroend

!macro KuroganeGuiInitImpl MINIMIZEFUNCTION CLOSEFUNCTION
  InitPluginsDir
  File /oname=$PLUGINSDIR\kurogane-left.bmp "${__FILEDIR__}\left-panel.bmp"
  File /oname=$PLUGINSDIR\kurogane-title.bmp "${__FILEDIR__}\title-brand.bmp"
  File /oname=$PLUGINSDIR\kurogane-progress.bmp "${__FILEDIR__}\progress-frame.bmp"

  CreateFont $KuroganeFontTitle "Segoe UI" 20 600
  CreateFont $KuroganeFontBody "Segoe UI" 9 400
  CreateFont $KuroganeFontMeta "Segoe UI" 8 400
  CreateFont $KuroganeFontSteps "Segoe UI" 8 500

  SetCtlColors $HWNDPARENT ${K_COLOR_TEXT} ${K_COLOR_WINDOW}

  GetDlgItem $0 $HWNDPARENT 1200
  ${If} $0 != 0
    ${NSD_SetImage} $0 "$PLUGINSDIR\kurogane-left.bmp" $KuroganeLeftBitmap
  ${EndIf}

  GetDlgItem $0 $HWNDPARENT 1201
  ${If} $0 != 0
    ${NSD_SetImage} $0 "$PLUGINSDIR\kurogane-title.bmp" $KuroganeTitleBitmap
  ${EndIf}

  GetDlgItem $0 $HWNDPARENT 1204
  ${If} $0 != 0
    SendMessage $0 ${WM_SETTEXT} 0 "STR:v${VERSION}"
    SetCtlColors $0 ${K_COLOR_MUTED} ${K_COLOR_WINDOW}
    SendMessage $0 ${WM_SETFONT} $KuroganeFontMeta 1
  ${EndIf}

  GetDlgItem $0 $HWNDPARENT 1205
  ${If} $0 != 0
    ${NSD_OnClick} $0 ${MINIMIZEFUNCTION}
    SetCtlColors $0 ${K_COLOR_MUTED} ${K_COLOR_WINDOW}
  ${EndIf}
  GetDlgItem $0 $HWNDPARENT 1207
  ${If} $0 != 0
    ${NSD_OnClick} $0 ${CLOSEFUNCTION}
    SetCtlColors $0 ${K_COLOR_MUTED} ${K_COLOR_WINDOW}
  ${EndIf}

  GetDlgItem $0 $HWNDPARENT 1212
  ${NSD_OnClick} $0 ${MINIMIZEFUNCTION}NavBack
  SetCtlColors $0 ${K_COLOR_MUTED} ${K_COLOR_PANEL}
  SendMessage $0 ${WM_SETFONT} $KuroganeFontBody 1
  GetDlgItem $0 $HWNDPARENT 1213
  ${NSD_OnClick} $0 ${MINIMIZEFUNCTION}NavNext
  SetCtlColors $0 ${K_COLOR_TEXT} C4213F
  SendMessage $0 ${WM_SETFONT} $KuroganeFontBody 1
  GetDlgItem $0 $HWNDPARENT 1214
  ${NSD_OnClick} $0 ${MINIMIZEFUNCTION}NavCancel
  SetCtlColors $0 ${K_COLOR_MUTED} ${K_COLOR_PANEL}
  SendMessage $0 ${WM_SETFONT} $KuroganeFontBody 1

  StrCpy $KuroganeDragWasDown 0
  ${NSD_CreateTimer} ${MINIMIZEFUNCTION}ShellTick 40
!macroend

Function KuroganeGuiInit
  !insertmacro KuroganeGuiInitImpl KuroganeMinimize KuroganeClose
FunctionEnd

Function un.KuroganeGuiInit
  !insertmacro KuroganeGuiInitImpl un.KuroganeMinimize un.KuroganeClose
FunctionEnd

Function KuroganeMinimize
  SendMessage $HWNDPARENT ${WM_SYSCOMMAND} ${SC_MINIMIZE} 0
FunctionEnd

Function un.KuroganeMinimize
  SendMessage $HWNDPARENT ${WM_SYSCOMMAND} ${SC_MINIMIZE} 0
FunctionEnd

Function KuroganeClose
  GetDlgItem $0 $HWNDPARENT 2
  SendMessage $0 ${BM_CLICK} 0 0
FunctionEnd

Function un.KuroganeClose
  GetDlgItem $0 $HWNDPARENT 2
  SendMessage $0 ${BM_CLICK} 0 0
FunctionEnd

!macro KuroganeNavClickImpl CONTROL
  GetDlgItem $0 $HWNDPARENT ${CONTROL}
  ${If} $0 != 0
    SendMessage $0 ${BM_CLICK} 0 0
  ${EndIf}
!macroend

Function KuroganeMinimizeNavBack
  !insertmacro KuroganeNavClickImpl 3
FunctionEnd
Function KuroganeMinimizeNavNext
  !insertmacro KuroganeNavClickImpl 1
FunctionEnd
Function KuroganeMinimizeNavCancel
  !insertmacro KuroganeNavClickImpl 2
FunctionEnd
Function un.KuroganeMinimizeNavBack
  !insertmacro KuroganeNavClickImpl 3
FunctionEnd
Function un.KuroganeMinimizeNavNext
  !insertmacro KuroganeNavClickImpl 1
FunctionEnd
Function un.KuroganeMinimizeNavCancel
  !insertmacro KuroganeNavClickImpl 2
FunctionEnd

!macro KuroganeMirrorButton SOURCE TARGET
  GetDlgItem $0 $HWNDPARENT ${SOURCE}
  GetDlgItem $1 $HWNDPARENT ${TARGET}
  ${If} $0 != 0
  ${AndIf} $1 != 0
    System::Call 'user32::GetWindowTextW(p r0, w .r2, i ${NSIS_MAX_STRLEN})'
    SendMessage $1 ${WM_SETTEXT} 0 "STR:$2"
    System::Call 'user32::IsWindowVisible(p r0) i .r2'
    ShowWindow $1 $2
    System::Call 'user32::IsWindowEnabled(p r0) i .r2'
    EnableWindow $1 $2
  ${EndIf}
!macroend

!macro KuroganeShellTickImpl
  !insertmacro KuroganeMirrorButton 3 1212
  !insertmacro KuroganeMirrorButton 1 1213
  !insertmacro KuroganeMirrorButton 2 1214

  System::Call 'user32::GetAsyncKeyState(i 1) i .r0'
  IntOp $0 $0 & 0x8000
  ${If} $0 == 0
    StrCpy $KuroganeDragWasDown 0
  ${ElseIf} $KuroganeDragWasDown == 0
    StrCpy $KuroganeDragWasDown 1
    GetDlgItem $0 $HWNDPARENT 1208
    ${If} $0 != 0
      System::Call '*(&i4 0, &i4 0) p .r1'
      System::Call 'user32::GetCursorPos(p r1)'
      System::Call '*$1(&i4 .r2, &i4 .r3)'
      System::Free $1
      System::Call '*(&i4 0, &i4 0, &i4 0, &i4 0) p .r1'
      System::Call 'user32::GetWindowRect(p r0, p r1)'
      System::Call '*$1(&i4 .r4, &i4 .r5, &i4 .r6, &i4 .r7)'
      System::Free $1
      ${If} $2 >= $4
      ${AndIf} $2 < $6
      ${AndIf} $3 >= $5
      ${AndIf} $3 < $7
        System::Call 'user32::ReleaseCapture()'
        SendMessage $HWNDPARENT ${WM_NCLBUTTONDOWN} ${HTCAPTION} 0
      ${EndIf}
    ${EndIf}
  ${EndIf}
!macroend

Function KuroganeMinimizeShellTick
  !insertmacro KuroganeShellTickImpl
FunctionEnd
Function un.KuroganeMinimizeShellTick
  !insertmacro KuroganeShellTickImpl
FunctionEnd

Function KuroganeStyleCurrentPage
  !insertmacro KuroganeStyleCurrentPageImpl
FunctionEnd

Function un.KuroganeStyleCurrentPage
  !insertmacro KuroganeStyleCurrentPageImpl
FunctionEnd

Function KuroganePageShow
  Call KuroganeStyleCurrentPage
FunctionEnd

Function un.KuroganePageShow
  Call un.KuroganeStyleCurrentPage
FunctionEnd

; MUI welcome/finish pages are created as right-hosted nsDialogs pages. Hide
; their stock wizard bitmap and use the full right atelier for native text and
; options; this preserves MUI lifecycle/checkbox behavior without its blue art.
!macro KuroganeFullWindowPageShowImpl UNPREFIX
  Call ${UNPREFIX}KuroganeStyleCurrentPage
  FindWindow $0 "Static" "" $KuroganePage 0
  ${If} $0 != 0
    ShowWindow $0 ${SW_HIDE}
    FindWindow $1 "Static" "" $KuroganePage $0
    ${If} $1 != 0
      System::Call 'user32::SetWindowPos(p r1, p 0, i 44, i 72, i 500, i 72, i 0x14)'
      SetCtlColors $1 ${K_COLOR_TEXT} ${K_COLOR_WINDOW}
      SendMessage $1 ${WM_SETFONT} $KuroganeFontTitle 1
      FindWindow $2 "Static" "" $KuroganePage $1
      ${If} $2 != 0
        System::Call 'user32::SetWindowPos(p r2, p 0, i 44, i 148, i 500, i 230, i 0x14)'
        SetCtlColors $2 ${K_COLOR_MUTED} ${K_COLOR_WINDOW}
        SendMessage $2 ${WM_SETFONT} $KuroganeFontBody 1
      ${EndIf}
    ${EndIf}
  ${EndIf}
!macroend

Function KuroganeFullWindowPageShow
  !insertmacro KuroganeFullWindowPageShowImpl ""
FunctionEnd
Function un.KuroganeFullWindowPageShow
  !insertmacro KuroganeFullWindowPageShowImpl "un."
FunctionEnd

!macro KuroganeProgressPageImpl UNPREFIX TITLE SUBTITLE STATUS
  Call ${UNPREFIX}KuroganeStyleCurrentPage

  !insertmacro KuroganeSetText 1220 "$(KStepOptions)"
  !insertmacro KuroganeSetText 1221 "$(KStepInstall)"
  !insertmacro KuroganeSetText 1222 "$(KStepDone)"
  !insertmacro KuroganeSetText 1223 "${TITLE}"
  !insertmacro KuroganeSetText 1224 "${SUBTITLE}"
  !insertmacro KuroganeSetText 1227 "●"
  !insertmacro KuroganeSetText 1228 "${STATUS}"

  !insertmacro KuroganeApplyFont 1220 $KuroganeFontSteps
  !insertmacro KuroganeApplyFont 1221 $KuroganeFontSteps
  !insertmacro KuroganeApplyFont 1222 $KuroganeFontSteps
  !insertmacro KuroganeApplyFont 1223 $KuroganeFontTitle
  !insertmacro KuroganeApplyFont 1224 $KuroganeFontBody
  !insertmacro KuroganeApplyFont 1226 $KuroganeFontBody
  !insertmacro KuroganeApplyFont 1227 $KuroganeFontBody
  !insertmacro KuroganeApplyFont 1228 $KuroganeFontMeta

  GetDlgItem $0 $KuroganePage 1220
  SetCtlColors $0 ${K_COLOR_MUTED} ${K_COLOR_WINDOW}
  GetDlgItem $0 $KuroganePage 1221
  SetCtlColors $0 ${K_COLOR_ACCENT} ${K_COLOR_WINDOW}
  GetDlgItem $0 $KuroganePage 1222
  SetCtlColors $0 ${K_COLOR_MUTED} ${K_COLOR_WINDOW}
  GetDlgItem $0 $KuroganePage 1223
  SetCtlColors $0 ${K_COLOR_TEXT} ${K_COLOR_WINDOW}
  GetDlgItem $0 $KuroganePage 1224
  SetCtlColors $0 ${K_COLOR_MUTED} ${K_COLOR_WINDOW}
  GetDlgItem $KuroganePercentControl $KuroganePage 1226
  SetCtlColors $KuroganePercentControl ${K_COLOR_MUTED} ${K_COLOR_WINDOW}
  GetDlgItem $0 $KuroganePage 1227
  SetCtlColors $0 ${K_COLOR_ACCENT} ${K_COLOR_WINDOW}
  GetDlgItem $KuroganeStatusControl $KuroganePage 1228
  SetCtlColors $KuroganeStatusControl ${K_COLOR_MUTED} ${K_COLOR_WINDOW}

  GetDlgItem $0 $KuroganePage 1225
  ${If} $0 != 0
    ${NSD_SetImage} $0 "$PLUGINSDIR\kurogane-progress.bmp" $KuroganeProgressBitmap
  ${EndIf}

  GetDlgItem $KuroganeProgressControl $KuroganePage 1004
  ${If} $KuroganeProgressControl != 0
    System::Call 'uxtheme::SetWindowTheme(p $KuroganeProgressControl, w "", w "")'
    ShowWindow $KuroganeProgressControl ${SW_SHOW}
    SendMessage $KuroganeProgressControl ${PBM_SETBARCOLOR} 0 0x5436FF
    SendMessage $KuroganeProgressControl ${PBM_SETBKCOLOR} 0 0x1D1717
  ${EndIf}

  GetDlgItem $0 $KuroganePage 1027
  ShowWindow $0 ${SW_HIDE}
  ${NSD_CreateTimer} ${UNPREFIX}KuroganeProgressTick 80
  Call ${UNPREFIX}KuroganeProgressTick
!macroend

Function KuroganeInstFilesShow
  !insertmacro KuroganeProgressPageImpl "" "$(KInstallTitle)" "$(KInstallSubtitle)" "$(KInstallStatus)"
FunctionEnd

Function un.KuroganeInstFilesShow
  !insertmacro KuroganeProgressPageImpl "un." "$(KUninstallTitle)" "$(KUninstallSubtitle)" "$(KUninstallStatus)"
FunctionEnd

!macro KuroganeProgressTickImpl
  ${If} $KuroganeProgressControl != 0
  ${AndIf} $KuroganePercentControl != 0
    SendMessage $KuroganeProgressControl ${PBM_GETPOS} 0 0 $0
    StrCpy $1 "$0%"
    SendMessage $KuroganePercentControl ${WM_SETTEXT} 0 "STR:$1"
  ${EndIf}
!macroend

Function KuroganeProgressTick
  !insertmacro KuroganeProgressTickImpl
FunctionEnd

Function un.KuroganeProgressTick
  !insertmacro KuroganeProgressTickImpl
FunctionEnd

!macro KuroganeProgressLeaveImpl UNPREFIX
  ${NSD_KillTimer} ${UNPREFIX}KuroganeProgressTick
  ${NSD_FreeImage} $KuroganeProgressBitmap
!macroend

Function KuroganeInstFilesLeave
  !insertmacro KuroganeProgressLeaveImpl ""
FunctionEnd

Function un.KuroganeInstFilesLeave
  !insertmacro KuroganeProgressLeaveImpl "un."
FunctionEnd

!macro KUROGANE_STATUS TEXT
  ${If} $KuroganeStatusControl != 0
    SendMessage $KuroganeStatusControl ${WM_SETTEXT} 0 "STR:${TEXT}"
  ${EndIf}
!macroend
