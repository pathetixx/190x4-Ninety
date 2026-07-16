; Ninety — Kurogane Split installer shell.
; The NSIS engine keeps ownership of navigation and progress. This layer only
; replaces the window resources, applies the visual system and mirrors progress.

!include LogicLib.nsh
!include nsDialogs.nsh
!include WinMessages.nsh

!define MUI_UI "${__FILEDIR__}\kurogane-ui.exe"
!define MUI_CUSTOMFUNCTION_GUIINIT KuroganeGuiInit
!define MUI_CUSTOMFUNCTION_UNGUIINIT un.KuroganeGuiInit
!define K_LANGUAGE_SELECTOR_EXE "${__FILEDIR__}\kurogane-language.exe"

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
Var KuroganeSignalPrimaryControl
Var KuroganeSignalSecondaryControl
Var KuroganeSignalPrimaryBitmap
Var KuroganeSignalSecondaryBitmap
Var KuroganeToggleControl
Var KuroganeToggleBitmap
Var KuroganeProgressControl
Var KuroganePercentControl
Var KuroganeStatusControl
Var KuroganePage
Var KuroganeFontTitle
Var KuroganeFontBody
Var KuroganeFontMeta
Var KuroganeFontSteps
Var KuroganeFontMono
Var KuroganeMatrixParent
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
Var KuroganeUninstallDataTitleControl
Var KuroganeUninstallDataDescriptionControl

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
LangString KLicenseSubtitle 1033 "Readable licensing without falling back to a stock Windows dialog."
LangString KLicenseSignal 1033 "LICENSE SIGNAL"
LangString KModeTitle 1033 "Choose who can use Ninety"
LangString KModeSubtitle 1033 "Choose which Windows accounts can launch Ninety."
LangString KModeSignal 1033 "ACCESS MATRIX"
LangString KModeAllTitle 1033 "ALL ACCOUNTS"
LangString KModeCurrentTitle 1033 "CURRENT ACCOUNT"
LangString KModeAllDescription 1033 "Available to every Windows account on this computer."
LangString KModeCurrentDescription 1033 "Installed only for the current Windows account."
LangString KMaintenanceTitle 1033 "Ninety is already installed"
LangString KMaintenanceSubtitle 1033 "Choose one deliberate action for the existing installation."
LangString KMaintenanceSignal 1033 "OPERATION GRID"
LangString KMaintenanceRepairDescription 1033 "Restore or update the installed application components."
LangString KMaintenanceRemoveDescription 1033 "Remove Ninety and its installed components from this computer."
LangString KMaintenanceReplaceDescription 1033 "Remove the existing version before installing the selected version."
LangString KMaintenanceKeepDescription 1033 "Keep the existing installation and continue without removing it first."
LangString KMaintenanceRepairAction 1033 "Add or reinstall components"
LangString KMaintenanceRemoveAction 1033 "Remove Ninety"
LangString KUninstallConfirmTitle 1033 "Remove Ninety"
LangString KUninstallConfirmSubtitle 1033 "The application will be closed and its installed components will be removed."
LangString KUninstallDeleteData 1033 "Remove settings and data"
LangString KUninstallDeleteDataDescription 1033 "Also remove saved profiles, preferences and local application data."
LangString KUninstallSignal 1033 "REMOVAL MATRIX"
LangString KUninstallPath 1033 "INSTALLATION TARGET"
LangString KTargetTitle 1033 "Deployment target"
LangString KTargetSubtitle 1033 "Keep the destination explicit and easy to verify."
LangString KTargetSignal 1033 "TARGET VECTOR"
LangString KTargetPath 1033 "INSTALL PATH"
LangString KTargetCapacity 1033 "CAPACITY"
LangString KTargetChange 1033 "CHANGE"
LangString KLanguageTitle 1033 "Installer language / Язык установщика"
LangString KLanguageSubtitle 1033 "Choose the interface language · Выберите язык интерфейса"
LangString KLanguageEnglishTitle 1033 "ENGLISH"
LangString KLanguageEnglishDescription 1033 "Primary · default fallback"
LangString KLanguageRussianTitle 1033 "РУССКИЙ"
LangString KLanguageRussianDescription 1033 "Дополнительный язык"
LangString KOtaWindowTitle 1033 "Ninety update"

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
LangString KLicenseSubtitle 1049 "Читаемая лицензия без возврата к стандартному диалогу Windows."
LangString KLicenseSignal 1049 "СИГНАЛ ЛИЦЕНЗИИ"
LangString KModeTitle 1049 "Кто сможет пользоваться Ninety"
LangString KModeSubtitle 1049 "Выберите, какие учётные записи Windows смогут запускать Ninety."
LangString KModeSignal 1049 "МАТРИЦА ДОСТУПА"
LangString KModeAllTitle 1049 "ВСЕ УЧЁТНЫЕ ЗАПИСИ"
LangString KModeCurrentTitle 1049 "ТЕКУЩАЯ УЧЁТНАЯ ЗАПИСЬ"
LangString KModeAllDescription 1049 "Приложение будет доступно всем учётным записям Windows на этом компьютере."
LangString KModeCurrentDescription 1049 "Приложение будет установлено только для текущей учётной записи Windows."
LangString KMaintenanceTitle 1049 "Ninety уже установлен"
LangString KMaintenanceSubtitle 1049 "Выберите одно осознанное действие для существующей установки."
LangString KMaintenanceSignal 1049 "СЕТКА ОПЕРАЦИЙ"
LangString KMaintenanceRepairDescription 1049 "Восстановить или обновить установленные компоненты приложения."
LangString KMaintenanceRemoveDescription 1049 "Удалить Ninety и установленные компоненты с этого компьютера."
LangString KMaintenanceReplaceDescription 1049 "Удалить существующую версию перед установкой выбранной версии."
LangString KMaintenanceKeepDescription 1049 "Сохранить существующую установку и продолжить без предварительного удаления."
LangString KMaintenanceRepairAction 1049 "Добавить или переустановить компоненты"
LangString KMaintenanceRemoveAction 1049 "Удалить Ninety"
LangString KUninstallConfirmTitle 1049 "Удаление Ninety"
LangString KUninstallConfirmSubtitle 1049 "Приложение будет закрыто, а установленные компоненты — удалены."
LangString KUninstallDeleteData 1049 "Удалить настройки и данные"
LangString KUninstallDeleteDataDescription 1049 "Также удалить профили, настройки и локальные данные приложения."
LangString KUninstallSignal 1049 "МАТРИЦА УДАЛЕНИЯ"
LangString KUninstallPath 1049 "ТОЧКА УСТАНОВКИ"
LangString KTargetTitle 1049 "Точка развёртывания"
LangString KTargetSubtitle 1049 "Каталог установки должен быть заметным и легко проверяемым."
LangString KTargetSignal 1049 "ВЕКТОР РАЗВЁРТЫВАНИЯ"
LangString KTargetPath 1049 "КАТАЛОГ УСТАНОВКИ"
LangString KTargetCapacity 1049 "МЕСТО НА ДИСКЕ"
LangString KTargetChange 1049 "ИЗМЕНИТЬ"
LangString KLanguageTitle 1049 "Installer language / Язык установщика"
LangString KLanguageSubtitle 1049 "Choose the interface language · Выберите язык интерфейса"
LangString KLanguageEnglishTitle 1049 "ENGLISH"
LangString KLanguageEnglishDescription 1049 "Primary · default fallback"
LangString KLanguageRussianTitle 1049 "РУССКИЙ"
LangString KLanguageRussianDescription 1049 "Дополнительный язык"
LangString KOtaWindowTitle 1049 "Обновление Ninety"

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

