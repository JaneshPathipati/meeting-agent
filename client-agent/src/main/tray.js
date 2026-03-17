// file: client-agent/src/main/tray.js
const { app, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const log = require('electron-log');
const { getConfig } = require('./config');

let tray = null;
let _isRecording = false;
let _recordingPaused = false;

// Emitted by meetingDetector when recording starts/stops
let _onPauseResume = null;

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
    items.push({ label: '● Recording in progress', enabled: false });
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
  refreshTray();
  if (tray) {
    tray.setToolTip(recording ? 'MeetChamp — Recording in progress' : 'MeetChamp');
  }
}

module.exports = { initTray, refreshTray, destroyTray, setRecordingStatus };
