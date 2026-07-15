; Compile-only contract test for the custom NSIS resource shell.
Unicode true
ManifestDPIAware true
ManifestDPIAwareness PerMonitorV2

!include MUI2.nsh

!define VERSION "0.2.19"
!define MUI_ICON "..\..\icons\icon.ico"
!include "kurogane-ui.nsh"

Name "Ninety"
OutFile "kurogane-smoke.exe"
RequestExecutionLevel user

!define MUI_PAGE_CUSTOMFUNCTION_SHOW KuroganePageShow
!insertmacro MUI_PAGE_WELCOME
!define MUI_PAGE_CUSTOMFUNCTION_SHOW KuroganeInstFilesShow
!define MUI_PAGE_CUSTOMFUNCTION_LEAVE KuroganeInstFilesLeave
!insertmacro MUI_PAGE_INSTFILES
!define MUI_PAGE_CUSTOMFUNCTION_SHOW KuroganePageShow
!insertmacro MUI_PAGE_FINISH

!define MUI_PAGE_CUSTOMFUNCTION_SHOW un.KuroganePageShow
!insertmacro MUI_UNPAGE_CONFIRM
!define MUI_PAGE_CUSTOMFUNCTION_SHOW un.KuroganeInstFilesShow
!define MUI_PAGE_CUSTOMFUNCTION_LEAVE un.KuroganeInstFilesLeave
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "English"
!insertmacro MUI_LANGUAGE "Russian"

Section
  SetOutPath "$TEMP\NinetySmoke"
  Sleep 500
  WriteUninstaller "$TEMP\NinetySmoke\uninstall.exe"
SectionEnd

Section "Uninstall"
  Delete "$TEMP\NinetySmoke\uninstall.exe"
  RMDir "$TEMP\NinetySmoke"
SectionEnd
