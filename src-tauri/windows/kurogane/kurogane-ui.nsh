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
Var KuroganeActionBitmap
Var KuroganeSignalPrimaryControl
Var KuroganeSignalSecondaryControl
Var KuroganeSignalPrimaryBorder
Var KuroganeSignalSecondaryBorder
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
Var KuroganeLicenseTextControl
Var KuroganeLicenseThumbControl
Var KuroganeLicensePositionControl
Var KuroganeMaintenancePrimaryTextValue
Var KuroganeMaintenanceSecondaryTextValue
Var KuroganeMaintenancePrimaryDescriptionValue
Var KuroganeMaintenanceSecondaryDescriptionValue
Var KuroganeTargetEditControl
Var KuroganeTargetPathDisplayControl
Var KuroganeForegroundHandoffPending
Var KuroganeForegroundHandoffAttempts

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
LangString KLicenseEyebrow 1033 "SIGNAL MATRIX / MANIFEST"
LangString KLicenseType 1033 "LICENSE"
LangString KLicenseModules 1033 "MODULES"
LangString KLicensePosition 1033 "READ POSITION"
LangString KLicenseKeys 1033 "PAGE UP / PAGE DOWN"
LangString KLicenseDocument1 1033 "Ninety — 190x4 VPN$\r$\nMIT License · Copyright © 2026 pathetixx · 190x4.pw$\r$\n$\r$\nNinety is free and open source:$\r$\ngithub.com/pathetixx/190x4-Ninety$\r$\n$\r$\nWHAT YOU ARE INSTALLING$\r$\n"
LangString KLicenseDocument2 1033 "• Ninety.exe — application interface and controller.$\r$\n• sing-box.exe — primary networking engine.$\r$\n• xray.exe — XHTTP engine.$\r$\n• naive.exe and trusttunnel_client.exe — local protocol bridges.$\r$\n• wintun.dll — VPN · TUN adapter.$\r$\n• winws.exe, WinDivert64.sys and Monkey64.sys — DPI-bypass components.$\r$\n$\r$\n"
LangString KLicenseDocument3 1033 "SYSTEM ACCESS$\r$\nNinety does not install its own permanently running Windows service. Elevated access is requested only for VPN · TUN, DPI bypass and related driver cleanup.$\r$\n$\r$\nNETWORK ACTIVITY$\r$\nSubscriptions are fetched from user-provided addresses. VPN traffic is sent through user-selected servers. App updates use GitLab and GitHub Releases; signed DPI data updates use GitHub Releases.$\r$\n$\r$\n"
LangString KLicenseDocument4 1033 "Region, availability and connection-quality checks contact external test or IP services only when those features are used. WARP registration contacts Cloudflare only on explicit request. Ninety contains no first-party telemetry, analytics or advertising.$\r$\n$\r$\nTHIRD-PARTY COMPONENTS$\r$\nBundled executables, libraries and drivers remain subject to their authors’ licenses. Sources, versions and build details are published in the Ninety repository.$\r$\n$\r$\n"
LangString KLicenseDocument5 1033 "MIT LICENSE$\r$\nPermission is granted, free of charge, to any person obtaining a copy of this software and associated documentation files, to use, copy, modify, merge, publish, distribute, sublicense and/or sell copies, and to permit others to do so, subject to the following condition:$\r$\n$\r$\nThe copyright and permission notices must be included in all copies or substantial portions of the Software.$\r$\n$\r$\n"
LangString KLicenseDocument6 1033 "THE SOFTWARE IS PROVIDED AS IS, WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. THE AUTHORS OR COPYRIGHT HOLDERS ARE NOT LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY ARISING FROM THE SOFTWARE OR ITS USE.$\r$\n$\r$\nContinuing means that you accept the MIT License."
LangString KModeTitle 1033 "Choose who can use Ninety"
LangString KModeSubtitle 1033 "Choose which Windows accounts can launch Ninety."
LangString KModeSignal 1033 "ACCESS MATRIX"
LangString KModeEyebrow 1033 "SIGNAL MATRIX / ACCESS"
LangString KModeAllTitle 1033 "ALL ACCOUNTS"
LangString KModeCurrentTitle 1033 "CURRENT ACCOUNT"
LangString KModeAllDescription 1033 "Available to every Windows account on this computer."
LangString KModeCurrentDescription 1033 "Installed only for the current Windows account."
LangString KMaintenanceTitle 1033 "Ninety is already installed"
LangString KMaintenanceSubtitle 1033 "Choose one deliberate action for the existing installation."
LangString KMaintenanceSignal 1033 "OPERATION GRID"
LangString KMaintenanceEyebrow 1033 "SIGNAL MATRIX / OPERATION"
LangString KMaintenanceDataPolicy 1033 "DATA / DECIDE ON REMOVE"
LangString KMaintenanceRepairDescription 1033 "Restore or update Ninety components."
LangString KMaintenanceRemoveDescription 1033 "Remove Ninety and its components from this computer."
LangString KMaintenanceReplaceDescription 1033 "Remove the existing version before installing the selected version."
LangString KMaintenanceKeepDescription 1033 "Keep the existing installation and continue without removing it first."
LangString KMaintenanceRepairAction 1033 "Add or reinstall components"
LangString KMaintenanceRemoveAction 1033 "Remove Ninety"
LangString KUninstallConfirmTitle 1033 "Remove Ninety"
LangString KUninstallConfirmSubtitle 1033 "The application will be closed and its installed components will be removed."
LangString KUninstallDeleteData 1033 "Remove settings and data"
LangString KUninstallDeleteDataDescription 1033 "Also remove saved profiles, preferences and local application data."
LangString KUninstallSignal 1033 "REMOVAL MATRIX"
LangString KUninstallEyebrow 1033 "SIGNAL MATRIX / REMOVE"
LangString KUninstallPath 1033 "INSTALLATION TARGET"
LangString KTargetTitle 1033 "Deployment target"
LangString KTargetSubtitle 1033 "Keep the destination explicit and easy to verify."
LangString KTargetSignal 1033 "TARGET VECTOR"
LangString KTargetEyebrow 1033 "SIGNAL MATRIX / TARGET"
LangString KTargetPath 1033 "INSTALL PATH"
LangString KTargetCapacity 1033 "CAPACITY"
LangString KTargetChange 1033 "CHANGE"
LangString KTargetReady 1033 "READY"
LangString KTargetShortcut 1033 "DESKTOP LINK / OPTIONAL"
LangString KLanguageTitle 1033 "Installer language / Язык установщика"
LangString KLanguageSubtitle 1033 "Choose the interface language · Выберите язык интерфейса"
LangString KLanguageEnglishTitle 1033 "ENGLISH"
LangString KLanguageRussianTitle 1033 "РУССКИЙ"
LangString KLanguageSelected 1033 "SELECTED"
LangString KOtaWindowTitle 1033 "Ninety update"
LangString KInstallerAlreadyRunning 1033 "Ninety Setup is already running. Finish or close the active setup before starting another one."
LangString KInstallTargetUnavailable 1033 "Ninety cannot safely update the selected folder because it is not writable or still contains a file in use. Close Ninety and try again. No files were skipped."

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
LangString KLicenseEyebrow 1049 "SIGNAL MATRIX / МАНИФЕСТ"
LangString KLicenseType 1049 "ЛИЦЕНЗИЯ"
LangString KLicenseModules 1049 "МОДУЛИ"
LangString KLicensePosition 1049 "ПОЗИЦИЯ ЧТЕНИЯ"
LangString KLicenseKeys 1049 "PAGE UP / PAGE DOWN"
LangString KLicenseDocument1 1049 "Ninety — 190x4 VPN$\r$\nЛицензия MIT · Copyright © 2026 pathetixx · 190x4.pw$\r$\n$\r$\nNinety распространяется бесплатно. Исходный код открыт:$\r$\ngithub.com/pathetixx/190x4-Ninety$\r$\n$\r$\nЧТО ВЫ УСТАНАВЛИВАЕТЕ$\r$\n"
LangString KLicenseDocument2 1049 "• Ninety.exe — интерфейс и управляющая часть.$\r$\n• sing-box.exe — основной сетевой движок.$\r$\n• xray.exe — движок XHTTP.$\r$\n• naive.exe и trusttunnel_client.exe — локальные протокольные мосты.$\r$\n• wintun.dll — адаптер VPN · TUN.$\r$\n• winws.exe, WinDivert64.sys и Monkey64.sys — компоненты обхода DPI.$\r$\n$\r$\n"
LangString KLicenseDocument3 1049 "СИСТЕМНЫЕ ПРАВА$\r$\nNinety не устанавливает собственную постоянно работающую службу Windows. Повышенные права запрашиваются только для VPN · TUN, обхода DPI и очистки связанных драйверов.$\r$\n$\r$\nСЕТЕВАЯ АКТИВНОСТЬ$\r$\nПодписки загружаются с адресов пользователя. VPN-трафик передаётся выбранным серверам. Обновления приложения поступают через GitLab и GitHub Releases, подписанные данные DPI — через GitHub Releases.$\r$\n$\r$\n"
LangString KLicenseDocument4 1049 "Проверки региона, доступности и качества обращаются к внешним тестовым/IP-сервисам только при использовании этих функций. Регистрация WARP обращается к Cloudflare только по команде пользователя. В Ninety нет собственной телеметрии, аналитики и рекламы.$\r$\n$\r$\nСТОРОННИЕ КОМПОНЕНТЫ$\r$\nИсполняемые файлы, библиотеки и драйверы распространяются по лицензиям их авторов. Исходники, версии и сведения о сборке опубликованы в репозитории Ninety.$\r$\n$\r$\n"
LangString KLicenseDocument5 1049 "ЛИЦЕНЗИЯ MIT$\r$\nЛюбому лицу, получившему копию программы и документации, бесплатно разрешается использовать, копировать, изменять, объединять, публиковать, распространять, сублицензировать и/или продавать копии, а также разрешать это другим лицам при следующем условии:$\r$\n$\r$\nУведомления об авторском праве и разрешении должны включаться во все копии или существенные части программы.$\r$\n$\r$\n"
LangString KLicenseDocument6 1049 "ПРОГРАММА ПРЕДОСТАВЛЯЕТСЯ КАК ЕСТЬ, БЕЗ КАКИХ-ЛИБО ЯВНЫХ ИЛИ ПОДРАЗУМЕВАЕМЫХ ГАРАНТИЙ, ВКЛЮЧАЯ ТОВАРНУЮ ПРИГОДНОСТЬ, ПРИГОДНОСТЬ ДЛЯ КОНКРЕТНОЙ ЦЕЛИ И НЕНАРУШЕНИЕ ПРАВ. АВТОРЫ И ПРАВООБЛАДАТЕЛИ НЕ НЕСУТ ОТВЕТСТВЕННОСТИ ЗА ПРЕТЕНЗИИ, УЩЕРБ ИЛИ ИНЫЕ ОБЯЗАТЕЛЬСТВА, СВЯЗАННЫЕ С ПРОГРАММОЙ ИЛИ ЕЁ ИСПОЛЬЗОВАНИЕМ.$\r$\n$\r$\nПродолжая, вы принимаете условия MIT."
LangString KModeTitle 1049 "Кто сможет пользоваться Ninety"
LangString KModeSubtitle 1049 "Выберите, какие учётные записи Windows смогут запускать Ninety."
LangString KModeSignal 1049 "МАТРИЦА ДОСТУПА"
LangString KModeEyebrow 1049 "SIGNAL MATRIX / ДОСТУП"
LangString KModeAllTitle 1049 "ВСЕ УЧЁТНЫЕ ЗАПИСИ"
LangString KModeCurrentTitle 1049 "ТЕКУЩАЯ УЧЁТНАЯ ЗАПИСЬ"
LangString KModeAllDescription 1049 "Приложение будет доступно всем учётным записям Windows на этом компьютере."
LangString KModeCurrentDescription 1049 "Приложение будет установлено только для текущей учётной записи Windows."
LangString KMaintenanceTitle 1049 "Ninety уже установлен"
LangString KMaintenanceSubtitle 1049 "Выберите одно осознанное действие для существующей установки."
LangString KMaintenanceSignal 1049 "СЕТКА ОПЕРАЦИЙ"
LangString KMaintenanceEyebrow 1049 "SIGNAL MATRIX / ОПЕРАЦИЯ"
LangString KMaintenanceDataPolicy 1049 "ДАННЫЕ / РЕШИТЬ ПРИ УДАЛЕНИИ"
LangString KMaintenanceRepairDescription 1049 "Восстановить или обновить компоненты Ninety."
LangString KMaintenanceRemoveDescription 1049 "Удалить Ninety и его компоненты с этого компьютера."
LangString KMaintenanceReplaceDescription 1049 "Удалить существующую версию перед установкой выбранной версии."
LangString KMaintenanceKeepDescription 1049 "Сохранить существующую установку и продолжить без предварительного удаления."
LangString KMaintenanceRepairAction 1049 "Добавить или переустановить компоненты"
LangString KMaintenanceRemoveAction 1049 "Удалить Ninety"
LangString KUninstallConfirmTitle 1049 "Удаление Ninety"
LangString KUninstallConfirmSubtitle 1049 "Приложение будет закрыто, а установленные компоненты — удалены."
LangString KUninstallDeleteData 1049 "Удалить настройки и данные"
LangString KUninstallDeleteDataDescription 1049 "Также удалить профили, настройки и локальные данные приложения."
LangString KUninstallSignal 1049 "МАТРИЦА УДАЛЕНИЯ"
LangString KUninstallEyebrow 1049 "SIGNAL MATRIX / УДАЛЕНИЕ"
LangString KUninstallPath 1049 "ТОЧКА УСТАНОВКИ"
LangString KTargetTitle 1049 "Точка развёртывания"
LangString KTargetSubtitle 1049 "Каталог установки должен быть заметным и легко проверяемым."
LangString KTargetSignal 1049 "ВЕКТОР РАЗВЁРТЫВАНИЯ"
LangString KTargetEyebrow 1049 "SIGNAL MATRIX / КАТАЛОГ"
LangString KTargetPath 1049 "КАТАЛОГ УСТАНОВКИ"
LangString KTargetCapacity 1049 "МЕСТО НА ДИСКЕ"
LangString KTargetChange 1049 "ИЗМЕНИТЬ"
LangString KTargetReady 1049 "ГОТОВО"
LangString KTargetShortcut 1049 "ЯРЛЫК / ПО ЖЕЛАНИЮ"
LangString KLanguageTitle 1049 "Installer language / Язык установщика"
LangString KLanguageSubtitle 1049 "Choose the interface language · Выберите язык интерфейса"
LangString KLanguageEnglishTitle 1049 "ENGLISH"
LangString KLanguageRussianTitle 1049 "РУССКИЙ"
LangString KLanguageSelected 1049 "ВЫБРАНО"
LangString KOtaWindowTitle 1049 "Обновление Ninety"
LangString KInstallerAlreadyRunning 1049 "Установка Ninety уже запущена. Завершите или закройте активную установку перед повторным запуском."
LangString KInstallTargetUnavailable 1049 "Ninety не может безопасно обновить выбранную папку: она недоступна для записи или один из файлов ещё используется. Закройте Ninety и повторите попытку. Ни один файл не был пропущен."

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
  ; nsDialogs resolves `u` units against the main resource dialog. Use the same
  ; base units while still parenting the control to the active page.
  System::Call 'user32::MapDialogRect(p $HWNDPARENT, p r6)'
  System::Call '*$6(&i4 .r4, &i4 .r5, &i4 .r7, &i4 .r8)'
  System::Free $6
  IntOp $7 $7 - $4
  IntOp $8 $8 - $5
  System::Call 'user32::CreateWindowExW(i 0, w "Static", w "", i 0x54000000, i r4, i r5, i r7, i r8, p $KuroganeMatrixParent, i 0, i 0, i 0) p .r0'
  SetCtlColors $0 ${COLOR} ${COLOR}
  ; Explicit Win32 child creation does not guarantee the painter order used by
  ; nsDialogs. Promote each later layer so frame interiors cover their outer
  ; border and content blocks cover the interior deterministically.
  !insertmacro KuroganeBringToFront $0
