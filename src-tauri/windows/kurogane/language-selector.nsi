; Premium pre-init locale selector for the production Ninety installer.
; It runs as a tiny child process because NSIS only permits changing the host
; installer's $LANGUAGE variable from the host .onInit callback.
Unicode true
ManifestDPIAware true
ManifestDPIAwareness PerMonitorV2

!include MUI2.nsh

!ifndef VERSION
  !define VERSION "0.0.0-preview"
!endif

!define MUI_ICON "..\..\icons\icon.ico"
!define MUI_CUSTOMFUNCTION_ABORT LanguageAbort
Var PassiveMode
!include "kurogane-ui.nsh"

Name "Ninety Installer Language"
OutFile "kurogane-language.exe"

Var LanguageDialog
Var LanguageEnglish
Var LanguageRussian
Var LanguageEnglishState
Var LanguageRussianState

Page custom LanguagePage LanguageLeave

!insertmacro MUI_LANGUAGE "English"
!insertmacro MUI_LANGUAGE "Russian"

Function .onInit
  System::Call 'kernel32::GetUserDefaultUILanguage() i .r0'
  ${If} $0 == 1049
    StrCpy $LANGUAGE 1049
  ${Else}
    ; English is the repository language and the fallback for every unsupported
    ; Windows locale.
    StrCpy $LANGUAGE 1033
  ${EndIf}
FunctionEnd

Function LanguageApplyState
  SendMessage $LanguageRussian ${BM_GETCHECK} 0 0 $0
  ${If} $0 == ${BST_CHECKED}
    SendMessage $LanguageEnglishState ${WM_SETTEXT} 0 "STR:"
    SendMessage $LanguageRussianState ${WM_SETTEXT} 0 "STR:$(KLanguageSelected)"
  ${Else}
    SendMessage $LanguageEnglishState ${WM_SETTEXT} 0 "STR:$(KLanguageSelected)"
    SendMessage $LanguageRussianState ${WM_SETTEXT} 0 "STR:"
  ${EndIf}
FunctionEnd

Function LanguageSelectEnglish
  Pop $0
  SendMessage $LanguageEnglish ${BM_SETCHECK} ${BST_CHECKED} 0
  SendMessage $LanguageRussian ${BM_SETCHECK} ${BST_UNCHECKED} 0
  Call KuroganeApplySignalStates
  Call LanguageApplyState
FunctionEnd

Function LanguageSelectRussian
  Pop $0
  SendMessage $LanguageEnglish ${BM_SETCHECK} ${BST_UNCHECKED} 0
  SendMessage $LanguageRussian ${BM_SETCHECK} ${BST_CHECKED} 0
  Call KuroganeApplySignalStates
  Call LanguageApplyState
FunctionEnd

Function LanguagePage
  nsDialogs::Create 1018
  Pop $LanguageDialog
  !insertmacro KuroganePrepareKnownPageImpl "" $LanguageDialog Next
  StrCpy $KuroganeMatrixParent $LanguageDialog

  !insertmacro KuroganeMatrixPageHeader "SIGNAL MATRIX / LOCALE" "$(KLanguageTitle)" "$(KLanguageSubtitle)" "LANGUAGE MATRIX" "190X4 / 01"

  !insertmacro KuroganeMatrixBox 42 121 260 51 ${K_COLOR_BORDER}
  StrCpy $KuroganeSignalPrimaryBorder $0
  !insertmacro KuroganeMatrixBox 43 122 258 49 ${K_COLOR_PANEL}
  !insertmacro KuroganeMatrixText 58 132 170 14 "$(KLanguageEnglishTitle)" ${K_COLOR_TEXT} ${K_COLOR_PANEL} $KuroganeFontSteps
  !insertmacro KuroganeMatrixText 58 151 190 18 "$(KLanguageEnglishDescription)" ${K_COLOR_MUTED} ${K_COLOR_PANEL} $KuroganeFontBody
  !insertmacro KuroganeSignalRadio 278 138 $LanguageEnglish
  ${NSD_OnClick} $LanguageEnglish LanguageSelectEnglish
  ${NSD_CreateLabel} 224u 139u 47u 12u ""
  Pop $LanguageEnglishState
  SetCtlColors $LanguageEnglishState ${K_COLOR_ACCENT} ${K_COLOR_PANEL}
  SendMessage $LanguageEnglishState ${WM_SETFONT} $KuroganeFontMono 1

  !insertmacro KuroganeMatrixBox 58 183 244 50 ${K_COLOR_BORDER}
  StrCpy $KuroganeSignalSecondaryBorder $0
  !insertmacro KuroganeMatrixBox 59 184 242 48 ${K_COLOR_FIELD}
  !insertmacro KuroganeMatrixText 74 194 154 14 "$(KLanguageRussianTitle)" ${K_COLOR_TEXT} ${K_COLOR_FIELD} $KuroganeFontSteps
  !insertmacro KuroganeMatrixText 74 213 174 18 "$(KLanguageRussianDescription)" ${K_COLOR_MUTED} ${K_COLOR_FIELD} $KuroganeFontBody
  !insertmacro KuroganeSignalRadio 278 200 $LanguageRussian
  ${NSD_OnClick} $LanguageRussian LanguageSelectRussian
  ${NSD_CreateLabel} 224u 204u 47u 12u ""
  Pop $LanguageRussianState
  SetCtlColors $LanguageRussianState ${K_COLOR_ACCENT} ${K_COLOR_FIELD}
  SendMessage $LanguageRussianState ${WM_SETFONT} $KuroganeFontMono 1
  !insertmacro KuroganeBringToFront $LanguageEnglishState
  !insertmacro KuroganeBringToFront $LanguageRussianState
  !insertmacro KuroganeBringToFront $LanguageEnglish
  !insertmacro KuroganeBringToFront $LanguageRussian
  !insertmacro KuroganeMatrixBox 31 251 287 3 ${K_COLOR_BORDER}
  !insertmacro KuroganeMatrixBox 31 251 57 3 ${K_COLOR_ACCENT}

  StrCpy $KuroganeSignalPrimaryControl $LanguageEnglish
  StrCpy $KuroganeSignalSecondaryControl $LanguageRussian

  ${If} $LANGUAGE == 1049
    SendMessage $LanguageRussian ${BM_SETCHECK} ${BST_CHECKED} 0
  ${Else}
    SendMessage $LanguageEnglish ${BM_SETCHECK} ${BST_CHECKED} 0
  ${EndIf}
  Call KuroganeApplySignalStates
  Call LanguageApplyState

  ; No Back action exists before locale selection.
  GetDlgItem $0 $HWNDPARENT 3
  ShowWindow $0 ${SW_HIDE}
  System::Call 'gdi32::CreateRectRgn(i 0, i 0, i 0, i 0) p .r1'
  System::Call 'user32::SetWindowRgn(p r0, p r1, i 1)'

  nsDialogs::Show
FunctionEnd

Function LanguageLeave
  SendMessage $LanguageRussian ${BM_GETCHECK} 0 0 $0
  ${If} $0 == ${BST_CHECKED}
    SetErrorLevel 11
  ${Else}
    SetErrorLevel 10
  ${EndIf}
  Quit
FunctionEnd

Function LanguageAbort
  SetErrorLevel 12
FunctionEnd

Section
SectionEnd
