; Three implementation-feasible Kurogane control concepts. Every page uses the
; real NSIS/nsDialogs canvas and the exact production shell dimensions.

Var ConceptDialog
Var ConceptFontMono
Var ConceptFontLabel
Var ConceptLanguageEnglish
Var ConceptLanguageRussian
Var ConceptLanguageEnglishText
Var ConceptLanguageRussianText
Var ConceptLanguageEnglishState
Var ConceptLanguageRussianState
Var ConceptSelectedLanguage

LangString CGConceptACards 1033 "CONCEPT A  /  CORE CARDS"
LangString CGConceptBTerminal 1033 "CONCEPT B  /  TERMINAL MANIFEST"
LangString CGConceptCMatrix 1033 "CONCEPT C  /  SIGNAL MATRIX"
LangString CGScopeTitle 1033 "Application access"
LangString CGScopeSubtitle 1033 "Choose which Windows accounts can launch Ninety."
LangString CGCurrentTitle 1033 "CURRENT ACCOUNT"
LangString CGCurrentDescription 1033 "Install only for the active Windows profile."
LangString CGAllTitle 1033 "ALL ACCOUNTS"
LangString CGAllDescription 1033 "Make Ninety available to every account on this PC."
LangString CGSelected 1033 "SELECTED"
LangString CGAdmin 1033 "ADMIN REQUIRED"
LangString CGTargetTitle 1033 "Deployment target"
LangString CGTargetSubtitle 1033 "Keep the destination explicit and easy to verify."
LangString CGInstallPath 1033 "INSTALL PATH"
LangString CGDefaultPath 1033 "C:  ›  Program Files  ›  Ninety"
LangString CGBrowse 1033 "CHANGE"
LangString CGDiskSpace 1033 "DISK SPACE"
LangString CGRequired 1033 "161.4 MB REQUIRED"
LangString CGAvailable 1033 "82.7 GB AVAILABLE"
LangString CGShortcut 1033 "Desktop shortcut"
LangString CGManifestTitle 1033 "Open-source manifest"
LangString CGManifestSubtitle 1033 "Readable licensing without falling back to a stock dialog."
LangString CGLicenseMeta 1033 "MIT  ·  OPEN SOURCE  ·  12 COMPONENTS"
LangString CGLicenseBody1 1033 "Ninety — 190x4 VPN"
LangString CGLicenseBody2 1033 "Source code: github.com/pathetixx/190x4-Ninety"
LangString CGLicenseBody3 1033 "Includes sing-box, xray, Wintun and signed DPI components."
LangString CGLicenseBody4 1033 "Administrative access is requested only for operations that require it."
LangString CGPageKeys 1033 "PAGE UP / PAGE DOWN"
LangString CGMaintenanceTitle 1033 "Installer operation"
LangString CGMaintenanceSubtitle 1033 "One deliberate action, with consequences visible before continuing."
LangString CGRepairTitle 1033 "RESTORE COMPONENTS"
LangString CGRepairDescription 1033 "Repair or update the installed Ninety package."
LangString CGRemoveTitle 1033 "REMOVE NINETY"
LangString CGRemoveDescription 1033 "Remove the application and installed networking components."
LangString CGDataPolicy 1033 "APPLICATION DATA"
LangString CGKeepData 1033 "KEEP SETTINGS AND DATA"
LangString CGStatusReady 1033 "READY"
LangString CGChange 1033 "CHANGE"

LangString CGConceptACards 1049 "КОНЦЕПТ A  /  CORE CARDS"
LangString CGConceptBTerminal 1049 "КОНЦЕПТ B  /  TERMINAL MANIFEST"
LangString CGConceptCMatrix 1049 "КОНЦЕПТ C  /  SIGNAL MATRIX"
LangString CGScopeTitle 1049 "Доступ к приложению"
LangString CGScopeSubtitle 1049 "Выберите, какие учётные записи Windows смогут запускать Ninety."
LangString CGCurrentTitle 1049 "ТЕКУЩАЯ УЧЁТНАЯ ЗАПИСЬ"
LangString CGCurrentDescription 1049 "Установить только для активного профиля Windows."
LangString CGAllTitle 1049 "ВСЕ УЧЁТНЫЕ ЗАПИСИ"
LangString CGAllDescription 1049 "Открыть доступ к Ninety всем пользователям этого ПК."
LangString CGSelected 1049 "ВЫБРАНО"
LangString CGAdmin 1049 "НУЖНЫ ПРАВА АДМИНИСТРАТОРА"
LangString CGTargetTitle 1049 "Точка развёртывания"
LangString CGTargetSubtitle 1049 "Каталог установки должен быть заметным и легко проверяемым."
LangString CGInstallPath 1049 "КАТАЛОГ УСТАНОВКИ"
LangString CGDefaultPath 1049 "C:  ›  Program Files  ›  Ninety"
LangString CGBrowse 1049 "ИЗМЕНИТЬ"
LangString CGDiskSpace 1049 "МЕСТО НА ДИСКЕ"
LangString CGRequired 1049 "ТРЕБУЕТСЯ 161,4 МБ"
LangString CGAvailable 1049 "ДОСТУПНО 82,7 ГБ"
LangString CGShortcut 1049 "Ярлык на рабочем столе"
LangString CGManifestTitle 1049 "Манифест открытого кода"
LangString CGManifestSubtitle 1049 "Читаемая лицензия без возврата к стандартному диалогу."
LangString CGLicenseMeta 1049 "MIT  ·  OPEN SOURCE  ·  12 КОМПОНЕНТОВ"
LangString CGLicenseBody1 1049 "Ninety — 190x4 VPN"
LangString CGLicenseBody2 1049 "Исходный код: github.com/pathetixx/190x4-Ninety"
LangString CGLicenseBody3 1049 "Включает sing-box, xray, Wintun и подписанные DPI-компоненты."
LangString CGLicenseBody4 1049 "Права администратора запрашиваются только для необходимых операций."
LangString CGPageKeys 1049 "PAGE UP / PAGE DOWN"
LangString CGMaintenanceTitle 1049 "Задача установщика"
LangString CGMaintenanceSubtitle 1049 "Одно осознанное действие, последствия которого видны заранее."
LangString CGRepairTitle 1049 "ВОССТАНОВИТЬ КОМПОНЕНТЫ"
LangString CGRepairDescription 1049 "Исправить или обновить установленный пакет Ninety."
LangString CGRemoveTitle 1049 "УДАЛИТЬ NINETY"
LangString CGRemoveDescription 1049 "Удалить приложение и установленные сетевые компоненты."
LangString CGDataPolicy 1049 "ДАННЫЕ ПРИЛОЖЕНИЯ"
LangString CGKeepData 1049 "СОХРАНИТЬ НАСТРОЙКИ И ДАННЫЕ"
LangString CGStatusReady 1049 "ГОТОВО"
LangString CGChange 1049 "ИЗМЕНИТЬ"

