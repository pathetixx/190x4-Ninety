; Compile-only contract test for the custom NSIS resource shell.
Unicode true
ManifestDPIAware true
ManifestDPIAwareness PerMonitorV2

!include MUI2.nsh
!include FileFunc.nsh
!define MULTIUSER_EXECUTIONLEVEL Highest
!define MULTIUSER_INSTALLMODE_DEFAULT_CURRENTUSER
!include MultiUser.nsh

!ifndef VERSION
  !define VERSION "0.0.0-preview"
!endif
!define MUI_ICON "..\..\icons\icon.ico"
Var PassiveMode
!include "kurogane-ui.nsh"

Name "Ninety"
OutFile "kurogane-smoke.exe"
InstallDir "$TEMP\NinetySmoke"
Var SmokeMaintenanceDialog
Var SmokeMaintenancePrimary
Var SmokeMaintenanceSecondary
Var SmokeDeleteAppDataCheckbox

!define MUI_PAGE_CUSTOMFUNCTION_PRE SmokeSkipIfPassive
!define MUI_PAGE_CUSTOMFUNCTION_SHOW SmokeWelcomeShow
!insertmacro MUI_PAGE_WELCOME
Function SmokeWelcomeShow
  !insertmacro KuroganeKnownFullWindowPageShowImpl "" $mui.WelcomePage $mui.WelcomePage.Image $mui.WelcomePage.Title $mui.WelcomePage.Text Install
FunctionEnd
!define MUI_PAGE_CUSTOMFUNCTION_PRE SmokeSkipIfPassive
!define MUI_PAGE_CUSTOMFUNCTION_SHOW SmokeLicenseShow
!insertmacro MUI_PAGE_LICENSE "..\license.rtf"
Function SmokeLicenseShow
  !insertmacro KuroganeLicensePageImpl "" $mui.LicensePage $mui.Licensepage.TopText $mui.Licensepage.LicenseText
FunctionEnd
!define MULTIUSER_PAGE_CUSTOMFUNCTION_PRE SmokeSkipIfPassive
!define MULTIUSER_PAGE_CUSTOMFUNCTION_SHOW SmokeInstallModeShow
!insertmacro MULTIUSER_PAGE_INSTALLMODE
Function SmokeInstallModeShow
  !insertmacro KuroganeInstallModePageImpl
FunctionEnd
Page custom SmokeMaintenanceShow
Function SmokeMaintenanceShow
  ${If} $PassiveMode == 1
    Abort
  ${EndIf}
  nsDialogs::Create 1018
  Pop $SmokeMaintenanceDialog
  StrCpy $0 "Ninety ${VERSION} - $(KMaintenanceSubtitle)"
  StrCpy $1 "$(KMaintenanceRepairAction)"
  StrCpy $2 "$(KMaintenanceRemoveAction)"
  StrCpy $3 "$(KMaintenanceRepairDescription)"
  StrCpy $4 "$(KMaintenanceRemoveDescription)"
  !insertmacro KuroganeMaintenancePageImpl $SmokeMaintenanceDialog $SmokeMaintenancePrimary $SmokeMaintenanceSecondary $0 $1 $2 $3 $4
  SendMessage $SmokeMaintenancePrimary ${BM_SETCHECK} ${BST_CHECKED} 0
  Call KuroganeApplySignalStates
  ${NSD_SetFocus} $SmokeMaintenancePrimary
  nsDialogs::Show
FunctionEnd
!define MUI_PAGE_CUSTOMFUNCTION_PRE SmokeSkipIfPassive
!define MUI_PAGE_CUSTOMFUNCTION_SHOW SmokeDirectoryShow
!insertmacro MUI_PAGE_DIRECTORY
Function SmokeDirectoryShow
  !insertmacro KuroganeDirectoryPageImpl $mui.DirectoryPage
FunctionEnd
!define MUI_PAGE_CUSTOMFUNCTION_SHOW KuroganeInstFilesShow
!define MUI_PAGE_CUSTOMFUNCTION_LEAVE KuroganeInstFilesLeave
!insertmacro MUI_PAGE_INSTFILES
!define MUI_FINISHPAGE_NOAUTOCLOSE
!define MUI_PAGE_CUSTOMFUNCTION_PRE SmokeSkipIfPassive
!define MUI_PAGE_CUSTOMFUNCTION_SHOW SmokeFinishShow
!insertmacro MUI_PAGE_FINISH
Function SmokeFinishShow
  !insertmacro KuroganeKnownFullWindowPageShowImpl "" $mui.FinishPage $mui.FinishPage.Image $mui.FinishPage.Title $mui.FinishPage.Text Finish
FunctionEnd

!define MUI_PAGE_CUSTOMFUNCTION_SHOW un.SmokeConfirmShow
!insertmacro MUI_UNPAGE_CONFIRM
Function un.SmokeConfirmShow
  !insertmacro KuroganeUninstallConfirmPageImpl $mui.UnConfirmPage $SmokeDeleteAppDataCheckbox "$(KUninstallDeleteData)"
FunctionEnd
!define MUI_PAGE_CUSTOMFUNCTION_SHOW un.KuroganeInstFilesShow
!define MUI_PAGE_CUSTOMFUNCTION_LEAVE un.KuroganeInstFilesLeave
!insertmacro MUI_UNPAGE_INSTFILES
!define MUI_PAGE_CUSTOMFUNCTION_SHOW un.SmokeFinishShow
!insertmacro MUI_UNPAGE_FINISH
Function un.SmokeFinishShow
  !insertmacro KuroganeKnownFullWindowPageShowImpl "un." $mui.FinishPage $mui.FinishPage.Image $mui.FinishPage.Title $mui.FinishPage.Text Finish
FunctionEnd

!insertmacro MUI_LANGUAGE "English"
!insertmacro MUI_LANGUAGE "Russian"

Function SmokeSkipIfPassive
  ${If} $PassiveMode == 1
    Abort
  ${EndIf}
FunctionEnd

Function .onInit
  ; Production updater on Dima's machine runs in Russian. Keep the visual gate
  ; on that exact locale so localized bitmap chrome is exercised on every push.
  StrCpy $LANGUAGE 1049
  ${GetOptions} $CMDLINE "/P" $PassiveMode
  ${IfNot} ${Errors}
    StrCpy $PassiveMode 1
  ${EndIf}
  ${GetOptions} $CMDLINE "/SELECTLANG" $0
  ${IfNot} ${Errors}
    !insertmacro KuroganeRunLanguageSelector $0
    ${If} $0 == 11
      StrCpy $LANGUAGE 1049
    ${ElseIf} $0 == 10
      StrCpy $LANGUAGE 1033
    ${Else}
      Abort
    ${EndIf}
  ${EndIf}
  !insertmacro MULTIUSER_INIT
FunctionEnd

Function un.onInit
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
  ${If} $PassiveMode == 1
    SetAutoClose true
  ${EndIf}
SectionEnd

Section "Uninstall"
  Delete "$TEMP\NinetySmoke\uninstall.exe"
  RMDir "$TEMP\NinetySmoke"
SectionEnd
