// file: scriptor/src/main/watchdog.js
// Registers a Windows scheduled task that relaunches the agent every 1 minute
// if it's not running.
//
// Uses a VBScript wrapper (wscript.exe) to launch PowerShell completely hidden —
// no console window flash. This is the standard production pattern used by
// VS Code, Slack, etc. for background scheduled tasks on Windows.
const { app } = require('electron');
const { execFile } = require('child_process');
const { writeFileSync } = require('fs');
const path = require('path');
const log = require('electron-log');

const TASK_NAME = 'ScriptorWatchdog';

/**
 * Write scripts and register the scheduled task.
 *
 * Files written to %AppData%/scriptor-agent/:
 *   watchdog.ps1      — checks if Scriptor is running, launches if not
 *   watchdog.vbs      — VBScript wrapper that runs ps1 with zero window flash
 *   register-task.ps1 — registers the scheduled task via PowerShell cmdlets
 */
function registerWatchdog() {
  try {
    const exePath = process.execPath;
    const exeName = path.basename(exePath, '.exe');
    const dataDir = app.getPath('userData');
    const ps1Path = path.join(dataDir, 'watchdog.ps1');
    const vbsPath = path.join(dataDir, 'watchdog.vbs');
    const registerPath = path.join(dataDir, 'register-task.ps1');

    // 1. watchdog.ps1 — the actual check-and-relaunch logic
    writeFileSync(ps1Path, [
      `$p = Get-Process -Name '${exeName}' -ErrorAction SilentlyContinue`,
      `if (-not $p) { Start-Process '${exePath}' -ArgumentList '--hidden' -WindowStyle Hidden }`,
    ].join('\r\n'), 'utf-8');

    // 2. watchdog.vbs — launches PowerShell with vbHide (0) = no window at all
    //    wscript.exe is itself windowless, and Run(..., 0) hides the child too
    writeFileSync(vbsPath, [
      `Set sh = CreateObject("WScript.Shell")`,
      `sh.Run "powershell.exe -ExecutionPolicy Bypass -WindowStyle Hidden -File ""${ps1Path}""", 0, False`,
    ].join('\r\n'), 'utf-8');

    // 3. register-task.ps1 — uses PowerShell cmdlets (not schtasks.exe)
    //    Task action points at wscript.exe running the .vbs wrapper
    writeFileSync(registerPath, [
      `Unregister-ScheduledTask -TaskName '${TASK_NAME}' -Confirm:$false -ErrorAction SilentlyContinue`,
      `$action = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument """${vbsPath}"""`,
      `$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 1)`,
      `$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 5)`,
      `Register-ScheduledTask -TaskName '${TASK_NAME}' -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null`,
    ].join('\r\n'), 'utf-8');

    // 4. Execute registration (this one-time PowerShell call runs during app startup
    //    when the Electron window isn't visible yet, so no flash concern here)
    execFile('powershell.exe', [
      '-WindowStyle', 'Hidden',
      '-ExecutionPolicy', 'Bypass',
      '-File', registerPath,
    ], (err, stdout, stderr) => {
      if (err) {
        log.error('[Watchdog] Failed to register scheduled task', { error: err.message, stderr });
      } else {
        log.info('[Watchdog] Scheduled task registered (1-min interval)', { vbsPath });
      }
    });
  } catch (err) {
    log.error('[Watchdog] Error in registerWatchdog', { error: err.message });
  }
}

/**
 * Remove the watchdog scheduled task.
 */
function unregisterWatchdog() {
  try {
    const dataDir = app.getPath('userData');
    const unregisterPath = path.join(dataDir, 'unregister-task.ps1');

    writeFileSync(unregisterPath, [
      `Unregister-ScheduledTask -TaskName '${TASK_NAME}' -Confirm:$false -ErrorAction SilentlyContinue`,
    ].join('\r\n'), 'utf-8');

    execFile('powershell.exe', [
      '-WindowStyle', 'Hidden',
      '-ExecutionPolicy', 'Bypass',
      '-File', unregisterPath,
    ], (err) => {
      if (err) {
        log.warn('[Watchdog] Failed to remove scheduled task', { error: err.message });
      } else {
        log.info('[Watchdog] Scheduled task removed');
      }
    });
  } catch (err) {
    log.error('[Watchdog] Error in unregisterWatchdog', { error: err.message });
  }
}

module.exports = { registerWatchdog, unregisterWatchdog };