!macro CGBox X Y W H COLOR
  ${NSD_CreateLabel} ${X}u ${Y}u ${W}u ${H}u ""
  Pop $0
  SetCtlColors $0 ${COLOR} ${COLOR}
!macroend

!macro CGText X Y W H TEXT FOREGROUND BACKGROUND FONT
  ${NSD_CreateLabel} ${X}u ${Y}u ${W}u ${H}u "${TEXT}"
  Pop $0
  SetCtlColors $0 ${FOREGROUND} ${BACKGROUND}
  SendMessage $0 ${WM_SETFONT} ${FONT} 1
!macroend

!macro CGCenterText X Y W H TEXT FOREGROUND BACKGROUND FONT
  ${NSD_CreateLabel} ${X}u ${Y}u ${W}u ${H}u "${TEXT}"
  Pop $0
  System::Call 'user32::GetWindowLongW(p r0, i -16) i .r1'
  IntOp $1 $1 | 0x00000001
  System::Call 'user32::SetWindowLongW(p r0, i -16, i r1)'
  SetCtlColors $0 ${FOREGROUND} ${BACKGROUND}
  SendMessage $0 ${WM_SETFONT} ${FONT} 1
!macroend

!macro CGFrame X Y W H IX IY IW IH BORDER BACKGROUND
  !insertmacro CGBox ${X} ${Y} ${W} ${H} ${BORDER}
  !insertmacro CGBox ${IX} ${IY} ${IW} ${IH} ${BACKGROUND}
!macroend

!macro CGBegin EYEBROW TITLE SUBTITLE
  nsDialogs::Create 1018
  Pop $ConceptDialog
  !insertmacro KuroganePrepareKnownPageImpl "" $ConceptDialog Next
  Call ConceptEnsureFonts
  !insertmacro CGText 22 14 296 12 "${EYEBROW}" ${K_COLOR_ACCENT} ${K_COLOR_WINDOW} $ConceptFontMono
  !insertmacro CGText 22 34 296 29 "${TITLE}" ${K_COLOR_TEXT} ${K_COLOR_WINDOW} $KuroganeFontTitle
  !insertmacro CGText 22 64 296 20 "${SUBTITLE}" ${K_COLOR_MUTED} ${K_COLOR_WINDOW} $KuroganeFontBody
!macroend

Function ConceptEnsureFonts
  ${If} $ConceptFontMono == 0
    CreateFont $ConceptFontMono "Cascadia Mono" 8 500
    CreateFont $ConceptFontLabel "Segoe UI" 10 600
  ${EndIf}
FunctionEnd

; ---------------------------------------------------------------------------
; Concept A — Core Cards: calm product cards, clear hierarchy, minimal chrome.

Function ConceptACardsScope
  !insertmacro CGBegin "$(CGConceptACards)" "$(CGScopeTitle)" "$(CGScopeSubtitle)"
  !insertmacro CGFrame 22 94 296 66 23 95 294 64 ${K_COLOR_ACCENT} ${K_COLOR_PANEL}
  !insertmacro CGBox 23 95 4 64 ${K_COLOR_ACCENT}
  !insertmacro CGText 39 106 184 15 "$(CGCurrentTitle)" ${K_COLOR_TEXT} ${K_COLOR_PANEL} $ConceptFontLabel
  !insertmacro CGText 39 126 200 18 "$(CGCurrentDescription)" ${K_COLOR_MUTED} ${K_COLOR_PANEL} $KuroganeFontBody
  !insertmacro CGCenterText 242 108 60 17 "$(CGSelected)" ${K_COLOR_TEXT} ${K_COLOR_ACCENT} $ConceptFontMono
  !insertmacro CGFrame 22 169 296 64 23 170 294 62 ${K_COLOR_BORDER} ${K_COLOR_PANEL}
  !insertmacro CGText 39 181 190 15 "$(CGAllTitle)" ${K_COLOR_TEXT} ${K_COLOR_PANEL} $ConceptFontLabel
  !insertmacro CGText 39 201 205 18 "$(CGAllDescription)" ${K_COLOR_MUTED} ${K_COLOR_PANEL} $KuroganeFontBody
  !insertmacro CGCenterText 225 181 77 17 "$(CGAdmin)" ${K_COLOR_MUTED} ${K_COLOR_FIELD} $ConceptFontMono
  !insertmacro CGText 22 250 296 12 "01  /  ACCESS POLICY" ${K_COLOR_MUTED} ${K_COLOR_WINDOW} $ConceptFontMono
  nsDialogs::Show
