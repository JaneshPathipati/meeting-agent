// file: client-agent/src/audio/systemRecorder.js
// System audio capture — records what plays through the speakers (remote participants).
//
// Capture strategy (tried in order):
//   1. Electron desktopCapturer — Chromium WASAPI loopback via hidden BrowserWindow.
//                                  Works on all Windows 10/11 machines without any extra
//                                  settings. Requires desktopCapturer.getSources() to be
//                                  called in the main process (fixed for Electron 17+).
//   2. ffmpeg dshow Stereo Mix  — Only works if user has enabled Stereo Mix in Windows
//                                  Sound settings (disabled by default on most machines).
//   3. Empty WAV file           — Mic-only mode; system audio unavailable.
'use strict';

const { spawnSync, spawn } = require('child_process');
const path = require('path');
const fs   = require('fs');
const log  = require('electron-log');
const { app } = require('electron');
const { startElectronCapture, stopElectronCapture } = require('./electronCapture');

let recordingOutputPath  = null;
let usingElectronCapture = false;
let ffmpegFallbackProcess = null;

function getFfmpegPath() {
  if (app.isPackaged) return path.join(process.resourcesPath, 'bin', 'ffmpeg.exe');
  return path.join(__dirname, '..', '..', 'bin', 'ffmpeg.exe');
}

/** Try to find a Stereo Mix / loopback device via dshow */
function findStereoMixDevice() {
  const ffmpeg = getFfmpegPath();
  const result = spawnSync(ffmpeg, [
    '-list_devices', 'true', '-f', 'dshow', '-i', 'dummy'
  ], { encoding: 'utf8', timeout: 8000, windowsHide: true });

  const output = (result.stderr || '') + (result.stdout || '');
  const audioDevices = [];
  for (const line of output.split('\n')) {
    if (line.includes('(audio)') && !line.includes('Alternative name')) {
      const match = line.match(/"([^"]+)"/);
      if (match) audioDevices.push(match[1]);
    }
  }

  return audioDevices.find(d =>
    /stereo mix|loopback|what u hear|wave out/i.test(d)
  ) || null;
}

/**
 * Start recording system audio.
 */
async function startSystemRecording(outputPath) {
  recordingOutputPath   = outputPath;
  usingElectronCapture  = false;
  ffmpegFallbackProcess = null;

  // ── PRIMARY: Electron desktopCapturer (Chromium WASAPI loopback) ──────────
  // Fixed for Electron 17+: desktopCapturer.getSources() now called in main process
  // and sourceId passed directly to renderer — prevents getUserMedia from hanging.
  try {
    log.info('[SystemRecorder] Starting Electron desktopCapturer (WASAPI loopback)');
    await startElectronCapture(outputPath);
    usingElectronCapture = true;
    log.info('[SystemRecorder] Electron capture started successfully');
    return outputPath;
  } catch (err) {
    log.warn('[SystemRecorder] Electron capture failed, trying dshow Stereo Mix', {
      error: err.message,
    });
  }

  // ── FALLBACK: ffmpeg dshow Stereo Mix ─────────────────────────────────────
  const stereoMix = findStereoMixDevice();
  if (stereoMix) {
    log.info('[SystemRecorder] Using ffmpeg dshow Stereo Mix', { device: stereoMix });
    return new Promise((resolve) => {
      const ffmpeg = getFfmpegPath();
      ffmpegFallbackProcess = spawn(ffmpeg, [
        '-f', 'dshow', '-i', `audio=${stereoMix}`,
        '-ar', '16000', '-ac', '1',
        '-y', outputPath,
      ], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });

      ffmpegFallbackProcess.on('error', (e) => {
        log.warn('[SystemRecorder] dshow fallback error', { error: e.message });
        ffmpegFallbackProcess = null;
        fs.writeFileSync(outputPath, Buffer.alloc(0));
        resolve(outputPath);
      });

      setTimeout(() => resolve(outputPath), 600);
    });
  }

  // ── LAST RESORT: empty file (mic-only mode) ───────────────────────────────
  log.warn('[SystemRecorder] No system audio capture available — mic-only mode');
  log.warn('[SystemRecorder] Tip: If system audio capture keeps failing, enable "Stereo Mix"');
  log.warn('[SystemRecorder]      in Windows Sound → Recording → right-click → Show Disabled Devices');
  fs.writeFileSync(outputPath, Buffer.alloc(0));
  return outputPath;
}

/**
 * Stop recording system audio.
 */
async function stopSystemRecording() {
  if (usingElectronCapture) {
    log.info('[SystemRecorder] Stopping Electron capture');
    try {
      await stopElectronCapture();
    } catch (err) {
      log.warn('[SystemRecorder] Error stopping Electron capture', { error: err.message });
    }
    usingElectronCapture = false;
  }

  if (ffmpegFallbackProcess) {
    log.info('[SystemRecorder] Stopping ffmpeg dshow fallback');
    try {
      if (!ffmpegFallbackProcess.stdin.destroyed) {
        ffmpegFallbackProcess.stdin.write('q');
      }
    } catch (_) {}
    ffmpegFallbackProcess = null;
    await new Promise(r => setTimeout(r, 800));
  }

  if (recordingOutputPath) {
    const size = fs.existsSync(recordingOutputPath)
      ? fs.statSync(recordingOutputPath).size : 0;
    if (size === 0) {
      log.warn('[SystemRecorder] System audio file is empty after recording', {
        path: recordingOutputPath,
      });
    } else {
      log.info('[SystemRecorder] System audio captured', {
        sizeMB: (size / 1024 / 1024).toFixed(2),
        path: recordingOutputPath,
      });
    }
  }

  const p = recordingOutputPath;
  recordingOutputPath = null;
  return p;
}

function getRecordingPath() {
  return recordingOutputPath;
}

module.exports = { startSystemRecording, stopSystemRecording, getRecordingPath };
