// file: client-agent/src/api/uploader.js
const log = require('electron-log');
const { getSupabaseClient } = require('./supabaseClient');
const { enqueue, dequeueAll, markCompleted, markFailed, getRetryableItems, incrementAttempts } = require('../database/queue');
const { getConfig } = require('../main/config');

const MAX_RETRIES = 5;

// Classify upload errors so we can apply appropriate retry delays.
// Permanent errors (file_too_large) are not retried.
function classifyError(err) {
  const msg = (err.message || '').toLowerCase();
  const code = err.code || '';
  const status = err.status || err.statusCode || 0;

  if (code === 'ENOTFOUND' || code === 'ECONNREFUSED' || code === 'ETIMEDOUT' ||
      msg.includes('network') || msg.includes('fetch failed') || msg.includes('socket')) {
    return 'network';
  }
  if (status === 429 || msg.includes('rate limit') || msg.includes('too many requests')) {
    return 'rate_limit';
  }
  if (status >= 500 || msg.includes('server error') || msg.includes('internal error')) {
    return 'server_error';
  }
  if (status === 401 || status === 403 || msg.includes('unauthorized') || msg.includes('jwt expired')) {
    return 'auth';
  }
  if (status === 413 || msg.includes('too large') || msg.includes('exceeds') || msg.includes('size limit')) {
    return 'file_too_large'; // permanent — will not retry
  }
  return 'unknown';
}

// Retry delay sequences (ms) indexed by attempt number (0-based)
const RETRY_DELAYS_BY_TYPE = {
  network:      [30000,  60000,  120000,  300000,  600000],  // 30s → 10m — wait for connectivity
  rate_limit:   [60000, 120000,  300000,  600000,  600000],  // 1m  → 10m — wait for quota reset
  server_error: [30000,  90000,  300000,  600000,  600000],  // 30s → 10m — server recovering
  auth:         [ 5000,  10000,   30000,   60000,  300000],  // 5s  →  5m — fast retry after token refresh
  unknown:      [60000, 300000,  900000, 3600000, 14400000], // 1m  →  4h — conservative default
};

function initUploadQueue() {
  log.info('[Uploader] Upload queue initialized');
}

/**
 * Create a meeting row immediately when recording starts.
 * This makes the meeting visible in the admin dashboard with 'recording' status
 * before the full pipeline (transcription + upload) completes.
 * Returns the meeting ID or null on failure.
 */
async function createMeetingRecord({ userId, startTime, detectedApp, teamsMeetingInfo }) {
  try {
    const supabase = getSupabaseClient();

    // Get user's org_id from profile
    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select('org_id')
      .eq('id', userId)
      .single();

    if (profileError || !profile) {
      log.error('[Uploader] Failed to get profile for early meeting record', { error: profileError?.message });
      return null;
    }

    // Insert meeting with 'recording' status. Use start_time as end_time placeholder
    // (will be updated when recording ends).
    const { data: meeting, error: meetingError } = await supabase
      .from('meetings')
      .insert({
        user_id: userId,
        org_id: profile.org_id,
        start_time: startTime,
        end_time: startTime, // Placeholder — updated when meeting ends
        detected_app: detectedApp,
        teams_meeting_id: teamsMeetingInfo?.meetingId || null,
        teams_join_url: teamsMeetingInfo?.joinUrl || null,
        status: 'recording'
      })
      .select('id')
      .single();

    if (meetingError) {
      log.error('[Uploader] Failed to create early meeting record', { error: meetingError.message });
      return null;
    }

    log.info('[Uploader] Early meeting record created', { meetingId: meeting.id });
    return meeting.id;
  } catch (err) {
    log.error('[Uploader] createMeetingRecord error', { error: err.message });
    return null;
  }
}

async function uploadMeeting(meetingData) {
  try {
    const result = await performUpload(meetingData);
    if (result.success) {
      log.info('[Uploader] Meeting uploaded successfully', { meetingId: result.meetingId });
      meetingData.meetingId = result.meetingId;
      return result;
    }
    throw new Error(result.error || 'Upload failed');
  } catch (err) {
    log.error('[Uploader] Upload failed, queuing for retry', { error: err.message });
    enqueue(meetingData);
    return { success: false, error: err.message };
  }
}

