; Veltriva's NSIS additions (M6.3, ADR-0007). electron-builder includes this file in the
; installer and the uninstaller (electron-builder.yml, nsis.include).
;
; The uninstaller asks whether to remove the profile, %APPDATA%\Veltriva (tabs, history,
; settings, site data). It never asks, and never removes it, when the uninstall is part of an
; update or reinstall (isUpdated) or runs silently (/S): those keep the profile, as electron-builder
; does by default.

!macro customUnInstall
  ${ifNot} ${isUpdated}
    ${ifNot} ${Silent}
      MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 \
        "Also remove your Veltriva data from this computer?$\r$\n$\r$\nThis deletes your tabs, history, settings and site data in $APPDATA\Veltriva. Choose No to keep them for a later install." \
        /SD IDNO IDNO veltrivaKeepProfile
      SetShellVarContext current
      RMDir /r "$APPDATA\Veltriva"
      veltrivaKeepProfile:
    ${endIf}
  ${endIf}
!macroend
