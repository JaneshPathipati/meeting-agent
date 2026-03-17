// file: client-agent/src/audio/mixer.js
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const log = require('electron-log');
const { app } = require('electron');

function getFfmpegPath() {
  const isPackaged = app.isPackaged;
  if (isPackaged) {
    return path.join(process.resourcesPath, 'bin', 'ffmpeg.exe');
  }
  return path.join(__dirname, '..', '..', 'bin', 'ffmpeg.exe');
}

/**
 * Calculate a dynamic ffmpeg timeout based on total input file size.
 * Rule of thumb: ~3s per MB of input, minimum 5 minutes, max 60 minutes.
 */
function calcTimeout(totalInputBytes) {
  const mb = totalInputBytes / (1024 * 1024);
  return Math.min(60 * 60 * 1000, Math.max(5 * 60 * 1000, Math.round(mb * 3000)));
}

function mixAudio(micPath, systemPath, outputPath) {
  return new Promise((resolve, reject) => {
    const ffmpegPath = getFfmpegPath();

    // Check if both files exist (handle null/undefined paths)
    const micExists = micPath && fs.existsSync(micPath);
    const sysExists = systemPath && fs.existsSync(systemPath);

    if (!micExists && !sysExists) {
      reject(new Error('No audio files to mix'));
      return;
    }

    // Calculate total input size for dynamic timeout
    let totalInputBytes = 0;
    if (micExists) totalInputBytes += fs.statSync(micPath).size;
    if (sysExists) totalInputBytes += fs.statSync(systemPath).size;
    const inputSizeMB = totalInputBytes / (1024 * 1024);

    // Check for empty/tiny files (< 1 KB = no real audio)
    const micSize = micExists ? fs.statSync(micPath).size : 0;
    const sysSize = sysExists ? fs.statSync(systemPath).size : 0;
    const micValid = micSize > 1024;
    const sysValid = sysSize > 1024;

    if (!micValid && !sysValid) {
      reject(new Error('Both audio files are empty or too small'));
      return;
    }

    let args;

    if (!micValid || !sysValid) {
      // Single source — convert to 16kHz mono.
      // Mic audio is already filtered at recording time (highpass + volume in micRecorder.js).
      // For system audio, apply EQ + volume boost (WASAPI loopback can be quiet).
      const inputPath = micValid ? micPath : systemPath;
      log.info('[Mixer] Only one audio source, converting', { inputPath, sizeMB: inputSizeMB.toFixed(1) });

      if (sysValid && !micValid) {
        // System-only: apply full EQ + volume boost for quiet loopback recordings
        args = [
          '-y', '-i', inputPath,
          '-af', 'highpass=f=80,lowpass=f=8000,volume=2.0',
          '-ar', '16000', '-ac', '1',
          outputPath,
        ];
      } else {
        // Mic-only: apply freq filtering only (mic already amplified in micRecorder.js)
        args = [
          '-y', '-i', inputPath,
          '-af', 'highpass=f=80,lowpass=f=8000',
          '-ar', '16000', '-ac', '1',
          outputPath,
        ];
      }
    } else {
      // Both sources available — mix mic (louder) and system audio,
      // then apply frequency EQ. Skip volume boost on the mix to avoid clipping.
      log.info('[Mixer] Mixing mic + system audio', { micPath, systemPath, outputPath, sizeMB: inputSizeMB.toFixed(1) });

      args = [
        '-y',
        '-i', micPath,
        '-i', systemPath,
        '-filter_complex', '[0:a][1:a]amix=inputs=2:duration=longest:weights=1.2 0.8,highpass=f=80,lowpass=f=8000',
        '-ar', '16000',
        '-ac', '1',
        outputPath,
      ];
    }

    const timeoutMs = calcTimeout(totalInputBytes);
    log.info('[Mixer] ffmpeg timeout', { timeoutMs, inputSizeMB: inputSizeMB.toFixed(1) });

    // Use spawn (not execFile) to avoid Node's maxBuffer limit on stderr.
    // ffmpeg writes continuous progress to stderr — for long encodes this can
    // exceed execFile's 1 MB default buffer and kill the process.
    const proc = spawn(ffmpegPath, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });

    // Keep only last 4 KB of stderr for error reporting
    let stderrTail = '';
    proc.stderr.on('data', (chunk) => {
      stderrTail += chunk.toString();
      if (stderrTail.length > 4096) stderrTail = stderrTail.slice(-4096);
    });

    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        proc.kill('SIGKILL');
        reject(new Error(`ffmpeg timed out after ${Math.round(timeoutMs / 1000)}s (input: ${inputSizeMB.toFixed(0)} MB)`));
      }
    }, timeoutMs);

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      if (code === 0) {
        log.info('[Mixer] Audio mixed/converted successfully', { outputPath });
        resolve(outputPath);
      } else {
        log.error('[Mixer] ffmpeg failed', { code, stderr: stderrTail.slice(-1000) });
        reject(new Error('ffmpeg exited with code ' + code + ': ' + stderrTail.slice(-500)));
      }
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      log.error('[Mixer] ffmpeg process error', { error: err.message });
      reject(err);
    });
  });
}

function cleanupAudioFiles(...filePaths) {
  for (const filePath of filePaths) {
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        log.debug('[Mixer] Deleted audio file', { filePath });
      }
    } catch (err) {
      log.error('[Mixer] Failed to delete audio file', { filePath, error: err.message });
    }
  }
}

module.exports = { mixAudio, cleanupAudioFiles };
