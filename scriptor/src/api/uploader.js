// file: scriptor/src/api/uploader.js
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
let _lastCreatedMeetingKey = '';  // Dedup key: "userId|startTimeMinute"
let _createMeetingLock = false;  // Async mutex — prevents concurrent DB calls

async function createMeetingRecord({ userId, startTime, detectedApp, teamsMeetingInfo }) {
  // ── Async mutex: only one createMeetingRecord call at a time ──
  // Prevents race where two rapid calls both SELECT (finding nothing) then both INSERT.
  if (_createMeetingLock) {
    log.warn('[Uploader] createMeetingRecord already in progress — blocking duplicate', { detectedApp });
    return null;
  }
  _createMeetingLock = true;

  try {
    const supabase = getSupabaseClient();

    // ── In-memory dedup guard ──
    // Use userId + startTime rounded to the minute (ignore app name — a user can't be
    // in two meetings simultaneously, and app name can vary e.g., "Microsoft Teams" vs
    // "Microsoft Teams (Edge)").
    const startMinute = startTime.replace(/:\d{2}\.\d{3}Z$/, '');
    const dedupKey = `${userId}|${startMinute}`;
    if (dedupKey === _lastCreatedMeetingKey) {
      log.warn('[Uploader] Duplicate createMeetingRecord call blocked (in-memory)', { dedupKey });
      return null;
    }

    // ── DB dedup: only reuse a record that is genuinely the same ongoing meeting ────────────
    //
    // Two scenarios where we should reuse an existing record:
    //   (a) status="recording" within ±10 min  — the app was restarted mid-meeting, or the
    //       same meeting was detected twice in quick succession (e.g., Teams desktop → browser).
    //       A wide 10-min window is safe here because a "recording" record must be from the
    //       CURRENT active session; there cannot be two genuinely different concurrent meetings.
    //
    //   (b) status="recording" only — we deliberately do NOT reuse completed/processed/failed
    //       records here.  If a previous meeting ended 5-10 minutes ago and a new, different
    //       meeting is now starting, the ±10 min window would incorrectly match the old record
    //       and merge both meetings into one session.  Back-to-back meetings (e.g., a 3-minute
    //       test call at 12:15 followed by a real call at 12:22) must each get their own record.
    //
    // The in-memory dedupKey guard above already handles the sub-minute duplicate case.
    const startDate = new Date(startTime);
    const windowStart = new Date(startDate.getTime() - 10 * 60 * 1000).toISOString();
    const windowEnd   = new Date(startDate.getTime() + 10 * 60 * 1000).toISOString();

    // Only look for orphaned "recording" records — never reuse a completed one.
    const { data: recordingOrphans, error: orphanError } = await supabase
      .from('meetings')
      .select('id, detected_app, start_time, duration_seconds')
      .eq('user_id', userId)
      .eq('status', 'recording')
      .gte('start_time', windowStart)
      .lte('start_time', windowEnd)
      .limit(1);

    if (orphanError) {
      log.warn('[Uploader] Dedup query (recording orphans) failed, aborting record creation to prevent duplicate', { error: orphanError.message });
      return null;
    }

    if (recordingOrphans && recordingOrphans.length > 0) {
      log.warn('[Uploader] Found existing "recording" record, reusing (prevents duplicate)', {
        existingId: recordingOrphans[0].id, existingApp: recordingOrphans[0].detected_app, newApp: detectedApp
      });
      _lastCreatedMeetingKey = dedupKey;
      return recordingOrphans[0].id;
    }

    // Do NOT query for non-recording records here.  A completed meeting from 5–10 minutes
    // ago is a different session and must get its own new record.

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

    // ── Post-insert verification: check for duplicates created by a concurrent process ──
    // (e.g., old agent instance still running during an update/reinstall)
    const { data: dupeCheck } = await supabase
      .from('meetings')
      .select('id')
      .eq('user_id', userId)
      .eq('status', 'recording')
      .gte('start_time', windowStart)
      .lte('start_time', windowEnd)
      .order('created_at', { ascending: true });

    if (dupeCheck && dupeCheck.length > 1) {
      // Keep the oldest record (first created), delete the rest
      const keepId = dupeCheck[0].id;
      const dupeIds = dupeCheck.filter(d => d.id !== keepId).map(d => d.id);
      log.warn('[Uploader] Post-insert duplicate detected — cleaning up', { keepId, dupeIds });
      await supabase.from('meetings').delete().in('id', dupeIds);
      _lastCreatedMeetingKey = dedupKey;
      return keepId;
    }

    _lastCreatedMeetingKey = dedupKey;
    log.info('[Uploader] Early meeting record created', { meetingId: meeting.id });
    return meeting.id;
  } catch (err) {
    log.error('[Uploader] createMeetingRecord error', { error: err.message });
    return null;
  } finally {
    _createMeetingLock = false;
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
    // ── Dedup check: abort if another record for the same meeting is already processed ──
    const startDate = new Date(meetingData.startTime);
    const windowStart = new Date(startDate.getTime() - 10 * 60 * 1000).toISOString();
    const windowEnd = new Date(startDate.getTime() + 10 * 60 * 1000).toISOString();
    const { data: alreadyProcessed, error: dedupCheckError } = await supabase
      .from('meetings')
      .select('id')
      .eq('user_id', meetingData.userId)
      .eq('detected_app', meetingData.detectedApp)
      .neq('status', 'recording')
      .neq('id', meetingId)
      .gte('start_time', windowStart)
      .lte('start_time', windowEnd)
      .limit(1);

    if (dedupCheckError) {
      log.warn('[Uploader] Dedup check failed during upload, proceeding with upload', { error: dedupCheckError.message });
    }

    if (alreadyProcessed && alreadyProcessed.length > 0) {
      log.warn('[Uploader] Duplicate detected during upload — another record already processed', {
        duplicateId: meetingId, existingId: alreadyProcessed[0].id
      });
      // Delete the duplicate early record
      await supabase.from('meetings').delete().eq('id', meetingId);
      return { success: true, meetingId: alreadyProcessed[0].id };
    }

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

    // Deduplication guard: check if a meeting with the same user, app, and start_time
    // already exists (within a 5-minute window). Prevents duplicate records when the
    // detector re-triggers for the same meeting after state reset.
    const startTime = new Date(meetingData.startTime);
    const dedupWindowStart = new Date(startTime.getTime() - 10 * 60 * 1000).toISOString();
    const dedupWindowEnd = new Date(startTime.getTime() + 10 * 60 * 1000).toISOString();
    const { data: existingMeetings, error: dedupError } = await supabase
      .from('meetings')
      .select('id')
      .eq('user_id', meetingData.userId)
      .eq('detected_app', meetingData.detectedApp)
      .gte('start_time', dedupWindowStart)
      .lte('start_time', dedupWindowEnd)
      .limit(1);

    if (dedupError) {
      throw new Error(`Dedup query failed in performUpload: ${dedupError.message}`);
    }

    if (existingMeetings && existingMeetings.length > 0) {
      log.warn('[Uploader] Duplicate meeting detected, reusing existing record', {
        existingId: existingMeetings[0].id
      });
      meetingId = existingMeetings[0].id;

      // Update the existing record with latest data
      const meetingUpdate = {
        end_time:     meetingData.endTime,
        status:       aiData?.summary ? 'processed' : 'uploaded',
      };
      if (aiData?.category) meetingUpdate.detected_category = aiData.category;
      const { error: reuseUpdateError } = await supabase.from('meetings').update(meetingUpdate).eq('id', meetingId);
      if (reuseUpdateError) {
        log.warn('[Uploader] Failed to update reused meeting record', { error: reuseUpdateError.message, meetingId });
      }
    } else {
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
    .upsert({
      meeting_id:      meetingId,
      transcript_json: meetingData.transcript,
      source:          dbSource,
      ai_pregenerated: hasSummary,
    }, { onConflict: 'meeting_id' });

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
    // Delete any existing default summary for this meeting first, then insert fresh.
    // We cannot use upsert onConflict here because the unique constraint is a partial
    // index (WHERE is_default = true), which PostgREST does not support as a conflict target.
    await supabase.from('summaries').delete().eq('meeting_id', meetingId).eq('is_default', true);

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

      // Delete existing alerts for this meeting then re-insert (avoids duplicate constraint issue).
      await supabase.from('tone_alerts').delete().eq('meeting_id', meetingId);

      const { error: alertError } = await supabase
        .from('tone_alerts')
        .insert(alertRows);

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

  // ── Orphan cleanup ──
  // After successfully processing a meeting, delete any "recording" status orphans
  // for the same user + app within ±10 minutes. These are leftover early records from
  // fragmented detection cycles that were never completed or cleaned up.
  try {
    const meetingStartTime = new Date(meetingData.startTime);
    const cleanupStart = new Date(meetingStartTime.getTime() - 10 * 60 * 1000).toISOString();
    const cleanupEnd = new Date(meetingStartTime.getTime() + 10 * 60 * 1000).toISOString();
    const { data: orphans } = await supabase
      .from('meetings')
      .select('id')
      .eq('user_id', meetingData.userId)
      .eq('detected_app', meetingData.detectedApp)
      .eq('status', 'recording')
      .gte('start_time', cleanupStart)
      .lt('start_time', meetingData.startTime)
      .neq('id', meetingId);

    if (orphans && orphans.length > 0) {
      const orphanIds = orphans.map(o => o.id);
      await supabase.from('meetings').delete().in('id', orphanIds);
      log.info('[Uploader] Cleaned up orphaned recording records', { count: orphanIds.length, orphanIds });
    }
  } catch (cleanupErr) {
    log.debug('[Uploader] Orphan cleanup failed (non-critical)', { error: cleanupErr.message });
  }

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
