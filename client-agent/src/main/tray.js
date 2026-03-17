// file: client-agent/src/main/tray.js
const { app, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const { execSync } = require('child_process');
const log = require('electron-log');
const { getConfig } = require('./config');

let tray = null;
let _isRecording = false;
let _recordingPaused = false;
let _recordingStartTime = null;
let _durationInterval = null;

// Emitted by meetingDetector when recording starts/stops
let _onPauseResume = null;

// Disk space cache — refreshed every 5 minutes
let _diskFreeGB = null;
let _diskCheckInterval = null;

/**
 * Returns free disk space in GB on the system drive (Windows only).
 * Uses wmic — no extra npm packages needed.
 */
function refreshDiskSpace() {
  try {
    const systemDrive = (process.env.SystemDrive || 'C:').replace('\\', '');
    const out = execSync(
      `wmic LogicalDisk where "DeviceID='${systemDrive}'" get FreeSpace /value`,
      { timeout: 4000, windowsHide: true }
    ).toString();
    const match = out.match(/FreeSpace=(\d+)/);
    if (match) {
      _diskFreeGB = Math.round((parseInt(match[1], 10) / (1024 ** 3)) * 10) / 10;
      if (_diskFreeGB < 0.5) {
        log.warn(`[Tray] Low disk space: ${_diskFreeGB} GB free`);
      }
    }
  } catch {
    // wmic unavailable (rare) — silently skip
    _diskFreeGB = null;
  }
}

function formatElapsed(startMs) {
  const totalSeconds = Math.floor((Date.now() - startMs) / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  if (hours > 0) return `Recording: ${hours}h ${minutes}m`;
  if (minutes < 1) return 'Recording: <1 min';
  return `Recording: ${minutes} min`;
}

function buildMenu() {
  const profileId = getConfig('userProfileId');
  const isActive = !!profileId;
  const items = [
    { label: 'MeetChamp v1.0', enabled: false },
    { type: 'separator' },
    { label: isActive ? 'Status: Active' : 'Status: Not Active', enabled: false },
  ];

  if (_isRecording) {
    items.push({ type: 'separator' });
    const elapsedLabel = _recordingStartTime
      ? `● ${formatElapsed(_recordingStartTime)}`
      : '● Recording in progress';
    items.push({ label: elapsedLabel, enabled: false });
    if (_onPauseResume) {
      items.push({
        label: _recordingPaused ? 'Resume Recording' : 'Pause Recording',
        click: () => {
          _recordingPaused = !_recordingPaused;
          if (_onPauseResume) _onPauseResume(_recordingPaused);
          refreshTray();
        }
      });
    }
  }

  // Disk space
  if (_diskFreeGB !== null) {
    items.push({ type: 'separator' });
    const diskLabel = _diskFreeGB < 0.5
      ? `⚠ Low disk space: ${_diskFreeGB} GB free`
      : _diskFreeGB < 2
        ? `Disk: ${_diskFreeGB} GB free (low)`
        : `Disk: ${_diskFreeGB} GB free`;
    items.push({ label: diskLabel, enabled: false });
  }

  items.push({ type: 'separator' });
  items.push({
    label: 'Quit',
    click: () => {
      log.info('[Tray] User clicked Quit');
      app.quit();
    }
  });

  return Menu.buildFromTemplate(items);
}

function initTray() {
  try {
    const iconPath = path.join(__dirname, '..', '..', 'assets', 'icon.ico');
    tray = new Tray(nativeImage.createFromPath(iconPath));

    tray.setToolTip('MeetChamp');

    // Initial disk check then refresh every 5 minutes
    refreshDiskSpace();
    _diskCheckInterval = setInterval(() => {
      refreshDiskSpace();
      refreshTray();
    }, 5 * 60 * 1000);

    tray.setContextMenu(buildMenu());

    log.info('[Tray] System tray initialized');
  } catch (err) {
    log.error('[Tray] Failed to initialize tray', { error: err.message });
  }
}

function refreshTray() {
  if (tray) {
    tray.setContextMenu(buildMenu());
  }
}

function destroyTray() {
  if (_durationInterval) {
    clearInterval(_durationInterval);
    _durationInterval = null;
  }
  if (_diskCheckInterval) {
    clearInterval(_diskCheckInterval);
    _diskCheckInterval = null;
  }
  if (tray) {
    tray.destroy();
    tray = null;
  }
}

/**
 * Called by meetingDetector when recording starts or stops.
 * @param {boolean} recording - true when recording is active
 * @param {Function} [onPauseResume] - callback when user clicks Pause/Resume
 */
function setRecordingStatus(recording, onPauseResume) {
  _isRecording = recording;
  _recordingPaused = false;
  _onPauseResume = onPauseResume || null;

  // Clear any existing duration interval
  if (_durationInterval) {
    clearInterval(_durationInterval);
    _durationInterval = null;
  }

  if (recording) {
    _recordingStartTime = Date.now();
    if (tray) tray.setToolTip('MeetChamp — Recording: <1 min');

    // Update tooltip every 60s with elapsed duration
    _durationInterval = setInterval(() => {
      if (tray && _recordingStartTime) {
        tray.setToolTip(`MeetChamp — ${formatElapsed(_recordingStartTime)}`);
      }
    }, 60000);
  } else {
    _recordingStartTime = null;
    if (tray) tray.setToolTip('MeetChamp');
  }

  refreshTray();
}

/**
 * Returns current cached free disk space in GB, or null if unavailable.
 * Call refreshDiskSpace() first to get a fresh reading.
 */
function getDiskFreeGB() {
  return _diskFreeGB;
}

module.exports = { initTray, refreshTray, destroyTray, setRecordingStatus, getDiskFreeGB, refreshDiskSpace };
