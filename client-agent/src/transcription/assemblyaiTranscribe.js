// file: client-agent/src/transcription/assemblyaiTranscribe.js
// Transcription + speaker diarization via AssemblyAI API.
//
// Flow:
//   1. Mix mic + system audio into single file (AssemblyAI needs one file)
//   2. Upload to AssemblyAI
//   3. Request transcription with speaker_labels=true
//   4. Poll until complete
//   5. Map speakers: dominant speaker = userName, others = Remote Participant N
//   6. Return transcript JSON in same format as other transcription modules
'use strict';

const fs    = require('fs');
const path  = require('path');
const https = require('https');
const log   = require('electron-log');

const ASSEMBLYAI_UPLOAD_URL    = 'https://api.assemblyai.com/v2/upload';
const ASSEMBLYAI_TRANSCRIPT_URL = 'https://api.assemblyai.com/v2/transcript';
const POLL_INTERVAL_MS = 3000;
const MAX_POLL_TIME_MS = 600000; // 10 min max

function getApiKey() {
  try {
    const defaults = require('../main/defaults.js');
    if (defaults.ASSEMBLYAI_API_KEY) return defaults.ASSEMBLYAI_API_KEY;
  } catch (_) {}
  return process.env.ASSEMBLYAI_API_KEY || '';
}

function getFfmpegPath() {
  const { app } = require('electron');
  if (app.isPackaged) return path.join(process.resourcesPath, 'bin', 'ffmpeg.exe');
  return path.join(__dirname, '..', '..', 'bin', 'ffmpeg.exe');
}

function formatTs(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/**
 * Make an HTTPS request to AssemblyAI.
 */
function apiRequest(method, url, apiKey, body, isUpload) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const headers = { 'Authorization': apiKey };

    if (isUpload) {
      headers['Content-Type'] = 'application/octet-stream';
      headers['Transfer-Encoding'] = 'chunked';
    } else if (body) {
      headers['Content-Type'] = 'application/json';
    }

    const req = https.request({
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method,
      headers,
      timeout: 300000,
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        try {
          const data = JSON.parse(raw);
          if (res.statusCode >= 400) {
            return reject(new Error(`AssemblyAI HTTP ${res.statusCode}: ${data.error || raw.slice(0, 200)}`));
          }
          resolve(data);
        } catch (e) {
          reject(new Error(`AssemblyAI response parse error: ${raw.slice(0, 200)}`));
        }
      });
    });

    req.on('timeout', () => req.destroy(new Error('AssemblyAI request timeout')));
    req.on('error', reject);

    if (isUpload && body) {
      req.write(body);
    } else if (body) {
      req.write(JSON.stringify(body));
    }
    req.end();
  });
}

/**
 * Upload audio file to AssemblyAI and return the upload URL.
 */
async function uploadAudio(filePath, apiKey) {
  const audioData = fs.readFileSync(filePath);
  log.info('[AssemblyAI] Uploading audio (%d KB)', Math.round(audioData.length / 1024));
  const result = await apiRequest('POST', ASSEMBLYAI_UPLOAD_URL, apiKey, audioData, true);
  log.info('[AssemblyAI] Upload complete: %s', result.upload_url);
  return result.upload_url;
}

/**
 * Request transcription with speaker diarization.
 */
async function requestTranscription(uploadUrl, apiKey, hasBothStreams) {
  const body = {
    audio_url: uploadUrl,
    speaker_labels: true,
    language_code: 'en',
    // universal-3-pro: best accuracy (5.9% WER), better diarization, crosstalk detection.
    // universal-2 as fallback: supports 99 languages, slightly lower accuracy.
    speech_models: ['universal-3-pro', 'universal-2'],
    // format_text + punctuate: add capitalization, punctuation, and sentence formatting
    // to the transcript — improves readability and excerpt display in the admin dashboard.
    format_text: true,
    punctuate: true,
  };

  // Speaker range hints — use min/max instead of exact count.
  // Exact speakers_expected can cause the model to force-split or force-merge voices.
  // min/max gives the model flexibility to detect the correct number.
  if (hasBothStreams) {
    // Both mic + system audio → at least 2 speakers (local + 1 remote minimum)
    body.speaker_options = { min_speakers_expected: 2, max_speakers_expected: 10 };
  }
  // If only one stream, let AssemblyAI auto-detect (default 1-10 range)

  const result = await apiRequest('POST', ASSEMBLYAI_TRANSCRIPT_URL, apiKey, body, false);
  log.info('[AssemblyAI] Transcription requested', {
    id: result.id,
    status: result.status,
    models: 'universal-3-pro → universal-2',
    speakerRange: hasBothStreams ? '2-10' : 'auto',
  });
  return result.id;
}