; ---------------------------------------------------------------------------
; Signal Matrix page primitives. Standard MUI pages are resource dialogs, not
; active nsDialogs contexts, so decorative controls must be parented explicitly
; instead of relying on nsDialogs' implicit current-page handle.

!macro KuroganeMatrixBox X Y W H COLOR
  IntOp $4 ${X} + ${W}
  IntOp $5 ${Y} + ${H}
  System::Call '*(&i4 ${X}, &i4 ${Y}, &i4 r4, &i4 r5) p .r6'
  System::Call 'user32::MapDialogRect(p $KuroganeMatrixParent, p r6)'
  System::Call '*$6(&i4 .r4, &i4 .r5, &i4 .r7, &i4 .r8)'
  System::Free $6
  IntOp $7 $7 - $4
  IntOp $8 $8 - $5
  System::Call 'user32::CreateWindowExW(i 0, w "Static", w "", i 0x50000000, i r4, i r5, i r7, i r8, p $KuroganeMatrixParent, i 0, i 0, i 0) p .r0'
  SetCtlColors $0 ${COLOR} ${COLOR}
!macroend

!macro KuroganeMatrixFrame X Y W H IX IY IW IH BORDER BACKGROUND
  !insertmacro KuroganeMatrixBox ${X} ${Y} ${W} ${H} ${BORDER}
  !insertmacro KuroganeMatrixBox ${IX} ${IY} ${IW} ${IH} ${BACKGROUND}
!macroend

!macro KuroganeMatrixText X Y W H TEXT FOREGROUND BACKGROUND FONT
  IntOp $4 ${X} + ${W}
  IntOp $5 ${Y} + ${H}
  System::Call '*(&i4 ${X}, &i4 ${Y}, &i4 r4, &i4 r5) p .r6'
  System::Call 'user32::MapDialogRect(p $KuroganeMatrixParent, p r6)'
  System::Call '*$6(&i4 .r4, &i4 .r5, &i4 .r7, &i4 .r8)'
  System::Free $6
  IntOp $7 $7 - $4
  IntOp $8 $8 - $5
  System::Call 'user32::CreateWindowExW(i 0, w "Static", w "${TEXT}", i 0x50000000, i r4, i r5, i r7, i r8, p $KuroganeMatrixParent, i 0, i 0, i 0) p .r0'
  SetCtlColors $0 ${FOREGROUND} ${BACKGROUND}
  SendMessage $0 ${WM_SETFONT} ${FONT} 1
!macroend

!macro KuroganeMatrixHeader LABEL META
  !insertmacro KuroganeMatrixBox 22 82 5 169 ${K_COLOR_ACCENT}
  !insertmacro KuroganeMatrixBox 31 82 287 1 ${K_COLOR_BORDER}
  !insertmacro KuroganeMatrixText 31 90 170 12 "${LABEL}" ${K_COLOR_ACCENT} ${K_COLOR_WINDOW} $KuroganeFontMono
  !insertmacro KuroganeMatrixText 221 90 97 12 "${META}" ${K_COLOR_MUTED} ${K_COLOR_WINDOW} $KuroganeFontMono
!macroend

