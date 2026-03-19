// file: scriptor/src/main/updater.js
const { autoUpdater } = require('electron-updater');
const log = require('electron-log');

function initUpdater() {
  autoUpdater.logger = log;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('checking-for-update', () => {
    log.info('[Updater] Checking for updates...');
  });

  autoUpdater.on('update-available', (info) => {
    log.info('[Updater] Update available', { version: info.version });
  });

  autoUpdater.on('update-not-available', () => {
    log.info('[Updater] No updates available');
  });

  autoUpdater.on('download-progress', (progress) => {
    log.info('[Updater] Download progress', { percent: progress.percent.toFixed(1) });
  });

  autoUpdater.on('update-downloaded', (info) => {
    log.info('[Updater] Update downloaded, will install on quit', { version: info.version });
  });

  autoUpdater.on('error', (err) => {
    log.error('[Updater] Update error', { error: err.message });
  });

  // Check for updates every 6 hours
  autoUpdater.checkForUpdates().catch((err) => {
    log.error('[Updater] Initial update check failed', { error: err.message });
  });

  setInterval(() => {
    autoUpdater.checkForUpdates().catch((err) => {
      log.error('[Updater] Periodic update check failed', { error: err.message });
    });
  }, 6 * 60 * 60 * 1000);
}

module.exports = { initUpdater };