FunctionEnd

Function ConceptACardsTarget
  !insertmacro CGBegin "$(CGConceptACards)" "$(CGTargetTitle)" "$(CGTargetSubtitle)"
  !insertmacro CGFrame 22 96 296 73 23 97 294 71 ${K_COLOR_BORDER} ${K_COLOR_PANEL}
  !insertmacro CGText 38 107 200 11 "$(CGDefaultPath)" ${K_COLOR_TEXT} ${K_COLOR_PANEL} $ConceptFontMono
  ${NSD_CreateText} 38u 126u 1u 1u "C:\Program Files\Ninety"
  Pop $0
  System::Call 'uxtheme::SetWindowTheme(p r0, w "", w "")'
  SetCtlColors $0 ${K_COLOR_TEXT} ${K_COLOR_FIELD}
  SendMessage $0 ${WM_SETFONT} $ConceptFontMono 1
  SendMessage $0 ${WM_SETTEXT} 0 "STR:C:\Program Files\Ninety"
  ; Production expands this collapsed native edit when the meta path is clicked.
  !insertmacro CGCenterText 248 126 54 23 "$(CGBrowse)" ${K_COLOR_TEXT} ${K_COLOR_ACCENT} $ConceptFontMono
  !insertmacro CGText 22 184 100 11 "$(CGDiskSpace)" ${K_COLOR_MUTED} ${K_COLOR_WINDOW} $ConceptFontMono
  !insertmacro CGText 214 184 104 11 "$(CGAvailable)" ${K_COLOR_MUTED} ${K_COLOR_WINDOW} $ConceptFontMono
  !insertmacro CGBox 22 204 296 6 ${K_COLOR_FIELD}
  !insertmacro CGBox 22 204 41 6 ${K_COLOR_ACCENT}
  !insertmacro CGText 22 216 130 11 "$(CGRequired)" ${K_COLOR_MUTED} ${K_COLOR_WINDOW} $ConceptFontMono
  !insertmacro CGFrame 207 224 111 30 208 225 109 28 ${K_COLOR_BORDER} ${K_COLOR_PANEL}
  !insertmacro CGText 218 233 72 12 "$(CGShortcut)" ${K_COLOR_TEXT} ${K_COLOR_PANEL} $KuroganeFontBody
  !insertmacro CGBox 294 231 12 8 ${K_COLOR_ACCENT}
  nsDialogs::Show
FunctionEnd

Function ConceptACardsManifest
  !insertmacro CGBegin "$(CGConceptACards)" "$(CGManifestTitle)" "$(CGManifestSubtitle)"
  !insertmacro CGFrame 22 94 296 142 23 95 294 140 ${K_COLOR_BORDER} ${K_COLOR_FIELD}
  !insertmacro CGText 36 106 240 12 "$(CGLicenseMeta)" ${K_COLOR_ACCENT} ${K_COLOR_FIELD} $ConceptFontMono
  !insertmacro CGBox 36 125 252 1 ${K_COLOR_BORDER}
  !insertmacro CGText 36 138 245 14 "$(CGLicenseBody1)" ${K_COLOR_TEXT} ${K_COLOR_FIELD} $ConceptFontMono
  !insertmacro CGText 36 158 245 24 "$(CGLicenseBody2)" ${K_COLOR_MUTED} ${K_COLOR_FIELD} $ConceptFontMono
  !insertmacro CGText 36 187 245 28 "$(CGLicenseBody3)" ${K_COLOR_MUTED} ${K_COLOR_FIELD} $KuroganeFontBody
  !insertmacro CGBox 301 108 3 112 ${K_COLOR_BORDER}
  !insertmacro CGBox 301 108 3 38 ${K_COLOR_ACCENT}
  !insertmacro CGText 22 246 145 12 "$(CGPageKeys)" ${K_COLOR_MUTED} ${K_COLOR_WINDOW} $ConceptFontMono
  !insertmacro CGText 254 246 64 12 "01 / 04" ${K_COLOR_ACCENT} ${K_COLOR_WINDOW} $ConceptFontMono
  nsDialogs::Show
FunctionEnd

Function ConceptACardsMaintenance
  !insertmacro CGBegin "$(CGConceptACards)" "$(CGMaintenanceTitle)" "$(CGMaintenanceSubtitle)"
  !insertmacro CGFrame 22 94 296 57 23 95 294 55 ${K_COLOR_ACCENT} ${K_COLOR_PANEL}
  !insertmacro CGBox 23 95 4 55 ${K_COLOR_ACCENT}
  !insertmacro CGText 39 105 210 14 "$(CGRepairTitle)" ${K_COLOR_TEXT} ${K_COLOR_PANEL} $ConceptFontLabel
  !insertmacro CGText 39 125 250 14 "$(CGRepairDescription)" ${K_COLOR_MUTED} ${K_COLOR_PANEL} $KuroganeFontBody
  !insertmacro CGCenterText 258 105 44 17 "$(CGStatusReady)" ${K_COLOR_TEXT} ${K_COLOR_ACCENT} $ConceptFontMono
  !insertmacro CGFrame 22 159 296 55 23 160 294 53 ${K_COLOR_BORDER} ${K_COLOR_PANEL}
  !insertmacro CGText 39 170 210 14 "$(CGRemoveTitle)" ${K_COLOR_TEXT} ${K_COLOR_PANEL} $ConceptFontLabel
  !insertmacro CGText 39 190 250 14 "$(CGRemoveDescription)" ${K_COLOR_MUTED} ${K_COLOR_PANEL} $KuroganeFontBody
  !insertmacro CGText 22 229 114 11 "$(CGDataPolicy)" ${K_COLOR_MUTED} ${K_COLOR_WINDOW} $ConceptFontMono
  !insertmacro CGText 151 229 133 11 "$(CGKeepData)" ${K_COLOR_TEXT} ${K_COLOR_WINDOW} $ConceptFontMono
  !insertmacro CGFrame 289 225 29 18 290 226 27 16 ${K_COLOR_BORDER} ${K_COLOR_FIELD}
  !insertmacro CGBox 292 229 10 10 ${K_COLOR_MUTED}
  nsDialogs::Show