!macro KuroganeMoveWindowDlu PARENT HWND X Y WIDTH HEIGHT
  IntOp $4 ${X} + ${WIDTH}
  IntOp $5 ${Y} + ${HEIGHT}
  System::Call '*(&i4 ${X}, &i4 ${Y}, &i4 r4, &i4 r5) p .r6'
  System::Call 'user32::MapDialogRect(p ${PARENT}, p r6)'
  System::Call '*$6(&i4 .r4, &i4 .r5, &i4 .r7, &i4 .r8)'
  System::Free $6
  IntOp $7 $7 - $4
  IntOp $8 $8 - $5
  System::Call 'user32::SetWindowPos(p ${HWND}, p 0, i r4, i r5, i r7, i r8, i 0x14)'
!macroend

!macro KuroganeBringToFront HWND
  System::Call 'user32::SetWindowPos(p ${HWND}, p 0, i 0, i 0, i 0, i 0, i 0x13)'
!macroend

!macro KuroganeSignalRadio X Y OUT
  nsDialogs::CreateControl BUTTON "${DEFAULT_STYLES}|${WS_TABSTOP}|${BS_AUTORADIOBUTTON}|${BS_BITMAP}|${BS_FLAT}" 0 ${X}u ${Y}u 14u 14u ""
  Pop ${OUT}
  System::Call 'uxtheme::SetWindowTheme(p ${OUT}, w "", w "")'
!macroend

!macro KuroganeSignalImage CONTROL HANDLE SELECTED
  ${If} ${CONTROL} != 0
    ${If} ${HANDLE} != 0
      SendMessage ${CONTROL} ${BM_SETIMAGE} ${IMAGE_BITMAP} 0
      ${NSD_FreeImage} ${HANDLE}
      StrCpy ${HANDLE} 0
    ${EndIf}
    ${If} ${SELECTED} == ${BST_CHECKED}
      System::Call 'user32::LoadImageW(p 0, w "$PLUGINSDIR\kurogane-signal-on.bmp", i 0, i 0, i 0, i 0x2010) p .r0'
    ${Else}
      System::Call 'user32::LoadImageW(p 0, w "$PLUGINSDIR\kurogane-signal-off.bmp", i 0, i 0, i 0, i 0x2010) p .r0'
    ${EndIf}
    StrCpy ${HANDLE} $0
    SendMessage ${CONTROL} ${BM_SETIMAGE} ${IMAGE_BITMAP} $0
  ${EndIf}
!macroend

Function KuroganeApplySignalStates
  SendMessage $KuroganeSignalPrimaryControl ${BM_GETCHECK} 0 0 $1
  !insertmacro KuroganeSignalImage $KuroganeSignalPrimaryControl $KuroganeSignalPrimaryBitmap $1
  ${If} $KuroganeSignalSecondaryControl != 0
    SendMessage $KuroganeSignalSecondaryControl ${BM_GETCHECK} 0 0 $1
    !insertmacro KuroganeSignalImage $KuroganeSignalSecondaryControl $KuroganeSignalSecondaryBitmap $1
  ${EndIf}
FunctionEnd

Function KuroganeSignalPrimaryClick
  Pop $9
  SendMessage $KuroganeSignalPrimaryControl ${BM_SETCHECK} ${BST_CHECKED} 0
  SendMessage $KuroganeSignalSecondaryControl ${BM_SETCHECK} ${BST_UNCHECKED} 0
  Call KuroganeApplySignalStates
FunctionEnd

Function KuroganeSignalSecondaryClick
  Pop $9
  SendMessage $KuroganeSignalPrimaryControl ${BM_SETCHECK} ${BST_UNCHECKED} 0
  SendMessage $KuroganeSignalSecondaryControl ${BM_SETCHECK} ${BST_CHECKED} 0
  Call KuroganeApplySignalStates
FunctionEnd

Function un.KuroganeApplyToggleState
  SendMessage $KuroganeToggleControl ${BM_GETCHECK} 0 0 $1
  !insertmacro KuroganeSignalImage $KuroganeToggleControl $KuroganeToggleBitmap $1
FunctionEnd

Function un.KuroganeToggleClick
  Pop $9
  Call un.KuroganeApplyToggleState
FunctionEnd

!macro KuroganeRunLanguageSelector RESULT
  InitPluginsDir
  File /oname=$PLUGINSDIR\ninety-language.exe "${K_LANGUAGE_SELECTOR_EXE}"
  ExecWait '"$PLUGINSDIR\ninety-language.exe"' ${RESULT}
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
    ; A native BS_BITMAP button still paints a system border over the bitmap.
    ; Give it a two-pixel gutter and clip that gutter out of the window region:
    ; the remaining hit target is exactly the original Kurogane bitmap.
    IntOp $4 $4 - 2
    IntOp $5 $5 - 2
    IntOp $6 $8 + 4
    IntOp $7 $9 + 4
    System::Call 'user32::SetWindowPos(p r0, p 0, i r4, i r5, i r6, i r7, i 0x14)'
    IntOp $6 $8 + 2
    IntOp $7 $9 + 2
    System::Call 'gdi32::CreateRectRgn(i 2, i 2, i r6, i r7) p .r3'
    System::Call 'user32::SetWindowRgn(p r0, p r3, i 1)'
    ShowWindow $1 ${SW_HIDE}
    System::Call 'user32::InvalidateRect(p r0, p 0, i 1)'
  ${EndIf}
!macroend

