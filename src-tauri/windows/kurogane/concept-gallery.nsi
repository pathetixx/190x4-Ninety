; Visual-only NSIS concept gallery for the next Kurogane control system.
; It is deliberately isolated from installer.nsi: no files, registry keys or
; production lifecycle behavior are changed by this executable.
Unicode true
ManifestDPIAware true
ManifestDPIAwareness PerMonitorV2

!include MUI2.nsh

!ifndef VERSION
  !define VERSION "0.0.0-concept"
!endif

!define MUI_ICON "..\..\icons\icon.ico"
Var PassiveMode
!include "kurogane-ui.nsh"
!include "concept-gallery.nsh"

Name "Ninety Installer Concepts"
OutFile "kurogane-concepts.exe"

Page custom ConceptACardsScope
Page custom ConceptACardsTarget
Page custom ConceptACardsManifest
Page custom ConceptACardsMaintenance

Page custom ConceptBTerminalScope
Page custom ConceptBTerminalTarget
Page custom ConceptBTerminalManifest
Page custom ConceptBTerminalMaintenance

Page custom ConceptCMatrixScope
Page custom ConceptCMatrixTarget
Page custom ConceptCMatrixManifest
Page custom ConceptCMatrixMaintenance

!insertmacro MUI_LANGUAGE "English"
!insertmacro MUI_LANGUAGE "Russian"

Function .onInit
  ; Dima reviews the localized visual artifact; English definitions remain the
  ; primary source directly above the Russian translations in the include.
  StrCpy $LANGUAGE 1049
FunctionEnd

Section
  ; Intentionally empty: this executable is a zero-side-effect design gallery.
SectionEnd
