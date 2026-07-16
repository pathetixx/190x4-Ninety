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
!define /ifndef PBM_GETRANGE    0x0407
!define /ifndef PBM_SETBARCOLOR 0x0409
!define /ifndef PBM_SETBKCOLOR  0x2001
!define /ifndef SC_MINIMIZE     0xF020
!define /ifndef WM_NCLBUTTONDOWN 0x00A1
!define /ifndef HTCAPTION        2
!define /ifndef EM_SETBKGNDCOLOR 0x0443

Var KuroganeLeftBitmap
Var KuroganeTitleBitmap
Var KuroganeProgressBitmap
Var KuroganeChromeMinimizeBitmap
Var KuroganeChromeCloseBitmap
Var KuroganeNavBackBitmap
Var KuroganeNavNextBitmap
Var KuroganeNavCancelBitmap
Var KuroganeProgressControl
Var KuroganePercentControl
Var KuroganeStatusControl
Var KuroganePage
Var KuroganeFontTitle
Var KuroganeFontBody
Var KuroganeFontMeta
Var KuroganeFontSteps
Var KuroganeDragWasDown
Var KuroganeProgressActive
Var KuroganeCaptionPressed
Var KuroganeModeTitleControl
Var KuroganeModeSubtitleControl
Var KuroganeModeAllDescriptionControl
Var KuroganeModeCurrentDescriptionControl
Var KuroganeMaintenanceTitleControl
Var KuroganeMaintenanceSubtitleControl
Var KuroganeMaintenanceInfoControl
Var KuroganeMaintenanceRepairDescriptionControl
Var KuroganeMaintenanceRemoveDescriptionControl
Var KuroganeUninstallSubtitleControl

LangString KStepOptions 1033 "OPTIONS"
LangString KStepInstall 1033 "INSTALL"
LangString KStepDone 1033 "DONE"
LangString KInstallTitle 1033 "Installing Ninety"
LangString KInstallSubtitle 1033 "Preparing a protected connection"
LangString KInstallStatus 1033 "CONFIGURING SECURE COMPONENTS"
LangString KUninstallTitle 1033 "Removing Ninety"
LangString KUninstallSubtitle 1033 "Cleaning application components"
LangString KUninstallStatus 1033 "REMOVING SECURE COMPONENTS"
LangString KLicenseTitle 1033 "License and components"
LangString KModeTitle 1033 "Choose who can use Ninety"
LangString KModeSubtitle 1033 "The installation scope can be changed later by reinstalling the application."
LangString KModeAllDescription 1033 "Available to every Windows account on this computer."
LangString KModeCurrentDescription 1033 "Installed only for the current Windows account."
LangString KMaintenanceTitle 1033 "Ninety is already installed"
LangString KMaintenanceSubtitle 1033 "Choose what to do with the existing installation."
LangString KMaintenanceRepairDescription 1033 "Restore or update the installed application components."
LangString KMaintenanceRemoveDescription 1033 "Remove Ninety and its installed components from this computer."
LangString KMaintenanceReplaceDescription 1033 "Remove the existing version before installing the selected version."
LangString KMaintenanceKeepDescription 1033 "Keep the existing installation and continue without removing it first."
LangString KUninstallConfirmTitle 1033 "Remove Ninety"
LangString KUninstallConfirmSubtitle 1033 "The application will be closed and its installed components will be removed."

LangString KStepOptions 1049 "ПАРАМЕТРЫ"
LangString KStepInstall 1049 "УСТАНОВКА"
LangString KStepDone 1049 "ГОТОВО"
LangString KInstallTitle 1049 "Устанавливаем Ninety"
LangString KInstallSubtitle 1049 "Подготавливаем защищённое подключение"
LangString KInstallStatus 1049 "НАСТРАИВАЕМ ЗАЩИЩЁННЫЕ КОМПОНЕНТЫ"
LangString KUninstallTitle 1049 "Удаляем Ninety"
LangString KUninstallSubtitle 1049 "Очищаем компоненты приложения"
LangString KUninstallStatus 1049 "УДАЛЯЕМ ЗАЩИЩЁННЫЕ КОМПОНЕНТЫ"
LangString KLicenseTitle 1049 "Лицензия и компоненты"
LangString KModeTitle 1049 "Кто сможет пользоваться Ninety"
LangString KModeSubtitle 1049 "Область установки можно изменить позже, переустановив приложение."
LangString KModeAllDescription 1049 "Приложение будет доступно всем учётным записям Windows на этом компьютере."
LangString KModeCurrentDescription 1049 "Приложение будет установлено только для текущей учётной записи Windows."
LangString KMaintenanceTitle 1049 "Ninety уже установлен"
LangString KMaintenanceSubtitle 1049 "Выберите, что сделать с существующей установкой."
LangString KMaintenanceRepairDescription 1049 "Восстановить или обновить установленные компоненты приложения."
LangString KMaintenanceRemoveDescription 1049 "Удалить Ninety и установленные компоненты с этого компьютера."
LangString KMaintenanceReplaceDescription 1049 "Удалить существующую версию перед установкой выбранной версии."
LangString KMaintenanceKeepDescription 1049 "Сохранить существующую установку и продолжить без предварительного удаления."
LangString KUninstallConfirmTitle 1049 "Удаление Ninety"
LangString KUninstallConfirmSubtitle 1049 "Приложение будет закрыто, а установленные компоненты — удалены."

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

