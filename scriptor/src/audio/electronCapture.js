// file: scriptor/src/audio/electronCapture.js
// System audio capture using Electron's desktopCapturer (Chromium WASAPI loopback).
//
// Key fixes for reliability:
//   1. desktopCapturer.getSources() called in MAIN process (Electron 17+ requirement)
//   2. setDisplayMediaRequestHandler with audio: 'loopback' (Electron 26+ reliable capture)
//   3. Window positioned OFF-SCREEN but VISIBLE (getDisplayMedia requires user activation)
//   4. User activation simulated via webContents.sendInputEvent (click)
//   5. Renderer console messages forwarded to main log for debugging
//   6. CSP updated to allow mediastream: and blob: sources
'use strict';

const { BrowserWindow, ipcMain, desktopCapturer, app } = require('electron');
const path   = require('path');
const fs     = require('fs');
const { spawn } = require('child_process');
const log    = require('electron-log');

let captureWindow    = null;
let stopResolve      = null;
let stopReject       = null;
let currentWavPath   = null;
let captureDidStart  = false;
let captureDidFail   = false;
const _ipcHandlers   = {};  // Named IPC handler references for clean removal

function getFfmpegPath() {
  if (app.isPackaged) return path.join(process.resourcesPath, 'bin', 'ffmpeg.exe');
  return path.join(__dirname, '..', '..', 'bin', 'ffmpeg.exe');
}

function getPreloadPath() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'app.asar.unpacked',
      'src', 'renderer', 'capturePreload.js');
  }
  return path.join(__dirname, '..', 'renderer', 'capturePreload.js');
}

function getCapturePagePath() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'app.asar.unpacked',
      'src', 'renderer', 'systemCapture.html');
  }
  return path.join(__dirname, '..', 'renderer', 'systemCapture.html');
}

function convertWebmToWav(webmPath, wavPath) {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(webmPath) || fs.statSync(webmPath).size === 0) {
      return reject(new Error('WebM file empty or missing'));
    }
    const ffmpeg = getFfmpegPath();
    const proc = spawn(ffmpeg, ['-y', '-i', webmPath, '-ar', '16000', '-ac', '1', wavPath], { windowsHide: true });
    let stderr = '';
    proc.stderr.on('data', d => { stderr += d.toString(); });
    proc.on('close', code => {
      try { fs.unlinkSync(webmPath); } catch (_) {}
      if (code === 0) {
        const wavSize = fs.existsSync(wavPath) ? fs.statSync(wavPath).size : 0;
        log.info('[ElectronCapture] WebM → WAV conversion complete', { wavPath, wavSize });
        resolve(wavPath);
      } else {
        reject(new Error(`ffmpeg conversion failed (code ${code}): ${stderr.slice(-300)}`));
      }
    });
    proc.on('error', err => reject(err));
  });
}

function resolveStop(wavPath) {
  const resolve = stopResolve;
  stopResolve = null;
  stopReject  = null;
  if (resolve) {
    resolve(wavPath);
  }
}

