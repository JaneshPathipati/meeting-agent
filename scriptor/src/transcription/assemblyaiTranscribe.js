// file: scriptor/src/transcription/assemblyaiTranscribe.js
// Transcription + speaker diarization via AssemblyAI API.
//
// NEW ARCHITECTURE (Layer 6):
//   Stereo path (both mic + system available):
//     1. Create stereo WAV: left channel = mic (local user), right channel = system audio (remote)
//     2. Upload stereo WAV to AssemblyAI
//     3. Request transcription with multichannel=true (channel per speaker, most accurate)
//     4. Poll until complete
//     5. Map speakers using known_values from pre-meeting enrichment (Layer 8)
//     6. Return transcript JSON
//
//   Mono fallback (single source):
//     1. Convert to 16kHz mono WAV
//     2. Upload to AssemblyAI
//     3. Request with speaker_labels=true, min/max_speakers_expected (attendeeCount + 2)
//     4. Poll until complete
//     5. Apply speaker identification via known_values
//     6. Return transcript JSON
//
// Changes from previous architecture:
//   - universal-3-pro as primary, universal-2 as fallback
//   - speakers_expected (integer hint) instead of exact count
//   - known_values passed for speaker identification
//   - Mic fingerprint transcription REMOVED (no longer needed with known_values)
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

/**
 * Measure the mean and max volume of an audio file using ffmpeg volumedetect.
 * Returns { meanDb, maxDb } in dBFS (negative numbers; 0 = full scale).
 * Returns { meanDb: -999, maxDb: -999 } on error.
 *
 * Use this to decide whether the system audio contains detectable speech or
 * only ambient noise.  Typical values:
 *   Silence / noise floor  : meanDb < -55
 *   Quiet speech (far-field): meanDb -40 to -55
 *   Normal speech           : meanDb -20 to -40
 */