FunctionEnd

; ---------------------------------------------------------------------------
; Concept B — Terminal Manifest: compact, explicit, keyboard-first operations.

!macro CGBTerminalHeader STEP
  !insertmacro CGBox 22 89 296 1 ${K_COLOR_BORDER}
  !insertmacro CGText 22 96 50 12 "${STEP}" ${K_COLOR_ACCENT} ${K_COLOR_WINDOW} $ConceptFontMono
!macroend

Function ConceptBTerminalScope
  !insertmacro CGBegin "$(CGConceptBTerminal)" "$(CGScopeTitle)" "$(CGScopeSubtitle)"
  !insertmacro CGBTerminalHeader "ACCESS"
  !insertmacro CGFrame 22 116 296 46 23 117 294 44 ${K_COLOR_ACCENT} ${K_COLOR_FIELD}
  !insertmacro CGText 34 126 18 14 ">" ${K_COLOR_ACCENT} ${K_COLOR_FIELD} $ConceptFontMono
  !insertmacro CGText 55 126 175 14 "01  CURRENT_USER" ${K_COLOR_TEXT} ${K_COLOR_FIELD} $ConceptFontMono
  !insertmacro CGCenterText 244 124 61 18 "[ ACTIVE ]" ${K_COLOR_ACCENT} ${K_COLOR_FIELD} $ConceptFontMono
  !insertmacro CGText 55 144 230 11 "$(CGCurrentDescription)" ${K_COLOR_MUTED} ${K_COLOR_FIELD} $ConceptFontMono
  !insertmacro CGFrame 22 171 296 46 23 172 294 44 ${K_COLOR_BORDER} ${K_COLOR_FIELD}
  !insertmacro CGText 34 181 18 14 " " ${K_COLOR_MUTED} ${K_COLOR_FIELD} $ConceptFontMono
  !insertmacro CGText 55 181 175 14 "02  ALL_USERS" ${K_COLOR_TEXT} ${K_COLOR_FIELD} $ConceptFontMono
  !insertmacro CGCenterText 229 179 76 18 "[ ELEVATE ]" ${K_COLOR_MUTED} ${K_COLOR_FIELD} $ConceptFontMono
  !insertmacro CGText 55 199 230 11 "$(CGAllDescription)" ${K_COLOR_MUTED} ${K_COLOR_FIELD} $ConceptFontMono
  !insertmacro CGText 22 237 296 12 "ninety.setup  ::  scope=current  ::  $(CGStatusReady)" ${K_COLOR_MUTED} ${K_COLOR_WINDOW} $ConceptFontMono
  nsDialogs::Show
FunctionEnd

Function ConceptBTerminalTarget
  !insertmacro CGBegin "$(CGConceptBTerminal)" "$(CGTargetTitle)" "$(CGTargetSubtitle)"
  !insertmacro CGBTerminalHeader "DEPLOY"
  !insertmacro CGText 22 116 296 13 "$$ deploy --target" ${K_COLOR_ACCENT} ${K_COLOR_WINDOW} $ConceptFontMono
  !insertmacro CGFrame 22 136 296 38 23 137 294 36 ${K_COLOR_BORDER} ${K_COLOR_FIELD}
  !insertmacro CGText 33 147 210 13 "> C:/Program Files/Ninety" ${K_COLOR_TEXT} ${K_COLOR_FIELD} $ConceptFontMono
  ${NSD_CreateText} 49u 143u 1u 1u "C:\Program Files\Ninety"
  Pop $0
  System::Call 'uxtheme::SetWindowTheme(p r0, w "", w "")'
  SetCtlColors $0 ${K_COLOR_TEXT} ${K_COLOR_FIELD}
  SendMessage $0 ${WM_SETFONT} $ConceptFontMono 1
  SendMessage $0 ${WM_SETTEXT} 0 "STR:C:\Program Files\Ninety"
  !insertmacro CGCenterText 257 143 49 22 "EDIT" ${K_COLOR_TEXT} ${K_COLOR_ACCENT} $ConceptFontMono
  !insertmacro CGText 22 190 296 12 "volume.c:  [###---------------------------]  0.2%" ${K_COLOR_MUTED} ${K_COLOR_WINDOW} $ConceptFontMono
  !insertmacro CGText 22 210 142 12 "required  161.4 MiB" ${K_COLOR_MUTED} ${K_COLOR_WINDOW} $ConceptFontMono
  !insertmacro CGText 176 210 142 12 "free      82.7 GiB" ${K_COLOR_TEXT} ${K_COLOR_WINDOW} $ConceptFontMono
  !insertmacro CGFrame 22 232 296 25 23 233 294 23 ${K_COLOR_BORDER} ${K_COLOR_PANEL}
  !insertmacro CGText 33 239 240 12 "shortcut.desktop = true" ${K_COLOR_TEXT} ${K_COLOR_PANEL} $ConceptFontMono
  !insertmacro CGText 287 239 18 12 "ON" ${K_COLOR_ACCENT} ${K_COLOR_PANEL} $ConceptFontMono
  nsDialogs::Show