!macroend

!macro KuroganeMatrixFrame X Y W H IX IY IW IH BORDER BACKGROUND
  !insertmacro KuroganeMatrixBox ${X} ${Y} ${W} ${H} ${BORDER}
  !insertmacro KuroganeMatrixBox ${IX} ${IY} ${IW} ${IH} ${BACKGROUND}
!macroend

!macro KuroganeMatrixText X Y W H TEXT FOREGROUND BACKGROUND FONT
  IntOp $4 ${X} + ${W}
  IntOp $5 ${Y} + ${H}
  System::Call '*(&i4 ${X}, &i4 ${Y}, &i4 r4, &i4 r5) p .r6'
  System::Call 'user32::MapDialogRect(p $HWNDPARENT, p r6)'
  System::Call '*$6(&i4 .r4, &i4 .r5, &i4 .r7, &i4 .r8)'
  System::Free $6
  IntOp $7 $7 - $4
  IntOp $8 $8 - $5
  System::Call 'user32::CreateWindowExW(i 0, w "Static", w "${TEXT}", i 0x54000080, i r4, i r5, i r7, i r8, p $KuroganeMatrixParent, i 0, i 0, i 0) p .r0'
  SetCtlColors $0 ${FOREGROUND} ${BACKGROUND}
  SendMessage $0 ${WM_SETFONT} ${FONT} 1
  !insertmacro KuroganeBringToFront $0