!macro KuroganeApplyChromeImpl NEXT_EN NEXT_RU SHOW_BACK SHOW_NEXT SHOW_CANCEL
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

  GetDlgItem $0 $HWNDPARENT 3
  ShowWindow $0 ${SHOW_BACK}
  GetDlgItem $0 $HWNDPARENT 1
  ShowWindow $0 ${SHOW_NEXT}
  GetDlgItem $0 $HWNDPARENT 2
  ShowWindow $0 ${SHOW_CANCEL}
!macroend

Function KuroganeApplyChromeNext
  !insertmacro KuroganeApplyChromeImpl "next" "next" ${SW_SHOW} ${SW_SHOW} ${SW_SHOW}
FunctionEnd
Function un.KuroganeApplyChromeNext
  !insertmacro KuroganeApplyChromeImpl "next" "next" ${SW_SHOW} ${SW_SHOW} ${SW_SHOW}
FunctionEnd
Function KuroganeApplyChromeInstall
  !insertmacro KuroganeApplyChromeImpl "install" "install" ${SW_HIDE} ${SW_SHOW} ${SW_SHOW}
FunctionEnd
Function un.KuroganeApplyChromeInstall
  !insertmacro KuroganeApplyChromeImpl "install" "install" ${SW_HIDE} ${SW_SHOW} ${SW_SHOW}
FunctionEnd
Function KuroganeApplyChromeRemove
  !insertmacro KuroganeApplyChromeImpl "remove" "remove" ${SW_HIDE} ${SW_SHOW} ${SW_SHOW}
FunctionEnd
Function un.KuroganeApplyChromeRemove
  !insertmacro KuroganeApplyChromeImpl "remove" "remove" ${SW_HIDE} ${SW_SHOW} ${SW_SHOW}
FunctionEnd
Function KuroganeApplyChromeFinish
  !insertmacro KuroganeApplyChromeImpl "finish" "finish" ${SW_HIDE} ${SW_SHOW} ${SW_HIDE}
FunctionEnd
Function un.KuroganeApplyChromeFinish
  !insertmacro KuroganeApplyChromeImpl "finish" "finish" ${SW_HIDE} ${SW_SHOW} ${SW_HIDE}
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

; During a passive OTA update NSIS starts directly on InstFiles and executes
; synchronous Section instructions. nsDialogs timers cannot service the custom
; caption in that state. Give only the OTA window a real dark Windows caption:
; native dragging/minimize remain responsive in the OS message loop, while
; Close is visibly disabled so an in-place binary replacement cannot be cut off.
!macro KuroganeEnableManagedOtaWindowImpl
  ${If} $PassiveMode == 1
    SendMessage $HWNDPARENT ${WM_SETTEXT} 0 "STR:$(KOtaWindowTitle)"

    GetDlgItem $0 $HWNDPARENT 1205
    ShowWindow $0 ${SW_HIDE}
    GetDlgItem $0 $HWNDPARENT 1207
    ShowWindow $0 ${SW_HIDE}

    System::Call '*(&i4 0, &i4 0, &i4 0, &i4 0) p .r0'
    System::Call 'user32::GetClientRect(p $HWNDPARENT, p r0)'
    System::Call '*$0(&i4 .r1, &i4 .r2, &i4 .r3, &i4 .r4)'
    System::Free $0
    IntOp $3 $3 - $1
    IntOp $4 $4 - $2

    System::Call 'user32::GetWindowLongW(p $HWNDPARENT, i -16) i .r5'
    IntOp $5 $5 | 0x00C20000
    System::Call 'user32::SetWindowLongW(p $HWNDPARENT, i -16, i r5)'
    System::Call 'user32::GetWindowLongW(p $HWNDPARENT, i -20) i .r6'
    System::Call '*(&i4 0, &i4 0, &i4 r3, &i4 r4) p .r0'
    System::Call 'user32::AdjustWindowRectEx(p r0, i r5, i 0, i r6)'
    System::Call '*$0(&i4 .r1, &i4 .r2, &i4 .r3, &i4 .r4)'
    System::Free $0
    IntOp $3 $3 - $1
    IntOp $4 $4 - $2
    System::Call 'user32::SetWindowPos(p $HWNDPARENT, p 0, i 0, i 0, i r3, i r4, i 0x36)'

    ; Windows 11 caption colors; immersive dark mode remains the Win10 fallback.
    System::Call 'dwmapi::DwmSetWindowAttribute(p $HWNDPARENT, i 20, *i 1, i 4)'
    System::Call 'dwmapi::DwmSetWindowAttribute(p $HWNDPARENT, i 19, *i 1, i 4)'
    System::Call 'dwmapi::DwmSetWindowAttribute(p $HWNDPARENT, i 34, *i 0x003E3737, i 4)'
    System::Call 'dwmapi::DwmSetWindowAttribute(p $HWNDPARENT, i 35, *i 0x000E0B0B, i 4)'
    System::Call 'dwmapi::DwmSetWindowAttribute(p $HWNDPARENT, i 36, *i 0x00F3F1F1, i 4)'

    System::Call 'user32::GetSystemMenu(p $HWNDPARENT, i 0) p .r0'
    System::Call 'user32::EnableMenuItem(p r0, i 0xF060, i 0x00000001)'
    System::Call 'user32::DrawMenuBar(p $HWNDPARENT)'
  ${EndIf}
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
  File /oname=$PLUGINSDIR\kurogane-signal-off.bmp "${__FILEDIR__}\signal-off.bmp"
  File /oname=$PLUGINSDIR\kurogane-signal-on.bmp "${__FILEDIR__}\signal-on.bmp"

  CreateFont $KuroganeFontTitle "Segoe UI" 20 600
  CreateFont $KuroganeFontBody "Segoe UI" 9 400
  CreateFont $KuroganeFontMeta "Segoe UI" 8 400
  CreateFont $KuroganeFontSteps "Segoe UI" 8 500
  CreateFont $KuroganeFontMono "Cascadia Mono" 8 500

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
  !insertmacro KuroganeEnableManagedOtaWindowImpl
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
          ; Follow the page's native action: Cancel during setup/progress and
          ; Finish on the final page where Cancel is intentionally hidden.
          GetDlgItem $0 $HWNDPARENT 2
          System::Call 'user32::IsWindowVisible(p r0) i .r1'
          ${If} $1 != 0
            SendMessage $0 ${BM_CLICK} 0 0
          ${Else}
            GetDlgItem $0 $HWNDPARENT 1
            SendMessage $0 ${BM_CLICK} 0 0
          ${EndIf}
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
  StrCpy $KuroganeMatrixParent ${PAGE}

  SendMessage ${TOPCONTROL} ${WM_SETTEXT} 0 "STR:$(KLicenseTitle)"
  SendMessage ${TOPCONTROL} ${WM_SETFONT} $KuroganeFontTitle 1
  SetCtlColors ${TOPCONTROL} ${K_COLOR_TEXT} ${K_COLOR_WINDOW}
  !insertmacro KuroganeMoveWindowDlu ${PAGE} ${TOPCONTROL} 22 17 296 25

  !insertmacro KuroganeMatrixText 22 48 296 22 "$(KLicenseSubtitle)" ${K_COLOR_MUTED} ${K_COLOR_WINDOW} $KuroganeFontBody
  !insertmacro KuroganeMatrixHeader "$(KLicenseSignal)" "MIT  /  OPEN SOURCE"
  !insertmacro KuroganeMatrixFrame 43 116 259 124 44 117 257 122 ${K_COLOR_BORDER} ${K_COLOR_FIELD}

  !insertmacro KuroganeMoveWindowDlu ${PAGE} ${RICHCONTROL} 43 116 259 124
  !insertmacro KuroganeBringToFront ${RICHCONTROL}
  System::Call 'uxtheme::SetWindowTheme(p ${RICHCONTROL}, w "", w "")'
  SetCtlColors ${RICHCONTROL} ${K_COLOR_TEXT} ${K_COLOR_FIELD}
  SendMessage ${RICHCONTROL} ${EM_SETBKGNDCOLOR} 0 0x1D1717

  GetDlgItem $0 ${PAGE} 1006
  !insertmacro KuroganeMoveWindowDlu ${PAGE} $0 43 247 259 27
  SetCtlColors $0 ${K_COLOR_MUTED} ${K_COLOR_WINDOW}
  SendMessage $0 ${WM_SETFONT} $KuroganeFontMeta 1
