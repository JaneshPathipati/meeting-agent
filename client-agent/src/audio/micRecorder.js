// file: client-agent/src/audio/micRecorder.js
const { spawn, spawnSync } = require('child_process');
const path = require('path');
const log = require('electron-log');
const { app } = require('electron');

let ffmpegProcess = null;

function getFfmpegPath() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'bin', 'ffmpeg.exe');
  }
  return path.join(__dirname, '..', '..', 'bin', 'ffmpeg.exe');
}

function getWindowsDefaultMic() {
  try {
    // Query PowerShell for the default recording device name
    const result = spawnSync('powershell', [
      '-NoProfile', '-Command',
      `Add-Type -AssemblyName System.Windows.Forms;` +
      `[System.Reflection.Assembly]::LoadWithPartialName('Microsoft.Multimedia') | Out-Null;` +
      `Get-CimInstance -Namespace 'root/cimv2' -ClassName Win32_SoundDevice | ` +
      `Where-Object { $_.Status -eq 'OK' -and $_.Name -match 'Microphone|USB|Bluetooth|Headset' } | ` +
      `Select-Object -ExpandProperty Name`
    ], { encoding: 'utf8', timeout: 5000, windowsHide: true });
    const devices = (result.stdout || '').trim().split('\n').map(d => d.trim()).filter(Boolean);
    if (devices.length > 0) {
      log.info('[MicRecorder] Windows mic devices from CIM', { devices });
    }
    return null; // CIM doesn't give us the dshow name, so we use it only for logging
  } catch (err) {
    return null;
  }
}

function getDefaultMicName(ffmpegPath) {
  try {
    // ffmpeg -list_devices always exits non-zero, but stderr has the device list
    const result = spawnSync(ffmpegPath, [
      '-list_devices', 'true', '-f', 'dshow', '-i', 'dummy'
    ], { encoding: 'utf8', timeout: 10000, windowsHide: true });

    const stderr = (result.stderr || '') + (result.stdout || '');
    log.info('[MicRecorder] Device list output length', { len: stderr.length });

    const audioLines = [];
    for (const line of stderr.split('\n')) {
      // Match lines like: [dshow @ ...] "Microphone (Realtek(R) Audio)" (audio)
      if (line.includes('(audio)') && !line.includes('Alternative name')) {
        const match = line.match(/"([^"]+)"/);
        if (match) {
          audioLines.push(match[1]);
        }
      }
    }
    if (audioLines.length === 0) {
      log.warn('[MicRecorder] No audio devices found in ffmpeg output');
      return null;
    }

    log.info('[MicRecorder] Found audio devices', { devices: audioLines });

    // Prefer headset/USB/Bluetooth mic when connected (covers headphone users).
    // Windows sets the headset as default recording device when plugged in,
    // but ffmpeg dshow list order doesn't always match Windows' default order.
    const headsetMic = audioLines.find(d =>
      /headset|headphone|bluetooth|earphone|jabra|bose|sony|airpod|galaxy|logitech/i.test(d)
    );
    if (headsetMic) {
      log.info('[MicRecorder] Headset mic detected — using it as priority device', { headsetMic });
      return headsetMic;
    }

    // Fallback: first audio device (usually built-in mic or Windows default)
    return audioLines[0];
  } catch (err) {
    log.error('[MicRecorder] Device detection failed', { error: err.message });
    return null;
  }
}

async function startMicRecording(outputPath) {
  const ffmpegPath = getFfmpegPath();
  log.info('[MicRecorder] Starting mic recording via ffmpeg', { outputPath });

  // Re-detect mic each recording to handle device connect/disconnect between meetings
  const micName = getDefaultMicName(ffmpegPath);
  if (!micName) {
    log.error('[MicRecorder] No microphone device found');
    throw new Error('No microphone device found');
  }
  log.info('[MicRecorder] Using mic device', { micName });

  return new Promise((resolve, reject) => {
    ffmpegProcess = spawn(ffmpegPath, [
      '-f', 'dshow',
      '-i', `audio=${micName}`,
      '-af', 'highpass=f=80,volume=2.0',
      '-ar', '16000',
      '-ac', '1',
      '-y',
      outputPath
    ], { windowsHide: true });

    ffmpegProcess.stderr.on('data', (data) => {
      log.debug('[MicRecorder] ffmpeg:', data.toString().trim());
    });

    ffmpegProcess.on('error', (err) => {
      log.error('[MicRecorder] ffmpeg process error', { error: err.message });
      reject(err);
    });

    ffmpegProcess.on('close', (code) => {
      log.info('[MicRecorder] ffmpeg mic recording exited', { code });
      ffmpegProcess = null;
    });

    // Give ffmpeg a moment to initialize
    setTimeout(() => resolve(outputPath), 1500);
  });
}

/**
 * Stop mic recording and wait for ffmpeg to fully exit.
 * ffmpeg must seek back to byte 0 to write the final WAV header (file size fields).
 * If we read the WAV file before that happens, the header is incomplete and the
 * last seconds of audio are missing. Awaiting exit guarantees the file is complete.
 */
function stopMicRecording() {
  const proc = ffmpegProcess;
  ffmpegProcess = null;

  if (!proc) return Promise.resolve();

  log.info('[MicRecorder] Stopping mic recording — waiting for ffmpeg to finalize WAV');

  return new Promise((resolve) => {
    // Resolve immediately if process already exited
    proc.on('close', () => {
      log.info('[MicRecorder] ffmpeg mic finalized');
      resolve();
    });

    // Safety timeout: if ffmpeg doesn't exit in 8s, give up
    const timeout = setTimeout(() => {
      log.warn('[MicRecorder] ffmpeg stop timeout — forcing kill');
      try { proc.kill('SIGTERM'); } catch (_) {}
      resolve();
    }, 8000);
    proc.on('close', () => clearTimeout(timeout));

    // Graceful stop: 'q' tells ffmpeg to flush buffers and write the WAV header
    try {
      proc.stdin.write('q');
    } catch (err) {
      log.warn('[MicRecorder] Graceful stop failed, killing', { error: err.message });
      try { proc.kill('SIGTERM'); } catch (_) {}
    }
  });
}

module.exports = { startMicRecording, stopMicRecording };
