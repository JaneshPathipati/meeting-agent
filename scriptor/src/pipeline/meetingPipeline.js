// file: scriptor/src/pipeline/meetingPipeline.js
// Meeting processing pipeline — replaces parakeet.js + inline logic in meetingDetector.js.
//
// Orchestrates the complete post-meeting pipeline in one place:
//   Layer 5:  Platform-specific transcription routing
//             Teams → try VTT first (free, names resolved), fallback to AssemblyAI
//             Google Meet / others → always AssemblyAI
//   Layer 6:  AssemblyAI transcription (multichannel for stereo, speaker_labels for mono)
//   Layer 8:  Speaker Identification via known_values from pre-meeting enrichment
//   Layer 9:  AI Summary (OpenAI GPT → local HuggingFace fallback)
//   Layer 10: Upload to Supabase + schedule Teams transcript polling
'use strict';

const fs   = require('fs');
const path = require('path');
const log  = require('electron-log');

const { transcribeWithAssemblyAI } = require('../transcription/assemblyaiTranscribe');
const { identifySpeakers } = require('../transcription/speakerIdentification');
const { checkTeamsTranscript, fallbackToLocalTranscript } = require('../transcription/teamsTranscript');
const { uploadMeeting } = require('../api/uploader');
const { generateLocalAI } = require('../ai/localSummary');
const { getConfig } = require('../main/config');

/**
 * Process a completed meeting through the full pipeline.
 *
 * @param {object} ctx - Meeting context snapshot
 * @param {string|null} ctx.effectiveMicPath   - Mic WAV path (null if unavailable)
 * @param {string|null} ctx.effectiveSysPath   - System audio WAV path (null if unavailable)
 * @param {Date}        ctx.meetingStartTime   - When meeting started
 * @param {Date}        ctx.meetingEndTime     - When meeting ended
 * @param {string}      ctx.detectedApp        - App name (e.g., "Microsoft Teams (Chrome)")
 * @param {object|null} ctx.teamsMeetingInfo   - Teams meeting metadata (null for non-Teams)
 * @param {string|null} ctx.earlyMeetingId     - Pre-created meeting row ID
 * @param {object}      ctx.enrichment         - Pre-meeting enrichment data
 * @param {string[]}    ctx.enrichment.knownValues    - Attendee names for speaker identification
 * @param {number}      ctx.enrichment.attendeeCount  - Number of attendees
 * @param {string|null} ctx.enrichment.meetingSubject - Calendar subject
 */
async function processMeeting(ctx) {
  const {
    effectiveMicPath, effectiveSysPath,
    meetingStartTime, meetingEndTime, detectedApp, teamsMeetingInfo,
    earlyMeetingId,
    enrichment = { knownValues: [], attendeeCount: 0, meetingSubject: null },
  } = ctx;

  const isTeams = !!(teamsMeetingInfo);
  const userName = getConfig('userDisplayName') || getConfig('userName') || 'You';

  // ── Layer 5: Platform-specific transcription routing ──────────────────────
  let transcript = null;
  let transcriptSource = 'local';
  let teamsVttUsed = false;

  if (isTeams) {
    // Teams: try VTT transcript first (names already resolved, zero AssemblyAI cost)
    transcript = await tryTeamsVttFirst(ctx);
    if (transcript) {
      teamsVttUsed = true;
      transcriptSource = 'teams';
      log.info('[Pipeline] Using Teams VTT transcript', {
        segments: transcript.segments?.length,
      });
    }
  }

  // If no VTT transcript (non-Teams, or Teams VTT not available), use AssemblyAI
  if (!transcript) {
    log.info('[Pipeline] Starting AssemblyAI transcription', {
      app: detectedApp, isTeams,
      hasMic: !!effectiveMicPath,
      hasSys: !!effectiveSysPath,
      knownValues: enrichment.knownValues.length,
      attendeeCount: enrichment.attendeeCount,
    });

    try {
      // Layer 6: AssemblyAI transcription with enrichment data
      transcript = await transcribeWithAssemblyAI(
        effectiveMicPath, effectiveSysPath, userName, enrichment
      );
      transcriptSource = 'assemblyai';

      // Layer 8: Speaker Identification using known_values
      // Only if we have known_values AND the transcript has generic speaker labels
      if (enrichment.knownValues.length > 0 && transcript.segments?.length > 0) {
        try {
          transcript = await applySpeakerIdentification(transcript, enrichment.knownValues, userName);
        } catch (idErr) {
          log.warn('[Pipeline] Speaker identification failed (non-critical)', { error: idErr.message });
        }
      }
    } catch (transcribeErr) {
      log.error('[Pipeline] AssemblyAI transcription failed', { error: transcribeErr.message });
      // Create empty transcript so meeting still uploads
      transcript = {
        segments: [],
        metadata: { source: 'assemblyai', model: 'failed', speaker_count: 0, speakers: [] },
      };
    }
  }

  // ── Layer 9: AI Summary ───────────────────────────────────────────────────
  log.info('[Pipeline] Starting AI summary + tone analysis');
  let aiData = null;
  try {
    aiData = await generateLocalAI(transcript, userName, earlyMeetingId);
    log.info('[Pipeline] AI complete', {
      category: aiData.category,
      summaryLen: aiData.summary?.length || 0,
      toneAlerts: aiData.toneAlerts?.length || 0,
    });
  } catch (aiErr) {
    log.error('[Pipeline] AI failed (meeting will still upload without summary)', {
      error: aiErr.message,
    });
  }

  // Override structuredJson.participants with actual transcript speakers
  const actualSpeakers = transcript.segments?.length > 0
    ? [...new Set(transcript.segments.map(s => s.speaker).filter(Boolean))]
    : [];
  if (actualSpeakers.length > 0) {
    if (!aiData) aiData = { category: 'general', summary: '', structuredJson: null, toneAlerts: [] };
    if (!aiData.structuredJson) aiData.structuredJson = {};
    aiData.structuredJson.participants = actualSpeakers;
  }
  if (aiData && !aiData.summary?.trim()) {
    aiData.summary = '';
    log.info('[Pipeline] No client-side summary — backend will generate');
  }

  // ── Layer 10: Upload to Supabase ──────────────────────────────────────────
  const meetingData = {
    meetingId: earlyMeetingId,
    userId: getConfig('userProfileId'),
    startTime: meetingStartTime.toISOString(),
    endTime: meetingEndTime.toISOString(),
    detectedApp,
    transcript,
    source: transcriptSource === 'teams' ? 'teams' : 'local',
    teamsMeetingInfo,
    aiData,
  };

  await uploadMeeting(meetingData);

  // ── Schedule deferred Teams transcript polling ────────────────────────────
  // If VTT wasn't available immediately, schedule polling for later availability
  const meetingDurationSec = (meetingEndTime - meetingStartTime) / 1000;
  if (isTeams && !teamsVttUsed && meetingDurationSec >= 120) {
    scheduleTeamsTranscriptCheck(meetingData);
  } else if (isTeams && teamsVttUsed) {
    log.info('[Pipeline] Teams VTT already used — skipping deferred polling');
  }

  return meetingData;
}