; Clickable resource statics are unreliable under the elevated/updater shell:
; some Windows themes repaint them as white system buttons. Switch the same
; HWNDs to bitmap statics and fill every pixel with deterministic Kurogane art.
!macro KuroganeSetBitmap CONTROL PATH HANDLE
  GetDlgItem $0 $HWNDPARENT ${CONTROL}
  ${If} $0 != 0
    ${If} ${HANDLE} != 0
      ${NSD_FreeImage} ${HANDLE}
      StrCpy ${HANDLE} 0
    ${EndIf}
    System::Call 'user32::GetWindowLongW(p r0, i -16) i .r1'
    IntOp $1 $1 & 0xFFFFFFE0
    IntOp $1 $1 | 0x0000030E
    System::Call 'user32::SetWindowLongW(p r0, i -16, i r1)'
    ${NSD_SetImage} $0 "${PATH}" ${HANDLE}
    System::Call 'user32::InvalidateRect(p r0, p 0, i 1)'
  ${EndIf}
!macroend

; Navigation must stay owned by NSIS. Move its real buttons over the bitmap
; anchors and give those buttons the Kurogane art instead of proxying clicks
; through main-window static controls (nsDialogs does not receive those events).
!macro KuroganeSetButtonBitmap CONTROL ANCHOR PATH HANDLE
  GetDlgItem $0 $HWNDPARENT ${CONTROL}
  GetDlgItem $1 $HWNDPARENT ${ANCHOR}
  ${If} $0 != 0
  ${AndIf} $1 != 0
    ${If} ${HANDLE} != 0
      SendMessage $0 ${BM_SETIMAGE} ${IMAGE_BITMAP} 0
      ${NSD_FreeImage} ${HANDLE}
      StrCpy ${HANDLE} 0
    ${EndIf}

    System::Call 'user32::GetWindowLongW(p r0, i -16) i .r2'
    IntOp $2 $2 | 0x00008080
    System::Call 'user32::SetWindowLongW(p r0, i -16, i r2)'
    System::Call 'uxtheme::SetWindowTheme(p r0, w "", w "")'
    System::Call 'user32::LoadImageW(p 0, w "${PATH}", i 0, i 0, i 0, i 0x2010) p .r2'
    StrCpy ${HANDLE} $2
    SendMessage $0 ${BM_SETIMAGE} ${IMAGE_BITMAP} $2

    System::Call '*(&i4 0, &i4 0, &i4 0, &i4 0) p .r3'
    System::Call 'user32::GetWindowRect(p r1, p r3)'
    System::Call '*$3(&i4 .r4, &i4 .r5, &i4 .r6, &i4 .r7)'
    System::Free $3
    IntOp $8 $6 - $4
    IntOp $9 $7 - $5
    System::Call '*(&i4 r4, &i4 r5) p .r3'
    System::Call 'user32::ScreenToClient(p $HWNDPARENT, p r3)'
    System::Call '*$3(&i4 .r4, &i4 .r5)'
    System::Free $3
    System::Call 'user32::SetWindowPos(p r0, p 0, i r4, i r5, i r8, i r9, i 0x14)'
    ShowWindow $1 ${SW_HIDE}
    System::Call 'user32::InvalidateRect(p r0, p 0, i 1)'
  ${EndIf}
!macroend