!macroend

!macro KuroganeMatrixPath X Y W H TEXT
  IntOp $4 ${X} + ${W}
  IntOp $5 ${Y} + ${H}
  System::Call '*(&i4 ${X}, &i4 ${Y}, &i4 r4, &i4 r5) p .r6'
  System::Call 'user32::MapDialogRect(p $HWNDPARENT, p r6)'
  System::Call '*$6(&i4 .r4, &i4 .r5, &i4 .r7, &i4 .r8)'
  System::Free $6
  IntOp $7 $7 - $4
  IntOp $8 $8 - $5
  ; SS_PATHELLIPSIS keeps long per-user destinations inside the reserved lane;
  ; control ID 1240 gives the Windows gate a stable non-stock target.
  System::Call 'user32::CreateWindowExW(i 0, w "Static", w "${TEXT}", i 0x54008080, i r4, i r5, i r7, i r8, p $KuroganeMatrixParent, i 1240, i 0, i 0) p .r0'
  SetCtlColors $0 ${K_COLOR_TEXT} ${K_COLOR_FIELD}
  SendMessage $0 ${WM_SETFONT} $KuroganeFontMono 1
  !insertmacro KuroganeBringToFront $0
!macroend

!macro KuroganeMatrixCenterText X Y W H TEXT FOREGROUND BACKGROUND FONT
  IntOp $4 ${X} + ${W}
  IntOp $5 ${Y} + ${H}
  System::Call '*(&i4 ${X}, &i4 ${Y}, &i4 r4, &i4 r5) p .r6'
  System::Call 'user32::MapDialogRect(p $HWNDPARENT, p r6)'
  System::Call '*$6(&i4 .r4, &i4 .r5, &i4 .r7, &i4 .r8)'
  System::Free $6
  IntOp $7 $7 - $4
  IntOp $8 $8 - $5
  System::Call 'user32::CreateWindowExW(i 0, w "Static", w "${TEXT}", i 0x54000081, i r4, i r5, i r7, i r8, p $KuroganeMatrixParent, i 0, i 0, i 0) p .r0'
  SetCtlColors $0 ${FOREGROUND} ${BACKGROUND}
  SendMessage $0 ${WM_SETFONT} ${FONT} 1
  !insertmacro KuroganeBringToFront $0
