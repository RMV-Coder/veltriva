; Veltriva's NSIS additions (M6.3, ADR-0007). electron-builder includes this file in the
; installer and the uninstaller (electron-builder.yml, nsis.include).
;
; The uninstaller asks whether to remove the profile, %APPDATA%\Veltriva (tabs, history,
; settings, site data). It never asks, and never removes it, when the uninstall is part of an
; update or reinstall (isUpdated) or was started silently (/S): those keep the profile, as
; electron-builder does by default (`--delete-app-data` removes it in a silent uninstall).
;
; `${Silent}` can't tell an interactive uninstall: a one-click uninstaller shows its own
; "Are you sure?", then turns itself silent for the rest (electron-builder's un.onInit). So the
; command line decides, and the question has no /SD default, which would answer it unseen.

!macro customUnInstall
  ${ifNot} ${isUpdated}
    Push $R0
    Push $R1
    ${GetParameters} $R0
    ClearErrors
    ${GetOptions} $R0 "/S" $R1
    ${if} ${Errors}
      MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2|MB_SETFOREGROUND \
        "Also remove your Veltriva data from this computer?$\r$\n$\r$\nThis deletes your tabs, history, settings and site data in $APPDATA\Veltriva. Choose No to keep them for a later install." \
        IDNO veltrivaKeepProfile
      SetShellVarContext current
      RMDir /r "$APPDATA\Veltriva"
      veltrivaKeepProfile:
    ${endIf}
    Pop $R1
    Pop $R0
  ${endIf}
!macroend