!macroend

; Rebuild the MultiUser page controls inside the page that the plugin already
; owns. Its leave callback continues to read the same handle variables.
!macro KuroganeInstallModePageImpl
  StrCpy $KuroganeMatrixParent $MultiUser.InstallModePage
  ShowWindow $MultiUser.InstallModePage.Text ${SW_HIDE}
  ShowWindow $MultiUser.InstallModePage.AllUsers ${SW_HIDE}
  ShowWindow $MultiUser.InstallModePage.CurrentUser ${SW_HIDE}

  ${NSD_CreateLabel} 22u 17u 296u 25u "$(KModeTitle)"
  Pop $KuroganeModeTitleControl
  ${NSD_CreateLabel} 22u 48u 296u 22u "$(KModeSubtitle)"
  Pop $KuroganeModeSubtitleControl

  !insertmacro KuroganeMatrixHeader "$(KModeSignal)" "WINDOWS / ACCOUNT SCOPE"
  !insertmacro KuroganeMatrixFrame 42 116 260 55 43 117 258 53 ${K_COLOR_BORDER} ${K_COLOR_PANEL}
  !insertmacro KuroganeMatrixText 58 127 185 14 "$(KModeCurrentTitle)" ${K_COLOR_TEXT} ${K_COLOR_PANEL} $KuroganeFontSteps
  ${NSD_CreateLabel} 58u 146u 200u 22u "$(KModeCurrentDescription)"
  Pop $KuroganeModeCurrentDescriptionControl
  !insertmacro KuroganeSignalRadio 278 135 $MultiUser.InstallModePage.CurrentUser

  !insertmacro KuroganeMatrixFrame 58 181 244 55 59 182 242 53 ${K_COLOR_BORDER} ${K_COLOR_FIELD}
  !insertmacro KuroganeMatrixText 74 192 169 14 "$(KModeAllTitle)" ${K_COLOR_TEXT} ${K_COLOR_FIELD} $KuroganeFontSteps
  ${NSD_CreateLabel} 74u 211u 184u 22u "$(KModeAllDescription)"
  Pop $KuroganeModeAllDescriptionControl
  !insertmacro KuroganeSignalRadio 278 200 $MultiUser.InstallModePage.AllUsers

  ${If} $MultiUser.InstallMode == "AllUsers"
    SendMessage $MultiUser.InstallModePage.AllUsers ${BM_SETCHECK} ${BST_CHECKED} 0
    ${NSD_SetFocus} $MultiUser.InstallModePage.AllUsers
  ${Else}
    SendMessage $MultiUser.InstallModePage.CurrentUser ${BM_SETCHECK} ${BST_CHECKED} 0
    ${NSD_SetFocus} $MultiUser.InstallModePage.CurrentUser
  ${EndIf}

  StrCpy $KuroganeSignalPrimaryControl $MultiUser.InstallModePage.CurrentUser
  StrCpy $KuroganeSignalSecondaryControl $MultiUser.InstallModePage.AllUsers
  ${NSD_OnClick} $KuroganeSignalPrimaryControl KuroganeSignalPrimaryClick
  ${NSD_OnClick} $KuroganeSignalSecondaryControl KuroganeSignalSecondaryClick
  Call KuroganeApplySignalStates

  !insertmacro KuroganePrepareKnownPageImpl "" $MultiUser.InstallModePage Next
  SendMessage $KuroganeModeTitleControl ${WM_SETFONT} $KuroganeFontTitle 1
  SetCtlColors $KuroganeModeTitleControl ${K_COLOR_TEXT} ${K_COLOR_WINDOW}
  SetCtlColors $KuroganeModeSubtitleControl ${K_COLOR_MUTED} ${K_COLOR_WINDOW}
  SetCtlColors $KuroganeModeCurrentDescriptionControl ${K_COLOR_MUTED} ${K_COLOR_PANEL}
  SetCtlColors $KuroganeModeAllDescriptionControl ${K_COLOR_MUTED} ${K_COLOR_FIELD}
  SendMessage $KuroganeModeCurrentDescriptionControl ${WM_SETFONT} $KuroganeFontBody 1
  SendMessage $KuroganeModeAllDescriptionControl ${WM_SETFONT} $KuroganeFontBody 1