!macroend

!macro KuroganeMatrixHeader LABEL META
  !insertmacro KuroganeMatrixBox 22 91 5 163 ${K_COLOR_ACCENT}
  !insertmacro KuroganeMatrixBox 31 91 287 1 ${K_COLOR_BORDER}
  !insertmacro KuroganeMatrixText 31 98 170 12 "${LABEL}" ${K_COLOR_ACCENT} ${K_COLOR_WINDOW} $KuroganeFontMono
  !insertmacro KuroganeMatrixText 247 98 71 12 "${META}" ${K_COLOR_MUTED} ${K_COLOR_WINDOW} $KuroganeFontMono
!macroend

!macro KuroganeMatrixPageHeader EYEBROW TITLE SUBTITLE SIGNAL CODE
  !insertmacro KuroganeMatrixText 22 14 296 12 "${EYEBROW}" ${K_COLOR_ACCENT} ${K_COLOR_WINDOW} $KuroganeFontMono
  !insertmacro KuroganeMatrixText 22 34 296 29 "${TITLE}" ${K_COLOR_TEXT} ${K_COLOR_WINDOW} $KuroganeFontTitle
  !insertmacro KuroganeMatrixText 22 64 296 20 "${SUBTITLE}" ${K_COLOR_MUTED} ${K_COLOR_WINDOW} $KuroganeFontBody
  !insertmacro KuroganeMatrixHeader "${SIGNAL}" "${CODE}"
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
  nsDialogs::CreateControl BUTTON "${DEFAULT_STYLES}|${WS_TABSTOP}|${BS_AUTORADIOBUTTON}|${BS_PUSHLIKE}|${BS_BITMAP}|${BS_FLAT}" 0 ${X}u ${Y}u 14u 14u ""
  Pop ${OUT}
  System::Call 'uxtheme::SetWindowTheme(p ${OUT}, w "", w "")'
  System::Call '*(&i4 0, &i4 0, &i4 0, &i4 0) p .r0'
  System::Call 'user32::GetWindowRect(p ${OUT}, p r0)'
  System::Call '*$0(&i4 .r1, &i4 .r2, &i4 .r3, &i4 .r4)'
  System::Free $0
  IntOp $3 $3 - $1
  IntOp $4 $4 - $2
  IntOp $3 $3 - 2
  IntOp $4 $4 - 2
  System::Call 'gdi32::CreateRectRgn(i 2, i 2, i r3, i r4) p .r0'
  System::Call 'user32::SetWindowRgn(p ${OUT}, p r0, i 1)'
  !insertmacro KuroganeBringToFront ${OUT}
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
  ${If} $KuroganeSignalPrimaryBorder != 0
    ${If} $1 == ${BST_CHECKED}
      SetCtlColors $KuroganeSignalPrimaryBorder ${K_COLOR_ACCENT} ${K_COLOR_ACCENT}
    ${Else}
      SetCtlColors $KuroganeSignalPrimaryBorder ${K_COLOR_BORDER} ${K_COLOR_BORDER}
    ${EndIf}
    System::Call 'user32::InvalidateRect(p $KuroganeSignalPrimaryBorder, p 0, i 1)'
  ${EndIf}
  ${If} $KuroganeSignalSecondaryControl != 0
    SendMessage $KuroganeSignalSecondaryControl ${BM_GETCHECK} 0 0 $1
    !insertmacro KuroganeSignalImage $KuroganeSignalSecondaryControl $KuroganeSignalSecondaryBitmap $1
    ${If} $KuroganeSignalSecondaryBorder != 0
      ${If} $1 == ${BST_CHECKED}
        SetCtlColors $KuroganeSignalSecondaryBorder ${K_COLOR_ACCENT} ${K_COLOR_ACCENT}
      ${Else}
        SetCtlColors $KuroganeSignalSecondaryBorder ${K_COLOR_BORDER} ${K_COLOR_BORDER}
      ${EndIf}
      System::Call 'user32::InvalidateRect(p $KuroganeSignalSecondaryBorder, p 0, i 1)'
    ${EndIf}
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
  System::Call 'kernel32::GetCurrentProcessId() i .r9'
  ExecWait '"$PLUGINSDIR\ninety-language.exe" /HOSTPID=$9' ${RESULT}
  ; The locale selector explicitly grants this host permission to reclaim the
  ; foreground. Keep retry state until the real wizard HWND is visible.
  StrCpy $KuroganeForegroundHandoffPending 1
  StrCpy $KuroganeForegroundHandoffAttempts 0
!macroend

