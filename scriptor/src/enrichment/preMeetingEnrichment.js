// file: scriptor/src/enrichment/preMeetingEnrichment.js
// Pre-meeting enrichment — Layer 3.
//
// Fires when detection hits CANDIDATE state (before recording starts).
// Pulls calendar attendees + display names to build known_values[] for
// AssemblyAI Speaker Identification. Runs during the debounce window
// so enrichment data is ready when recording starts.
//
// Teams path:  MS Graph API → /me/calendarView → attendee displayNames
// Google Meet:  Stubbed for Phase 2 (requires Google OAuth2 enrollment)
'use strict';

const log = require('electron-log');

/**
 * Enrich a meeting candidate with attendee information from calendar APIs.
 *
 * @param {string}  appName       - Detected app name (e.g., "Microsoft Teams", "Google Meet (Chrome)")
 * @param {boolean} isTeams       - Whether this is a Teams meeting
 * @param {boolean} isGoogleMeet  - Whether this is a Google Meet meeting
 * @returns {Promise<{ knownValues: string[], attendeeCount: number, meetingSubject: string|null }>}
 */
async function enrichCandidate(appName, isTeams, isGoogleMeet) {
  const result = { knownValues: [], attendeeCount: 0, meetingSubject: null };

  if (isTeams) {
    try {
      const teamsResult = await enrichFromTeamsCalendar();
      Object.assign(result, teamsResult);
    } catch (err) {
      log.warn('[Enrichment] Teams calendar enrichment failed (non-critical)', { error: err.message });
    }
  } else if (isGoogleMeet) {
    // Phase 2: Google Calendar API enrichment
    // Requires OAuth2 with Google, which needs a separate enrollment flow.
    log.info('[Enrichment] Google Meet enrichment not yet implemented (Phase 2)');
  }

  // Always include the local user's display name in known_values
  try {
    const { getConfig } = require('../main/config');
    const userName = getConfig('userDisplayName') || getConfig('userName');
    if (userName && !result.knownValues.includes(userName)) {
      result.knownValues.unshift(userName);
    }
  } catch (_) { /* ignore */ }

  log.info('[Enrichment] Candidate enriched', {
    app: appName,
    knownValues: result.knownValues.length,
    attendeeCount: result.attendeeCount,
    subject: result.meetingSubject,
  });

  return result;
}

/**
 * Pull attendee names from the user's Teams/Outlook calendar for the current time window.
 * Uses the existing Graph client (MSAL delegated token, Calendars.Read scope).
 */
async function enrichFromTeamsCalendar() {
  const { getGraphClient } = require('../api/graphClient');
  const graphClient = await getGraphClient();
  if (!graphClient) {
    log.debug('[Enrichment] Graph client not available — skipping Teams enrichment');
    return { knownValues: [], attendeeCount: 0, meetingSubject: null };
  }

  // Search window: now -10 min to now +60 min (covers early joins + scheduled starts)
  const now = new Date();
  const searchStart = new Date(now.getTime() - 10 * 60 * 1000);
  const searchEnd = new Date(now.getTime() + 60 * 60 * 1000);

  const calendarEvents = await graphClient
    .api('/me/calendarView')
    .query({
      startDateTime: searchStart.toISOString(),
      endDateTime: searchEnd.toISOString(),
    })
    .select('subject,start,end,attendees,isOnlineMeeting,onlineMeeting')
    .top(50)
    .get();

  if (!calendarEvents || !calendarEvents.value || calendarEvents.value.length === 0) {
    log.debug('[Enrichment] No calendar events in search window');
    return { knownValues: [], attendeeCount: 0, meetingSubject: null };
  }

  // Find the best-matching Teams meeting event by time overlap with "now"
  const nowMs = now.getTime();
  let bestEvent = null;
  let bestOverlap = -Infinity;

  for (const evt of calendarEvents.value) {
    if (!evt.isOnlineMeeting) continue;
    const evtStart = new Date(evt.start.dateTime + 'Z').getTime();
    const evtEnd = new Date(evt.end.dateTime + 'Z').getTime();

    // Overlap with the current moment: prefer events happening NOW
    const overlapStart = Math.max(nowMs - 5 * 60 * 1000, evtStart); // 5min grace for early start
    const overlapEnd = Math.min(nowMs + 5 * 60 * 1000, evtEnd);
    const overlap = overlapEnd - overlapStart;

    if (overlap > bestOverlap) {
      bestOverlap = overlap;
      bestEvent = evt;
    }
  }

  if (!bestEvent) {
    // Fallback: use the soonest upcoming online meeting
    const upcoming = calendarEvents.value
      .filter(e => e.isOnlineMeeting)
      .sort((a, b) => new Date(a.start.dateTime) - new Date(b.start.dateTime));
    if (upcoming.length > 0) bestEvent = upcoming[0];
  }

  if (!bestEvent) {
    log.debug('[Enrichment] No online meeting found in calendar');
    return { knownValues: [], attendeeCount: 0, meetingSubject: null };
  }

  // Extract attendee display names
  const knownValues = [];
  const attendees = bestEvent.attendees || [];

  for (const attendee of attendees) {
    const name = attendee.emailAddress?.name;
    if (name && name.trim() && !knownValues.includes(name.trim())) {
      knownValues.push(name.trim());
    }
  }

  log.info('[Enrichment] Calendar event matched', {
    subject: bestEvent.subject,
    attendees: knownValues.length,
    eventStart: bestEvent.start.dateTime,
  });

  return {
    knownValues,
    attendeeCount: knownValues.length,
    meetingSubject: bestEvent.subject || null,
  };
}

module.exports = { enrichCandidate };