function ensureCaptureWindow() {
  if (captureWindow && !captureWindow.isDestroyed()) return;

  captureDidStart = false;
  captureDidFail  = false;

  // Window must be VISIBLE for getDisplayMedia to work (user activation requirement).
  // Position it off-screen so the user doesn't see it.
  captureWindow = new BrowserWindow({
    show:   true,
    x:      -10000,
    y:      -10000,
    width:  100,
    height: 100,
    skipTaskbar:    true,
    focusable:      false,
    transparent:    true,
    frame:          false,
    alwaysOnTop:    false,
    webPreferences: {
      nodeIntegration:  false,
      contextIsolation: true,
      preload: getPreloadPath(),
    },
  });

  // Grant media permissions
  captureWindow.webContents.session.setPermissionRequestHandler(
    (webContents, permission, callback) => {
      if (permission === 'media' || permission === 'display-media' || permission === 'mediaKeySystem') {
        callback(true);
      } else {
        callback(false);
      }
    }
  );

  // Electron 26+: auto-respond to getDisplayMedia with system audio loopback
  try {
    captureWindow.webContents.session.setDisplayMediaRequestHandler(
      (request, callback) => {
        desktopCapturer.getSources({ types: ['screen'] }).then((sources) => {
          if (sources && sources.length > 0) {
            log.info('[ElectronCapture] DisplayMediaHandler: providing loopback audio', { sourceId: sources[0].id });
            callback({ video: sources[0], audio: 'loopback' });
          } else {
            log.warn('[ElectronCapture] DisplayMediaHandler: no screen sources');
            callback({});
          }
        }).catch((err) => {
          log.warn('[ElectronCapture] DisplayMediaHandler error', { error: err.message });
          callback({});
        });
      }
    );
    log.info('[ElectronCapture] setDisplayMediaRequestHandler registered');
  } catch (err) {
    log.warn('[ElectronCapture] setDisplayMediaRequestHandler not available', { error: err.message });
  }

  captureWindow.loadFile(getCapturePagePath());

  // Prevent background throttling
  captureWindow.webContents.setBackgroundThrottling(false);

  // Forward renderer console messages to main log for debugging
  captureWindow.webContents.on('console-message', (_, level, message) => {
    const levels = ['debug', 'info', 'warn', 'error'];
    const levelName = levels[level] || 'info';
    log[levelName]('[ElectronCapture:renderer]', message);
  });

  // Detect renderer crashes — clean up IPC handlers to prevent leaks
  captureWindow.webContents.on('render-process-gone', (_, details) => {
    log.error('[ElectronCapture] Renderer process crashed!', { reason: details.reason });
    captureDidFail = true;
    // Clean up IPC handlers for dead window to prevent listener leaks
    if (_ipcHandlers.writeFile)  ipcMain.removeListener('system-capture-write-file', _ipcHandlers.writeFile);
    if (_ipcHandlers.started)    ipcMain.removeListener('system-capture-started', _ipcHandlers.started);
    if (_ipcHandlers.stopped)    ipcMain.removeListener('system-capture-stopped', _ipcHandlers.stopped);
    if (_ipcHandlers.error)      ipcMain.removeListener('system-capture-error', _ipcHandlers.error);
    if (currentWavPath) {
      try { fs.writeFileSync(currentWavPath, Buffer.alloc(0)); } catch (_) {}
    }
    resolveStop(currentWavPath);
  });

  captureWindow.on('closed', () => {
    captureWindow = null;
    // Clean up IPC handlers for closed window
    if (_ipcHandlers.writeFile)  ipcMain.removeListener('system-capture-write-file', _ipcHandlers.writeFile);
    if (_ipcHandlers.started)    ipcMain.removeListener('system-capture-started', _ipcHandlers.started);
    if (_ipcHandlers.stopped)    ipcMain.removeListener('system-capture-stopped', _ipcHandlers.stopped);
    if (_ipcHandlers.error)      ipcMain.removeListener('system-capture-error', _ipcHandlers.error);
  });

  // IPC handlers — remove previous listeners by reference (not removeAllListeners)
  // to avoid accidentally removing listeners registered by other modules.
  if (_ipcHandlers.writeFile)  ipcMain.removeListener('system-capture-write-file', _ipcHandlers.writeFile);
  if (_ipcHandlers.started)    ipcMain.removeListener('system-capture-started', _ipcHandlers.started);
  if (_ipcHandlers.stopped)    ipcMain.removeListener('system-capture-stopped', _ipcHandlers.stopped);
  if (_ipcHandlers.error)      ipcMain.removeListener('system-capture-error', _ipcHandlers.error);

  // Handle file writes from the sandboxed renderer (fs not available in preload)
  _ipcHandlers.writeFile = (event, filePath, buffer) => {
    try {
      fs.writeFileSync(filePath, Buffer.from(buffer));
      event.returnValue = true;
    } catch (err) {
      log.error('[ElectronCapture] Failed to write capture file', { error: err.message, filePath });
      event.returnValue = false;
    }
  };

  _ipcHandlers.started = () => {
    captureDidStart = true;
    captureDidFail  = false;
    log.info('[ElectronCapture] System audio capture confirmed started ✓');
  };

  _ipcHandlers.stopped = async (_, webmPath) => {
    if (!webmPath) {
      log.warn('[ElectronCapture] Capture produced no audio');
      if (currentWavPath) fs.writeFileSync(currentWavPath, Buffer.alloc(0));
      resolveStop(currentWavPath);
      return;
    }
    if (!stopResolve) return;
    try {
      await convertWebmToWav(webmPath, currentWavPath);
      resolveStop(currentWavPath);
    } catch (err) {
      log.warn('[ElectronCapture] Conversion failed', { error: err.message });
      fs.writeFileSync(currentWavPath, Buffer.alloc(0));
      resolveStop(currentWavPath);
    }
  };

  _ipcHandlers.error = (_, msg) => {
    log.warn('[ElectronCapture] Capture error from renderer', { msg });
    captureDidFail = true;
    if (currentWavPath) {
      try { fs.writeFileSync(currentWavPath, Buffer.alloc(0)); } catch (_) {}
    }
    resolveStop(currentWavPath);
  };

  ipcMain.on('system-capture-write-file', _ipcHandlers.writeFile);
  ipcMain.on('system-capture-started', _ipcHandlers.started);
  ipcMain.on('system-capture-stopped', _ipcHandlers.stopped);
  ipcMain.on('system-capture-error', _ipcHandlers.error);
}