function measureAudioEnergy(audioPath) {
  try {
    const { spawnSync } = require('child_process');
    const r = spawnSync(getFfmpegPath(), [
      '-i', audioPath,
      '-af', 'volumedetect',
      '-f', 'null', 'NUL',
    ], { timeout: 30000, windowsHide: true });
    const out = (r.stderr || '').toString();
    const meanMatch = out.match(/mean_volume:\s*([-\d.]+)\s*dB/);
    const maxMatch  = out.match(/max_volume:\s*([-\d.]+)\s*dB/);
    return {
      meanDb: meanMatch ? parseFloat(meanMatch[1]) : -999,
      maxDb:  maxMatch  ? parseFloat(maxMatch[1])  : -999,
    };
  } catch (_) {
    return { meanDb: -999, maxDb: -999 };
  }
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
      timeout: isUpload ? 600000 : 300000, // 10 min for uploads (large files), 5 min for other requests
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        try {
          const data = JSON.parse(raw);
          if (res.statusCode >= 400) {
            const errMsg = data.error || data.message || raw.slice(0, 400);
            log.error('[AssemblyAI] API error HTTP ' + res.statusCode + ': ' + errMsg);
            return reject(new Error('AssemblyAI HTTP ' + res.statusCode + ': ' + errMsg));
          }
          resolve(data);
        } catch (e) {
          log.error('[AssemblyAI] Response parse error', { raw: raw.slice(0, 200) });
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
  log.info('[AssemblyAI] Uploading audio', { sizeKB: Math.round(audioData.length / 1024) });
  const result = await apiRequest('POST', ASSEMBLYAI_UPLOAD_URL, apiKey, audioData, true);
  log.info('[AssemblyAI] Upload complete', { url: result.upload_url });
  return result.upload_url;
}

/**
 * Request transcription with speaker identification.
 *
 * @param {string}  uploadUrl   - AssemblyAI upload URL
 * @param {string}  apiKey      - API key
 * @param {object}  options
 * @param {boolean} options.multichannel              - Use multichannel mode (stereo input)
 * @param {number}  [options.minSpeakersExpected]     - Speaker count hint for mono diarization
 *                                                      (AssemblyAI accepts a single integer; this
 *                                                      is passed as speakers_expected)
 * @param {boolean} [options.useSlamModel]            - Try universal-3-pro first (default: true)
 */
async function requestTranscription(uploadUrl, apiKey, options = {}) {
  const mode = options.multichannel ? 'multichannel' : 'speaker_labels';
  const useSlamModel = options.useSlamModel !== false;

  const body = {
    audio_url: uploadUrl,
    // Do NOT set language_code — let AssemblyAI auto-detect.
    // Forcing 'en' breaks meetings conducted in Hindi, Tamil, Telugu, or any
    // other language. Universal-3-pro and universal-2 both support multilingual
    // audio and produce accurate transcripts without a language hint.
    format_text: true,
    punctuate: true,
  };

  // Always pass BOTH models as an array so AssemblyAI can pick the best one per language.
  // universal-3-pro alone only supports a limited set of languages (English, Spanish, etc.).
  // When the meeting is in Hindi, Telugu, Tamil, Arabic, or any other of the 99+ languages
  // supported by universal-2, passing a single-element ["universal-3-pro"] causes a hard
  // HTTP 400 error and produces zero transcription output.
  // Passing ["universal-3-pro", "universal-2"] tells AssemblyAI to use pro where it can and
  // fall back to universal-2 for any language pro doesn't support — this is the API-recommended
  // pattern as stated in AssemblyAI's own error message.
  if (useSlamModel) {
    body.speech_models = ['universal-3-pro', 'universal-2'];
  } else {
    body.speech_models = ['universal-2'];
  }

  if (options.multichannel) {
    // Multichannel mode: each audio channel is a separate speaker.
    // Cannot be used together with speaker_labels — they are mutually exclusive.
    body.multichannel = true;
  } else {
    // Mono diarization: AI distinguishes speakers by voice characteristics.
    body.speaker_labels = true;

    // Provide a speaker count hint to guide diarization.
    // AssemblyAI supports speakers_expected as a single integer (not a min/max range).
    // Use minSpeakersExpected as the hint — the model still auto-detects the real count;
    // this is just a starting point (typically 2 for 1-on-1 calls).
    if (options.minSpeakersExpected) {
      body.speakers_expected = options.minSpeakersExpected;
    }
  }

  log.info('[AssemblyAI] Requesting transcription', {
    mode,
    model: body.speech_models?.[0],
    speakerRange: body.speakers_expected ? String(body.speakers_expected) : 'auto',
  });

  try {
    const result = await apiRequest('POST', ASSEMBLYAI_TRANSCRIPT_URL, apiKey, body, false);
    log.info('[AssemblyAI] Transcription job created id=' + result.id + ' status=' + result.status);
    return result.id;
  } catch (err) {
    // If universal-3-pro fails, retry with universal-2
    if (useSlamModel) {
      log.warn('[AssemblyAI] universal-3-pro failed, retrying with universal-2', { error: err.message });
      body.speech_models = ['universal-2'];
      const result = await apiRequest('POST', ASSEMBLYAI_TRANSCRIPT_URL, apiKey, body, false);
      log.info('[AssemblyAI] Transcription job created (fallback) id=' + result.id);
      return result.id;
    }
    throw err;
  }
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
      log.info('[AssemblyAI] Transcription completed', { utterances: (result.utterances || []).length });
      return result;
    }
    if (result.status === 'error') {
      throw new Error(`AssemblyAI processing failed: ${result.error}`);
    }

    log.debug('[AssemblyAI] Polling...', { status: result.status });
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
  }

  throw new Error('AssemblyAI transcription timed out after 10 minutes');
}