!macro KuroganeApplyChromeImpl NEXT_EN NEXT_RU
  !insertmacro KuroganeSetBitmap 1205 "$PLUGINSDIR\kurogane-minimize.bmp" $KuroganeChromeMinimizeBitmap
  !insertmacro KuroganeSetBitmap 1207 "$PLUGINSDIR\kurogane-close.bmp" $KuroganeChromeCloseBitmap
  ${If} $LANGUAGE == 1049
    !insertmacro KuroganeSetButtonBitmap 3 1212 "$PLUGINSDIR\kurogane-back-ru.bmp" $KuroganeNavBackBitmap
    !insertmacro KuroganeSetButtonBitmap 1 1213 "$PLUGINSDIR\kurogane-${NEXT_RU}-ru.bmp" $KuroganeNavNextBitmap
    !insertmacro KuroganeSetButtonBitmap 2 1214 "$PLUGINSDIR\kurogane-cancel-ru.bmp" $KuroganeNavCancelBitmap
  ${Else}
    !insertmacro KuroganeSetButtonBitmap 3 1212 "$PLUGINSDIR\kurogane-back-en.bmp" $KuroganeNavBackBitmap
    !insertmacro KuroganeSetButtonBitmap 1 1213 "$PLUGINSDIR\kurogane-${NEXT_EN}-en.bmp" $KuroganeNavNextBitmap
    !insertmacro KuroganeSetButtonBitmap 2 1214 "$PLUGINSDIR\kurogane-cancel-en.bmp" $KuroganeNavCancelBitmap
  ${EndIf}
!macroend

Function KuroganeApplyChromeNext
  !insertmacro KuroganeApplyChromeImpl "next" "next"
FunctionEnd
Function un.KuroganeApplyChromeNext
  !insertmacro KuroganeApplyChromeImpl "next" "next"
FunctionEnd
Function KuroganeApplyChromeInstall
  !insertmacro KuroganeApplyChromeImpl "install" "install"
FunctionEnd
Function un.KuroganeApplyChromeInstall
  !insertmacro KuroganeApplyChromeImpl "install" "install"
FunctionEnd
Function KuroganeApplyChromeRemove
  !insertmacro KuroganeApplyChromeImpl "remove" "remove"
FunctionEnd
Function un.KuroganeApplyChromeRemove
  !insertmacro KuroganeApplyChromeImpl "remove" "remove"
FunctionEnd
Function KuroganeApplyChromeFinish
  !insertmacro KuroganeApplyChromeImpl "finish" "finish"
FunctionEnd
Function un.KuroganeApplyChromeFinish
  !insertmacro KuroganeApplyChromeImpl "finish" "finish"
FunctionEnd

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

!macro KuroganeStylePageImpl PAGE
  StrCpy $KuroganePage ${PAGE}
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

!macro KuroganeStyleCurrentPageImpl
  FindWindow $KuroganePage "#32770" "" $HWNDPARENT
  !insertmacro KuroganeStylePageImpl $KuroganePage
!macroend

!macro KuroganeGuiInitImpl MINIMIZEFUNCTION CLOSEFUNCTION
  InitPluginsDir
  File /oname=$PLUGINSDIR\kurogane-left.bmp "${__FILEDIR__}\left-panel.bmp"
  File /oname=$PLUGINSDIR\kurogane-title.bmp "${__FILEDIR__}\title-brand.bmp"
  File /oname=$PLUGINSDIR\kurogane-progress.bmp "${__FILEDIR__}\progress-frame.bmp"
  File /oname=$PLUGINSDIR\kurogane-minimize.bmp "${__FILEDIR__}\chrome-minimize.bmp"
  File /oname=$PLUGINSDIR\kurogane-close.bmp "${__FILEDIR__}\chrome-close.bmp"
  File /oname=$PLUGINSDIR\kurogane-back-en.bmp "${__FILEDIR__}\nav-back-en.bmp"
  File /oname=$PLUGINSDIR\kurogane-back-ru.bmp "${__FILEDIR__}\nav-back-ru.bmp"
  File /oname=$PLUGINSDIR\kurogane-next-en.bmp "${__FILEDIR__}\nav-next-en.bmp"
  File /oname=$PLUGINSDIR\kurogane-next-ru.bmp "${__FILEDIR__}\nav-next-ru.bmp"
  File /oname=$PLUGINSDIR\kurogane-install-en.bmp "${__FILEDIR__}\nav-install-en.bmp"
  File /oname=$PLUGINSDIR\kurogane-install-ru.bmp "${__FILEDIR__}\nav-install-ru.bmp"
  File /oname=$PLUGINSDIR\kurogane-remove-en.bmp "${__FILEDIR__}\nav-remove-en.bmp"
  File /oname=$PLUGINSDIR\kurogane-remove-ru.bmp "${__FILEDIR__}\nav-remove-ru.bmp"
  File /oname=$PLUGINSDIR\kurogane-finish-en.bmp "${__FILEDIR__}\nav-finish-en.bmp"
  File /oname=$PLUGINSDIR\kurogane-finish-ru.bmp "${__FILEDIR__}\nav-finish-ru.bmp"
  File /oname=$PLUGINSDIR\kurogane-cancel-en.bmp "${__FILEDIR__}\nav-cancel-en.bmp"
  File /oname=$PLUGINSDIR\kurogane-cancel-ru.bmp "${__FILEDIR__}\nav-cancel-ru.bmp"

  CreateFont $KuroganeFontTitle "Segoe UI" 20 600
  CreateFont $KuroganeFontBody "Segoe UI" 9 400
  CreateFont $KuroganeFontMeta "Segoe UI" 8 400
  CreateFont $KuroganeFontSteps "Segoe UI" 8 500

  SetCtlColors $HWNDPARENT ${K_COLOR_TEXT} ${K_COLOR_WINDOW}

  GetDlgItem $0 $HWNDPARENT 1208
  SetCtlColors $0 ${K_COLOR_WINDOW} ${K_COLOR_WINDOW}
  GetDlgItem $0 $HWNDPARENT 1209
  SetCtlColors $0 ${K_COLOR_BORDER} ${K_COLOR_BORDER}
  GetDlgItem $0 $HWNDPARENT 1210
  SetCtlColors $0 ${K_COLOR_WINDOW} ${K_COLOR_WINDOW}
  GetDlgItem $0 $HWNDPARENT 1211
  SetCtlColors $0 ${K_COLOR_BORDER} ${K_COLOR_BORDER}

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
  ${EndIf}
  GetDlgItem $0 $HWNDPARENT 1207
  ${If} $0 != 0
    ${NSD_OnClick} $0 ${CLOSEFUNCTION}
  ${EndIf}

  GetDlgItem $0 $HWNDPARENT 1212
  ${NSD_OnClick} $0 ${MINIMIZEFUNCTION}NavBack
  GetDlgItem $0 $HWNDPARENT 1213
  ${NSD_OnClick} $0 ${MINIMIZEFUNCTION}NavNext
  GetDlgItem $0 $HWNDPARENT 1214
  ${NSD_OnClick} $0 ${MINIMIZEFUNCTION}NavCancel

  StrCpy $KuroganeDragWasDown 0
  StrCpy $KuroganeProgressActive 0
  StrCpy $KuroganeCaptionPressed 0
