// file: client-agent/src/transcription/teamsTranscript.js
const log = require('electron-log');
const { getGraphClient } = require('../api/graphClient');
const { getAppGraphClient } = require('../api/graphClientApp');
const { getSupabaseClient } = require('../api/supabaseClient');
const { getConfig } = require('../main/config');

// Graph SDK returns ArrayBuffer/Buffer for /content endpoints — ensure we get a string.
function ensureString(data) {
  if (typeof data === 'string') return data;
  if (Buffer.isBuffer(data)) return data.toString('utf-8');
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf-8');
  if (data && typeof data === 'object' && data.constructor && data.constructor.name === 'ArrayBuffer') {
    return Buffer.from(data).toString('utf-8');
  }
  if (data && typeof data === 'object') return JSON.stringify(data);
  return String(data || '');
}

// Returns true if Teams transcript was found and override succeeded, false otherwise.
// Uses a 4-approach strategy ordered for maximum coverage in consultant/client orgs:
//   1. Meeting Chats → JoinWebUrl → transcripts (PRIMARY — ALL meeting types, organizer OR attendee)
//   2. Calendar Events → JoinWebUrl → transcripts (scheduled meetings, organizer OR attendee)
//   3. getAllTranscripts via app-only token (organizer-only, optional — needs Application Access Policy)
//   4. Direct /me/onlineMeetings listing (organizer-only fallback)
//
// Key insight: GET /me/onlineMeetings?$filter=JoinWebUrl eq '{url}' works for BOTH
// organizer AND attendee with delegated permissions (confirmed in MS docs).
// The challenge is discovering the JoinWebUrl — Approach 1 (chats) solves this for ALL meeting types.
async function checkTeamsTranscript(meetingData, attempt) {
  log.info('[TeamsTranscript] Checking for Teams transcript', {
    attempt,
    meetingId: meetingData.meetingId,
    meetingStart: meetingData.startTime,
    meetingEnd: meetingData.endTime
  });

  try {
    // Update attempt number in DB so admin panel can show progress
    const supabaseForAttempt = getSupabaseClient();
    await supabaseForAttempt
      .from('meetings')
      .update({ teams_transcript_attempt: attempt })
      .eq('id', meetingData.meetingId);

    const graphClient = await getGraphClient();
    if (!graphClient) {
      log.warn('[TeamsTranscript] Graph client not available');
      return false;
    }

    const microsoftUserId = getConfig('microsoftUserId');
    if (!microsoftUserId) {
      log.warn('[TeamsTranscript] No Microsoft user ID configured');
      return false;
    }

    const meetingStart = new Date(meetingData.startTime);
    const meetingEnd = new Date(meetingData.endTime);
    // Generous fixed buffers — no proportional caps, works for any meeting duration.
    // Pre-buffer: 30 min (handles early joins, calendar events that start before actual join)
    // Post-buffer: 60 min (handles transcript generation delay after long meetings)
    const PRE_BUFFER_MS = 30 * 60 * 1000;
    const POST_BUFFER_MS = 60 * 60 * 1000;
    const searchStart = new Date(meetingStart.getTime() - PRE_BUFFER_MS);
    const searchEnd = new Date(meetingEnd.getTime() + POST_BUFFER_MS);

    let vttContent = null;
    let teamsMeetingId = null;
    let teamsMeetingSubject = null;
    let teamsJoinUrl = null;
    let teamsStartTime = null;  // Official meeting start from Graph API
    let teamsEndTime = null;    // Official meeting end from Graph API

    // ── Approach 1 (PRIMARY): Meeting Chats → JoinWebUrl → online meeting → transcripts ──
    // Covers ALL meeting types: scheduled, ad-hoc "Meet Now", link-shared via chat,
    // channel meetings — regardless of who organized the meeting.
    // Every Teams meeting creates a meeting chat when the user joins.
    // The chat's onlineMeetingInfo.joinWebUrl lets us look up the meeting via
    // GET /me/onlineMeetings?$filter=JoinWebUrl — which works for organizer AND attendee.
    // Requires: Chat.ReadBasic (delegated, lightweight — only chat metadata, not messages)
    try {
      log.info('[TeamsTranscript] Approach 1: Meeting Chats + JoinWebUrl', { attempt });
      const meetingChats = await graphClient
        .api('/me/chats')
        .filter("chatType eq 'meeting'")
        .top(200)
        .select('id,topic,chatType,createdDateTime,lastUpdatedDateTime,onlineMeetingInfo')
        .get();

      if (meetingChats && meetingChats.value && meetingChats.value.length > 0) {
        log.info('[TeamsTranscript] Approach 1: meeting chats found', {
          count: meetingChats.value.length, attempt
        });

        // Find the chat whose lastUpdatedDateTime is closest to our meeting end.
        // For recurring meetings or reused links, createdDateTime is the ORIGINAL
        // chat creation date (possibly weeks/months ago), so it fails the time-window
        // filter. lastUpdatedDateTime reflects the most recent message activity, which
        // happens DURING or immediately after the current meeting instance.
        const meetingEndMs = meetingEnd.getTime();
        const validChats = meetingChats.value.filter(c => {
          if (!c.onlineMeetingInfo || !c.onlineMeetingInfo.joinWebUrl) return false;
          const chatUpdated = new Date(c.lastUpdatedDateTime || c.createdDateTime).getTime();
          return chatUpdated >= searchStart.getTime() && chatUpdated <= searchEnd.getTime();
        });

        if (validChats.length > 0) {
          // Best-match by closest lastUpdatedDateTime to meeting end (chat activity peaks at end)
          const bestChat = validChats.reduce((best, c) => {
            const cTime = new Date(c.lastUpdatedDateTime || c.createdDateTime).getTime();
            const bestTime = new Date(best.lastUpdatedDateTime || best.createdDateTime).getTime();
            return Math.abs(cTime - meetingEndMs) < Math.abs(bestTime - meetingEndMs) ? c : best;
          });

          const joinUrl = bestChat.onlineMeetingInfo.joinWebUrl;
          teamsMeetingSubject = bestChat.topic || null;
          teamsJoinUrl = joinUrl;

          log.info('[TeamsTranscript] Approach 1: best-match chat', {
            topic: bestChat.topic,
            chatCreated: bestChat.createdDateTime,
            chatUpdated: bestChat.lastUpdatedDateTime,
            joinUrl: joinUrl.substring(0, 80)
          });

          // Look up the online meeting by JoinWebUrl — works for organizer AND attendee
          const result = await fetchTranscriptByJoinUrl(graphClient, joinUrl, meetingStart, meetingEnd);
          if (result) {
            vttContent = result.vttContent;
            teamsMeetingId = result.meetingId;
            teamsJoinUrl = result.joinWebUrl || joinUrl;
            teamsMeetingSubject = teamsMeetingSubject || result.subject;
            teamsStartTime = result.startDateTime || teamsStartTime;
            teamsEndTime = result.endDateTime || teamsEndTime;
          }
        } else {
          log.info('[TeamsTranscript] Approach 1: no meeting chat with joinWebUrl in time window', { attempt });
        }
      } else {
        log.info('[TeamsTranscript] Approach 1: no meeting chats found', { attempt });
      }
    } catch (chatErr) {
      log.warn('[TeamsTranscript] Approach 1 (Meeting Chats) failed', {
        error: chatErr.message,
        statusCode: chatErr.statusCode || chatErr.code || 'unknown',
        attempt
      });
    }

    // ── Approach 2: Calendar Events → JoinWebUrl → online meeting → transcripts ──
    // Covers scheduled meetings (both organizer and attendee).
    // Ad-hoc / Meet Now meetings do NOT appear in calendar — covered by Approach 1.
    // Uses overlap-based matching to correctly handle long meetings alongside short ones.
    if (!vttContent) try {
      log.info('[TeamsTranscript] Approach 2: Calendar Events + JoinWebUrl', { attempt });
      const calendarEvents = await graphClient
        .api('/me/calendarView')
        .query({
          startDateTime: searchStart.toISOString(),
          endDateTime: searchEnd.toISOString()
        })
        .select('subject,start,end,onlineMeeting,isOnlineMeeting')
        .top(200)
        .get();

      if (calendarEvents && calendarEvents.value) {
        const teamsMeetings = calendarEvents.value.filter(e =>
          e.isOnlineMeeting && e.onlineMeeting && e.onlineMeeting.joinUrl
        );

        log.info('[TeamsTranscript] Approach 2: Teams calendar events found', {
          total: calendarEvents.value.length, teamsCount: teamsMeetings.length, attempt
        });

        // Best-match by time overlap — prevents picking a short standup over a 3-hour client call
        let bestEvent = null;
        let bestOverlap = 0;

        for (const evt of teamsMeetings) {
          const evtStart = new Date(evt.start.dateTime + 'Z').getTime();
          const evtEnd = new Date(evt.end.dateTime + 'Z').getTime();
          const overlapStart = Math.max(meetingStart.getTime(), evtStart);
          const overlapEnd = Math.min(meetingEnd.getTime(), evtEnd);
          const overlap = Math.max(0, overlapEnd - overlapStart);

          if (overlap > bestOverlap) {
            bestOverlap = overlap;
            bestEvent = evt;
          }
        }

        if (bestEvent) {
          const joinUrl = bestEvent.onlineMeeting.joinUrl;
          teamsMeetingSubject = bestEvent.subject;
          teamsJoinUrl = joinUrl;

          log.info('[TeamsTranscript] Approach 2: best-match calendar event', {
            subject: bestEvent.subject,
            overlapMinutes: Math.round(bestOverlap / 60000),
            joinUrl: joinUrl.substring(0, 80)
          });

          const result = await fetchTranscriptByJoinUrl(graphClient, joinUrl, meetingStart, meetingEnd);
          if (result) {
            vttContent = result.vttContent;
            teamsMeetingId = result.meetingId;
            teamsJoinUrl = result.joinWebUrl || joinUrl;
            teamsMeetingSubject = teamsMeetingSubject || result.subject;
            // Prefer Graph API meeting times; fall back to calendar event times
            teamsStartTime = result.startDateTime || (bestEvent.start?.dateTime ? bestEvent.start.dateTime + 'Z' : null) || teamsStartTime;
            teamsEndTime = result.endDateTime || (bestEvent.end?.dateTime ? bestEvent.end.dateTime + 'Z' : null) || teamsEndTime;
          }
        } else {
          log.info('[TeamsTranscript] Approach 2: no Teams calendar event overlapping our meeting', { attempt });
        }
      }
    } catch (calErr) {
      log.warn('[TeamsTranscript] Approach 2 (Calendar+JoinWebUrl) failed', {
        error: calErr.message, attempt
      });
    }

    // ── Approach 3: getAllTranscripts via app-only token ──
    // Only returns transcripts for meetings the user ORGANIZED.
    // Optional optimization — silently skips if app-only client unavailable.
    // Requires: OnlineMeetings.Read.All + OnlineMeetingTranscript.Read.All (Application)
    //           + Application Access Policy configured via PowerShell.
    if (!vttContent) try {
      const appGraphClient = await getAppGraphClient();
      if (appGraphClient) {
        log.info('[TeamsTranscript] Approach 3: getAllTranscripts (app-only, organizer-only)', { attempt });

        const allTranscripts = await appGraphClient
          .api(`/users/${microsoftUserId}/onlineMeetings/getAllTranscripts(meetingOrganizerUserId='${microsoftUserId}',startDateTime=${searchStart.toISOString()},endDateTime=${searchEnd.toISOString()})`)
          .get();

        if (allTranscripts && allTranscripts.value && allTranscripts.value.length > 0) {
          log.info('[TeamsTranscript] Approach 3: found transcripts', {
            count: allTranscripts.value.length, attempt
          });

          // Best-match: closest creation time to our meeting end (transcripts are created after meeting ends)
          let transcript = allTranscripts.value[0];
          if (allTranscripts.value.length > 1) {
            const meetingEndMs = meetingEnd.getTime();
            transcript = allTranscripts.value.reduce((best, t) => {
              const tTime = new Date(t.createdDateTime || 0).getTime();
              const bestTime = new Date(best.createdDateTime || 0).getTime();
              return Math.abs(tTime - meetingEndMs) < Math.abs(bestTime - meetingEndMs) ? t : best;
            });
          }

          const meetingIdFromTranscript = transcript.meetingId;
          const transcriptId = transcript.id;

          log.info('[TeamsTranscript] Approach 3: selected transcript', {
            transcriptId, meetingId: meetingIdFromTranscript, attempt
          });

          try {
            const meetingDetails = await appGraphClient
              .api(`/users/${microsoftUserId}/onlineMeetings/${meetingIdFromTranscript}`)
              .select('id,subject,joinWebUrl,startDateTime,endDateTime')
              .get();

            if (meetingDetails) {
              teamsMeetingId = meetingDetails.id;
              teamsMeetingSubject = meetingDetails.subject || null;
              teamsJoinUrl = meetingDetails.joinWebUrl || null;
              teamsStartTime = meetingDetails.startDateTime || teamsStartTime;
              teamsEndTime = meetingDetails.endDateTime || teamsEndTime;
            }
          } catch (detailErr) {
            log.warn('[TeamsTranscript] Approach 3: could not fetch meeting details', { error: detailErr.message });
            teamsMeetingId = meetingIdFromTranscript;
          }

          vttContent = await appGraphClient
            .api(`/users/${microsoftUserId}/onlineMeetings/${meetingIdFromTranscript}/transcripts/${transcriptId}/content`)
            .query({ '$format': 'text/vtt' })
            .responseType('text')
            .get();
        } else {
          log.info('[TeamsTranscript] Approach 3: no transcripts in time window', { attempt });
        }
      } else {
        log.debug('[TeamsTranscript] Approach 3: skipped (app-only client not available)');
      }
    } catch (appErr) {
      log.warn('[TeamsTranscript] Approach 3 (getAllTranscripts) failed', {
        error: appErr.message, attempt
      });
    }

    // ── Approach 4: Direct /me/onlineMeetings by JoinWebUrl (retry) ──
    // /me/onlineMeetings only supports $filter by JoinWebUrl, joinMeetingId, or
    // VideoTeleconferenceId — NOT startDateTime.
    // If Approaches 1 or 2 discovered a joinUrl but fetchTranscriptByJoinUrl returned
    // no transcripts yet, retry the same joinUrl here (transcript may have appeared
    // between approach attempts). Also handles the case where the meeting was found
    // but transcript wasn't ready.
    if (!vttContent && teamsJoinUrl) {
      try {
        log.info('[TeamsTranscript] Approach 4: Retry JoinWebUrl lookup', {
          joinUrl: teamsJoinUrl.substring(0, 80), attempt
        });

        const result = await fetchTranscriptByJoinUrl(graphClient, teamsJoinUrl, meetingStart, meetingEnd);
        if (result) {
          vttContent = result.vttContent;
          teamsMeetingId = teamsMeetingId || result.meetingId;
          teamsJoinUrl = result.joinWebUrl || teamsJoinUrl;
          teamsMeetingSubject = teamsMeetingSubject || result.subject;
          teamsStartTime = teamsStartTime || result.startDateTime;
          teamsEndTime = teamsEndTime || result.endDateTime;
        } else {
          log.info('[TeamsTranscript] Approach 4: still no transcript via JoinWebUrl', { attempt });
        }
      } catch (retryErr) {
        log.warn('[TeamsTranscript] Approach 4 (JoinWebUrl retry) failed', {
          error: retryErr.message, attempt
        });
      }
    } else if (!vttContent) {
      log.info('[TeamsTranscript] Approach 4: skipped (no joinUrl discovered by earlier approaches)', { attempt });
    }

    // ── No transcript found across all approaches ──
    if (!vttContent) {
      log.info('[TeamsTranscript] No transcript found across all 4 approaches', { attempt });
      return false;
    }

    // Ensure vttContent is a string (safety net)
    if (typeof vttContent !== 'string') {
      vttContent = ensureString(vttContent);
    }

    log.info('[TeamsTranscript] Transcript VTT content retrieved', {
      attempt,
      meetingId: teamsMeetingId,
      vttLength: vttContent.length,
      preview: vttContent.substring(0, 200)
    });

    // Reject empty or malformed VTT — must contain WEBVTT header and at least one timestamp
    if (!vttContent || vttContent.length < 50 || !vttContent.includes('WEBVTT') || !vttContent.includes('-->')) {
      log.warn('[TeamsTranscript] VTT content is empty or malformed, skipping override', {
        vttLength: vttContent ? vttContent.length : 0,
        hasWebVTT: vttContent ? vttContent.includes('WEBVTT') : false,
        hasTimestamp: vttContent ? vttContent.includes('-->') : false
      });
      return false;
    }

    // ── Rejoin dedup: only block TRUE rejoins (leave + rejoin same ongoing session) ──
    // When a user drops and rejoins the same Teams meeting within minutes, our detector
    // creates separate local meetings, but Teams has ONE transcript for the whole session.
    // Only dedup if another meeting with the same Teams ID ended within 15 min of our
    // start (i.e., same ongoing session), or is still ongoing (end_time is null).
    // With correct transcript selection via createdDateTime filtering above, this is just
    // a minimal safety net — reused links after hours/days/weeks are handled by the
    // time-filtered transcript selection, not by dedup.
    const supabase = getSupabaseClient();
    if (teamsMeetingId) {
      const REJOIN_GAP_MS = 15 * 60 * 1000;
      const gapThreshold = new Date(new Date(meetingData.startTime).getTime() - REJOIN_GAP_MS).toISOString();

      const { data: existing } = await supabase
        .from('meetings')
        .select('id')
        .eq('teams_meeting_id', teamsMeetingId)
        .neq('id', meetingData.meetingId)
        .or(`end_time.gte.${gapThreshold},end_time.is.null`)
        .limit(1);

      if (existing && existing.length > 0) {
        log.info('[TeamsTranscript] Teams transcript already applied to another meeting (rejoin dedup)', {
          existingMeetingId: existing[0].id,
          teamsMeetingId,
          currentMeetingId: meetingData.meetingId
        });
        return false;
      }
    }

    // Fetch registered org profile names for speaker matching
    let orgProfiles = [];
    try {
      const orgId = meetingData.orgId || null;
      let profileQuery = supabase.from('profiles').select('full_name');
      if (orgId) profileQuery = profileQuery.eq('org_id', orgId);
      else {
        // Get org_id from the meeting
        const { data: mtg } = await supabase.from('meetings').select('org_id').eq('id', meetingData.meetingId).single();
        if (mtg?.org_id) profileQuery = profileQuery.eq('org_id', mtg.org_id);
      }
      const { data: profiles } = await profileQuery;
      orgProfiles = (profiles || []).map(p => p.full_name).filter(Boolean);
      log.info('[TeamsTranscript] Loaded org profiles for speaker matching', { count: orgProfiles.length });
    } catch (profErr) {
      log.warn('[TeamsTranscript] Could not load org profiles (speaker matching degraded)', { error: profErr.message });
    }

    // Parse VTT to canonical JSON format with speaker name resolution
    const transcriptJson = parseVttToJson(vttContent, meetingData, orgProfiles);
    const { error } = await supabase
      .from('transcripts')
      .update({
        transcript_json: transcriptJson,
        source: 'teams',
        overridden_at: new Date().toISOString()
      })
      .eq('meeting_id', meetingData.meetingId);

    if (error) {
      log.error('[TeamsTranscript] Failed to update transcript', { error: error.message });
      return false;
    }

    // Update meeting with Teams info + times.
    // ALWAYS use local detection times for start_time/end_time — they reflect when
    // the meeting ACTUALLY happened on this machine. Graph API's onlineMeeting
    // startDateTime/endDateTime are the ORIGINAL scheduling times, which are wrong
    // for recurring meetings or reused links (e.g., link created Feb 12, meeting
    // held today → Graph returns Feb 12 times). Local times are always correct.
    const meetingUpdate = {
      teams_meeting_id: teamsMeetingId || null,
      teams_join_url: teamsJoinUrl || null,
      start_time: meetingData.startTime,
      end_time: meetingData.endTime
    };

    // Fetch attendance report for all meeting attendees
    if (teamsMeetingId) {
      try {
        const attendees = await fetchMeetingAttendees(graphClient, teamsMeetingId);
        if (attendees && attendees.length > 0) {
          meetingUpdate.attendees = attendees;
          log.info('[TeamsTranscript] Fetched attendees', { count: attendees.length });
        }
      } catch (attendeeErr) {
        log.warn('[TeamsTranscript] Failed to fetch attendees (non-critical)', { error: attendeeErr.message });
      }
    }

    log.info('[TeamsTranscript] Updating meeting times', {
      start: meetingUpdate.start_time,
      end: meetingUpdate.end_time,
      graphStart: teamsStartTime || 'n/a',
      graphEnd: teamsEndTime || 'n/a',
      source: 'local'
    });
    const { error: meetingUpdateError } = await supabase
      .from('meetings')
      .update(meetingUpdate)
      .eq('id', meetingData.meetingId);

    if (meetingUpdateError) {
      log.error('[TeamsTranscript] Failed to update meeting info', { error: meetingUpdateError.message });
    }

    log.info('[TeamsTranscript] Teams transcript override successful', {
      meetingId: meetingData.meetingId,
      segments: transcriptJson.segments.length,
      approach: teamsMeetingId ? 'graph' : 'unknown'
    });

    // Wait for the trigger + cron to re-process the Teams transcript, then send email.
    // The transcript UPDATE fires on_transcript_upserted → cron generates new summary.
    // We poll until status='processed', then call send_deferred_email.
    scheduleEmailAfterReprocessing(supabase, meetingData.meetingId);

    return true;

  } catch (err) {
    log.error('[TeamsTranscript] Check failed', {
      attempt,
      error: err.message
    });
    return false;
  }
}