FunctionEnd

Function ConceptBTerminalManifest
  !insertmacro CGBegin "$(CGConceptBTerminal)" "$(CGManifestTitle)" "$(CGManifestSubtitle)"
  !insertmacro CGBTerminalHeader "MANIFEST"
  !insertmacro CGFrame 22 114 296 124 23 115 294 122 ${K_COLOR_BORDER} ${K_COLOR_FIELD}
  !insertmacro CGBox 23 115 31 122 ${K_COLOR_PANEL}
  !insertmacro CGText 31 125 18 92 "01$\r$\n02$\r$\n03$\r$\n04$\r$\n05" ${K_COLOR_MUTED} ${K_COLOR_PANEL} $ConceptFontMono
  !insertmacro CGText 65 125 225 13 "LICENSE = MIT" ${K_COLOR_ACCENT} ${K_COLOR_FIELD} $ConceptFontMono
  !insertmacro CGText 65 146 225 13 "PACKAGE = ninety@${VERSION}" ${K_COLOR_TEXT} ${K_COLOR_FIELD} $ConceptFontMono
  !insertmacro CGText 65 167 225 13 "SOURCE  = github.com/pathetixx/" ${K_COLOR_MUTED} ${K_COLOR_FIELD} $ConceptFontMono
  !insertmacro CGText 65 183 225 13 "          190x4-Ninety" ${K_COLOR_MUTED} ${K_COLOR_FIELD} $ConceptFontMono
  !insertmacro CGText 65 202 225 13 "COMPONENTS = 12 / VERIFIED" ${K_COLOR_TEXT} ${K_COLOR_FIELD} $ConceptFontMono
  !insertmacro CGBox 301 122 3 104 ${K_COLOR_BORDER}
  !insertmacro CGBox 301 122 3 31 ${K_COLOR_ACCENT}
  !insertmacro CGText 22 247 296 12 "[PgUp] [PgDn]  ·  EOF 18%  ·  UTF-8" ${K_COLOR_MUTED} ${K_COLOR_WINDOW} $ConceptFontMono
  nsDialogs::Show
FunctionEnd

Function ConceptBTerminalMaintenance
  !insertmacro CGBegin "$(CGConceptBTerminal)" "$(CGMaintenanceTitle)" "$(CGMaintenanceSubtitle)"
  !insertmacro CGBTerminalHeader "OPERATION"
  !insertmacro CGText 22 116 296 13 "$$ ninety-maintenance --select" ${K_COLOR_ACCENT} ${K_COLOR_WINDOW} $ConceptFontMono
  !insertmacro CGFrame 22 138 296 37 23 139 294 35 ${K_COLOR_ACCENT} ${K_COLOR_FIELD}
  !insertmacro CGText 34 149 210 13 ">  REPAIR_COMPONENTS" ${K_COLOR_TEXT} ${K_COLOR_FIELD} $ConceptFontMono
  !insertmacro CGText 265 149 40 13 "SAFE" ${K_COLOR_ACCENT} ${K_COLOR_FIELD} $ConceptFontMono
  !insertmacro CGFrame 22 184 296 37 23 185 294 35 ${K_COLOR_BORDER} ${K_COLOR_FIELD}
  !insertmacro CGText 34 195 210 13 "   REMOVE_PACKAGE" ${K_COLOR_TEXT} ${K_COLOR_FIELD} $ConceptFontMono
  !insertmacro CGText 258 195 47 13 "DANGER" ${K_COLOR_MUTED} ${K_COLOR_FIELD} $ConceptFontMono
  !insertmacro CGText 22 238 296 12 "preserve.app_data = true   [locked until remove]" ${K_COLOR_MUTED} ${K_COLOR_WINDOW} $ConceptFontMono
  nsDialogs::Show
FunctionEnd

; ---------------------------------------------------------------------------
; Concept C — Signal Matrix: asymmetric rails and a more distinctive HUD feel.

!macro CGMatrixHeader STEP INDEX
  !insertmacro CGBox 22 91 5 163 ${K_COLOR_ACCENT}
  !insertmacro CGBox 31 91 287 1 ${K_COLOR_BORDER}
  !insertmacro CGText 31 98 120 12 "${STEP}" ${K_COLOR_ACCENT} ${K_COLOR_WINDOW} $ConceptFontMono
  !insertmacro CGText 247 98 71 12 "STEP ${INDEX} / 05" ${K_COLOR_MUTED} ${K_COLOR_WINDOW} $ConceptFontMono
!macroend

Function ConceptApplyEnglish
  StrCpy $ConceptSelectedLanguage 1033
  StrCpy $LANGUAGE 1033
  SendMessage $ConceptLanguageEnglish ${BM_SETCHECK} ${BST_CHECKED} 0
  SendMessage $ConceptLanguageRussian ${BM_SETCHECK} ${BST_UNCHECKED} 0
  SetCtlColors $ConceptLanguageEnglish ${K_COLOR_TEXT} ${K_COLOR_PANEL}
  SetCtlColors $ConceptLanguageRussian ${K_COLOR_MUTED} ${K_COLOR_FIELD}
  SetCtlColors $ConceptLanguageEnglishText ${K_COLOR_TEXT} ${K_COLOR_PANEL}
  SetCtlColors $ConceptLanguageRussianText ${K_COLOR_MUTED} ${K_COLOR_FIELD}
  SendMessage $ConceptLanguageEnglishState ${WM_SETTEXT} 0 "STR:SELECTED"
  SendMessage $ConceptLanguageRussianState ${WM_SETTEXT} 0 "STR:"