!macroend

Function KuroganeGuiInit
  !insertmacro KuroganeGuiInitImpl KuroganeMinimize KuroganeClose
FunctionEnd

Function un.KuroganeGuiInit
  !insertmacro KuroganeGuiInitImpl un.KuroganeMinimize un.KuroganeClose
FunctionEnd

; nsDialogs ignores OnClick registrations made before its page dialog exists.
; Bind the resource-shell controls from each page SHOW callback instead of
; relying on the early .onGUIInit registration alone.
!macro KuroganeBindChromeEventsImpl UNPREFIX
  GetDlgItem $0 $HWNDPARENT 1205
  ${If} $0 != 0
    ${NSD_OnClick} $0 ${UNPREFIX}KuroganeMinimize
  ${EndIf}
  GetDlgItem $0 $HWNDPARENT 1207
  ${If} $0 != 0
    ${NSD_OnClick} $0 ${UNPREFIX}KuroganeClose
  ${EndIf}
  GetDlgItem $0 $HWNDPARENT 1212
  ${If} $0 != 0
    ${NSD_OnClick} $0 ${UNPREFIX}KuroganeMinimizeNavBack
  ${EndIf}
  GetDlgItem $0 $HWNDPARENT 1213
  ${If} $0 != 0
    ${NSD_OnClick} $0 ${UNPREFIX}KuroganeMinimizeNavNext
  ${EndIf}
  GetDlgItem $0 $HWNDPARENT 1214
  ${If} $0 != 0
    ${NSD_OnClick} $0 ${UNPREFIX}KuroganeMinimizeNavCancel
  ${EndIf}
!macroend

Function KuroganeBindChromeEvents
  !insertmacro KuroganeBindChromeEventsImpl ""
FunctionEnd

Function un.KuroganeBindChromeEvents
  !insertmacro KuroganeBindChromeEventsImpl "un."
FunctionEnd

Function KuroganeMinimize
  ; nsDialogs puts the originating HWND on the callback stack.
  Pop $9
  SendMessage $HWNDPARENT ${WM_SYSCOMMAND} ${SC_MINIMIZE} 0
FunctionEnd

Function un.KuroganeMinimize
  Pop $9
  SendMessage $HWNDPARENT ${WM_SYSCOMMAND} ${SC_MINIMIZE} 0
FunctionEnd

Function KuroganeClose
  Pop $9
  SendMessage $HWNDPARENT ${WM_CLOSE} 0 0
FunctionEnd

Function un.KuroganeClose
  Pop $9
  SendMessage $HWNDPARENT ${WM_CLOSE} 0 0