Function KuroganeClaimForeground
  Push $0
  Push $1
  ${If} $KuroganeForegroundHandoffPending == 1
    IntOp $KuroganeForegroundHandoffAttempts $KuroganeForegroundHandoffAttempts + 1
    ShowWindow $HWNDPARENT ${SW_SHOW}
    ; A short TOPMOST pulse puts the newly-created wizard above Explorer, then
    ; immediately removes TOPMOST so intentional Alt+Tab still behaves normally.
    System::Call 'user32::SetWindowPos(p $HWNDPARENT, p -1, i 0, i 0, i 0, i 0, i 0x0043)'
    System::Call 'user32::BringWindowToTop(p $HWNDPARENT) i .r0'
    System::Call 'user32::SetForegroundWindow(p $HWNDPARENT) i .r0'
    System::Call 'user32::SetActiveWindow(p $HWNDPARENT) p .r0'
    System::Call 'user32::SetWindowPos(p $HWNDPARENT, p -2, i 0, i 0, i 0, i 0, i 0x0013)'
    System::Call 'user32::GetForegroundWindow() p .r1'
    ${If} $1 == $HWNDPARENT
      StrCpy $KuroganeForegroundHandoffPending 0
    ${ElseIf} $KuroganeForegroundHandoffAttempts >= 12
      ; Never turn foreground recovery into a permanent focus-stealing loop.
      StrCpy $KuroganeForegroundHandoffPending 0
    ${EndIf}
  ${EndIf}
  Pop $1
  Pop $0
FunctionEnd

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

!macro KuroganeSetDirectButtonBitmap HWND PATH HANDLE
  StrCpy $9 ${HWND}
  ${If} ${HANDLE} != 0
    SendMessage $9 ${BM_SETIMAGE} ${IMAGE_BITMAP} 0
    ${NSD_FreeImage} ${HANDLE}
    StrCpy ${HANDLE} 0
  ${EndIf}
  System::Call 'user32::GetWindowLongW(p r9, i -16) i .r0'
  IntOp $0 $0 | 0x00008080
  System::Call 'user32::SetWindowLongW(p r9, i -16, i r0)'
  System::Call 'uxtheme::SetWindowTheme(p r9, w "", w "")'
  System::Call 'user32::LoadImageW(p 0, w "${PATH}", i 0, i 0, i 0, i 0x2010) p .r0'
  StrCpy ${HANDLE} $0
  SendMessage $9 ${BM_SETIMAGE} ${IMAGE_BITMAP} $0
  System::Call '*(&i4 0, &i4 0, &i4 0, &i4 0) p .r1'
  System::Call 'user32::GetWindowRect(p r9, p r1)'
  System::Call '*$1(&i4 .r2, &i4 .r3, &i4 .r4, &i4 .r5)'
  System::Free $1
  IntOp $4 $4 - $2
  IntOp $5 $5 - $3
  IntOp $4 $4 - 2
  IntOp $5 $5 - 2
  System::Call 'gdi32::CreateRectRgn(i 2, i 2, i r4, i r5) p .r1'
  System::Call 'user32::SetWindowRgn(p r9, p r1, i 1)'
  System::Call 'user32::InvalidateRect(p r9, p 0, i 1)'
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
  File /oname=$PLUGINSDIR\kurogane-change-en.bmp "${__FILEDIR__}\action-change-en.bmp"
  File /oname=$PLUGINSDIR\kurogane-change-ru.bmp "${__FILEDIR__}\action-change-ru.bmp"
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
  StrCpy $KuroganeTargetEditControl 0
  StrCpy $KuroganeTargetPathDisplayControl 0
!macroend

Function KuroganeGuiInit
  !insertmacro KuroganeGuiInitImpl KuroganeMinimize KuroganeClose
  !insertmacro KuroganeEnableManagedOtaWindowImpl
  Call KuroganeClaimForeground
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

!macro KuroganeLicenseTickImpl
  SendMessage $KuroganeLicenseTextControl ${EM_GETFIRSTVISIBLELINE} 0 0 $0
  SendMessage $KuroganeLicenseTextControl ${EM_GETLINECOUNT} 0 0 $1
  IntOp $1 $1 - 8
  ${If} $1 <= 0
    StrCpy $0 0
  ${Else}
    IntOp $0 $0 * 100
    IntOp $0 $0 / $1
  ${EndIf}
  ${If} $0 < 0
    StrCpy $0 0
  ${ElseIf} $0 > 100
    StrCpy $0 100
  ${EndIf}
  IntFmt $1 "%03d" $0
  StrCpy $3 "$(KLicensePosition) / $1%"
  SendMessage $KuroganeLicensePositionControl ${WM_SETTEXT} 0 "STR:$3"
  IntOp $2 $0 * 62
  IntOp $2 $2 / 100
  IntOp $2 $2 + 132
  !insertmacro KuroganeMoveWindowDlu $KuroganePage $KuroganeLicenseThumbControl 291 $2 3 31
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
  Call KuroganeClaimForeground
  ${If} $KuroganeTargetEditControl != 0
  ${AndIf} $KuroganeTargetPathDisplayControl != 0
    ${NSD_GetText} $KuroganeTargetEditControl $0
    SendMessage $KuroganeTargetPathDisplayControl ${WM_SETTEXT} 0 "STR:$0"
  ${EndIf}
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

