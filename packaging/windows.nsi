Unicode true
RequestExecutionLevel user
!include MUI2.nsh
Name "Better HMP7"
OutFile "${PACKAGE}"
InstallDir "$LOCALAPPDATA\Programs\Better HMP7"
InstallDirRegKey HKCU "Software\Better HMP7" "InstallDir"
SetCompressor /SOLID lzma
ShowInstDetails nevershow
!define MUI_ICON "${ICON}"
!define MUI_UNICON "${ICON}"
!define MUI_ABORTWARNING
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "SimpChinese"
!insertmacro MUI_LANGUAGE "English"

Section
  SetShellVarContext current
  SetOutPath "$INSTDIR"
  File "/oname=Better HMP7.exe" "${APP_EXE}"
  File "/oname=LICENSE.txt" "${PROJECT_LICENSE}"
  SetOutPath "$INSTDIR\licenses"
  File "${NOTICES}\*.txt"
  SetOutPath "$INSTDIR"
  WriteUninstaller "$INSTDIR\uninstall.exe"
  CreateShortcut "$SMPROGRAMS\Better HMP7.lnk" "$INSTDIR\Better HMP7.exe"
  WriteRegStr HKCU "Software\Better HMP7" "InstallDir" "$INSTDIR"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\BetterHMP7" "DisplayName" "Better HMP7"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\BetterHMP7" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\BetterHMP7" "Publisher" "Better HMP7 contributors"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\BetterHMP7" "DisplayIcon" "$INSTDIR\Better HMP7.exe"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\BetterHMP7" "UninstallString" '"$INSTDIR\uninstall.exe"'
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\BetterHMP7" "NoModify" 1
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\BetterHMP7" "NoRepair" 1
SectionEnd

Section Uninstall
  SetShellVarContext current
  Delete "$SMPROGRAMS\Better HMP7.lnk"
  Delete "$INSTDIR\Better HMP7.exe"
  Delete "$INSTDIR\LICENSE.txt"
  !include "${UNINSTALL_NOTICES}"
  RMDir "$INSTDIR\licenses"
  Delete "$INSTDIR\uninstall.exe"
  RMDir "$INSTDIR"
  DeleteRegKey HKCU "Software\Better HMP7"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\BetterHMP7"
SectionEnd