// Helper: Given a joinWebUrl, look up the online meeting and fetch its transcript.
// The JoinWebUrl filter works for BOTH organizer AND attendee with delegated permissions.
// For reused meeting links, each session generates its own transcript with a distinct
// createdDateTime. We use $filter + best-match to select the transcript from the correct session.
// Returns { vttContent, meetingId, joinWebUrl, subject } or null if not found/no transcript.
async function fetchTranscriptByJoinUrl(graphClient, joinUrl, meetingStart, meetingEnd) {
  try {
    // URL-encode the joinUrl for the OData filter (handles special chars in Teams URLs)
    const encodedUrl = joinUrl.replace(/'/g, "''");
    const onlineMeetings = await graphClient
      .api('/me/onlineMeetings')
      .filter(`JoinWebUrl eq '${encodedUrl}'`)
      .get();

    log.info('[TeamsTranscript] fetchByJoinUrl: online meeting lookup', {
      found: !!(onlineMeetings?.value?.length),
      count: onlineMeetings?.value?.length || 0,
      joinUrlPrefix: joinUrl.substring(0, 80)
    });

    if (!onlineMeetings || !onlineMeetings.value || onlineMeetings.value.length === 0) {
      log.info('[TeamsTranscript] fetchByJoinUrl: no meeting found for joinUrl');
      return null;
    }

    const meeting = onlineMeetings.value[0];

    // Extract official meeting times from Graph API (if available)
    const officialStartTime = meeting.startDateTime || null;
    const officialEndTime = meeting.endDateTime || null;

    // Time-filter transcripts to select the one from our specific meeting session.
    // Each session on a reused meeting link generates its own transcript with a unique createdDateTime.
    const searchStart = new Date(meetingStart.getTime() - 30 * 60 * 1000);  // 30 min before
    const searchEnd = new Date(meetingEnd.getTime() + 60 * 60 * 1000);      // 60 min after

    let transcriptsList = null;

    // Try server-side $filter first (most efficient)
    try {
      const filtered = await graphClient
        .api(`/me/onlineMeetings/${meeting.id}/transcripts`)
        .filter(`createdDateTime ge ${searchStart.toISOString()} and createdDateTime le ${searchEnd.toISOString()}`)
        .select('id,createdDateTime')
        .get();

      if (filtered && filtered.value && filtered.value.length > 0) {
        transcriptsList = filtered.value;
        log.info('[TeamsTranscript] fetchByJoinUrl: time-filtered transcripts', {
          count: transcriptsList.length, meetingId: meeting.id
        });
      }
    } catch (filterErr) {
      // $filter on transcripts may not be supported in all Graph API versions — fall back
      log.info('[TeamsTranscript] fetchByJoinUrl: $filter not supported, falling back to unfiltered', {
        error: filterErr.message
      });
    }

    // Fall back to unfiltered list + client-side time matching
    if (!transcriptsList) {
      const unfiltered = await graphClient
        .api(`/me/onlineMeetings/${meeting.id}/transcripts`)
        .select('id,createdDateTime')
        .get();

      if (!unfiltered || !unfiltered.value || unfiltered.value.length === 0) {
        log.info('[TeamsTranscript] fetchByJoinUrl: meeting found but no transcripts yet', {
          meetingId: meeting.id
        });
        return null;
      }

      // Client-side filter to our time window
      const inWindow = unfiltered.value.filter(t => {
        if (!t.createdDateTime) return true; // include if no timestamp (shouldn't happen)
        const created = new Date(t.createdDateTime).getTime();
        return created >= searchStart.getTime() && created <= searchEnd.getTime();
      });

      if (inWindow.length === 0) {
        // NEVER fall back to old transcripts from recurring meeting links.
        // If no transcript exists in the time window, it genuinely doesn't exist for this session.
        log.info('[TeamsTranscript] fetchByJoinUrl: no transcripts in time window, skipping stale ones', {
          total: unfiltered.value.length,
          meetingId: meeting.id,
          windowStart: searchStart.toISOString(),
          windowEnd: searchEnd.toISOString()
        });
        return null;
      }

      transcriptsList = inWindow;

      log.info('[TeamsTranscript] fetchByJoinUrl: time-filtered transcripts (client-side)', {
        total: unfiltered.value.length,
        inWindow: inWindow.length,
        meetingId: meeting.id
      });
    }

    // Best-match: pick transcript whose createdDateTime is closest to meetingStart
    // (transcripts are created when the session starts)
    let bestTranscript = transcriptsList[0];
    if (transcriptsList.length > 1) {
      const meetingStartMs = meetingStart.getTime();
      bestTranscript = transcriptsList.reduce((best, t) => {
        const tTime = new Date(t.createdDateTime || 0).getTime();
        const bestTime = new Date(best.createdDateTime || 0).getTime();
        return Math.abs(tTime - meetingStartMs) < Math.abs(bestTime - meetingStartMs) ? t : best;
      });

      log.info('[TeamsTranscript] fetchByJoinUrl: selected best-match transcript', {
        selectedId: bestTranscript.id,
        selectedCreated: bestTranscript.createdDateTime,
        candidateCount: transcriptsList.length
      });
    }

    const transcriptId = bestTranscript.id;
    const vttContent = await graphClient
      .api(`/me/onlineMeetings/${meeting.id}/transcripts/${transcriptId}/content`)
      .query({ '$format': 'text/vtt' })
      .responseType('text')
      .get();

    return {
      vttContent,
      meetingId: meeting.id,
      joinWebUrl: meeting.joinWebUrl,
      subject: meeting.subject || null,
      startDateTime: officialStartTime,
      endDateTime: officialEndTime
    };
  } catch (err) {
    const status = err.statusCode || err.status || err.code;

    // 429 = Graph API rate limit — respect Retry-After header before returning
    if (status === 429) {
      const retryAfterSec = parseInt(
        (err.headers && (err.headers['retry-after'] || err.headers['Retry-After'])) || '60',
        10
      );
      log.warn('[TeamsTranscript] fetchByJoinUrl: Graph API rate limited (429)', {
        retryAfterSec,
        joinUrl: joinUrl ? joinUrl.substring(0, 80) : 'n/a',
      });
      await new Promise(r => setTimeout(r, retryAfterSec * 1000));
    } else {
      log.warn('[TeamsTranscript] fetchByJoinUrl failed', {
        error: err.message,
        statusCode: status || 'unknown',
        joinUrl: joinUrl ? joinUrl.substring(0, 100) : 'n/a',
        meetingStart: meetingStart?.toISOString(),
        meetingEnd: meetingEnd?.toISOString(),
      });
    }
    return null;
  }
}

// After a successful Teams transcript override, the trigger re-processes the meeting.
// This function polls until re-processing completes, then sends the deferred email.
// Runs async (fire-and-forget) so it doesn't block the caller.
function scheduleEmailAfterReprocessing(supabase, meetingId) {
  const MAX_POLLS = 20; // 20 × 15s = 5 min max wait
  let polls = 0;

  async function poll() {
    if (polls >= MAX_POLLS) {
      log.warn('[TeamsTranscript] Email poll: max polls reached, giving up', { meetingId });
      return;
    }
    polls++;
    try {
      const { data: meeting } = await supabase
        .from('meetings')
        .select('status')
        .eq('id', meetingId)
        .single();

      if (!meeting) {
        log.warn('[TeamsTranscript] Email poll: meeting not found', { meetingId });
        return;
      }

      log.info('[TeamsTranscript] Email poll: waiting for re-processing', {
        meetingId, status: meeting.status, poll: polls
      });

      if (meeting.status === 'processed') {
        log.info('[TeamsTranscript] Re-processing complete, sending email', { meetingId });

        const { data: emailResult, error: rpcErr } = await supabase.rpc('send_deferred_email', {
          p_meeting_id: meetingId
        });

        if (rpcErr) {
          log.warn('[TeamsTranscript] Post-override email failed', { meetingId, error: rpcErr.message });
        } else {
          log.info('[TeamsTranscript] Post-override email sent', { meetingId, result: emailResult });
        }
        return; // done
      } else if (meeting.status === 'failed') {
        log.warn('[TeamsTranscript] Email poll: gave up waiting', {
          meetingId, status: meeting.status, polls
        });
        return; // done
      }
    } catch (err) {
      log.warn('[TeamsTranscript] Email poll error', { meetingId, error: err.message });
      if (polls >= MAX_POLLS) {
        log.warn('[TeamsTranscript] Email poll: max polls reached in catch, giving up', { meetingId });
        return;
      }
    }
    // Schedule next poll only after this one finishes (avoids overlapping calls)
    setTimeout(poll, 15000);
  }

  setTimeout(poll, 15000);
}

// Called when all Teams transcript checks have been exhausted.
// With the new architecture, the local transcript is already processed immediately on upload,
// so this marks attempt=99 and sends the deferred email (which was held back during initial
// processing to avoid double-emailing if a Teams transcript override arrived).
async function fallbackToLocalTranscript(meetingData) {
  log.info('[TeamsTranscript] All Teams transcript checks exhausted, local transcript already processed', {
    meetingId: meetingData.meetingId
  });

  try {
    const supabase = getSupabaseClient();

    // Mark attempt as 99 to indicate all checks exhausted
    await supabase
      .from('meetings')
      .update({ teams_transcript_attempt: 99 })
      .eq('id', meetingData.meetingId);

    // Send the deferred email now (summary was already generated from local transcript)
    const { error: rpcErr } = await supabase.rpc('send_deferred_email', {
      p_meeting_id: meetingData.meetingId
    });

    if (rpcErr) {
      log.warn('[TeamsTranscript] Deferred email send failed', { error: rpcErr.message });
    } else {
      log.info('[TeamsTranscript] Deferred email sent for meeting', { meetingId: meetingData.meetingId });
    }
  } catch (err) {
    log.error('[TeamsTranscript] Fallback failed', { error: err.message });
  }
}

/**
 * Parse VTT transcript into JSON, matching speaker names against registered org profiles.
 * - Registered users → their profile full_name
 * - Unregistered/external → "Unknown Speaker 1", "Unknown Speaker 2", etc.
 *
 * @param {string}   vttContent   - Raw VTT content from Teams Graph API
 * @param {object}   meetingData  - Meeting metadata (startTime, endTime, etc.)
 * @param {string[]} orgProfiles  - Array of registered profile names in the org (optional)
 */
function parseVttToJson(vttContent, meetingData, orgProfiles) {
  const lines = vttContent.split('\n');
  const rawSegments = [];
  let currentSegment = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    // Match timestamp line: 00:00:05.000 --> 00:00:12.000
    const timeMatch = line.match(/(\d{2}:\d{2}:\d{2})\.\d{3}\s*-->\s*(\d{2}:\d{2}:\d{2})\.\d{3}/);
    if (timeMatch) {
      if (currentSegment) {
        rawSegments.push(currentSegment);
      }
      currentSegment = {
        start_time: timeMatch[1],
        end_time: timeMatch[2],
        speaker: 'Unknown',
        text: ''
      };
      continue;
    }

    // Match speaker line: <v Speaker Name>text</v>
    if (currentSegment && line.startsWith('<v ')) {
      const speakerMatch = line.match(/<v\s+([^>]+)>(.*?)(?:<\/v>)?$/);
      if (speakerMatch) {
        currentSegment.speaker = speakerMatch[1].trim();
        currentSegment.text = speakerMatch[2].replace(/<\/v>/g, '').trim();
      }
    } else if (currentSegment && line && !line.startsWith('WEBVTT') && !line.startsWith('NOTE')) {
      if (currentSegment.text) {
        currentSegment.text += ' ' + line;
      } else {
        currentSegment.text = line;
      }
    }
  }

  if (currentSegment) {
    rawSegments.push(currentSegment);
  }

  // ── Speaker name resolution ──────────────────────────────────────────────
  // Match VTT speaker names against registered org profiles.
  // Teams VTT gives display names from Teams accounts (e.g., "Janesh Pathi").
  // We fuzzy-match against profile full_name to identify org members.
  // Unmatched speakers → "Unknown Speaker 1", "Unknown Speaker 2", etc.
  const profileNames = (orgProfiles || []).map(n => n.toLowerCase().trim()).filter(Boolean);
  const speakerMap = {};     // vttName → resolved display name
  let unknownCounter = 0;

  function resolveSpeaker(vttName) {
    if (!vttName || vttName === 'Unknown') {
      unknownCounter++;
      return 'Unknown Speaker ' + unknownCounter;
    }

    // Already resolved
    if (speakerMap[vttName]) return speakerMap[vttName];

    const vttLower = vttName.toLowerCase().trim();

    // Try exact match first
    const exactIdx = profileNames.findIndex(p => p === vttLower);
    if (exactIdx >= 0) {
      speakerMap[vttName] = orgProfiles[exactIdx];
      return speakerMap[vttName];
    }

    // Try partial match: VTT name contains profile name or vice versa
    // e.g., VTT "Janesh Pathi" matches profile "janesh", or "sree vastav" matches "Sree Vastav"
    const partialIdx = profileNames.findIndex(p =>
      vttLower.includes(p) || p.includes(vttLower)
    );
    if (partialIdx >= 0) {
      speakerMap[vttName] = orgProfiles[partialIdx];
      return speakerMap[vttName];
    }

    // Try word overlap: at least one word matches (first name or last name)
    const vttWords = vttLower.split(/\s+/);
    const wordIdx = profileNames.findIndex(p => {
      const pWords = p.split(/\s+/);
      return vttWords.some(vw => vw.length > 2 && pWords.some(pw => pw.length > 2 && pw === vw));
    });
    if (wordIdx >= 0) {
      speakerMap[vttName] = orgProfiles[wordIdx];
      return speakerMap[vttName];
    }

    // No match → unknown speaker
    unknownCounter++;
    const label = 'Unknown Speaker ' + unknownCounter;
    speakerMap[vttName] = label;
    return label;
  }

  // Resolve all speakers
  const segments = rawSegments.map(seg => ({
    ...seg,
    speaker: resolveSpeaker(seg.speaker),
  }));

  const meetingStart = new Date(meetingData.startTime);
  const meetingEnd = new Date(meetingData.endTime);
  const durationSeconds = Math.round((meetingEnd - meetingStart) / 1000);
  const uniqueSpeakers = [...new Set(segments.map(s => s.speaker))];

  log.info('[TeamsTranscript] VTT parsed with speaker resolution', {
    totalSegments: segments.length,
    speakers: uniqueSpeakers,
    unknownCount: unknownCounter,
    profilesChecked: profileNames.length,
  });

  return {
    segments,
    metadata: {
      duration_seconds: durationSeconds,
      source: 'teams',
      model: 'microsoft-teams',
      speaker_count: uniqueSpeakers.length,
      speakers: uniqueSpeakers,
      transcribed_at: new Date().toISOString()
    }
  };
}