!macro KuroganeLicensePageImpl UNPREFIX PAGE
  !insertmacro KuroganePrepareKnownPageImpl "${UNPREFIX}" ${PAGE} Next
  StrCpy $KuroganeMatrixParent ${PAGE}

  !insertmacro KuroganeMatrixPageHeader "$(KLicenseEyebrow)" "$(KLicenseTitle)" "$(KLicenseSubtitle)" "$(KLicenseSignal)" "190X4 / 04"
  !insertmacro KuroganeMatrixFrame 43 121 259 118 44 122 257 116 ${K_COLOR_BORDER} ${K_COLOR_FIELD}
  !insertmacro KuroganeMatrixBox 44 122 70 116 ${K_COLOR_PANEL}
  !insertmacro KuroganeMatrixText 54 133 50 12 "$(KLicenseType)" ${K_COLOR_MUTED} ${K_COLOR_PANEL} $KuroganeFontMono
  !insertmacro KuroganeMatrixText 54 151 50 17 "MIT" ${K_COLOR_ACCENT} ${K_COLOR_PANEL} $KuroganeFontSteps
  !insertmacro KuroganeMatrixText 54 181 50 12 "$(KLicenseModules)" ${K_COLOR_MUTED} ${K_COLOR_PANEL} $KuroganeFontMono
  !insertmacro KuroganeMatrixText 54 199 50 17 "12" ${K_COLOR_TEXT} ${K_COLOR_PANEL} $KuroganeFontSteps

  ; A plain read-only Edit keeps keyboard and mouse-wheel scrolling without the
  ; themed non-client scrollbar that leaked into the old MUI license page.
  IntOp $4 126 + 157
  IntOp $5 130 + 96
  System::Call '*(&i4 126, &i4 130, &i4 r4, &i4 r5) p .r6'
  System::Call 'user32::MapDialogRect(p $HWNDPARENT, p r6)'
  System::Call '*$6(&i4 .r4, &i4 .r5, &i4 .r7, &i4 .r8)'
  System::Free $6
  IntOp $7 $7 - $4
  IntOp $8 $8 - $5
  System::Call 'user32::CreateWindowExW(i 0, w "Edit", w "", i 0x54010044, i r4, i r5, i r7, i r8, p ${PAGE}, i 0, i 0, i 0) p .r9'
  System::Call 'uxtheme::SetWindowTheme(p r9, w "", w "")'
  SetCtlColors $9 ${K_COLOR_TEXT} ${K_COLOR_FIELD}
  SendMessage $9 ${WM_SETFONT} $KuroganeFontBody 1
  SendMessage $9 ${WM_SETTEXT} 0 "STR:"
  SendMessage $9 ${EM_SETSEL} 0 0
  SendMessage $9 ${EM_REPLACESEL} 0 "STR:$(KLicenseDocument1)"
  SendMessage $9 ${EM_REPLACESEL} 0 "STR:$(KLicenseDocument2)"
  SendMessage $9 ${EM_REPLACESEL} 0 "STR:$(KLicenseDocument3)"
  SendMessage $9 ${EM_REPLACESEL} 0 "STR:$(KLicenseDocument4)"
  SendMessage $9 ${EM_REPLACESEL} 0 "STR:$(KLicenseDocument5)"
  SendMessage $9 ${EM_REPLACESEL} 0 "STR:$(KLicenseDocument6)"
  SendMessage $9 ${EM_SETSEL} 0 0
  SendMessage $9 ${EM_SCROLLCARET} 0 0
  SendMessage $9 ${EM_LINESCROLL} 0 -10000
  SendMessage $9 ${EM_SETREADONLY} 1 0
  !insertmacro KuroganeBringToFront $9
  StrCpy $KuroganeLicenseTextControl $9

  !insertmacro KuroganeMatrixBox 291 132 3 93 ${K_COLOR_BORDER}
  !insertmacro KuroganeMatrixBox 291 132 3 31 ${K_COLOR_ACCENT}
  StrCpy $KuroganeLicenseThumbControl $0
  !insertmacro KuroganeMatrixText 43 247 128 11 "$(KLicenseKeys)" ${K_COLOR_MUTED} ${K_COLOR_WINDOW} $KuroganeFontMono
  !insertmacro KuroganeMatrixText 187 247 115 11 "$(KLicensePosition) / 000%" ${K_COLOR_MUTED} ${K_COLOR_WINDOW} $KuroganeFontMono
  StrCpy $KuroganeLicensePositionControl $0

  ${NSD_KillTimer} KuroganeLicenseTick
  ${NSD_CreateTimer} KuroganeLicenseTick 60
  Call KuroganeLicenseTick
  ${NSD_SetFocus} $KuroganeLicenseTextControl
!macroend

Function KuroganeLicenseTick
  ${If} $KuroganeLicenseTextControl == 0
    Return
  ${EndIf}
  !insertmacro KuroganeLicenseTickImpl
FunctionEnd

Function KuroganeLicenseLeave
  ${NSD_KillTimer} KuroganeLicenseTick
  StrCpy $KuroganeLicenseTextControl 0
  StrCpy $KuroganeLicenseThumbControl 0
  StrCpy $KuroganeLicensePositionControl 0
FunctionEnd

; Rebuild the MultiUser page controls inside the page that the plugin already
; owns. Its leave callback continues to read the same handle variables.
!macro KuroganeInstallModePageImpl
  !insertmacro KuroganePrepareKnownPageImpl "" $MultiUser.InstallModePage Next
  StrCpy $KuroganeMatrixParent $MultiUser.InstallModePage
  ShowWindow $MultiUser.InstallModePage.Text ${SW_HIDE}
  ShowWindow $MultiUser.InstallModePage.AllUsers ${SW_HIDE}
  ShowWindow $MultiUser.InstallModePage.CurrentUser ${SW_HIDE}

  !insertmacro KuroganeMatrixPageHeader "$(KModeEyebrow)" "$(KModeTitle)" "$(KModeSubtitle)" "$(KModeSignal)" "190X4 / 02"

  !insertmacro KuroganeMatrixBox 42 121 260 51 ${K_COLOR_BORDER}
  StrCpy $KuroganeSignalPrimaryBorder $0
  !insertmacro KuroganeMatrixBox 43 122 258 49 ${K_COLOR_PANEL}
  !insertmacro KuroganeMatrixBox 43 122 39 49 ${K_COLOR_ACCENT}
  !insertmacro KuroganeMatrixCenterText 43 139 39 14 "01" ${K_COLOR_TEXT} ${K_COLOR_ACCENT} $KuroganeFontSteps
  !insertmacro KuroganeMatrixText 94 131 174 14 "$(KModeCurrentTitle)" ${K_COLOR_TEXT} ${K_COLOR_PANEL} $KuroganeFontSteps
  !insertmacro KuroganeMatrixText 94 150 176 18 "$(KModeCurrentDescription)" ${K_COLOR_MUTED} ${K_COLOR_PANEL} $KuroganeFontBody
  !insertmacro KuroganeSignalRadio 278 138 $MultiUser.InstallModePage.CurrentUser

  !insertmacro KuroganeMatrixBox 58 183 244 57 ${K_COLOR_BORDER}
  StrCpy $KuroganeSignalSecondaryBorder $0
  !insertmacro KuroganeMatrixBox 59 184 242 55 ${K_COLOR_FIELD}
  !insertmacro KuroganeMatrixBox 59 184 39 55 ${K_COLOR_PANEL}
  !insertmacro KuroganeMatrixCenterText 59 201 39 14 "02" ${K_COLOR_MUTED} ${K_COLOR_PANEL} $KuroganeFontSteps
  !insertmacro KuroganeMatrixText 110 193 158 14 "$(KModeAllTitle)" ${K_COLOR_TEXT} ${K_COLOR_FIELD} $KuroganeFontSteps
  !insertmacro KuroganeMatrixText 110 210 166 24 "$(KModeAllDescription)" ${K_COLOR_MUTED} ${K_COLOR_FIELD} $KuroganeFontBody
  !insertmacro KuroganeSignalRadio 278 200 $MultiUser.InstallModePage.AllUsers

  !insertmacro KuroganeMatrixBox 31 251 287 3 ${K_COLOR_BORDER}
  !insertmacro KuroganeMatrixBox 31 251 96 3 ${K_COLOR_ACCENT}

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
  !insertmacro KuroganeBringToFront $MultiUser.InstallModePage.CurrentUser
  !insertmacro KuroganeBringToFront $MultiUser.InstallModePage.AllUsers