/**
 * Try to get Teams VTT transcript immediately after meeting ends.
 * This is a single attempt (no polling) — called synchronously in the pipeline.
 */
async function tryTeamsVttFirst(ctx) {
  const { meetingStartTime, meetingEndTime, earlyMeetingId, enrichment } = ctx;

  if (!earlyMeetingId) return null;

  try {
    const meetingData = {
      meetingId: earlyMeetingId,
      startTime: meetingStartTime.toISOString(),
      endTime: meetingEndTime.toISOString(),
    };

    log.info('[Pipeline] Trying Teams VTT transcript (immediate, before AssemblyAI)');
    const success = await checkTeamsTranscript(meetingData, 0); // attempt 0 = immediate

    if (success) {
      // VTT was found and applied — fetch the stored transcript
      const { getSupabaseClient } = require('../api/supabaseClient');
      const supabase = getSupabaseClient();
      const { data: tx } = await supabase
        .from('transcripts')
        .select('transcript_json')
        .eq('meeting_id', earlyMeetingId)
        .single();

      if (tx && tx.transcript_json && tx.transcript_json.segments?.length > 0) {
        return tx.transcript_json;
      }
    }
  } catch (err) {
    log.warn('[Pipeline] Immediate Teams VTT check failed (will try AssemblyAI)', {
      error: err.message,
    });
  }

  return null;
}

/**
 * Apply Speaker Identification to an AssemblyAI transcript.
 * Uses known_values from pre-meeting enrichment to resolve generic labels
 * (Speaker A, Remote Participant 1) to real names.
 */
async function applySpeakerIdentification(transcript, knownValues, userName) {
  if (!transcript.segments || transcript.segments.length === 0) return transcript;

  const transcriptId = transcript.metadata?._assemblyai_id;

  // If we have an AssemblyAI transcript ID, use the API-based identification
  if (transcriptId) {
    try {
      const defaults = require('../main/defaults.js');
      const apiKey = defaults.ASSEMBLYAI_API_KEY || process.env.ASSEMBLYAI_API_KEY;
      if (apiKey) {
        const { speakerMap, identified } = await identifySpeakers(transcriptId, knownValues, apiKey);
        if (identified) {
          return applyNameMap(transcript, speakerMap, userName);
        }
      }
    } catch (_) { /* fall through to local identification */ }
  }

  // Local fallback: simple name resolution using conversation context
  const speakerMap = buildLocalSpeakerMap(transcript, knownValues, userName);
  if (Object.keys(speakerMap).length > 0) {
    return applyNameMap(transcript, speakerMap, userName);
  }

  return transcript;
}

