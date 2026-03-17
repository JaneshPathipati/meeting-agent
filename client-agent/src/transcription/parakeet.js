// file: client-agent/src/transcription/parakeet.js
// Transcription orchestrator:
//
//   AssemblyAI API — transcription + speaker diarization
//
// AssemblyAI provides built-in speaker diarization (speaker_labels=true)
// so no external diarization model or cloud server is needed.
'use strict';

const log = require('electron-log');

/**
 * Transcribe meeting audio using AssemblyAI with speaker diarization.
 *
 * @param {string|null} micPath  - Path to mic audio WAV (user's voice)
 * @param {string|null} sysPath  - Path to system audio WAV (remote participants)
 * @param {string}      userName - User's display name for mic speaker label
 * @returns {Promise<object>}    - { segments: [{start_time, end_time, speaker, text}], metadata }
 */
async function transcribeAudio(micPath, sysPath, userName) {
  log.info('[Transcribe] Starting transcription', {
    micPath: micPath || 'none',
    sysPath: sysPath || 'none',
    userName,
  });

  const { transcribeWithAssemblyAI } = require('./assemblyaiTranscribe');
  const result = await transcribeWithAssemblyAI(micPath, sysPath, userName);
  log.info('[Transcribe] AssemblyAI transcription succeeded', {
    segments: result.segments?.length,
    speakers: result.metadata?.speakers?.join(', '),
  });
  return result;
}

module.exports = { transcribeAudio };