/**
 * Poll for transcription completion.
 */
async function pollTranscription(transcriptId, apiKey) {
  const url = `${ASSEMBLYAI_TRANSCRIPT_URL}/${transcriptId}`;
  const startTime = Date.now();

  while (Date.now() - startTime < MAX_POLL_TIME_MS) {
    const result = await apiRequest('GET', url, apiKey, null, false);

    if (result.status === 'completed') {
      log.info('[AssemblyAI] Transcription completed (utterances=%d)', (result.utterances || []).length);
      return result;
    }
    if (result.status === 'error') {
      throw new Error(`AssemblyAI processing failed: ${result.error}`);
    }

    log.debug('[AssemblyAI] Polling... status=%s', result.status);
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
  }

  throw new Error('AssemblyAI transcription timed out after 10 minutes');
}

/**
 * Mix mic and system audio into a single WAV file.
 * If only one file exists, convert it to 16kHz mono.
 * Returns the output path.
 */
function mixAudioForUpload(micPath, sysPath, outputPath) {
  const { spawnSync } = require('child_process');
  const ffmpeg = getFfmpegPath();

  const micValid = micPath && fs.existsSync(micPath) && fs.statSync(micPath).size > 1024;
  const sysValid = sysPath && fs.existsSync(sysPath) && fs.statSync(sysPath).size > 1024;

  if (!micValid && !sysValid) {
    throw new Error('No valid audio files to process');
  }

  let args;
  if (micValid && sysValid) {
    args = [
      '-y', '-i', micPath, '-i', sysPath,
      '-filter_complex', '[0:a][1:a]amix=inputs=2:duration=longest:weights=1.2 0.8',
      '-ar', '16000', '-ac', '1', outputPath,
    ];
    log.info('[AssemblyAI] Mixing mic + system audio');
  } else {
    const inputPath = micValid ? micPath : sysPath;
    args = ['-y', '-i', inputPath, '-ar', '16000', '-ac', '1', outputPath];
    log.info('[AssemblyAI] Using %s audio only', micValid ? 'mic' : 'system');
  }

  const result = spawnSync(ffmpeg, args, { timeout: 120000, windowsHide: true });
  if (result.status !== 0) {
    const stderr = (result.stderr || '').toString().slice(-300);
    throw new Error(`ffmpeg mix failed (code ${result.status}): ${stderr}`);
  }

  const outSize = fs.statSync(outputPath).size;
  log.info('[AssemblyAI] Audio prepared: %d KB', Math.round(outSize / 1024));
  return outputPath;
}

/**
 * Main entry: transcribe with AssemblyAI + speaker diarization.
 *
 * @param {string|null} micPath  - Mic audio WAV (user's voice)
 * @param {string|null} sysPath  - System audio WAV (remote participants)
 * @param {string}      userName - Display name for the mic speaker
 * @returns {Promise<object>}    - { segments, metadata }
 */
