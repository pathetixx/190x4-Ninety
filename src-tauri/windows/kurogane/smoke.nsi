; Compile-only contract test for the custom NSIS resource shell.
Unicode true
ManifestDPIAware true
ManifestDPIAwareness PerMonitorV2

!include MUI2.nsh

!ifndef VERSION
  !define VERSION "0.0.0-preview"
!endif
!define MUI_ICON "..\..\icons\icon.ico"
!include "kurogane-ui.nsh"

Name "Ninety"
OutFile "kurogane-smoke.exe"
RequestExecutionLevel user

!define MUI_PAGE_CUSTOMFUNCTION_SHOW SmokeWelcomeShow
!insertmacro MUI_PAGE_WELCOME
Function SmokeWelcomeShow
  !insertmacro KuroganeKnownFullWindowPageShowImpl "" $mui.WelcomePage $mui.WelcomePage.Image $mui.WelcomePage.Title $mui.WelcomePage.Text Install
FunctionEnd
!define MUI_PAGE_CUSTOMFUNCTION_SHOW KuroganeInstFilesShow
!define MUI_PAGE_CUSTOMFUNCTION_LEAVE KuroganeInstFilesLeave
!insertmacro MUI_PAGE_INSTFILES
!define MUI_FINISHPAGE_NOAUTOCLOSE
!define MUI_PAGE_CUSTOMFUNCTION_SHOW SmokeFinishShow
!insertmacro MUI_PAGE_FINISH
Function SmokeFinishShow
  !insertmacro KuroganeKnownFullWindowPageShowImpl "" $mui.FinishPage $mui.FinishPage.Image $mui.FinishPage.Title $mui.FinishPage.Text Finish
FunctionEnd

!define MUI_PAGE_CUSTOMFUNCTION_SHOW un.KuroganePageShow
!insertmacro MUI_UNPAGE_CONFIRM
!define MUI_PAGE_CUSTOMFUNCTION_SHOW un.KuroganeInstFilesShow
!define MUI_PAGE_CUSTOMFUNCTION_LEAVE un.KuroganeInstFilesLeave
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "English"
!insertmacro MUI_LANGUAGE "Russian"

Function .onInit
  ; Production updater on Dima's machine runs in Russian. Keep the visual gate
  ; on that exact locale so localized bitmap chrome is exercised on every push.
  StrCpy $LANGUAGE 1049
FunctionEnd

Section
  SetOutPath "$TEMP\NinetySmoke"
  FindWindow $0 "#32770" "" $HWNDPARENT
  GetDlgItem $R1 $0 1004
  SendMessage $R1 0x0406 0 100
  StrCpy $2 0
  smoke_progress:
    IntOp $2 $2 + 10
    SendMessage $R1 0x0402 $2 0
    Call KuroganeProgressTick
    Sleep 650
    IntCmp $2 100 smoke_progress_done smoke_progress smoke_progress_done
  smoke_progress_done:
  WriteUninstaller "$TEMP\NinetySmoke\uninstall.exe"
SectionEnd

Section "Uninstall"
  Delete "$TEMP\NinetySmoke\uninstall.exe"
  RMDir "$TEMP\NinetySmoke"
SectionEnd
