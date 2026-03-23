// file: scriptor/src/main/updater.js
//
// Auto-updater for the Scriptor desktop agent.
//
// How it works:
//   1. On startup (and every 6 hours) we check the private GitHub repo for a
//      new release.  The GH_UPDATE_TOKEN (read-only PAT, contents:read scope)
//      is embedded at build-time so the app can authenticate against the
//      private repo without asking the user for credentials.
//   2. If a newer version is found the installer is downloaded silently in the
//      background.  A tray balloon notification tells the user.
//   3. When the user restarts / quits the app the new version installs
//      automatically.  We also expose a "Restart to Update" tray menu entry.
//
// Release workflow (for the developer):
//   1. Bump version in scriptor/package.json  (e.g. "2.0.1" → "2.0.2")
//   2. Commit + push to main
//   3. git tag v2.0.2 && git push origin v2.0.2
//   4. GitHub Actions builds the installer and creates a GitHub Release
//      automatically.  Users auto-update within 6 hours.

'use strict';

const { autoUpdater } = require('electron-updater');
const { app }         = require('electron');
const log             = require('electron-log');

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours

let _updateReady = false;   // true once an update has been downloaded
let _trayRef     = null;    // set by initUpdater so we can update the menu

// Called from tray.js to let the updater know about the tray instance so it
// can call refreshMenu() after an update is downloaded.
function setTrayRef(tray) {
  _trayRef = tray;
}

function isUpdateReady() {
  return _updateReady;
}

function quitAndInstall() {
  autoUpdater.quitAndInstall(false, true); // isSilent=false, isForceRunAfter=true
}

function initUpdater() {
  // ── Authentication for the private GitHub repo ──────────────────────────
  // The GH_UPDATE_TOKEN is a read-only GitHub PAT (contents:read scope) that
  // was embedded in the binary at build-time via prebuild.js / defaults.js.
  // Without it, electron-updater can't reach the private release assets.
  try {
    const defaults = require('./defaults');
    if (defaults.GH_UPDATE_TOKEN) {
      autoUpdater.requestHeaders = {
        Authorization: `token ${defaults.GH_UPDATE_TOKEN}`,
      };
    }
  } catch (_) {
    // defaults.js not present in dev mode — auto-updater will run without auth
    // (fine for local development, will fail silently for private repos)
  }

  autoUpdater.logger          = log;
  autoUpdater.autoDownload    = true;
  autoUpdater.autoInstallOnAppQuit = true;

  // ── Events ────────────────────────────────────────────────────────────────
  autoUpdater.on('checking-for-update', () => {
    log.info('[Updater] Checking for updates…');
  });

  autoUpdater.on('update-available', (info) => {
    log.info('[Updater] Update available', { version: info.version });
  });

  autoUpdater.on('update-not-available', () => {
    log.info('[Updater] No updates — already on latest');
  });

  autoUpdater.on('download-progress', (p) => {
    log.info('[Updater] Downloading update', {
      percent: p.percent.toFixed(1),
      speed: Math.round(p.bytesPerSecond / 1024) + ' KB/s',
    });
  });

  autoUpdater.on('update-downloaded', (info) => {
    _updateReady = true;
    log.info('[Updater] Update downloaded — will install on next restart', {
      version: info.version,
    });

    // ── Windows balloon + tray menu update ───────────────────────────────
    // Show a balloon notification so the user knows about the pending update.
    // Also rebuild the tray menu so "Restart to Update" becomes visible.
    try {
      if (_trayRef) {
        _trayRef.displayBalloon({
          title:    'Scriptor update ready',
          content:  `Version ${info.version} will be installed on next restart.`,
          iconType: 'info',
        });
      }
      // refreshTray() rebuilds the context menu (which now includes "Restart to Update")
      const { refreshTray } = require('./tray');
      refreshTray();
    } catch (_) {}
  });

  autoUpdater.on('error', (err) => {
    // Log but don't surface to user — update failures are non-critical
    log.warn('[Updater] Update check/download failed (non-critical)', {
      error: err.message,
    });
  });

  // ── Initial check + periodic interval ────────────────────────────────────
  // Delay the first check by 30 seconds so the app fully starts before we
  // make network calls.
  setTimeout(() => {
    autoUpdater.checkForUpdates().catch((err) => {
      log.warn('[Updater] Initial check failed', { error: err.message });
    });
  }, 30 * 1000);

  setInterval(() => {
    autoUpdater.checkForUpdates().catch((err) => {
      log.warn('[Updater] Periodic check failed', { error: err.message });
    });
  }, CHECK_INTERVAL_MS);
}

module.exports = { initUpdater, setTrayRef, isUpdateReady, quitAndInstall };