async function startElectronCapture(wavOutputPath) {
  currentWavPath  = wavOutputPath;
  captureDidStart = false;
  captureDidFail  = false;

  // Get desktop sources in main process
  let sourceId;
  try {
    const sources = await desktopCapturer.getSources({ types: ['screen'] });
    if (!sources || sources.length === 0) {
      throw new Error('No desktop sources found');
    }
    sourceId = sources[0].id;
    log.info('[ElectronCapture] Got desktop source', { sourceId, total: sources.length });
  } catch (err) {
    throw new Error(`desktopCapturer.getSources failed: ${err.message}`);
  }

  return new Promise((resolve, reject) => {
    try {
      ensureCaptureWindow();

      const send = () => {
        // Simulate user activation (click) before sending start command
        // getDisplayMedia requires user gesture in Chromium
        try {
          captureWindow.webContents.sendInputEvent({ type: 'mouseDown', x: 50, y: 50, button: 'left' });
          captureWindow.webContents.sendInputEvent({ type: 'mouseUp', x: 50, y: 50, button: 'left' });
        } catch (e) {
          log.debug('[ElectronCapture] User activation simulation failed (non-critical)', { error: e.message });
        }

        // Small delay to let the click register, then start capture
        setTimeout(() => {
          captureWindow.webContents.send('start-system-capture', wavOutputPath, sourceId);
        }, 200);

        let waited = 0;
        const poll = setInterval(() => {
          waited += 100;
          if (captureDidStart) {
            clearInterval(poll);
            resolve(wavOutputPath);
          } else if (captureDidFail) {
            clearInterval(poll);
            reject(new Error('System audio capture failed in renderer'));
          } else if (waited >= 8000) {
            clearInterval(poll);
            log.warn('[ElectronCapture] No start confirmation in 8s — assuming capture started');
            resolve(wavOutputPath);
          }
        }, 100);
      };

      if (captureWindow.webContents.isLoading()) {
        captureWindow.webContents.once('did-finish-load', send);
      } else {
        send();
      }
    } catch (err) {
      reject(err);
    }
  });
}

function stopElectronCapture() {
  return new Promise((resolve, reject) => {
    if (!captureWindow || captureWindow.isDestroyed()) {
      if (currentWavPath) fs.writeFileSync(currentWavPath, Buffer.alloc(0));
      return resolve(currentWavPath);
    }

    stopResolve = resolve;
    stopReject  = reject;

    captureWindow.webContents.send('stop-system-capture');

    // Safety timeout: if no IPC response in 30s, force resolve.
    // The timeout guard (stopResolve check) prevents double-resolution
    // when the IPC arrives after the timeout fires.
    setTimeout(() => {
      if (stopResolve) {
        log.warn('[ElectronCapture] Stop timeout — no response from renderer in 30s');
        if (currentWavPath) {
          try { fs.writeFileSync(currentWavPath, Buffer.alloc(0)); } catch (_) {}
        }
        resolveStop(currentWavPath);
      }
    }, 30000);
  });
}

module.exports = { startElectronCapture, stopElectronCapture };
