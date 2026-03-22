; installer.nsh — Custom NSIS installer/uninstaller macros
; Called by electron-builder during NSIS packaging
;
; UPGRADE SAFETY GUARANTEE:
;   This macro runs on EVERY install (new install + upgrade).
;   It ensures any previous version — including the old "Meetchamp" product —
;   is fully stopped and cleaned up before new files are written.
;   Users only need the single .exe; no separate clean-install script required.

; Runs after install completes (also runs during upgrades)
!macro customInstall

  ; ── 1. Stop all running agent processes ─────────────────────────────────────
  ; Kill current Scriptor before overwriting files (prevents file-in-use errors)
  nsExec::ExecToLog 'taskkill /f /im "Scriptor.exe" /t'
  ; Kill old "Meetchamp" agent from previous product versions
  nsExec::ExecToLog 'taskkill /f /im "meetchamp.exe" /t'
  nsExec::ExecToLog 'taskkill /f /im "Meetchamp.exe" /t'
  ; Short wait so OS releases file handles before we overwrite them
  Sleep 1500

  ; ── 2. Remove old-version watchdog scheduled tasks ───────────────────────────
  ; Old watchdog tasks would restart the old process after we kill it.
  nsExec::ExecToLog 'schtasks /delete /tn "MeetchampWatchdog" /f'
  nsExec::ExecToLog 'schtasks /delete /tn "meetchampWatchdog" /f'
  nsExec::ExecToLog 'schtasks /delete /tn "ScriptorWatchdog" /f'

  ; ── 3. Remove old auto-start registry entries ────────────────────────────────
  ; Old Meetchamp auto-start keys — replaced by the Scriptor key below.
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "meetchamp"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Meetchamp"

  ; ── 4. Remove old Meetchamp app-data (stale config/tokens from old product) ──
  ; We intentionally keep %APPDATA%\Scriptor so existing users retain their
  ; login session, API keys, and pending upload queue across upgrades.
  ; Only the legacy Meetchamp directories are removed here.
  RMDir /r "$APPDATA\meetchamp"
  RMDir /r "$APPDATA\Meetchamp"
  RMDir /r "$APPDATA\scriptor-agent"

  ; ── 5. Clean up any stale temp audio files from the old product ──────────────
  ; Scriptor writes to %TEMP%\scriptor — safe to wipe leftover .wav/.webm files.
  ; The folder is recreated automatically on next recording start.
  RMDir /r "$TEMP\scriptor"

  ; ── 6. Register new version to auto-start with Windows ──────────────────────
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