FunctionEnd

Function ConceptApplyRussian
  StrCpy $ConceptSelectedLanguage 1049
  StrCpy $LANGUAGE 1049
  SendMessage $ConceptLanguageEnglish ${BM_SETCHECK} ${BST_UNCHECKED} 0
  SendMessage $ConceptLanguageRussian ${BM_SETCHECK} ${BST_CHECKED} 0
  SetCtlColors $ConceptLanguageEnglish ${K_COLOR_MUTED} ${K_COLOR_FIELD}
  SetCtlColors $ConceptLanguageRussian ${K_COLOR_TEXT} ${K_COLOR_PANEL}
  SetCtlColors $ConceptLanguageEnglishText ${K_COLOR_MUTED} ${K_COLOR_FIELD}
  SetCtlColors $ConceptLanguageRussianText ${K_COLOR_TEXT} ${K_COLOR_PANEL}
  SendMessage $ConceptLanguageEnglishState ${WM_SETTEXT} 0 "STR:"
  SendMessage $ConceptLanguageRussianState ${WM_SETTEXT} 0 "STR:ВЫБРАНО"
FunctionEnd

Function ConceptSelectEnglish
  Pop $0
  Call ConceptApplyEnglish
FunctionEnd

Function ConceptSelectRussian
  Pop $0
  Call ConceptApplyRussian
FunctionEnd

Function ConceptSyncLanguageSelection
  SendMessage $ConceptLanguageRussian ${BM_GETCHECK} 0 0 $0
  ${If} $0 == ${BST_CHECKED}
    ${If} $ConceptSelectedLanguage != 1049
      Call ConceptApplyRussian
    ${EndIf}
  ${ElseIf} $ConceptSelectedLanguage != 1033
    Call ConceptApplyEnglish
  ${EndIf}
FunctionEnd

Function ConceptCMatrixLanguage
  !insertmacro CGBegin "SIGNAL MATRIX / LOCALE" "Installer language / Язык установщика" "Choose the interface language · Выберите язык интерфейса"
  !insertmacro CGMatrixHeader "LANGUAGE MATRIX" "01"

  !insertmacro CGFrame 42 121 260 51 43 122 258 49 ${K_COLOR_ACCENT} ${K_COLOR_PANEL}
  nsDialogs::CreateControl BUTTON "${DEFAULT_STYLES}|${WS_TABSTOP}|${BS_AUTORADIOBUTTON}|${BS_PUSHLIKE}|${BS_FLAT}" 0 43u 122u 258u 49u ""
  Pop $ConceptLanguageEnglish
  System::Call 'uxtheme::SetWindowTheme(p rConceptLanguageEnglish, w "", w "")'
  SetCtlColors $ConceptLanguageEnglish ${K_COLOR_TEXT} ${K_COLOR_PANEL}
  SendMessage $ConceptLanguageEnglish ${WM_SETFONT} $ConceptFontLabel 1
  ${NSD_OnClick} $ConceptLanguageEnglish ConceptSelectEnglish
  ${NSD_CreateLabel} 58u 132u 176u 28u "ENGLISH$\r$\nPrimary · default fallback"
  Pop $ConceptLanguageEnglishText
  SetCtlColors $ConceptLanguageEnglishText ${K_COLOR_TEXT} ${K_COLOR_PANEL}
  SendMessage $ConceptLanguageEnglishText ${WM_SETFONT} $ConceptFontLabel 1
  EnableWindow $ConceptLanguageEnglishText 0
  ${NSD_CreateLabel} 240u 137u 52u 14u "SELECTED"
  Pop $ConceptLanguageEnglishState
  SetCtlColors $ConceptLanguageEnglishState ${K_COLOR_ACCENT} ${K_COLOR_PANEL}
  SendMessage $ConceptLanguageEnglishState ${WM_SETFONT} $ConceptFontMono 1
  EnableWindow $ConceptLanguageEnglishState 0
  System::Call 'user32::SetWindowPos(p rConceptLanguageEnglishText, p 0, i 0, i 0, i 0, i 0, i 0x13)'
  System::Call 'user32::SetWindowPos(p rConceptLanguageEnglishState, p 0, i 0, i 0, i 0, i 0, i 0x13)'

  !insertmacro CGFrame 58 183 244 50 59 184 242 48 ${K_COLOR_BORDER} ${K_COLOR_FIELD}
  nsDialogs::CreateControl BUTTON "${DEFAULT_STYLES}|${WS_TABSTOP}|${BS_AUTORADIOBUTTON}|${BS_PUSHLIKE}|${BS_FLAT}" 0 59u 184u 242u 48u ""
  Pop $ConceptLanguageRussian
  System::Call 'uxtheme::SetWindowTheme(p rConceptLanguageRussian, w "", w "")'
  SetCtlColors $ConceptLanguageRussian ${K_COLOR_MUTED} ${K_COLOR_FIELD}
  SendMessage $ConceptLanguageRussian ${WM_SETFONT} $ConceptFontLabel 1
  ${NSD_OnClick} $ConceptLanguageRussian ConceptSelectRussian
  ${NSD_CreateLabel} 74u 194u 160u 28u "РУССКИЙ$\r$\nДополнительный язык"
  Pop $ConceptLanguageRussianText
  SetCtlColors $ConceptLanguageRussianText ${K_COLOR_MUTED} ${K_COLOR_FIELD}
  SendMessage $ConceptLanguageRussianText ${WM_SETFONT} $ConceptFontLabel 1
  EnableWindow $ConceptLanguageRussianText 0
  ${NSD_CreateLabel} 240u 199u 52u 14u ""
  Pop $ConceptLanguageRussianState
  SetCtlColors $ConceptLanguageRussianState ${K_COLOR_ACCENT} ${K_COLOR_FIELD}
  SendMessage $ConceptLanguageRussianState ${WM_SETFONT} $ConceptFontMono 1
  EnableWindow $ConceptLanguageRussianState 0
  System::Call 'user32::SetWindowPos(p rConceptLanguageRussianText, p 0, i 0, i 0, i 0, i 0, i 0x13)'
  System::Call 'user32::SetWindowPos(p rConceptLanguageRussianState, p 0, i 0, i 0, i 0, i 0, i 0x13)'

  ${If} $LANGUAGE == 1049
    Call ConceptApplyRussian
  ${Else}
    Call ConceptApplyEnglish
  ${EndIf}
  ; Native push-card state changes immediately on pointer/keyboard input. The
  ; timer mirrors that state into the bilingual labels and locale without
  ; depending on a fragile STATIC/BN_CLICKED notification path.
  ${NSD_CreateTimer} ConceptSyncLanguageSelection 80
  !insertmacro CGBox 31 251 287 3 ${K_COLOR_BORDER}
  !insertmacro CGBox 31 251 57 3 ${K_COLOR_ACCENT}
  nsDialogs::Show