FunctionEnd

!macro KuroganeNavClickImpl CONTROL
  Pop $9
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

!macro KuroganePointInControl CONTROL RESULT
  StrCpy ${RESULT} 0
  GetDlgItem $0 $HWNDPARENT ${CONTROL}
  ${If} $0 != 0
    System::Call '*(&i4 0, &i4 0, &i4 0, &i4 0) p .r1'
    System::Call 'user32::GetWindowRect(p r0, p r1)'
    System::Call '*$1(&i4 .r4, &i4 .r5, &i4 .r6, &i4 .r7)'
    System::Free $1
    ${If} $2 >= $4
    ${AndIf} $2 < $6
    ${AndIf} $3 >= $5
    ${AndIf} $3 < $7
      StrCpy ${RESULT} 1
    ${EndIf}
  ${EndIf}
!macroend

!macro KuroganeShellTickImpl
  System::Call 'user32::GetAsyncKeyState(i 1) i .r0'
  IntOp $0 $0 & 0x8000
  ${If} $0 == 0
    ${If} $KuroganeDragWasDown == 1
    ${AndIf} $KuroganeCaptionPressed != 0
      System::Call '*(&i4 0, &i4 0) p .r1'
      System::Call 'user32::GetCursorPos(p r1)'
      System::Call '*$1(&i4 .r2, &i4 .r3)'
      System::Free $1
      !insertmacro KuroganePointInControl $KuroganeCaptionPressed $8
      ${If} $8 == 1
        ${If} $KuroganeCaptionPressed == 1205
          SendMessage $HWNDPARENT ${WM_SYSCOMMAND} ${SC_MINIMIZE} 0
        ${ElseIf} $KuroganeCaptionPressed == 1207
          SendMessage $HWNDPARENT ${WM_CLOSE} 0 0
        ${EndIf}
      ${EndIf}
    ${EndIf}
    StrCpy $KuroganeDragWasDown 0
    StrCpy $KuroganeCaptionPressed 0
  ${ElseIf} $KuroganeDragWasDown == 0
    StrCpy $KuroganeDragWasDown 1
    StrCpy $KuroganeCaptionPressed 0
    System::Call '*(&i4 0, &i4 0) p .r1'
    System::Call 'user32::GetCursorPos(p r1)'
    System::Call '*$1(&i4 .r2, &i4 .r3)'
    System::Free $1

    !insertmacro KuroganePointInControl 1205 $8
    ${If} $8 == 1
      StrCpy $KuroganeCaptionPressed 1205
    ${Else}
      !insertmacro KuroganePointInControl 1207 $8
      ${If} $8 == 1
        StrCpy $KuroganeCaptionPressed 1207
      ${Else}
        !insertmacro KuroganePointInControl 1208 $8
        ${If} $8 == 1
          System::Call 'user32::ReleaseCapture()'
          SendMessage $HWNDPARENT ${WM_NCLBUTTONDOWN} ${HTCAPTION} 0
        ${EndIf}
      ${EndIf}
    ${EndIf}
  ${EndIf}
!macroend

Function KuroganeMinimizeShellTick
  Push $0
  Push $1
  Push $2
  Push $3
  Push $4
  Push $5
  Push $6
  Push $7
  Push $8
  !insertmacro KuroganeShellTickImpl
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
Function un.KuroganeMinimizeShellTick
  Push $0
  Push $1
  Push $2
  Push $3
  Push $4
  Push $5
  Push $6
  Push $7
  Push $8
  !insertmacro KuroganeShellTickImpl
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

Function KuroganeStartShellTimer
  ${NSD_KillTimer} KuroganeMinimizeShellTick
  ${NSD_CreateTimer} KuroganeMinimizeShellTick 20
FunctionEnd
Function un.KuroganeStartShellTimer
  ${NSD_KillTimer} un.KuroganeMinimizeShellTick
  ${NSD_CreateTimer} un.KuroganeMinimizeShellTick 20
FunctionEnd

Function KuroganeStyleCurrentPage
  !insertmacro KuroganeStyleCurrentPageImpl
FunctionEnd

Function un.KuroganeStyleCurrentPage
  !insertmacro KuroganeStyleCurrentPageImpl
FunctionEnd

Function KuroganePageShow
  StrCpy $KuroganeProgressActive 0
  Call KuroganeApplyChromeNext
  Call KuroganeBindChromeEvents
  Call KuroganeStartShellTimer
  Call KuroganeStyleCurrentPage
FunctionEnd