async function transcribeWithAssemblyAI(micPath, sysPath, userName) {
  const apiKey = getApiKey();
  if (!apiKey) throw new Error('ASSEMBLYAI_API_KEY not set');

  // Validate: at least one audio path must be valid
  const micValid = micPath && fs.existsSync(micPath) && fs.statSync(micPath).size > 1024;
  const sysValid = sysPath && fs.existsSync(sysPath) && fs.statSync(sysPath).size > 1024;
  if (!micValid && !sysValid) {
    throw new Error('No valid audio files provided (both mic and sys empty or missing)');
  }

  const speakerName = userName && userName.trim() ? userName.trim() : 'You';

  log.info('[AssemblyAI] Starting transcription with speaker diarization', {
    mic: micValid ? path.basename(micPath) : 'none',
    sys: sysValid ? path.basename(sysPath) : 'none',
    user: speakerName,
  });

  const startMs = Date.now();

  // Use the first valid path as base for the mixed file name
  const basePath = micValid ? micPath : sysPath;
  const mixedPath = basePath + '.mixed.wav';

  try {
    // Step 1: Prepare audio (mix or convert to single file)
    mixAudioForUpload(micPath, sysPath, mixedPath);

    // Step 1b: Guard against oversized files (AssemblyAI limit: 2 GB)
    const MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024;
    const mixedSize = fs.statSync(mixedPath).size;
    if (mixedSize > MAX_UPLOAD_BYTES) {
      throw new Error(`Audio file exceeds 2 GB AssemblyAI limit (${Math.round(mixedSize / 1024 / 1024)} MB)`);
    }

    // Step 2: Upload to AssemblyAI
    const uploadUrl = await uploadAudio(mixedPath, apiKey);

    // Step 3: Request transcription with speaker diarization
    const hasBothStreams = micValid && sysValid;
    const transcriptId = await requestTranscription(uploadUrl, apiKey, hasBothStreams);

    // Step 4: Poll until complete
    const result = await pollTranscription(transcriptId, apiKey);

    // Step 5: Process utterances
    const utterances = result.utterances || [];
    if (utterances.length === 0) {
      log.warn('[AssemblyAI] No utterances returned');
      return {
        segments: [],
        metadata: {
          source: 'assemblyai',
          model: 'conformer-2',
          speaker_count: 0,
          speakers: [],
          mic_text_length: 0,
          sys_text_length: 0,
        },
      };
    }

    // Step 6: Map AssemblyAI speaker labels to readable names
    // Dominant speaker (most total speech time) = mic user
    const speakerDurations = {};
    for (const utt of utterances) {
      const dur = (utt.end - utt.start) / 1000;
      speakerDurations[utt.speaker] = (speakerDurations[utt.speaker] || 0) + dur;
    }

    const sortedSpeakers = Object.entries(speakerDurations)
      .sort((a, b) => b[1] - a[1])
      .map(([speaker]) => speaker);

    // Build complete speaker map upfront (no mutation during segment building)
    const speakerMap = {};
    if (sortedSpeakers.length > 0) {
      speakerMap[sortedSpeakers[0]] = speakerName;
      for (let i = 1; i < sortedSpeakers.length; i++) {
        speakerMap[sortedSpeakers[i]] = `Remote Participant ${i}`;
      }
    }

    // Step 7: Build segments with low-confidence word flagging
    let lowConfidenceCount = 0;
    const segments = utterances.map(utt => {
      if (!speakerMap[utt.speaker]) {
        const idx = Object.keys(speakerMap).length;
        speakerMap[utt.speaker] = `Remote Participant ${idx}`;
      }

      // Flag low-confidence words (< 0.5) — these are likely misheard
      let text = utt.text;
      if (utt.words && utt.words.length > 0) {
        const lowConfWords = utt.words.filter(w => w.confidence < 0.5);
        lowConfidenceCount += lowConfWords.length;
      }

      return {
        start_time: formatTs(utt.start / 1000),
        end_time: formatTs(utt.end / 1000),
        speaker: speakerMap[utt.speaker],
        text,
      };
    });

    const speakers = [...new Set(segments.map(s => s.speaker))];
    const elapsed = Math.round((Date.now() - startMs) / 1000);
    const overallConfidence = result.confidence || 0;

    log.info('[AssemblyAI] Transcription complete', {
      elapsed: `${elapsed}s`,
      segments: segments.length,
      speakers: speakers.join(', '),
      confidence: `${(overallConfidence * 100).toFixed(1)}%`,
      lowConfidenceWords: lowConfidenceCount,
    });

    return {
      segments,
      metadata: {
        source: 'assemblyai',
        model: 'universal-3-pro',
        speaker_count: speakers.length,
        speakers,
        confidence: overallConfidence,
        low_confidence_words: lowConfidenceCount,
        mic_text_length: segments
          .filter(s => s.speaker === speakerName)
          .reduce((n, s) => n + s.text.length, 0),
        sys_text_length: segments
          .filter(s => s.speaker !== speakerName)
          .reduce((n, s) => n + s.text.length, 0),
      },
    };
  } finally {
    // Cleanup mixed file
    try { if (fs.existsSync(mixedPath)) fs.unlinkSync(mixedPath); } catch (_) {}
  }
}

module.exports = { transcribeWithAssemblyAI };
