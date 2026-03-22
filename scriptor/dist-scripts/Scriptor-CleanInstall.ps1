# Scriptor Clean Install Script
# Run this BEFORE installing a new version of Scriptor to ensure a completely
# fresh installation — no leftover files, processes, registry entries, or
# scheduled tasks from any previous version (including old "Meetchamp" builds).
#
# Usage:
#   Right-click → Run with PowerShell (or run from an elevated prompt)
#   Place this file in the same folder as "Scriptor Setup x.x.x.exe"

param(
    [switch]$Silent   # Pass -Silent to skip confirmation prompts
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'SilentlyContinue'

# ── Colour helpers ────────────────────────────────────────────────────────────
function Write-Step  { param($msg) Write-Host "  >> $msg" -ForegroundColor Cyan    }
function Write-OK    { param($msg) Write-Host "  OK $msg" -ForegroundColor Green   }
function Write-Warn  { param($msg) Write-Host "  !! $msg" -ForegroundColor Yellow  }
function Write-Title { param($msg) Write-Host "`n$msg" -ForegroundColor White      }

Write-Host ""
Write-Host "================================================" -ForegroundColor Cyan
Write-Host "   Scriptor — Clean Install Helper              " -ForegroundColor Cyan
Write-Host "================================================" -ForegroundColor Cyan
Write-Host ""

if (-not $Silent) {
    Write-Host "This script will:" -ForegroundColor Yellow
    Write-Host "  1. Stop any running Scriptor / Meetchamp processes"
    Write-Host "  2. Uninstall all previous versions"
    Write-Host "  3. Remove leftover files, registry entries, and scheduled tasks"
    Write-Host "  4. Launch the new installer (if found in this folder)"
    Write-Host ""
    $confirm = Read-Host "Continue? (Y/N)"
    if ($confirm -notmatch '^[Yy]') {
        Write-Host "Cancelled." -ForegroundColor Red
        exit 0
    }
}

# ─────────────────────────────────────────────────────────────────────────────
# STEP 1 — Kill running processes
# ─────────────────────────────────────────────────────────────────────────────
Write-Title "Step 1: Stopping running processes..."

$processesToKill = @('Scriptor', 'scriptor', 'meetchamp', 'Meetchamp')
foreach ($proc in $processesToKill) {
    $found = Get-Process -Name $proc -ErrorAction SilentlyContinue
    if ($found) {
        Write-Step "Killing $proc (PID $($found.Id))..."
        Stop-Process -Name $proc -Force -ErrorAction SilentlyContinue
        Start-Sleep -Milliseconds 500
        Write-OK "Stopped $proc"
    }
}

# Also kill via taskkill to ensure child processes are gone
Start-Process -FilePath "taskkill" -ArgumentList '/f /im "Scriptor.exe" /t'   -WindowStyle Hidden -Wait -ErrorAction SilentlyContinue
Start-Process -FilePath "taskkill" -ArgumentList '/f /im "meetchamp.exe" /t'  -WindowStyle Hidden -Wait -ErrorAction SilentlyContinue
Start-Process -FilePath "taskkill" -ArgumentList '/f /im "Meetchamp.exe" /t'  -WindowStyle Hidden -Wait -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2
Write-OK "Process cleanup done"

# ─────────────────────────────────────────────────────────────────────────────
# STEP 2 — Run existing uninstallers
# ─────────────────────────────────────────────────────────────────────────────
Write-Title "Step 2: Uninstalling previous versions..."

# electron-builder perMachine=false installs to %LOCALAPPDATA%\Programs\<ProductName>
$uninstallerPaths = @(
    "$env:LOCALAPPDATA\Programs\Scriptor\Uninstall Scriptor.exe",
    "$env:LOCALAPPDATA\Programs\scriptor\Uninstall scriptor.exe",
    "$env:LOCALAPPDATA\Programs\Meetchamp\Uninstall Meetchamp.exe",
    "$env:LOCALAPPDATA\Programs\meetchamp\Uninstall meetchamp.exe",
    # Some older builds used ProgramFiles
    "$env:ProgramFiles\Scriptor\Uninstall Scriptor.exe",
    "$env:ProgramFiles\Meetchamp\Uninstall Meetchamp.exe"
)

$uninstalledAny = $false
foreach ($path in $uninstallerPaths) {
    if (Test-Path $path) {
        Write-Step "Found uninstaller: $path"
        # /S = silent uninstall for NSIS
        Start-Process -FilePath $path -ArgumentList '/S' -Wait -ErrorAction SilentlyContinue
        Start-Sleep -Seconds 3
        Write-OK "Uninstalled: $path"
        $uninstalledAny = $true
    }
}

if (-not $uninstalledAny) {
    Write-Warn "No previous uninstaller found — may be a first install or already removed"
}

# ─────────────────────────────────────────────────────────────────────────────
# STEP 3 — Remove leftover installation directories
# ─────────────────────────────────────────────────────────────────────────────
Write-Title "Step 3: Removing leftover installation folders..."

$installDirs = @(
    "$env:LOCALAPPDATA\Programs\Scriptor",
    "$env:LOCALAPPDATA\Programs\scriptor",
    "$env:LOCALAPPDATA\Programs\Meetchamp",
    "$env:LOCALAPPDATA\Programs\meetchamp",
    "$env:ProgramFiles\Scriptor",
    "$env:ProgramFiles\Meetchamp"
)

foreach ($dir in $installDirs) {
    if (Test-Path $dir) {
        Write-Step "Removing $dir..."
        Remove-Item -Path $dir -Recurse -Force -ErrorAction SilentlyContinue
        Write-OK "Removed $dir"
    }
}

# ─────────────────────────────────────────────────────────────────────────────
# STEP 4 — Remove user data directories
# ─────────────────────────────────────────────────────────────────────────────
Write-Title "Step 4: Removing app data (config, logs, SQLite queue, tokens)..."

$dataDirs = @(
    "$env:APPDATA\Scriptor",
    "$env:APPDATA\scriptor",
    "$env:APPDATA\scriptor-agent",
    "$env:APPDATA\Meetchamp",
    "$env:APPDATA\meetchamp",
    "$env:LOCALAPPDATA\Scriptor",
    "$env:TEMP\scriptor"
)

foreach ($dir in $dataDirs) {
    if (Test-Path $dir) {
        Write-Step "Removing $dir..."
        Remove-Item -Path $dir -Recurse -Force -ErrorAction SilentlyContinue
        Write-OK "Removed $dir"
    }
}

# ─────────────────────────────────────────────────────────────────────────────
# STEP 5 — Remove registry entries
# ─────────────────────────────────────────────────────────────────────────────
Write-Title "Step 5: Cleaning registry entries..."

$runKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run"
$runEntries = @('Scriptor', 'scriptor', 'Meetchamp', 'meetchamp')
foreach ($entry in $runEntries) {
    if (Get-ItemProperty -Path $runKey -Name $entry -ErrorAction SilentlyContinue) {
        Remove-ItemProperty -Path $runKey -Name $entry -ErrorAction SilentlyContinue
        Write-OK "Removed auto-start entry: $entry"
    }
}

# Remove Uninstall registry keys left by NSIS
$uninstallBases = @(
    "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall",
    "HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall",
    "HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall"
)
$appNames = @('Scriptor', 'scriptor', 'Meetchamp', 'meetchamp', 'scriptor-agent')
foreach ($base in $uninstallBases) {
    if (Test-Path $base) {
        Get-ChildItem $base -ErrorAction SilentlyContinue | ForEach-Object {
            $dispName = (Get-ItemProperty $_.PsPath -Name DisplayName -ErrorAction SilentlyContinue).DisplayName
            if ($appNames -contains $dispName -or ($dispName -match 'scriptor|meetchamp' )) {
                Write-Step "Removing uninstall registry key: $dispName"
                Remove-Item $_.PsPath -Recurse -Force -ErrorAction SilentlyContinue
                Write-OK "Removed: $dispName"
            }
        }
    }
}

# ─────────────────────────────────────────────────────────────────────────────
# STEP 6 — Remove scheduled tasks (watchdog)
# ─────────────────────────────────────────────────────────────────────────────
Write-Title "Step 6: Removing scheduled tasks..."

$tasks = @('ScriptorWatchdog', 'scriptorWatchdog', 'MeetchampWatchdog', 'meetchampWatchdog')
foreach ($task in $tasks) {
    $exists = Get-ScheduledTask -TaskName $task -ErrorAction SilentlyContinue
    if ($exists) {
        Unregister-ScheduledTask -TaskName $task -Confirm:$false -ErrorAction SilentlyContinue
        Write-OK "Removed scheduled task: $task"
    }
}

# ─────────────────────────────────────────────────────────────────────────────
# STEP 7 — Remove Start Menu shortcuts
# ─────────────────────────────────────────────────────────────────────────────
Write-Title "Step 7: Removing Start Menu shortcuts..."

$shortcutDirs = @(
    "$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Scriptor",
    "$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Meetchamp",
    "$env:ProgramData\Microsoft\Windows\Start Menu\Programs\Scriptor",
    "$env:ProgramData\Microsoft\Windows\Start Menu\Programs\Meetchamp"
)
foreach ($dir in $shortcutDirs) {
    if (Test-Path $dir) {
        Remove-Item $dir -Recurse -Force -ErrorAction SilentlyContinue
        Write-OK "Removed shortcut folder: $dir"
    }
}

# ─────────────────────────────────────────────────────────────────────────────
# STEP 8 — Find and launch new installer
# ─────────────────────────────────────────────────────────────────────────────
Write-Title "Step 8: Looking for new installer..."

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$installers = Get-ChildItem -Path $scriptDir -Filter "Scriptor Setup*.exe" |
              Sort-Object LastWriteTime -Descending

if ($installers.Count -gt 0) {
    $latest = $installers[0]
    Write-OK "Found: $($latest.Name)"

    if (-not $Silent) {
        $launch = Read-Host "Launch installer now? (Y/N)"
        if ($launch -match '^[Yy]') {
            Write-Step "Launching $($latest.Name)..."
            Start-Process -FilePath $latest.FullName
        }
    } else {
        Write-Step "Launching $($latest.Name) silently..."
        Start-Process -FilePath $latest.FullName
    }
} else {
    Write-Warn "No 'Scriptor Setup*.exe' found in this folder."
    Write-Warn "Copy the new installer here and run it manually."
}

# ─────────────────────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "================================================" -ForegroundColor Green
Write-Host "   Clean uninstall complete!                    " -ForegroundColor Green
Write-Host "================================================" -ForegroundColor Green
Write-Host ""

if (-not $Silent) {
    Write-Host "Press any key to exit..." -NoNewline
    $null = $Host.UI.RawUI.ReadKey('NoEcho,IncludeKeyDown')
}