!macroend

!macro KuroganeMaintenancePageImpl DIALOG PRIMARY SECONDARY INTROTEXT PRIMARYTEXT SECONDARYTEXT PRIMARYDESC SECONDARYDESC
  StrCpy $KuroganeMatrixParent ${DIALOG}
  ${NSD_CreateLabel} 22u 17u 296u 25u "$(KMaintenanceTitle)"
  Pop $KuroganeMaintenanceTitleControl
  ${NSD_CreateLabel} 22u 48u 296u 22u "$(KMaintenanceSubtitle)"
  Pop $KuroganeMaintenanceSubtitleControl
  !insertmacro KuroganeMatrixHeader "$(KMaintenanceSignal)" "PACKAGE / DECISION"
  ${NSD_CreateLabel} 43u 107u 259u 13u "${INTROTEXT}"
  Pop $KuroganeMaintenanceInfoControl

  !insertmacro KuroganeMatrixFrame 43 126 259 52 44 127 257 50 ${K_COLOR_BORDER} ${K_COLOR_PANEL}
  !insertmacro KuroganeMatrixText 59 136 188 14 "${PRIMARYTEXT}" ${K_COLOR_TEXT} ${K_COLOR_PANEL} $KuroganeFontSteps
  ${NSD_CreateLabel} 59u 155u 205u 20u "${PRIMARYDESC}"
  Pop $KuroganeMaintenanceRepairDescriptionControl
  !insertmacro KuroganeSignalRadio 278 145 ${PRIMARY}

  !insertmacro KuroganeMatrixFrame 59 188 243 57 60 189 241 55 ${K_COLOR_BORDER} ${K_COLOR_FIELD}
  !insertmacro KuroganeMatrixText 75 198 172 14 "${SECONDARYTEXT}" ${K_COLOR_TEXT} ${K_COLOR_FIELD} $KuroganeFontSteps
  ${NSD_CreateLabel} 75u 217u 189u 24u "${SECONDARYDESC}"
  Pop $KuroganeMaintenanceRemoveDescriptionControl
  !insertmacro KuroganeSignalRadio 278 207 ${SECONDARY}

  StrCpy $KuroganeSignalPrimaryControl ${PRIMARY}
  StrCpy $KuroganeSignalSecondaryControl ${SECONDARY}
  ${NSD_OnClick} $KuroganeSignalPrimaryControl KuroganeSignalPrimaryClick
  ${NSD_OnClick} $KuroganeSignalSecondaryControl KuroganeSignalSecondaryClick
  Call KuroganeApplySignalStates

  !insertmacro KuroganePrepareKnownPageImpl "" ${DIALOG} Next
  SendMessage $KuroganeMaintenanceTitleControl ${WM_SETFONT} $KuroganeFontTitle 1
  SetCtlColors $KuroganeMaintenanceTitleControl ${K_COLOR_TEXT} ${K_COLOR_WINDOW}
  SetCtlColors $KuroganeMaintenanceSubtitleControl ${K_COLOR_MUTED} ${K_COLOR_WINDOW}
  SetCtlColors $KuroganeMaintenanceInfoControl ${K_COLOR_MUTED} ${K_COLOR_WINDOW}
  SetCtlColors $KuroganeMaintenanceRepairDescriptionControl ${K_COLOR_MUTED} ${K_COLOR_PANEL}
  SetCtlColors $KuroganeMaintenanceRemoveDescriptionControl ${K_COLOR_MUTED} ${K_COLOR_FIELD}
  SendMessage $KuroganeMaintenanceInfoControl ${WM_SETFONT} $KuroganeFontMono 1
  SendMessage $KuroganeMaintenanceRepairDescriptionControl ${WM_SETFONT} $KuroganeFontBody 1
  SendMessage $KuroganeMaintenanceRemoveDescriptionControl ${WM_SETFONT} $KuroganeFontBody 1