Function un.KuroganePageShow
  StrCpy $KuroganeProgressActive 0
  Call un.KuroganeApplyChromeNext
  Call un.KuroganeBindChromeEvents
  Call un.KuroganeStartShellTimer
  Call un.KuroganeStyleCurrentPage
FunctionEnd

; Page-specific show callbacks pass the exact MUI/nsDialogs HWND here. Generic
; FindWindow is intentionally avoided: NSIS may keep an older child dialog alive
; while the next page is being shown.
!macro KuroganePrepareKnownPageImpl UNPREFIX PAGE CHROME
  StrCpy $KuroganeProgressActive 0
  StrCpy $KuroganePage ${PAGE}
  Call ${UNPREFIX}KuroganeApplyChrome${CHROME}
  Call ${UNPREFIX}KuroganeBindChromeEvents
  Call ${UNPREFIX}KuroganeStartShellTimer
  !insertmacro KuroganeStylePageImpl ${PAGE}
!macroend

!macro KuroganeLicensePageImpl UNPREFIX PAGE TOPCONTROL RICHCONTROL
  !insertmacro KuroganePrepareKnownPageImpl "${UNPREFIX}" ${PAGE} Next
  SendMessage ${TOPCONTROL} ${WM_SETTEXT} 0 "STR:$(KLicenseTitle)"
  SendMessage ${TOPCONTROL} ${WM_SETFONT} $KuroganeFontTitle 1
  SetCtlColors ${TOPCONTROL} ${K_COLOR_TEXT} ${K_COLOR_WINDOW}
  SetCtlColors ${RICHCONTROL} ${K_COLOR_TEXT} ${K_COLOR_FIELD}
  SendMessage ${RICHCONTROL} ${EM_SETBKGNDCOLOR} 0 0x1D1717
!macroend

; Rebuild the MultiUser page controls inside the page that the plugin already
; owns. Its leave callback continues to read the same handle variables.
!macro KuroganeInstallModePageImpl
  ShowWindow $MultiUser.InstallModePage.Text ${SW_HIDE}
  ShowWindow $MultiUser.InstallModePage.AllUsers ${SW_HIDE}
  ShowWindow $MultiUser.InstallModePage.CurrentUser ${SW_HIDE}

  ${NSD_CreateLabel} 22u 18u 296u 24u "$(KModeTitle)"
  Pop $KuroganeModeTitleControl
  ${NSD_CreateLabel} 22u 47u 296u 24u "$(KModeSubtitle)"
  Pop $KuroganeModeSubtitleControl

  ${NSD_CreateGroupBox} 22u 82u 296u 64u ""
  Pop $0
  ${NSD_CreateRadioButton} 34u 95u 272u 14u "$(MULTIUSER_INNERTEXT_INSTALLMODE_ALLUSERS)"
  Pop $MultiUser.InstallModePage.AllUsers
  ${NSD_CreateLabel} 53u 115u 249u 22u "$(KModeAllDescription)"
  Pop $KuroganeModeAllDescriptionControl

  ${NSD_CreateGroupBox} 22u 158u 296u 64u ""
  Pop $0
  ${NSD_CreateRadioButton} 34u 171u 272u 14u "$(MULTIUSER_INNERTEXT_INSTALLMODE_CURRENTUSER)"
  Pop $MultiUser.InstallModePage.CurrentUser
  ${NSD_CreateLabel} 53u 191u 249u 22u "$(KModeCurrentDescription)"
  Pop $KuroganeModeCurrentDescriptionControl

  ${If} $MultiUser.InstallMode == "AllUsers"
    SendMessage $MultiUser.InstallModePage.AllUsers ${BM_SETCHECK} ${BST_CHECKED} 0
    ${NSD_SetFocus} $MultiUser.InstallModePage.AllUsers
  ${Else}
    SendMessage $MultiUser.InstallModePage.CurrentUser ${BM_SETCHECK} ${BST_CHECKED} 0
    ${NSD_SetFocus} $MultiUser.InstallModePage.CurrentUser
  ${EndIf}

  !insertmacro KuroganePrepareKnownPageImpl "" $MultiUser.InstallModePage Next
  SendMessage $KuroganeModeTitleControl ${WM_SETFONT} $KuroganeFontTitle 1
  SetCtlColors $KuroganeModeTitleControl ${K_COLOR_TEXT} ${K_COLOR_WINDOW}
  SetCtlColors $KuroganeModeSubtitleControl ${K_COLOR_MUTED} ${K_COLOR_WINDOW}
  SetCtlColors $KuroganeModeAllDescriptionControl ${K_COLOR_MUTED} ${K_COLOR_PANEL}
  SetCtlColors $KuroganeModeCurrentDescriptionControl ${K_COLOR_MUTED} ${K_COLOR_PANEL}
