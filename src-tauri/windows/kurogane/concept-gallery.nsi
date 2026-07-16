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

; Signal Matrix is the selected direction, so its complete five-step flow is
; presented first. Core Cards and Terminal Manifest remain comparison material.
Page custom ConceptCMatrixLanguage
Page custom ConceptCMatrixScope
Page custom ConceptCMatrixTarget
Page custom ConceptCMatrixManifest
Page custom ConceptCMatrixMaintenance

Page custom ConceptACardsScope
Page custom ConceptACardsTarget
Page custom ConceptACardsManifest
Page custom ConceptACardsMaintenance

Page custom ConceptBTerminalScope
Page custom ConceptBTerminalTarget
Page custom ConceptBTerminalManifest
Page custom ConceptBTerminalMaintenance

!insertmacro MUI_LANGUAGE "English"
!insertmacro MUI_LANGUAGE "Russian"

Function .onInit
  ; English is the fallback. Russian Windows is detected before the bilingual
  ; custom language page appears; the user can always override that choice.
  System::Call 'kernel32::GetUserDefaultUILanguage() i .r0'
  ${If} $0 == 1049
    StrCpy $LANGUAGE 1049
  ${Else}
    StrCpy $LANGUAGE 1033
  ${EndIf}
FunctionEnd

Section
  ; Intentionally empty: this executable is a zero-side-effect design gallery.
SectionEnd