/**
 * Build a speaker name map using local conversation context analysis.
 * Checks for self-introductions and name mentions in the transcript text.
 */
function buildLocalSpeakerMap(transcript, knownValues, userName) {
  const speakerMap = {};
  const usedNames = new Set([userName]); // Don't remap the local user

  // Group text by speaker
  const speakerTexts = {};
  for (const seg of transcript.segments) {
    if (!speakerTexts[seg.speaker]) speakerTexts[seg.speaker] = '';
    speakerTexts[seg.speaker] += ' ' + seg.text;
  }

  const uniqueSpeakers = Object.keys(speakerTexts)
    .filter(s => s !== userName); // Don't try to identify the local user

  for (const speaker of uniqueSpeakers) {
    const text = speakerTexts[speaker].toLowerCase();

    for (const name of knownValues) {
      if (usedNames.has(name)) continue;
      const firstName = name.toLowerCase().split(/\s+/)[0];
      if (firstName.length < 3) continue; // Skip very short names

      const patterns = [
        `this is ${firstName}`,
        `i'm ${firstName}`,
        `i am ${firstName}`,
        `my name is ${firstName}`,
        `${firstName} here`,
      ];

      if (patterns.some(p => text.includes(p))) {
        speakerMap[speaker] = name;
        usedNames.add(name);
        log.info('[Pipeline] Local speaker ID: identified via self-introduction', {
          speaker, resolvedName: name,
        });
        break;
      }
    }
  }

  return speakerMap;
}

/**
 * Apply a speaker name map to transcript segments.
 */
function applyNameMap(transcript, speakerMap, userName) {
  const updatedSegments = transcript.segments.map(seg => {
    const resolvedName = speakerMap[seg.speaker];
    if (resolvedName && seg.speaker !== userName) {
      return { ...seg, speaker: resolvedName };
    }
    return seg;
  });

  const updatedSpeakers = [...new Set(updatedSegments.map(s => s.speaker))];

  return {
    ...transcript,
    segments: updatedSegments,
    metadata: {
      ...transcript.metadata,
      speakers: updatedSpeakers,
      speaker_identification: {
        method: 'known_values',
        resolved: Object.keys(speakerMap).length,
        total: updatedSpeakers.length,
      },
    },
  };
}

/**
 * Schedule deferred Teams transcript checks.
 * Dynamic delays based on meeting duration.
 */
function scheduleTeamsTranscriptCheck(meetingData) {
  const meetingDurationMs = new Date(meetingData.endTime) - new Date(meetingData.startTime);
  const meetingDurationMin = meetingDurationMs / 60000;

  const totalWindowMin = Math.min(60, Math.max(20, meetingDurationMin * 0.5));
  const numChecks = totalWindowMin <= 20 ? 4 : totalWindowMin <= 40 ? 5 : 6;

  const firstCheckMin = 3;
  const remainingWindowMin = totalWindowMin - firstCheckMin;
  const gapMin = remainingWindowMin / (numChecks - 1);

  const delays = [firstCheckMin * 60 * 1000];
  for (let i = 1; i < numChecks; i++) {
    delays.push(Math.round((firstCheckMin + gapMin * i) * 60 * 1000));
  }

  log.info('[Pipeline] Scheduling Teams transcript checks', {
    meetingDurationMin: Math.round(meetingDurationMin),
    totalWindowMin: Math.round(totalWindowMin),
    attempts: delays.length,
    delaysMin: delays.map(d => Math.round(d / 60000 * 10) / 10),
  });

  let currentAttempt = 0;

  function scheduleNext() {
    if (currentAttempt >= delays.length) return;

    const absoluteDelay = delays[currentAttempt];
    const previousAbsoluteDelay = currentAttempt > 0 ? delays[currentAttempt - 1] : 0;
    const relativeDelay = absoluteDelay - previousAbsoluteDelay;

    setTimeout(async () => {
      currentAttempt++;
      const attempt = currentAttempt;
      const isLastAttempt = attempt === delays.length;

      try {
        log.info('[Pipeline] Teams transcript check attempt', { attempt, of: delays.length });
        const success = await checkTeamsTranscript(meetingData, attempt);

        if (success) {
          log.info('[Pipeline] Teams transcript override succeeded', { attempt });
        } else if (isLastAttempt) {
          log.info('[Pipeline] All Teams transcript checks exhausted, using local');
          await fallbackToLocalTranscript(meetingData);
        } else {
          scheduleNext();
        }
      } catch (err) {
        log.error('[Pipeline] Teams transcript check failed', { attempt, error: err.message });
        if (isLastAttempt) {
          await fallbackToLocalTranscript(meetingData);
        } else {
          scheduleNext();
        }
      }
    }, currentAttempt === 0 ? absoluteDelay : relativeDelay);
  }

  scheduleNext();
}

module.exports = { processMeeting };