/**
 * Prepare audio for AssemblyAI upload.
 *
 * When both mic and system audio are available, produces a 2-channel (stereo) WAV:
 *   - Channel 1 (left)  = mic audio  → local user
 *   - Channel 2 (right) = system audio → remote participant(s)
 * This enables AssemblyAI multichannel mode, which provides the clearest speaker
 * separation and is the recommended approach for real-time diarization accuracy.
 *
 * When only one source is available, falls back to 16kHz mono WAV (speaker_labels mode).
 *
 * @returns {{ outputPath: string, isStereo: boolean }}
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
  let isStereo = false;

  if (micValid && sysValid) {
    // Produce a 2-channel stereo WAV: left=mic (local user), right=system (remote).
    // Each channel is normalised to mono 16kHz independently before merging so
    // volume imbalances between WASAPI loopback and mic don't bleed across channels.
    // The system (right) channel applies dynaudnorm (dynamic loudness normaliser) instead
    // of a fixed volume boost.  dynaudnorm amplifies quiet sections up to 50× while
    // keeping loud sections at their natural level, so faint remote-participant speech
    // that barely registers in the WASAPI loopback is brought up to a detectable level.
    isStereo = true;
    args = [
      '-y',
      '-i', micPath,
      '-i', sysPath,
      '-filter_complex',
      '[0:a]aresample=16000,aformat=channel_layouts=mono,highpass=f=80,lowpass=f=8000[left];' +
      '[1:a]aresample=16000,aformat=channel_layouts=mono,highpass=f=80,lowpass=f=8000,dynaudnorm=g=5:p=0.9:m=50[right];' +
      '[left][right]amerge=inputs=2[out]',
      '-map', '[out]',
      '-ar', '16000', '-ac', '2',
      outputPath,
    ];
    log.info('[AssemblyAI] Preparing stereo WAV (left=mic, right=system) for multichannel transcription');
  } else {
    const inputPath = micValid ? micPath : sysPath;
    const label = micValid ? 'mic' : 'system';
    args = [
      '-y', '-i', inputPath,
      '-af', 'highpass=f=80,lowpass=f=8000',
      '-ar', '16000', '-ac', '1',
      outputPath,
    ];
    log.info(`[AssemblyAI] Single source (${label} only) → mono WAV, will use speaker_labels`);
  }

  const result = spawnSync(ffmpeg, args, { timeout: 120000, windowsHide: true });
  if (result.status !== 0) {
    const stderr = (result.stderr || '').toString().slice(-300);
    throw new Error(`ffmpeg mix failed (code ${result.status}): ${stderr}`);
  }

  const outSize = fs.statSync(outputPath).size;
  log.info('[AssemblyAI] Audio prepared', { sizeKB: Math.round(outSize / 1024), stereo: isStereo });
  return { outputPath, isStereo };
}

/**
 * Main entry: transcribe with AssemblyAI + speaker diarization.
 *
 * @param {string|null} micPath     - Mic audio WAV (user's voice)
 * @param {string|null} sysPath     - System audio WAV (remote participants)
 * @param {string}      userName    - Display name for the mic speaker
 * @param {object}      enrichment  - Pre-meeting enrichment data from Layer 3
 * @param {string[]}    enrichment.knownValues    - Attendee names for speaker identification
 * @param {number}      enrichment.attendeeCount  - Number of attendees
 * @returns {Promise<object>}       - { segments, metadata }
 */