!macroend

!macro KuroganeMaintenancePageImpl DIALOG PRIMARY SECONDARY INTROTEXT PRIMARYTEXT SECONDARYTEXT PRIMARYDESC SECONDARYDESC
  ${NSD_CreateLabel} 22u 16u 296u 24u "$(KMaintenanceTitle)"
  Pop $KuroganeMaintenanceTitleControl
  ${NSD_CreateLabel} 22u 44u 296u 18u "$(KMaintenanceSubtitle)"
  Pop $KuroganeMaintenanceSubtitleControl
  ${NSD_CreateLabel} 22u 69u 296u 30u "${INTROTEXT}"
  Pop $KuroganeMaintenanceInfoControl

  ${NSD_CreateGroupBox} 22u 108u 296u 58u ""
  Pop $0
  ${NSD_CreateRadioButton} 34u 119u 272u 14u "${PRIMARYTEXT}"
  Pop ${PRIMARY}
  ${NSD_CreateLabel} 53u 139u 249u 18u "${PRIMARYDESC}"
  Pop $KuroganeMaintenanceRepairDescriptionControl

  ${NSD_CreateGroupBox} 22u 176u 296u 58u ""
  Pop $0
  ${NSD_CreateRadioButton} 34u 187u 272u 14u "${SECONDARYTEXT}"
  Pop ${SECONDARY}
  ${NSD_CreateLabel} 53u 207u 249u 18u "${SECONDARYDESC}"
  Pop $KuroganeMaintenanceRemoveDescriptionControl

  !insertmacro KuroganePrepareKnownPageImpl "" ${DIALOG} Next
  SendMessage $KuroganeMaintenanceTitleControl ${WM_SETFONT} $KuroganeFontTitle 1
  SetCtlColors $KuroganeMaintenanceTitleControl ${K_COLOR_TEXT} ${K_COLOR_WINDOW}
  SetCtlColors $KuroganeMaintenanceSubtitleControl ${K_COLOR_MUTED} ${K_COLOR_WINDOW}
  SetCtlColors $KuroganeMaintenanceInfoControl ${K_COLOR_MUTED} ${K_COLOR_WINDOW}
  SetCtlColors $KuroganeMaintenanceRepairDescriptionControl ${K_COLOR_MUTED} ${K_COLOR_PANEL}
  SetCtlColors $KuroganeMaintenanceRemoveDescriptionControl ${K_COLOR_MUTED} ${K_COLOR_PANEL}
!macroend

!macro KuroganeMoveWindowDpi HWND X Y WIDTH HEIGHT DPI
  IntOp $4 ${X} * ${DPI}
  IntOp $5 ${Y} * ${DPI}
  IntOp $6 ${WIDTH} * ${DPI}
  IntOp $7 ${HEIGHT} * ${DPI}
  IntOp $4 $4 / 96
  IntOp $5 $5 / 96
  IntOp $6 $6 / 96
  IntOp $7 $7 / 96
  System::Call 'user32::SetWindowPos(p ${HWND}, p 0, i r4, i r5, i r6, i r7, i 0x14)'
!macroend

!macro KuroganeUninstallConfirmPageImpl PAGE CHECKBOX CHECKBOXTEXT
  StrCpy $1 ${PAGE}
  System::Call "user32::GetDpiForWindow(p r1) i .r2"
  ${If} $(^RTL) = 1
    StrCpy $3 "${__NSD_CheckBox_EXSTYLE} | 0x00400000"
  ${Else}
    StrCpy $3 "${__NSD_CheckBox_EXSTYLE}"
  ${EndIf}
  IntOp $4 44 * $2
  IntOp $5 184 * $2
  IntOp $6 500 * $2
  IntOp $7 28 * $2
  IntOp $4 $4 / 96
  IntOp $5 $5 / 96
  IntOp $6 $6 / 96
  IntOp $7 $7 / 96
  System::Call 'user32::CreateWindowEx(i r3, w "${__NSD_CheckBox_CLASS}", w "${CHECKBOXTEXT}", i ${__NSD_CheckBox_STYLE}, i r4, i r5, i r6, i r7, p r1, i0, i0, i0) p .r0'
  StrCpy ${CHECKBOX} $0
  SendMessage ${CHECKBOX} ${WM_SETFONT} $KuroganeFontBody 1

  IntOp $4 44 * $2
  IntOp $5 108 * $2
  IntOp $6 500 * $2
  IntOp $7 48 * $2
  IntOp $4 $4 / 96
  IntOp $5 $5 / 96
  IntOp $6 $6 / 96
  IntOp $7 $7 / 96
  System::Call 'user32::CreateWindowEx(i 0, w "Static", w "$(KUninstallConfirmSubtitle)", i 0x50000000, i r4, i r5, i r6, i r7, p r1, i0, i0, i0) p .r0'
  StrCpy $KuroganeUninstallSubtitleControl $0

  GetDlgItem $0 $1 1006
  SendMessage $0 ${WM_SETTEXT} 0 "STR:$(KUninstallConfirmTitle)"
  SendMessage $0 ${WM_SETFONT} $KuroganeFontTitle 1
  !insertmacro KuroganeMoveWindowDpi $0 44 58 500 40 $2

  GetDlgItem $0 $1 1029
  !insertmacro KuroganeMoveWindowDpi $0 44 250 500 20 $2
  GetDlgItem $0 $1 1000
  !insertmacro KuroganeMoveWindowDpi $0 44 278 500 34 $2

  !insertmacro KuroganePrepareKnownPageImpl "un." ${PAGE} Remove
  GetDlgItem $0 ${PAGE} 1006
  SetCtlColors $0 ${K_COLOR_TEXT} ${K_COLOR_WINDOW}
  SendMessage $KuroganeUninstallSubtitleControl ${WM_SETFONT} $KuroganeFontBody 1
  SetCtlColors $KuroganeUninstallSubtitleControl ${K_COLOR_MUTED} ${K_COLOR_WINDOW}
  SetCtlColors ${CHECKBOX} ${K_COLOR_TEXT} ${K_COLOR_PANEL}
