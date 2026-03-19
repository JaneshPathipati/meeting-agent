// file: scriptor/src/audio/systemRecorder.js
// System audio capture — records what plays through the speakers (remote participants).
//
// Uses Electron desktopCapturer with audio: 'loopback' via setDisplayMediaRequestHandler.
// This is the officially supported WASAPI loopback path in Electron — the cleanest
// capture method that works on all Windows 10/11 without extra settings.
//
// Fallbacks removed: Stereo Mix (required manual enable) and empty WAV (mic-only mode)
// are no longer used. If Electron capture fails, the error propagates to the pipeline
// which handles mic-only transcription gracefully.
'use strict';

const fs   = require('fs');
const log  = require('electron-log');
const { startElectronCapture, stopElectronCapture } = require('./electronCapture');

let recordingOutputPath  = null;

/**
 * Start recording system audio via Electron desktopCapturer (WASAPI loopback).
 */
async function startSystemRecording(outputPath) {
  recordingOutputPath = outputPath;

  log.info('[SystemRecorder] Starting Electron desktopCapturer (WASAPI loopback)');
  await startElectronCapture(outputPath);
  log.info('[SystemRecorder] Electron capture started successfully');
  return outputPath;
}

/**
 * Stop recording system audio.
 */
async function stopSystemRecording() {
  log.info('[SystemRecorder] Stopping Electron capture');
  try {
    await stopElectronCapture();
  } catch (err) {
    log.warn('[SystemRecorder] Error stopping Electron capture', { error: err.message });
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
