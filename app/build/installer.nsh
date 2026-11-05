; Included by electron-builder's NSIS script (`nsis.include` in electron-builder.json). Spec: Uninstall and data, Writing the PATH entry.
;
; The uninstaller removes the program only. The data root stays, as with most apps, so a reinstall resumes; Remove all data (settings, Computer) is the full removal, and the PM guide says to use it
; before uninstalling. What the uninstaller does beyond the program:
;   1. `--stop-stack`: the installed app runs the stop sequence and exits (the stack is not left running from files that are about to go). electron-builder's uninstaller has closed a running app
;      before this point, which skips the app's quit handler, so this call is what stops the stack. It runs on an update too: the app stopped the stack for the update already, and a second
;      stop finds nothing to do.
;   2. `--remove-user-path`: the app removes its one user PATH entry (`<root>\tools\shims`) through the same module that wrote it, which keeps the registry type and every other entry. This is
;      guarded by `isUpdated`: electron-builder runs the old uninstaller during every update, and an unguarded removal would drop the entry at each update until a Repair puts it back.
; Both calls need the installed program, so they run only when it is still there. ExecWait waits for each to end; their exit codes are not acted on, since an uninstall must finish.

!macro customUnInstall
  ${if} ${FileExists} "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
    DetailPrint "Stopping Straw Boss"
    ExecWait '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --stop-stack' $0
    ${ifNot} ${isUpdated}
      DetailPrint "Removing Straw Boss from the PATH"
      ExecWait '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --remove-user-path' $1
    ${endIf}
  ${endIf}
!macroend