!macroend

!macro KuroganeMaintenancePageImpl DIALOG PRIMARY SECONDARY INTROTEXT PRIMARYTEXT SECONDARYTEXT PRIMARYDESC SECONDARYDESC
  ; The caller often passes temporary registers that page preparation is free
  ; to clobber. Preserve every visible string before invoking shell callbacks.
  StrCpy $KuroganeMaintenancePrimaryTextValue ${PRIMARYTEXT}
  StrCpy $KuroganeMaintenanceSecondaryTextValue ${SECONDARYTEXT}
  StrCpy $KuroganeMaintenancePrimaryDescriptionValue ${PRIMARYDESC}
  StrCpy $KuroganeMaintenanceSecondaryDescriptionValue ${SECONDARYDESC}
  !insertmacro KuroganePrepareKnownPageImpl "" ${DIALOG} Next
  StrCpy $KuroganeMatrixParent ${DIALOG}
  !insertmacro KuroganeMatrixPageHeader "$(KMaintenanceEyebrow)" "$(KMaintenanceTitle)" "$(KMaintenanceSubtitle)" "$(KMaintenanceSignal)" "190X4 / 05"

  ; Render the action strings before PRIMARY/SECONDARY are overwritten with
  ; the native radio HWNDs expected by Tauri's maintenance leave callback.
  !insertmacro KuroganeMatrixBox 43 121 259 58 ${K_COLOR_BORDER}
  StrCpy $KuroganeSignalPrimaryBorder $0
  !insertmacro KuroganeMatrixBox 44 122 257 56 ${K_COLOR_PANEL}
  !insertmacro KuroganeMatrixBox 44 122 34 56 ${K_COLOR_ACCENT}
  !insertmacro KuroganeMatrixCenterText 44 143 34 14 "+" ${K_COLOR_TEXT} ${K_COLOR_ACCENT} $KuroganeFontSteps
  !insertmacro KuroganeMatrixText 91 129 174 18 "$KuroganeMaintenancePrimaryTextValue" ${K_COLOR_TEXT} ${K_COLOR_PANEL} $KuroganeFontSteps
  !insertmacro KuroganeMatrixText 91 151 174 25 "$KuroganeMaintenancePrimaryDescriptionValue" ${K_COLOR_MUTED} ${K_COLOR_PANEL} $KuroganeFontBody
  !insertmacro KuroganeSignalRadio 278 141 ${PRIMARY}

  !insertmacro KuroganeMatrixBox 59 187 243 57 ${K_COLOR_BORDER}
  StrCpy $KuroganeSignalSecondaryBorder $0
  !insertmacro KuroganeMatrixBox 60 188 241 55 ${K_COLOR_FIELD}
  !insertmacro KuroganeMatrixBox 60 188 34 55 ${K_COLOR_PANEL}
  !insertmacro KuroganeMatrixCenterText 60 208 34 14 "×" ${K_COLOR_MUTED} ${K_COLOR_PANEL} $KuroganeFontSteps
  !insertmacro KuroganeMatrixText 107 197 158 14 "$KuroganeMaintenanceSecondaryTextValue" ${K_COLOR_TEXT} ${K_COLOR_FIELD} $KuroganeFontSteps
  !insertmacro KuroganeMatrixText 107 216 158 24 "$KuroganeMaintenanceSecondaryDescriptionValue" ${K_COLOR_MUTED} ${K_COLOR_FIELD} $KuroganeFontBody
  !insertmacro KuroganeSignalRadio 278 206 ${SECONDARY}

  !insertmacro KuroganeMatrixText 43 251 199 12 "$(KMaintenanceDataPolicy)" ${K_COLOR_MUTED} ${K_COLOR_WINDOW} $KuroganeFontMono
  !insertmacro KuroganeMatrixBox 247 255 55 3 ${K_COLOR_BORDER}
  !insertmacro KuroganeMatrixBox 247 255 31 3 ${K_COLOR_ACCENT}

  StrCpy $KuroganeSignalPrimaryControl ${PRIMARY}
  StrCpy $KuroganeSignalSecondaryControl ${SECONDARY}
  ${NSD_OnClick} $KuroganeSignalPrimaryControl KuroganeSignalPrimaryClick
  ${NSD_OnClick} $KuroganeSignalSecondaryControl KuroganeSignalSecondaryClick
  Call KuroganeApplySignalStates
  !insertmacro KuroganeBringToFront ${PRIMARY}
  !insertmacro KuroganeBringToFront ${SECONDARY}
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

  !insertmacro KuroganeMatrixPageHeader "$(KTargetEyebrow)" "$(KTargetTitle)" "$(KTargetSubtitle)" "$(KTargetSignal)" "190X4 / 03"
  !insertmacro KuroganeMatrixText 43 121 200 11 "$(KTargetPath)" ${K_COLOR_MUTED} ${K_COLOR_WINDOW} $KuroganeFontMono
  !insertmacro KuroganeMatrixFrame 43 139 259 43 44 140 257 41 ${K_COLOR_ACCENT} ${K_COLOR_FIELD}
  !insertmacro KuroganeMatrixBox 44 140 5 41 ${K_COLOR_ACCENT}

  ; Keep MUI's edit control as the authoritative value for validation and the
  ; native folder picker, but never expose its stock Windows border/selection.
  GetDlgItem $KuroganeTargetEditControl ${PAGE} 1019
  ${NSD_GetText} $KuroganeTargetEditControl $1
  ShowWindow $KuroganeTargetEditControl ${SW_HIDE}
  !insertmacro KuroganeMatrixPath 60 153 150 14 "$1"
  StrCpy $KuroganeTargetPathDisplayControl $0

  GetDlgItem $0 ${PAGE} 1001
  !insertmacro KuroganeMoveWindowDlu ${PAGE} $0 219 151 74 18
  !insertmacro KuroganeBringToFront $0
  ${If} $LANGUAGE == 1049
    !insertmacro KuroganeSetDirectButtonBitmap $0 "$PLUGINSDIR\kurogane-change-ru.bmp" $KuroganeActionBitmap
  ${Else}
    !insertmacro KuroganeSetDirectButtonBitmap $0 "$PLUGINSDIR\kurogane-change-en.bmp" $KuroganeActionBitmap
  ${EndIf}

  !insertmacro KuroganeMatrixText 43 197 100 11 "$(KTargetCapacity)" ${K_COLOR_MUTED} ${K_COLOR_WINDOW} $KuroganeFontMono
  !insertmacro KuroganeMatrixBox 43 216 18 8 ${K_COLOR_ACCENT}
  !insertmacro KuroganeMatrixBox 65 216 18 8 ${K_COLOR_BORDER}
  !insertmacro KuroganeMatrixBox 87 216 18 8 ${K_COLOR_BORDER}
  !insertmacro KuroganeMatrixBox 109 216 18 8 ${K_COLOR_BORDER}
  !insertmacro KuroganeMatrixBox 131 216 18 8 ${K_COLOR_BORDER}
  !insertmacro KuroganeMatrixBox 153 216 18 8 ${K_COLOR_BORDER}

  GetDlgItem $0 ${PAGE} 1023
  !insertmacro KuroganeMoveWindowDlu ${PAGE} $0 43 235 128 18
  !insertmacro KuroganeBringToFront $0
  SetCtlColors $0 ${K_COLOR_MUTED} ${K_COLOR_WINDOW}
  SendMessage $0 ${WM_SETFONT} $KuroganeFontMeta 1
  GetDlgItem $0 ${PAGE} 1024
  !insertmacro KuroganeMoveWindowDlu ${PAGE} $0 176 209 126 18
  !insertmacro KuroganeBringToFront $0
  SetCtlColors $0 ${K_COLOR_TEXT} ${K_COLOR_WINDOW}
  SendMessage $0 ${WM_SETFONT} $KuroganeFontMeta 1
