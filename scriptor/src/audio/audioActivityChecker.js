// file: scriptor/src/audio/audioActivityChecker.js
// Checks if system audio is actively flowing by reading the tail of the WAV file
// being written by Electron WASAPI capture and computing RMS amplitude.
// This is a read-only operation — no interference with the recording process.
//
// Amplitude notes:
//   - WASAPI loopback capture: max amplitude ~0.05 (low)
//   - Digital silence: RMS = 0
//   - Background noise floor: RMS ~0.0005
//   - Quiet speech: RMS ~0.002-0.01
//   - Normal speech: RMS ~0.01-0.05
//   - Threshold set at 0.001 to catch even quiet/low-amplitude audio

const fs = require('fs');
const log = require('electron-log');

// WAV header is 44 bytes for standard PCM format
const WAV_HEADER_SIZE = 44;
// Read last N bytes from the file (covers ~2-3 seconds at 16kHz stereo 16-bit)
const TAIL_BYTES = 128000; // ~2s of 16kHz stereo 16-bit audio
// RMS threshold: anything above this is considered "audio activity"
// Set very low because WASAPI loopback captures at low amplitude (~0.05 raw max).
// 0.001 catches even quiet speech while filtering out digital silence.
const RMS_THRESHOLD = 0.001;
// Minimum file growth to confirm recording is still active
const MIN_GROWTH_BYTES = 1000;

let _lastFileSize = 0;
let _lastCheckTime = 0;

/**
 * Check if the system audio WAV file has recent audio activity.
 * Uses two checks:
 *   1. File is growing (recording is still active)
 *   2. RMS amplitude of tail samples exceeds threshold (audio is non-silent)
 * Returns true if audio is flowing, false if silent or file too small.
 *
 * @param {string} wavPath - Path to the system audio WAV file being recorded
 * @returns {boolean}
 */
function hasAudioActivity(wavPath) {
  try {
    if (!wavPath || !fs.existsSync(wavPath)) return false;

    const stat = fs.statSync(wavPath);
    const fileSize = stat.size;

    // File too small to have meaningful audio
    if (fileSize < WAV_HEADER_SIZE + 4096) return false;

    // Check 1: Is the file still growing? (confirms recording is active)
    // Capture previous state BEFORE updating, so the first-call guard works correctly.
    const now = Date.now();
    const prevFileSize = _lastFileSize;
    const prevCheckTime = _lastCheckTime;
    const fileGrowing = (fileSize - prevFileSize) > MIN_GROWTH_BYTES;
    _lastFileSize = fileSize;
    _lastCheckTime = now;

    // Only skip RMS check if we have a prior measurement AND file isn't growing.
    // prevCheckTime === 0 on the first call → fall through to RMS check regardless.
    if (!fileGrowing && prevCheckTime > 0) {
      return false;
    }

    // Check 2: RMS amplitude of the tail
    const readStart = Math.max(WAV_HEADER_SIZE, fileSize - TAIL_BYTES);
    const readLength = Math.min(fileSize - readStart, TAIL_BYTES); // Cap to prevent OOM on huge files

    const fd = fs.openSync(wavPath, 'r');
    const buffer = Buffer.alloc(readLength);
    fs.readSync(fd, buffer, 0, readLength, readStart);
    fs.closeSync(fd);

    // Parse as 16-bit signed PCM samples and compute RMS
    const sampleCount = Math.floor(buffer.length / 2);
    if (sampleCount === 0) return false;

    let sumSquares = 0;
    for (let i = 0; i < sampleCount; i++) {
      const sample = buffer.readInt16LE(i * 2) / 32768.0; // Normalize to [-1, 1]
      sumSquares += sample * sample;
    }

    const rms = Math.sqrt(sumSquares / sampleCount);

    return rms > RMS_THRESHOLD;
  } catch (err) {
    // File might be locked momentarily by ffmpeg/capture — this means recording IS active.
    // Returning false here caused false "meeting ended" signals when ffmpeg had the file locked.
    log.debug('[AudioActivity] Check failed (likely file lock — assuming active)', { error: err.message });
    return true; // File locked = recording in progress = audio is active
  }
}

/**
 * Reset internal state. Call when a new recording starts.
 */
function resetAudioActivityState() {
  _lastFileSize = 0;
  _lastCheckTime = 0;
}

module.exports = { hasAudioActivity, resetAudioActivityState };