async function performUpload(meetingData) {
  const supabase = getSupabaseClient();

  let meetingId = meetingData.meetingId;

  const aiData = meetingData.aiData || null;

  if (meetingId) {
    // Meeting row was created early (during recording start) — update it
    const meetingUpdate = {
      end_time:         meetingData.endTime,
      detected_app:     meetingData.detectedApp,
      teams_meeting_id: meetingData.teamsMeetingInfo?.meetingId || null,
      teams_join_url:   meetingData.teamsMeetingInfo?.joinUrl   || null,
      // When AI data is pre-generated client-side, mark as 'processed' immediately;
      // the backend trigger will see ai_pregenerated=true and skip OpenAI.
      status: aiData?.summary ? 'processed' : 'uploaded',
    };
    if (aiData?.category) {
      meetingUpdate.detected_category = aiData.category;
    }

    const { error: updateError } = await supabase
      .from('meetings')
      .update(meetingUpdate)
      .eq('id', meetingId);

    if (updateError) {
      throw new Error(`Meeting update failed: ${updateError.message}`);
    }
  } else {
    // No early record — create the meeting row now (fallback for queued retries, etc.)
    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select('org_id')
      .eq('id', meetingData.userId)
      .single();

    if (profileError || !profile) {
      throw new Error(`Profile not found: ${profileError?.message || 'No data'}`);
    }

    const meetingInsert = {
      user_id:          meetingData.userId,
      org_id:           profile.org_id,
      start_time:       meetingData.startTime,
      end_time:         meetingData.endTime,
      detected_app:     meetingData.detectedApp,
      teams_meeting_id: meetingData.teamsMeetingInfo?.meetingId || null,
      teams_join_url:   meetingData.teamsMeetingInfo?.joinUrl   || null,
      status:           'uploaded',
    };
    if (aiData?.category) {
      meetingInsert.detected_category = aiData.category;
    }

    const { data: meeting, error: meetingError } = await supabase
      .from('meetings')
      .insert(meetingInsert)
      .select('id')
      .single();

    if (meetingError) {
      throw new Error(`Meeting insert failed: ${meetingError.message}`);
    }

    meetingId = meeting.id;
  }

  // Check if we have actual transcript content
  const segments = meetingData.transcript?.segments || [];
  const hasSummary = !!(aiData?.summary && aiData.summary.trim());

  // Set ai_pregenerated only when we actually pre-generated an AI summary.
  // When true, the backend trigger skips OpenAI processing (avoids double-processing).
  // Empty-segment meetings (no audio) are NOT marked ai_pregenerated — they are
  // marked 'processed' directly below, which is correct without needing this flag.
  // DB constraint only allows 'local' or 'teams' — map openai-whisper to 'local'
  // The real source is preserved inside transcript_json.metadata.source for the UI badge
  const rawSource = meetingData.source || 'local';
  const dbSource = rawSource === 'teams' ? 'teams' : 'local';

  const { error: transcriptError } = await supabase
    .from('transcripts')
    .insert({
      meeting_id:      meetingId,
      transcript_json: meetingData.transcript,
      source:          dbSource,
      ai_pregenerated: hasSummary,
    });

  if (transcriptError) {
    throw new Error(`Transcript insert failed: ${transcriptError.message}`);
  }

  // If transcript is empty, mark meeting accordingly and skip summary insertion
  if (segments.length === 0) {
    log.warn('[Uploader] Empty transcript — no segments to upload', { meetingId });
    await supabase
      .from('meetings')
      .update({ status: 'processed' })
      .eq('id', meetingId);

    // Update agent heartbeat
    await supabase
      .from('profiles')
      .update({ last_agent_heartbeat: new Date().toISOString() })
      .eq('id', meetingData.userId);

    return { success: true, meetingId };
  }

  // If AI data was pre-generated, insert summary and tone alerts directly
  if (hasSummary) {
    const { error: summaryError } = await supabase
      .from('summaries')
      .insert({
        meeting_id:      meetingId,
        category:        aiData.category    || 'general',
        content:         aiData.summary,
        structured_json: aiData.structuredJson || null,
        is_default:      true,
      });

    if (summaryError) {
      log.warn('[Uploader] Failed to insert pre-generated summary', {
        error: summaryError.message, meetingId,
      });
    } else {
      log.info('[Uploader] Pre-generated summary inserted', { meetingId });
    }

    // Insert tone alerts if any
    if (aiData.toneAlerts && aiData.toneAlerts.length > 0) {
      // Get org_id for tone_alerts FK
      const { data: meetingRow } = await supabase
        .from('meetings')
        .select('org_id')
        .eq('id', meetingId)
        .single();

      const alertRows = aiData.toneAlerts.map(a => ({
        meeting_id:   meetingId,
        org_id:       meetingRow?.org_id || null,
        start_time:   a.start_time   || '00:00:00',
        speaker:      a.speaker      || 'Unknown',
        severity:     ['low', 'medium', 'high'].includes(a.severity) ? a.severity : 'low',
        flagged_text: a.flagged_text || '',
        reason:       a.reason       || '',
      }));

      const { error: alertError } = await supabase
        .from('tone_alerts')
        .upsert(alertRows, { onConflict: 'meeting_id,start_time,speaker', ignoreDuplicates: true });

      if (alertError) {
        log.warn('[Uploader] Failed to insert tone alerts', {
          error: alertError.message, count: alertRows.length,
        });
      } else {
        log.info('[Uploader] Tone alerts inserted', { count: alertRows.length, meetingId });
      }
    }

    // Mark meeting as processed since AI is done
    await supabase
      .from('meetings')
      .update({ status: 'processed' })
      .eq('id', meetingId);
  }

  // Update agent heartbeat
  await supabase
    .from('profiles')
    .update({ last_agent_heartbeat: new Date().toISOString() })
    .eq('id', meetingData.userId);

  // Trigger email sending for pre-generated summaries (non-Teams meetings).
  // Teams meetings defer email until the Teams transcript override check completes.
  const isTeams = !!(meetingData.teamsMeetingInfo);
  if (hasSummary && !isTeams) {
    try {
      const { data: emailResult, error: emailError } = await supabase.rpc('send_deferred_email', {
        p_meeting_id: meetingId,
      });
      if (emailError) {
        log.warn('[Uploader] Email trigger failed (non-critical)', { error: emailError.message, meetingId });
      } else {
        log.info('[Uploader] Email triggered', { meetingId, result: emailResult });
      }
    } catch (emailErr) {
      log.warn('[Uploader] Email trigger error (non-critical)', { error: emailErr.message, meetingId });
    }
  }

  log.info('[Uploader] Meeting uploaded', {
    meetingId,
    aiPregenerated: !!(aiData?.summary),
  });

  return { success: true, meetingId };
}