!macroend

Function KuroganeDirectoryLeave
  StrCpy $KuroganeTargetEditControl 0
  StrCpy $KuroganeTargetPathDisplayControl 0
FunctionEnd

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
  !insertmacro KuroganePrepareKnownPageImpl "un." ${PAGE} Remove
  StrCpy $1 ${PAGE}
  StrCpy $KuroganeMatrixParent ${PAGE}
  IntOp $4 278 + 14
  IntOp $5 138 + 14
  System::Call '*(&i4 278, &i4 138, &i4 r4, &i4 r5) p .r6'
  System::Call 'user32::MapDialogRect(p $HWNDPARENT, p r6)'
  System::Call '*$6(&i4 .r4, &i4 .r5, &i4 .r7, &i4 .r8)'
  System::Free $6
  IntOp $7 $7 - $4
  IntOp $8 $8 - $5
  System::Call 'user32::CreateWindowExW(i 0, w "Button", w "", i 0x54019083, i r4, i r5, i r7, i r8, p r1, i 0, i 0, i 0) p .r0'
  StrCpy ${CHECKBOX} $0
  System::Call 'uxtheme::SetWindowTheme(p r0, w "", w "")'
  System::Call '*(&i4 0, &i4 0, &i4 0, &i4 0) p .r3'
  System::Call 'user32::GetWindowRect(p ${CHECKBOX}, p r3)'
  System::Call '*$3(&i4 .r4, &i4 .r5, &i4 .r6, &i4 .r7)'
  System::Free $3
  IntOp $6 $6 - $4
  IntOp $7 $7 - $5
  IntOp $6 $6 - 2
  IntOp $7 $7 - 2
  System::Call 'gdi32::CreateRectRgn(i 2, i 2, i r6, i r7) p .r3'
  System::Call 'user32::SetWindowRgn(p ${CHECKBOX}, p r3, i 1)'

  !insertmacro KuroganeMatrixPageHeader "$(KUninstallEyebrow)" "$(KUninstallConfirmTitle)" "$(KUninstallConfirmSubtitle)" "$(KUninstallSignal)" "190X4 / RM"
  !insertmacro KuroganeMatrixFrame 43 121 259 52 44 122 257 50 ${K_COLOR_BORDER} ${K_COLOR_PANEL}
  !insertmacro KuroganeMatrixBox 44 122 34 50 ${K_COLOR_PANEL}
  !insertmacro KuroganeMatrixCenterText 44 140 34 14 "×" ${K_COLOR_ACCENT} ${K_COLOR_PANEL} $KuroganeFontSteps
  !insertmacro KuroganeMatrixText 91 131 174 14 "${CHECKBOXTEXT}" ${K_COLOR_TEXT} ${K_COLOR_PANEL} $KuroganeFontSteps
  !insertmacro KuroganeMatrixText 91 150 174 20 "$(KUninstallDeleteDataDescription)" ${K_COLOR_MUTED} ${K_COLOR_PANEL} $KuroganeFontBody
  !insertmacro KuroganeMatrixText 43 197 259 12 "$(KUninstallPath)" ${K_COLOR_MUTED} ${K_COLOR_WINDOW} $KuroganeFontMono
  !insertmacro KuroganeMatrixFrame 43 216 259 32 44 217 257 30 ${K_COLOR_BORDER} ${K_COLOR_FIELD}

  GetDlgItem $0 $1 1006
  ShowWindow $0 ${SW_HIDE}

  GetDlgItem $0 $1 1029
  ShowWindow $0 ${SW_HIDE}
  GetDlgItem $0 $1 1000
  ${NSD_GetText} $0 $2
  ShowWindow $0 ${SW_HIDE}
  !insertmacro KuroganeMatrixText 55 224 235 16 "$2" ${K_COLOR_TEXT} ${K_COLOR_FIELD} $KuroganeFontMono
  !insertmacro KuroganeBringToFront ${CHECKBOX}
  StrCpy $KuroganeToggleControl ${CHECKBOX}
  ${NSD_OnClick} $KuroganeToggleControl un.KuroganeToggleClick
  Call un.KuroganeApplyToggleState
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