FunctionEnd

Function ConceptCMatrixLanguageLeave
  ${NSD_KillTimer} ConceptSyncLanguageSelection
  Call ConceptSyncLanguageSelection
  StrCpy $LANGUAGE $ConceptSelectedLanguage
FunctionEnd

Function ConceptCMatrixScope
  !insertmacro CGBegin "$(CGConceptCMatrix)" "$(CGScopeTitle)" "$(CGScopeSubtitle)"
  !insertmacro CGMatrixHeader "ACCESS MATRIX" "02"
  !insertmacro CGFrame 42 121 260 51 43 122 258 49 ${K_COLOR_ACCENT} ${K_COLOR_PANEL}
  !insertmacro CGCenterText 43 122 39 49 "01" ${K_COLOR_TEXT} ${K_COLOR_ACCENT} $ConceptFontLabel
  !insertmacro CGText 94 131 145 14 "$(CGCurrentTitle)" ${K_COLOR_TEXT} ${K_COLOR_PANEL} $ConceptFontLabel
  !insertmacro CGText 94 150 190 12 "$(CGCurrentDescription)" ${K_COLOR_MUTED} ${K_COLOR_PANEL} $KuroganeFontBody
  !insertmacro CGBox 287 137 5 18 ${K_COLOR_ACCENT}
  !insertmacro CGFrame 58 183 244 50 59 184 242 48 ${K_COLOR_BORDER} ${K_COLOR_FIELD}
  !insertmacro CGCenterText 59 184 39 48 "02" ${K_COLOR_MUTED} ${K_COLOR_PANEL} $ConceptFontLabel
  !insertmacro CGText 110 193 130 14 "$(CGAllTitle)" ${K_COLOR_TEXT} ${K_COLOR_FIELD} $ConceptFontLabel
  !insertmacro CGText 110 212 176 12 "$(CGAllDescription)" ${K_COLOR_MUTED} ${K_COLOR_FIELD} $KuroganeFontBody
  !insertmacro CGBox 31 251 287 3 ${K_COLOR_BORDER}
  !insertmacro CGBox 31 251 96 3 ${K_COLOR_ACCENT}
  nsDialogs::Show
FunctionEnd

Function ConceptCMatrixTarget
  !insertmacro CGBegin "$(CGConceptCMatrix)" "$(CGTargetTitle)" "$(CGTargetSubtitle)"
  !insertmacro CGMatrixHeader "TARGET VECTOR" "03"
  !insertmacro CGText 43 121 200 11 "INSTALL TARGET" ${K_COLOR_MUTED} ${K_COLOR_WINDOW} $ConceptFontMono
  !insertmacro CGFrame 43 139 259 43 44 140 257 41 ${K_COLOR_ACCENT} ${K_COLOR_FIELD}
  !insertmacro CGBox 44 140 5 41 ${K_COLOR_ACCENT}
  ${NSD_CreateText} 60u 149u 1u 1u "C:\Program Files\Ninety"
  Pop $0
  System::Call 'uxtheme::SetWindowTheme(p r0, w "", w "")'
  SetCtlColors $0 ${K_COLOR_TEXT} ${K_COLOR_FIELD}
  SendMessage $0 ${WM_SETFONT} $ConceptFontMono 1
  SendMessage $0 ${WM_SETTEXT} 0 "STR:C:\Program Files\Ninety"
  !insertmacro CGText 60 153 150 12 "$(CGDefaultPath)" ${K_COLOR_TEXT} ${K_COLOR_FIELD} $ConceptFontMono
  !insertmacro CGFrame 219 149 74 22 220 150 72 20 ${K_COLOR_ACCENT} ${K_COLOR_PANEL}
  !insertmacro CGCenterText 220 154 72 12 "$(CGChange)" ${K_COLOR_ACCENT} ${K_COLOR_PANEL} $ConceptFontMono
  !insertmacro CGText 43 197 78 11 "CAPACITY" ${K_COLOR_MUTED} ${K_COLOR_WINDOW} $ConceptFontMono
  !insertmacro CGBox 43 216 18 8 ${K_COLOR_ACCENT}
  !insertmacro CGBox 65 216 18 8 ${K_COLOR_BORDER}
  !insertmacro CGBox 87 216 18 8 ${K_COLOR_BORDER}
  !insertmacro CGBox 109 216 18 8 ${K_COLOR_BORDER}
  !insertmacro CGBox 131 216 18 8 ${K_COLOR_BORDER}
  !insertmacro CGBox 153 216 18 8 ${K_COLOR_BORDER}
  !insertmacro CGText 176 211 126 14 "82.7 GB / $(CGStatusReady)" ${K_COLOR_TEXT} ${K_COLOR_WINDOW} $ConceptFontMono
  !insertmacro CGText 43 241 200 12 "DESKTOP.LINK" ${K_COLOR_MUTED} ${K_COLOR_WINDOW} $ConceptFontMono
  !insertmacro CGCenterText 259 238 43 18 "ON" ${K_COLOR_TEXT} ${K_COLOR_ACCENT} $ConceptFontMono
  nsDialogs::Show