!macroend

!macro KuroganeDirectoryPageImpl PAGE
  !insertmacro KuroganePrepareKnownPageImpl "" ${PAGE} Next
  StrCpy $KuroganeMatrixParent ${PAGE}

  GetDlgItem $0 ${PAGE} 1006
  ShowWindow $0 ${SW_HIDE}
  GetDlgItem $0 ${PAGE} 1020
  ShowWindow $0 ${SW_HIDE}
  GetDlgItem $0 ${PAGE} 1008
  ShowWindow $0 ${SW_HIDE}

  !insertmacro KuroganeMatrixText 22 17 296 25 "$(KTargetTitle)" ${K_COLOR_TEXT} ${K_COLOR_WINDOW} $KuroganeFontTitle
  !insertmacro KuroganeMatrixText 22 48 296 22 "$(KTargetSubtitle)" ${K_COLOR_MUTED} ${K_COLOR_WINDOW} $KuroganeFontBody
  !insertmacro KuroganeMatrixHeader "$(KTargetSignal)" "FILESYSTEM / LOCAL"
  !insertmacro KuroganeMatrixText 43 116 200 11 "$(KTargetPath)" ${K_COLOR_MUTED} ${K_COLOR_WINDOW} $KuroganeFontMono
  !insertmacro KuroganeMatrixFrame 43 134 259 45 44 135 257 43 ${K_COLOR_ACCENT} ${K_COLOR_FIELD}
  !insertmacro KuroganeMatrixBox 44 135 5 43 ${K_COLOR_ACCENT}

  GetDlgItem $0 ${PAGE} 1019
  !insertmacro KuroganeMoveWindowDlu ${PAGE} $0 58 147 150 18
  !insertmacro KuroganeBringToFront $0
  System::Call 'uxtheme::SetWindowTheme(p r0, w "", w "")'
  SetCtlColors $0 ${K_COLOR_TEXT} ${K_COLOR_FIELD}
  SendMessage $0 ${WM_SETFONT} $KuroganeFontMono 1

  GetDlgItem $0 ${PAGE} 1001
  !insertmacro KuroganeMoveWindowDlu ${PAGE} $0 219 145 74 22
  !insertmacro KuroganeBringToFront $0
  SendMessage $0 ${WM_SETTEXT} 0 "STR:$(KTargetChange)"
  System::Call 'uxtheme::SetWindowTheme(p r0, w "", w "")'
  SetCtlColors $0 ${K_COLOR_ACCENT} ${K_COLOR_PANEL}
  SendMessage $0 ${WM_SETFONT} $KuroganeFontMono 1

  !insertmacro KuroganeMatrixText 43 195 100 11 "$(KTargetCapacity)" ${K_COLOR_MUTED} ${K_COLOR_WINDOW} $KuroganeFontMono
  !insertmacro KuroganeMatrixBox 43 214 18 8 ${K_COLOR_ACCENT}
  !insertmacro KuroganeMatrixBox 65 214 18 8 ${K_COLOR_BORDER}
  !insertmacro KuroganeMatrixBox 87 214 18 8 ${K_COLOR_BORDER}
  !insertmacro KuroganeMatrixBox 109 214 18 8 ${K_COLOR_BORDER}
  !insertmacro KuroganeMatrixBox 131 214 18 8 ${K_COLOR_BORDER}
  !insertmacro KuroganeMatrixBox 153 214 18 8 ${K_COLOR_BORDER}

  GetDlgItem $0 ${PAGE} 1023
  !insertmacro KuroganeMoveWindowDlu ${PAGE} $0 43 234 128 16
  SetCtlColors $0 ${K_COLOR_MUTED} ${K_COLOR_WINDOW}
  SendMessage $0 ${WM_SETFONT} $KuroganeFontMeta 1
  GetDlgItem $0 ${PAGE} 1024
  !insertmacro KuroganeMoveWindowDlu ${PAGE} $0 176 234 126 16
  SetCtlColors $0 ${K_COLOR_TEXT} ${K_COLOR_WINDOW}
  SendMessage $0 ${WM_SETFONT} $KuroganeFontMeta 1
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
  StrCpy $KuroganeMatrixParent ${PAGE}
  ${If} $(^RTL) = 1
    StrCpy $3 "${__NSD_CheckBox_EXSTYLE} | 0x00400000"
  ${Else}
    StrCpy $3 "${__NSD_CheckBox_EXSTYLE}"
  ${EndIf}
  IntOp $4 278 + 14
  IntOp $5 135 + 14
  System::Call '*(&i4 278, &i4 135, &i4 r4, &i4 r5) p .r6'
  System::Call 'user32::MapDialogRect(p r1, p r6)'
  System::Call '*$6(&i4 .r4, &i4 .r5, &i4 .r7, &i4 .r8)'
  System::Free $6
  IntOp $7 $7 - $4
  IntOp $8 $8 - $5
  IntOp $9 ${__NSD_CheckBox_STYLE} | ${BS_BITMAP}
  IntOp $9 $9 | ${BS_FLAT}
  System::Call 'user32::CreateWindowEx(i r3, w "${__NSD_CheckBox_CLASS}", w "", i r9, i r4, i r5, i r7, i r8, p r1, i0, i0, i0) p .r0'
  StrCpy ${CHECKBOX} $0
  System::Call 'uxtheme::SetWindowTheme(p r0, w "", w "")'
  SendMessage ${CHECKBOX} ${WM_SETFONT} $KuroganeFontBody 1

  !insertmacro KuroganeMatrixText 22 48 296 22 "$(KUninstallConfirmSubtitle)" ${K_COLOR_MUTED} ${K_COLOR_WINDOW} $KuroganeFontBody
  !insertmacro KuroganeMatrixHeader "$(KUninstallSignal)" "DATA / COMPONENTS"
  !insertmacro KuroganeMatrixFrame 43 118 259 54 44 119 257 52 ${K_COLOR_BORDER} ${K_COLOR_PANEL}

  !insertmacro KuroganeMatrixText 58 127 205 14 "${CHECKBOXTEXT}" ${K_COLOR_TEXT} ${K_COLOR_PANEL} $KuroganeFontSteps
  StrCpy $KuroganeUninstallDataTitleControl $0
  !insertmacro KuroganeMatrixText 58 146 205 22 "$(KUninstallDeleteDataDescription)" ${K_COLOR_MUTED} ${K_COLOR_PANEL} $KuroganeFontBody
  StrCpy $KuroganeUninstallDataDescriptionControl $0

  !insertmacro KuroganeMatrixText 43 187 259 12 "$(KUninstallPath)" ${K_COLOR_MUTED} ${K_COLOR_WINDOW} $KuroganeFontMono
  StrCpy $KuroganeUninstallSubtitleControl $0

  GetDlgItem $0 $1 1006
  SendMessage $0 ${WM_SETTEXT} 0 "STR:$(KUninstallConfirmTitle)"
  SendMessage $0 ${WM_SETFONT} $KuroganeFontTitle 1
  !insertmacro KuroganeMoveWindowDlu ${PAGE} $0 22 17 296 25

  GetDlgItem $0 $1 1029
  ShowWindow $0 ${SW_HIDE}
  GetDlgItem $0 $1 1000
  !insertmacro KuroganeMoveWindowDlu ${PAGE} $0 43 207 259 20
  !insertmacro KuroganeBringToFront $0
  System::Call 'uxtheme::SetWindowTheme(p r0, w "", w "")'

  !insertmacro KuroganePrepareKnownPageImpl "un." ${PAGE} Remove
  GetDlgItem $0 ${PAGE} 1006
  SetCtlColors $0 ${K_COLOR_TEXT} ${K_COLOR_WINDOW}
  SendMessage $KuroganeUninstallSubtitleControl ${WM_SETFONT} $KuroganeFontMono 1
  SetCtlColors $KuroganeUninstallSubtitleControl ${K_COLOR_MUTED} ${K_COLOR_WINDOW}
  SetCtlColors $KuroganeUninstallDataTitleControl ${K_COLOR_TEXT} ${K_COLOR_PANEL}
  SetCtlColors $KuroganeUninstallDataDescriptionControl ${K_COLOR_MUTED} ${K_COLOR_PANEL}
  SendMessage $KuroganeUninstallDataTitleControl ${WM_SETFONT} $KuroganeFontSteps 1
  SendMessage $KuroganeUninstallDataDescriptionControl ${WM_SETFONT} $KuroganeFontBody 1
  SetCtlColors ${CHECKBOX} ${K_COLOR_TEXT} ${K_COLOR_ACCENT}
  !insertmacro KuroganeBringToFront ${CHECKBOX}
  StrCpy $KuroganeToggleControl ${CHECKBOX}
  ${NSD_OnClick} $KuroganeToggleControl un.KuroganeToggleClick
  Call un.KuroganeApplyToggleState
  GetDlgItem $0 ${PAGE} 1000
  SetCtlColors $0 ${K_COLOR_TEXT} ${K_COLOR_FIELD}
  SendMessage $0 ${WM_SETFONT} $KuroganeFontMono 1
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
  System::Call 'gdi32::CreateRectRgn(i 0, i 0, i 0, i 0) p .r1'
  System::Call 'user32::SetWindowRgn(p r0, p r1, i 1)'
  GetDlgItem $0 $HWNDPARENT 1
  ShowWindow $0 ${SW_HIDE}
  System::Call 'gdi32::CreateRectRgn(i 0, i 0, i 0, i 0) p .r1'
  System::Call 'user32::SetWindowRgn(p r0, p r1, i 1)'
  ; Hiding a clipped bitmap button can leave stale pixels in the frameless
  ; footer until Windows happens to repaint its parent. Redraw synchronously.
  System::Call 'user32::RedrawWindow(p $HWNDPARENT, p 0, p 0, i 0x0185)'
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
  ${If} $PassiveMode == 1
    SendMessage $HWNDPARENT ${WM_SETTEXT} 0 "STR:$(KOtaWindowTitle)"
  ${EndIf}
  !insertmacro KuroganeProgressPageImpl "" "$(KInstallTitle)" "$(KInstallSubtitle)" "$(KInstallStatus)"
  ${If} $PassiveMode == 1
    ; An in-place OTA replacement must not advertise an unsafe action that
    ; cannot be serviced while NSIS executes synchronous Section instructions.
    GetDlgItem $0 $HWNDPARENT 1214
    ShowWindow $0 ${SW_HIDE}
    GetDlgItem $0 $HWNDPARENT 2
    ShowWindow $0 ${SW_HIDE}
  ${EndIf}
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