/**
 * Fetch meeting attendees via Graph API attendance reports.
 * Returns an array of { name, email } objects, or [] if unavailable.
 * Requires OnlineMeetingArtifact.Read.All or similar delegated/app permission.
 */
async function fetchMeetingAttendees(graphClient, teamsMeetingId) {
  if (!graphClient || !teamsMeetingId) return [];
  try {
    // Fetch attendance reports for this meeting
    const reportsResult = await graphClient
      .api(`/me/onlineMeetings/${teamsMeetingId}/attendanceReports`)
      .select('id,meetingStartDateTime,meetingEndDateTime,totalParticipantCount')
      .get();

    if (!reportsResult || !reportsResult.value || reportsResult.value.length === 0) {
      log.info('[TeamsTranscript] No attendance reports available', { teamsMeetingId });
      return [];
    }

    // Use the most recent report
    const report = reportsResult.value[reportsResult.value.length - 1];

    const attendanceResult = await graphClient
      .api(`/me/onlineMeetings/${teamsMeetingId}/attendanceReports/${report.id}/attendanceRecords`)
      .select('emailAddress,identity,totalAttendanceInSeconds')
      .get();

    if (!attendanceResult || !attendanceResult.value) return [];

    const attendees = [];
    for (const record of attendanceResult.value) {
      const email = record.emailAddress || record.identity?.user?.email || '';
      const name = record.identity?.displayName || record.identity?.user?.displayName || email;
      if (email && email.includes('@')) {
        attendees.push({ name, email });
      }
    }

    return attendees;
  } catch (err) {
    log.warn('[TeamsTranscript] fetchMeetingAttendees error', { error: err.message, teamsMeetingId });
    return [];
  }
}

module.exports = { checkTeamsTranscript, fallbackToLocalTranscript };