FunctionEnd

Function ConceptCMatrixManifest
  !insertmacro CGBegin "$(CGConceptCMatrix)" "$(CGManifestTitle)" "$(CGManifestSubtitle)"
  !insertmacro CGMatrixHeader "LICENSE SIGNAL" "04"
  !insertmacro CGFrame 43 121 259 118 44 122 257 116 ${K_COLOR_BORDER} ${K_COLOR_FIELD}
  !insertmacro CGBox 44 122 70 116 ${K_COLOR_PANEL}
  !insertmacro CGText 54 133 50 12 "LICENSE" ${K_COLOR_MUTED} ${K_COLOR_PANEL} $ConceptFontMono
  !insertmacro CGText 54 151 50 17 "MIT" ${K_COLOR_ACCENT} ${K_COLOR_PANEL} $ConceptFontLabel
  !insertmacro CGText 54 181 50 12 "MODULES" ${K_COLOR_MUTED} ${K_COLOR_PANEL} $ConceptFontMono
  !insertmacro CGText 54 199 50 17 "12" ${K_COLOR_TEXT} ${K_COLOR_PANEL} $ConceptFontLabel
  !insertmacro CGText 126 133 157 14 "$(CGLicenseBody1)" ${K_COLOR_TEXT} ${K_COLOR_FIELD} $ConceptFontMono
  !insertmacro CGText 126 155 157 28 "$(CGLicenseBody2)" ${K_COLOR_MUTED} ${K_COLOR_FIELD} $KuroganeFontBody
  !insertmacro CGText 126 191 157 30 "$(CGLicenseBody3)" ${K_COLOR_MUTED} ${K_COLOR_FIELD} $KuroganeFontBody
  !insertmacro CGBox 291 132 3 93 ${K_COLOR_BORDER}
  !insertmacro CGBox 291 132 3 31 ${K_COLOR_ACCENT}
  !insertmacro CGText 43 247 259 11 "READ POSITION  /  018%" ${K_COLOR_MUTED} ${K_COLOR_WINDOW} $ConceptFontMono
  nsDialogs::Show
FunctionEnd

Function ConceptCMatrixMaintenance
  !insertmacro CGBegin "$(CGConceptCMatrix)" "$(CGMaintenanceTitle)" "$(CGMaintenanceSubtitle)"
  !insertmacro CGMatrixHeader "OPERATION GRID" "05"
  !insertmacro CGFrame 43 121 259 52 44 122 257 50 ${K_COLOR_ACCENT} ${K_COLOR_PANEL}
  !insertmacro CGBox 44 122 34 50 ${K_COLOR_ACCENT}
  !insertmacro CGCenterText 44 140 34 14 "+" ${K_COLOR_TEXT} ${K_COLOR_ACCENT} $ConceptFontLabel
  !insertmacro CGText 91 131 180 14 "$(CGRepairTitle)" ${K_COLOR_TEXT} ${K_COLOR_PANEL} $ConceptFontLabel
  !insertmacro CGText 91 150 195 20 "$(CGRepairDescription)" ${K_COLOR_MUTED} ${K_COLOR_PANEL} $KuroganeFontBody
  !insertmacro CGFrame 59 181 243 57 60 182 241 55 ${K_COLOR_BORDER} ${K_COLOR_FIELD}
  !insertmacro CGBox 60 182 34 55 ${K_COLOR_PANEL}
  !insertmacro CGCenterText 60 202 34 14 "×" ${K_COLOR_MUTED} ${K_COLOR_PANEL} $ConceptFontLabel
  !insertmacro CGText 107 191 178 14 "$(CGRemoveTitle)" ${K_COLOR_TEXT} ${K_COLOR_FIELD} $ConceptFontLabel
  !insertmacro CGText 107 210 178 24 "$(CGRemoveDescription)" ${K_COLOR_MUTED} ${K_COLOR_FIELD} $KuroganeFontBody
  !insertmacro CGText 43 247 132 12 "DATA / PRESERVE" ${K_COLOR_MUTED} ${K_COLOR_WINDOW} $ConceptFontMono
  !insertmacro CGBox 186 251 85 3 ${K_COLOR_BORDER}
  !insertmacro CGBox 186 251 57 3 ${K_COLOR_ACCENT}
  !insertmacro CGText 279 245 23 12 "ON" ${K_COLOR_ACCENT} ${K_COLOR_WINDOW} $ConceptFontMono
  nsDialogs::Show
FunctionEnd