async function transcribeWithAssemblyAI(micPath, sysPath, userName, enrichment = {}) {
  const apiKey = getApiKey();
  if (!apiKey) throw new Error('ASSEMBLYAI_API_KEY not set');

  const { knownValues = [], attendeeCount = 0 } = enrichment;

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
    knownValues: knownValues.length,
    attendeeCount,
  });

  const startMs = Date.now();
  const basePath = micValid ? micPath : sysPath;
  const mixedPath = basePath + '.mixed.wav';

  // Step 0: Measure system audio energy so we can decide whether to attempt
  // multichannel mode.  When Google Meet (or any WebRTC app) renders remote audio
  // through its own audio pipeline rather than the OS WASAPI mixer, the WASAPI
  // loopback records only ambient room noise.  Running a full multichannel
  // transcription in that case wastes ~30–45 s and always falls back anyway.
  // Threshold: if system audio mean is below −55 dBFS it is at noise floor —
  // skip multichannel and proceed directly to speaker_labels on the mic.
  let sysIsNoise = false;
  if (micValid && sysValid) {
    const energy = measureAudioEnergy(sysPath);
    log.info('[AssemblyAI] System audio energy', { meanDb: energy.meanDb, maxDb: energy.maxDb });
    if (energy.meanDb < -55) {
      sysIsNoise = true;
      log.warn('[AssemblyAI] System audio is at noise floor (mean=' + energy.meanDb.toFixed(1) + ' dBFS) — Google Meet WebRTC audio did not go through WASAPI. Skipping multichannel, using speaker_labels on mic directly.');
    }
  }

  try {
    // Step 1: Prepare audio.
    // If system audio is noise only, build a mic-only mono WAV directly so we
    // skip the stereo mix and the multichannel API round-trip.
    const { isStereo } = sysIsNoise
      ? mixAudioForUpload(micPath, null, mixedPath)
      : mixAudioForUpload(micPath, sysPath, mixedPath);

    // Guard against oversized files (AssemblyAI limit: 2 GB)
    const mixedSize = fs.statSync(mixedPath).size;
    if (mixedSize > 2 * 1024 * 1024 * 1024) {
      throw new Error(`Audio file exceeds 2 GB AssemblyAI limit (${Math.round(mixedSize / 1024 / 1024)} MB)`);
    }

    // Step 2: Upload prepared audio to AssemblyAI
    const uploadUrl = await uploadAudio(mixedPath, apiKey);

    let transcriptId;
    let usedMultichannel = false;

    if (isStereo) {
      // ── STEREO PATH ──────────────────────────────────────────────────────────
      // Channel 1 = mic (local user), Channel 2 = system audio (remote).
      // multichannel mode transcribes each channel independently — no voice mixing.
      log.info('[AssemblyAI] Using multichannel mode (stereo: ch1=local, ch2=remote)');
      try {
        transcriptId = await requestTranscription(uploadUrl, apiKey, { multichannel: true });
        usedMultichannel = true;
      } catch (multiErr) {
        // If multichannel is rejected, fall back to speaker_labels on a fresh MONO mix.
        log.warn('[AssemblyAI] Multichannel failed (' + multiErr.message + '), building mono fallback');
        const monoFallbackPath = mixedPath + '.mono.wav';
        try {
          const { spawnSync } = require('child_process');
          const ffmpeg = getFfmpegPath();
          const monoArgs = micValid && sysValid ? [
            '-y', '-i', micPath, '-i', sysPath,
            '-filter_complex', '[0:a][1:a]amix=inputs=2:duration=longest:weights=1.2 0.8,highpass=f=80,lowpass=f=8000',
            '-ar', '16000', '-ac', '1', monoFallbackPath,
          ] : [
            '-y', '-i', micValid ? micPath : sysPath,
            '-af', 'highpass=f=80,lowpass=f=8000',
            '-ar', '16000', '-ac', '1', monoFallbackPath,
          ];
          spawnSync(ffmpeg, monoArgs, { timeout: 120000, windowsHide: true });
          const monoUrl = await uploadAudio(monoFallbackPath, apiKey);
          transcriptId = await requestTranscription(monoUrl, apiKey, {
            multichannel: false,
            minSpeakersExpected: Math.max(2, attendeeCount),
            maxSpeakersExpected: Math.max(4, attendeeCount + 2),
          });
        } finally {
          try { if (fs.existsSync(monoFallbackPath)) fs.unlinkSync(monoFallbackPath); } catch (_) {}
        }
      }
    } else {
      // ── MONO PATH ───────────────────────────────────────────────────────────
      // Only one audio source available; use speaker_labels diarization.
      // Use min/max_speakers_expected from enrichment for better accuracy.
      log.info('[AssemblyAI] Using speaker_labels mode (single source)', {
        minSpeakers: Math.max(2, attendeeCount),
        maxSpeakers: Math.max(4, attendeeCount + 2),
      });
      transcriptId = await requestTranscription(uploadUrl, apiKey, {
        multichannel: false,
        minSpeakersExpected: attendeeCount > 0 ? Math.max(2, attendeeCount) : undefined,
        maxSpeakersExpected: attendeeCount > 0 ? Math.max(4, attendeeCount + 2) : undefined,
      });
    }

    // Step 3: Poll until transcription is complete
    // (Mic fingerprint transcription REMOVED — known_values replaces it)
    let result = await pollTranscription(transcriptId, apiKey);

    // Step 3b: If we used multichannel but the remote channel (ch2) is completely silent OR
    // has very little content (< 25% of total), the system audio loopback either had echo
    // cancellation applied or the WebRTC audio bypassed the WASAPI mixer.  In both cases
    // the majority of the remote participant's voice leaked acoustically into the mic channel
    // and will be wrongly labelled as the local user.
    // Fall back to speaker_labels on the mic audio alone — the mic picks up all voices
    // (local + remote leaking through speakers), and diarization will separate them by voice.
    // ch2ReferenceWords: unique significant words captured exclusively on the system-audio
    // channel (channel 2) in the multichannel result.  These words come only from the remote
    // participant's digital audio and are used after speaker-label diarization to identify
    // which diarized speaker is the remote, without relying on confidence or duration heuristics.
    let ch2ReferenceWords = new Set();

    if (usedMultichannel && micValid) {
      const channelUtterances = result.utterances || [];
      const hasRemoteSpeech = channelUtterances.some(u => String(u.channel) !== '1');
      const hasAnyMicSpeech = channelUtterances.some(u => String(u.channel) === '1');

      // Compute ratio of system-channel words vs total to detect partial bleed
      const micChars = channelUtterances
        .filter(u => String(u.channel) === '1')
        .reduce((s, u) => s + (u.text || '').length, 0);
      const sysChars = channelUtterances
        .filter(u => String(u.channel) !== '1')
        .reduce((s, u) => s + (u.text || '').length, 0);
      const sysRatio = (micChars + sysChars) > 0 ? sysChars / (micChars + sysChars) : 0;
      const remoteUtteranceCount = channelUtterances.filter(u => String(u.channel) !== '1').length;

      // Trigger fallback when:
      //   (a) remote channel is completely silent (echo-cancelled), OR
      //   (b) remote channel is weak (< 25% of total chars) AND remote had ≥ 2 utterances
      //       → an active remote speaker whose voice mostly leaked into the mic channel.
      //       Threshold 25%: if sys captured ≥ 25% the multichannel split is reliable enough.
      const remoteChannelSilent = hasAnyMicSpeech && !hasRemoteSpeech;
      const remoteChannelWeak   = hasAnyMicSpeech && hasRemoteSpeech
                                  && sysRatio < 0.25 && remoteUtteranceCount >= 2;

      if (remoteChannelSilent || remoteChannelWeak) {
        if (remoteChannelSilent) {
          log.warn('[AssemblyAI] Multichannel: remote channel silent — system audio was echo-cancelled. Retrying with speaker_labels on mic.');
        } else {
          log.warn('[AssemblyAI] Multichannel: remote channel weak (' + Math.round(sysRatio * 100) + '% of content, ' + remoteUtteranceCount + ' utterances) — acoustic bleed into mic. Retrying with speaker_labels for better diarization.');
        }

        // Capture channel-2 words BEFORE overwriting result.
        // These words are exclusively the remote participant's voice and will be used
        // after diarization to reliably identify which speaker is the remote participant.
        if (hasRemoteSpeech) {
          const ch2Raw = channelUtterances
            .filter(u => String(u.channel) !== '1')
            .map(u => (u.text || '').toLowerCase())
            .join(' ')
            .replace(/[^a-z0-9\s]/g, ' ');
          ch2ReferenceWords = new Set(ch2Raw.split(/\s+/).filter(w => w.length > 3));
          log.info('[AssemblyAI] Channel-2 reference captured', { wordCount: ch2ReferenceWords.size });
        }

        const monoRetryPath = mixedPath + '.mono.wav';
        try {
          const { spawnSync } = require('child_process');
          // Apply dynaudnorm to normalise loudness across the mic channel.
          // When the remote participant's voice leaks acoustically through the local
          // speakers into the mic, it tends to be quieter than the local user's direct
          // voice.  Normalising levels helps AssemblyAI's diarization model detect and
          // correctly separate the second (quieter) speaker.
          const monoArgs = [
            '-y', '-i', micPath,
            '-af', 'highpass=f=80,lowpass=f=8000,dynaudnorm=g=5:p=0.9:m=30',
            '-ar', '16000', '-ac', '1',
            monoRetryPath,
          ];
          spawnSync(getFfmpegPath(), monoArgs, { timeout: 120000, windowsHide: true });
          const monoUrl = await uploadAudio(monoRetryPath, apiKey);
          // In the echo-cancelled fallback the mic captured all voices together.
          // Use attendeeCount if known; otherwise cap at 4 to avoid over-splitting
          // when names are mentioned in speech (e.g. "Hey Janesh" doesn't mean there
          // are more speakers — AssemblyAI uses acoustic patterns, not text mentions).
          const minSpk = 2;
          const maxSpk = attendeeCount > 0 ? Math.min(attendeeCount + 1, 6) : 4;
          const monoId = await requestTranscription(monoUrl, apiKey, {
            multichannel: false,
            minSpeakersExpected: minSpk,
            maxSpeakersExpected: maxSpk,
          });
          const monoResult = await pollTranscription(monoId, apiKey);
          if ((monoResult.utterances || []).length > 0) {
            result = monoResult;
            transcriptId = monoId;
            usedMultichannel = false;
            log.info('[AssemblyAI] speaker_labels retry succeeded', { utterances: monoResult.utterances.length });
          } else {
            log.warn('[AssemblyAI] speaker_labels retry also empty — keeping multichannel result');
          }
        } catch (retryErr) {
          log.warn('[AssemblyAI] speaker_labels retry failed (non-critical)', { error: retryErr.message });
        } finally {
          try { if (fs.existsSync(monoRetryPath)) fs.unlinkSync(monoRetryPath); } catch (_) {}
        }
      }
    }

    // Step 4: Process utterances
    const utterances = result.utterances || [];
    if (utterances.length === 0) {
      log.warn('[AssemblyAI] No utterances returned');
      return {
        segments: [],
        metadata: {
          source: 'assemblyai',
          model: result.speech_model || result.speech_models?.[0] || 'universal-3-pro',
          mode: usedMultichannel ? 'multichannel' : 'speaker_labels',
          speaker_count: 0,
          speakers: [],
          _assemblyai_id: transcriptId,
        },
      };
    }

    // Step 5: Build speaker name map
    const speakerMap = {};

    if (usedMultichannel) {
      // ── MULTICHANNEL SPEAKER MAPPING ─────────────────────────────────────────
      // Channel "1" = left = mic = local user.
      // Channel "2"+ = right = system audio = remote participant(s).
      let remoteCount = 0;
      const uniqueChannels = [...new Set(utterances.map(u => String(u.channel)))].sort();
      for (const ch of uniqueChannels) {
        if (ch === '1') {
          speakerMap[ch] = speakerName;
        } else {
          remoteCount++;
          speakerMap[ch] = `Remote Participant ${remoteCount}`;
        }
      }
      log.info('[AssemblyAI] Multichannel speaker map:', speakerMap);
    } else {
      // ── MONO DIARIZATION SPEAKER MAPPING ─────────────────────────────────────
      // Three strategies in priority order to identify the local user:
      //
      // 1. CHANNEL-2 REFERENCE OVERLAP (most reliable, only available when falling
      //    back from a weak multichannel result):
      //    The system audio (channel 2) captures exclusively the remote participant's
      //    digital voice.  Even a few words are enough to identify which diarized
      //    speaker is the remote — the speaker with highest word overlap = remote,
      //    the other = local user.  This is immune to confidence/duration bias.
      //
      // 2. CONFIDENCE GAP ≥ 5% (medium reliability):
      //    Direct mic capture produces cleaner audio than room-leaked audio, so the
      //    local user tends to have higher per-word confidence.  Only used when the
      //    gap is large enough to be meaningful.
      //
      // 3. DURATION (last resort):
      //    Least reliable (breaks when local user speaks less), used only when both
      //    other strategies are inconclusive.

      const speakerConfSum  = {};
      const speakerWordCnt  = {};
      const speakerDurations = {};

      for (const utt of utterances) {
        speakerDurations[utt.speaker] = (speakerDurations[utt.speaker] || 0) + (utt.end - utt.start) / 1000;
        if (utt.words && utt.words.length > 0) {
          for (const w of utt.words) {
            speakerConfSum[utt.speaker] = (speakerConfSum[utt.speaker] || 0) + (w.confidence || 0);
            speakerWordCnt[utt.speaker] = (speakerWordCnt[utt.speaker] || 0) + 1;
          }
        }
      }

      const speakerAvgConf = {};
      for (const sp of Object.keys(speakerDurations)) {
        speakerAvgConf[sp] = speakerWordCnt[sp] > 0
          ? speakerConfSum[sp] / speakerWordCnt[sp]
          : 0;
      }

      const sortedByConf     = Object.entries(speakerAvgConf).sort((a, b) => b[1] - a[1]);
      const sortedByDuration = Object.entries(speakerDurations).sort((a, b) => b[1] - a[1]);

      let localSpeakerLabel = null;

      // ── Strategy 1: Channel-2 reference word overlap ──────────────────────────
      // Requires ≥ 5 meaningful reference words from the system-audio channel.
      // Guards against two failure modes:
      //   (a) Zero overlap — no ch2 words appeared in the diarized result (the
      //       diarization uses different word boundaries than multichannel, or the
      //       ch2 words were all filtered as too short).  In this case the "remote"
      //       pick would be arbitrary, so we fall through to confidence.
      //   (b) Tied overlap — both speakers have the same word count.  A tie means we
      //       cannot confidently determine which speaker is remote, so we fall through.
      if (ch2ReferenceWords.size >= 5) {
        const speakerOverlap = {};
        for (const sp of Object.keys(speakerDurations)) {
          const spWords = utterances
            .filter(u => u.speaker === sp)
            .flatMap(u => (u.text || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/))
            .filter(w => w.length > 3);
          speakerOverlap[sp] = spWords.filter(w => ch2ReferenceWords.has(w)).length;
        }
        const sortedByOverlap = Object.entries(speakerOverlap).sort((a, b) => b[1] - a[1]);
        const topOverlap    = sortedByOverlap[0]?.[1] ?? 0;
        const secondOverlap = sortedByOverlap[1]?.[1] ?? 0;
        const remoteSpeaker = sortedByOverlap[0]?.[0];
        const localCandidate = sortedByOverlap.find(([sp]) => sp !== remoteSpeaker)?.[0];

        if (remoteSpeaker && localCandidate && topOverlap > 0 && topOverlap > secondOverlap) {
          localSpeakerLabel = localCandidate;
          log.info('[AssemblyAI] Local user via channel-2 reference overlap', {
            speaker: localSpeakerLabel,
            remoteSpeaker,
            remoteOverlap: topOverlap,
            localOverlap:  secondOverlap,
            refWords: ch2ReferenceWords.size,
          });
        } else {
          log.info('[AssemblyAI] Channel-2 overlap inconclusive (zero or tied), falling through to confidence', {
            topOverlap,
            secondOverlap,
            refWords: ch2ReferenceWords.size,
          });
        }
      }

      // ── Strategy 2: Confidence gap ≥ 5% ──────────────────────────────────────
      if (!localSpeakerLabel && sortedByConf.length > 0 && sortedByConf[0][1] > 0) {
        const topConf    = sortedByConf[0][1];
        const secondConf = sortedByConf.length > 1 ? sortedByConf[1][1] : 0;
        if (topConf - secondConf >= 0.05) {
          localSpeakerLabel = sortedByConf[0][0];
          log.info('[AssemblyAI] Local user via confidence heuristic', {
            speaker: localSpeakerLabel,
            avgConf: topConf.toFixed(3),
            gap: (topConf - secondConf).toFixed(3),
          });
        }
      }

      // ── Strategy 3: Duration (last resort) ────────────────────────────────────
      if (!localSpeakerLabel && sortedByDuration.length > 0) {
        localSpeakerLabel = sortedByDuration[0][0];
        log.info('[AssemblyAI] Local user via duration fallback (confidence gap too small)', {
          speaker: localSpeakerLabel,
          durationSec: sortedByDuration[0][1].toFixed(1),
        });
      }

      const uniqueSpeakers = [...new Set(utterances.map(u => u.speaker))];

      // Edge case: diarization returned only 1 speaker (everyone spoke in unison
      // or the AI couldn't distinguish voices).  Treat the single speaker as the
      // local user — it is safer to label all speech as "you" than to call it
      // all "Remote Participant 1" which would be confusing and wrong.
      if (uniqueSpeakers.length === 1 && !localSpeakerLabel) {
        localSpeakerLabel = uniqueSpeakers[0];
        log.info('[AssemblyAI] Single speaker in diarization result — labelling as local user', {
          speaker: localSpeakerLabel,
        });
      }

      let remoteCount = 0;
      for (const speaker of uniqueSpeakers) {
        if (speaker === localSpeakerLabel) {
          speakerMap[speaker] = speakerName;
        } else {
          remoteCount++;
          speakerMap[speaker] = `Remote Participant ${remoteCount}`;
        }
      }
    }

    // Step 6: Build segments
    let lowConfidenceCount = 0;
    const segments = utterances.map(utt => {
      const mapKey = usedMultichannel ? String(utt.channel) : utt.speaker;

      if (!speakerMap[mapKey]) {
        const idx = Object.keys(speakerMap).length + 1;
        speakerMap[mapKey] = `Remote Participant ${idx}`;
      }

      if (utt.words && utt.words.length > 0) {
        lowConfidenceCount += utt.words.filter(w => w.confidence < 0.5).length;
      }

      return {
        start_time: formatTs(utt.start / 1000),
        end_time: formatTs(utt.end / 1000),
        speaker: speakerMap[mapKey],
        text: utt.text,
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
      mode: usedMultichannel ? 'multichannel' : 'speaker_labels',
      model: result.speech_model || result.speech_models?.[0] || 'universal-3-pro',
    });

    const meta = {
      source: 'assemblyai',
      model: result.speech_model || result.speech_models?.[0] || 'universal-3-pro',
      mode: usedMultichannel ? 'multichannel' : 'speaker_labels',
      speaker_count: speakers.length,
      speakers,
      confidence: overallConfidence,
      low_confidence_words: lowConfidenceCount,
      mic_text_length: segments
        .filter(s => s.speaker === speakerName)
        .reduce((n, s) => n + (s.text || '').length, 0),
      sys_text_length: segments
        .filter(s => s.speaker !== speakerName)
        .reduce((n, s) => n + (s.text || '').length, 0),
      _assemblyai_id: transcriptId,
    };
    if (sysIsNoise) meta.sys_skipped_noise_floor = true;
    return { segments, metadata: meta };
  } finally {
    try { if (fs.existsSync(mixedPath)) fs.unlinkSync(mixedPath); } catch (_) {}
  }
}

module.exports = { transcribeWithAssemblyAI };
