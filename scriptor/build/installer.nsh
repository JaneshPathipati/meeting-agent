; installer.nsh — Custom NSIS installer/uninstaller macros
; Called by electron-builder during NSIS packaging

; Runs after install completes (also runs during upgrades)
!macro customInstall
  ; Kill any running Scriptor processes before overwriting files (prevents file-in-use errors during upgrades)
  nsExec::ExecToLog 'taskkill /f /im "Scriptor.exe" /t'

  ; Kill any old "meetchamp" agent instance still running from a previous version
  ; (old app used a different product name so its process won't match Scriptor.exe)
  nsExec::ExecToLog 'taskkill /f /im "meetchamp.exe" /t'
  nsExec::ExecToLog 'taskkill /f /im "Meetchamp.exe" /t'

  ; Remove old-version watchdog scheduled tasks so they don't restart the old process
  nsExec::ExecToLog 'schtasks /delete /tn "MeetchampWatchdog" /f'
  nsExec::ExecToLog 'schtasks /delete /tn "meetchampWatchdog" /f'

  ; Remove old auto-start registry entries left by previous installs
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "meetchamp"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Meetchamp"

  ; Register app to auto-start with Windows (hidden, no splash)
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Scriptor" '"$INSTDIR\Scriptor.exe" --hidden'
!macroend

; Runs before uninstall
!macro customUnInstall
  ; Remove auto-start registry entry on uninstall
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Scriptor"

  ; Kill any running Scriptor processes before cleanup
  nsExec::ExecToLog 'taskkill /f /im "Scriptor.exe" /t'

  ; Delete ALL user data so reinstall starts completely fresh:
  ;   - Config (login, MSAL tokens, encrypted store)
  ;   - SQLite upload queue
  ;   - Electron cache, logs, local storage
  ;   - Temp audio files

  ; Primary Electron userData (%APPDATA%\Scriptor)
  RMDir /r "$APPDATA\Scriptor"

  ; Legacy/secondary userData (%APPDATA%\scriptor-agent)
  RMDir /r "$APPDATA\scriptor-agent"

  ; Temp audio files
  RMDir /r "$TEMP\scriptor"

  ; Scheduled task (watchdog)
  nsExec::ExecToLog 'schtasks /delete /tn "ScriptorWatchdog" /f'
!macroend