!macroend

; MUI welcome/finish pages expose their exact HWNDs. Use those directly: after
; the progress page, a generic FindWindow can otherwise select a stale dialog.
!macro KuroganeKnownFullWindowPageShowImpl UNPREFIX PAGE IMAGE TITLE TEXT CHROME
  !insertmacro KuroganePrepareKnownPageImpl "${UNPREFIX}" ${PAGE} ${CHROME}

  ShowWindow ${IMAGE} ${SW_HIDE}
  System::Call 'user32::SetWindowPos(p ${TITLE}, p 0, i 44, i 72, i 500, i 72, i 0x14)'
  SetCtlColors ${TITLE} ${K_COLOR_TEXT} ${K_COLOR_WINDOW}
  SendMessage ${TITLE} ${WM_SETFONT} $KuroganeFontTitle 1
  System::Call 'user32::SetWindowPos(p ${TEXT}, p 0, i 44, i 148, i 500, i 230, i 0x14)'
  SetCtlColors ${TEXT} ${K_COLOR_MUTED} ${K_COLOR_WINDOW}
  SendMessage ${TEXT} ${WM_SETFONT} $KuroganeFontBody 1
!macroend

!macro KuroganeProgressPageImpl UNPREFIX TITLE SUBTITLE STATUS
  StrCpy $KuroganeProgressActive 1
  Call ${UNPREFIX}KuroganeApplyChromeNext
  Call ${UNPREFIX}KuroganeBindChromeEvents
  ; The NSIS VM blocks nsDialogs timers while Section instructions execute.
  ; Hide stale welcome navigation synchronously before the first File command.
  GetDlgItem $0 $HWNDPARENT 3
  ShowWindow $0 ${SW_HIDE}
  GetDlgItem $0 $HWNDPARENT 1
  ShowWindow $0 ${SW_HIDE}
  Call ${UNPREFIX}KuroganeStartShellTimer
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
    ; NSIS uses its own progress range (commonly 0..30000), not 0..100.
    ; Normalize the live native position before presenting a percentage.
    SendMessage $KuroganeProgressControl ${PBM_GETRANGE} 0 0 $2
    ${If} $2 > 0
      IntOp $0 $0 * 100
      IntOp $0 $0 / $2
    ${EndIf}
    StrCpy $1 "$0%"
    SendMessage $KuroganePercentControl ${WM_SETTEXT} 0 "STR:$1"
  ${EndIf}
!macroend

Function KuroganeProgressTick
  Push $0
  Push $1
  Push $2
  !insertmacro KuroganeProgressTickImpl
  Pop $2
  Pop $1
  Pop $0
FunctionEnd

Function un.KuroganeProgressTick
  Push $0
  Push $1
  Push $2
  !insertmacro KuroganeProgressTickImpl
  Pop $2
  Pop $1
  Pop $0
FunctionEnd

!macro KuroganeProgressLeaveImpl UNPREFIX
  ${NSD_KillTimer} ${UNPREFIX}KuroganeProgressTick
  ${NSD_FreeImage} $KuroganeProgressBitmap
  StrCpy $KuroganeProgressActive 0
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
  Call KuroganeProgressTick
!macroend