async function retryQueuedItems() {
  const items = getRetryableItems();

  if (items.length === 0) return;

  log.info('[Uploader] Retrying queued uploads', { count: items.length });

  for (const item of items) {
    try {
      const meetingData = JSON.parse(item.payload);
      const result = await performUpload(meetingData);

      if (result.success) {
        markCompleted(item.id);
        log.info('[Uploader] Queued upload succeeded', { queueId: item.id });
      } else {
        throw new Error(result.error);
      }
    } catch (err) {
      const errorType = classifyError(err);

      // Permanent errors — don't retry, just mark failed immediately
      if (errorType === 'file_too_large') {
        markFailed(item.id, `[${errorType}] ${err.message}`);
        log.error('[Uploader] Queued upload permanently failed (file too large)', {
          queueId: item.id, error: err.message,
        });
        continue;
      }

      const newAttempts = item.attempts + 1;
      if (newAttempts >= MAX_RETRIES) {
        markFailed(item.id, `[${errorType}] ${err.message}`);
        log.error('[Uploader] Queued upload permanently failed (max retries)', {
          queueId: item.id, errorType, error: err.message,
        });
      } else {
        const delays = RETRY_DELAYS_BY_TYPE[errorType] || RETRY_DELAYS_BY_TYPE.unknown;
        const delayMs = delays[newAttempts - 1] || delays[delays.length - 1];
        const nextRetry = new Date(Date.now() + delayMs);
        incrementAttempts(item.id, nextRetry.toISOString());
        log.warn('[Uploader] Queued upload failed, will retry', {
          queueId: item.id, attempt: newAttempts, errorType,
          nextRetry: nextRetry.toISOString(), delayMs,
        });
      }
    }
  }
}

module.exports = { initUploadQueue, uploadMeeting, createMeetingRecord, retryQueuedItems };
