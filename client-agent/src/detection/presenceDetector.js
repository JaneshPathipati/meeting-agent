// file: client-agent/src/detection/presenceDetector.js
// Uses Microsoft Graph Presence API to detect Teams meetings.
// GET /me/presence returns { availability, activity } where:
//   activity = "InAMeeting" or "InACall" → user is in a Teams meeting/call
// This is the definitive, title-independent way to detect Teams meetings.
// Works regardless of meeting name, window title, or Teams UI version.

const log = require('electron-log');
const { getGraphClient } = require('../api/graphClient');

// Presence activity values that indicate an active Teams meeting or call
const MEETING_ACTIVITIES = new Set(['InAMeeting', 'InACall', 'InAConferenceCall']);

// Activities that mean the user has ACTUALLY JOINED a call (the red dot indicator).
// InACall/InAConferenceCall fire regardless of mic/camera/speaker state.
// InAMeeting only indicates a calendar block — user may NOT have joined.
const ACTIVE_CALL_ACTIVITIES = new Set(['InACall', 'InAConferenceCall']);

// Activities where user-set preferences OVERRIDE actual call state in the Graph API.
// Microsoft Teams sets these as BOTH availability AND activity when manually set,
// hiding InACall/InAConferenceCall. Absence of InACall is NOT proof of not being in a call
// when activity is one of these values.
const PRESENCE_AMBIGUOUS_ACTIVITIES = new Set([
  'doNotDisturb',             // User-set DND overrides InACall in both fields
  'focusing',                 // Focus mode — identical behavior to DND
  'urgentInterruptionsOnly',  // Teams urgent mode — same override behavior
  'presenting',               // Screen sharing may hide call state
]);

// Cache to avoid hammering the API (rate limit: 1500 req / 30s / app / tenant)
let _lastPresence = { time: 0, result: null };
const PRESENCE_CACHE_MS = 4000; // Cache for 4s (poll interval is 5s)

/**
 * Check if the user is currently in a Teams meeting via Graph Presence API.
 * Returns { inMeeting: boolean, activity: string, availability: string } or null on error.
 */
async function checkTeamsPresence() {
  const now = Date.now();
  if (now - _lastPresence.time < PRESENCE_CACHE_MS && _lastPresence.result !== null) {
    return _lastPresence.result;
  }

  try {
    const graphClient = await getGraphClient();
    if (!graphClient) {
      return null;
    }

    const presence = await graphClient
      .api('/me/presence')
      .get();

    const result = {
      inMeeting: MEETING_ACTIVITIES.has(presence.activity),
      isActiveCall: ACTIVE_CALL_ACTIVITIES.has(presence.activity),
      activity: presence.activity || 'Unknown',
      availability: presence.availability || 'Unknown'
    };

    _lastPresence = { time: now, result };
    log.debug('[Presence] Status', { activity: result.activity, availability: result.availability, inMeeting: result.inMeeting, isActiveCall: result.isActiveCall });
    return result;
  } catch (err) {
    // On error (network, token expired, etc.), return null — caller should fall back
    log.debug('[Presence] API call failed', { error: err.message });
    _lastPresence = { time: now, result: null };
    return null;
  }
}

/**
 * Reset the presence cache (e.g., after meeting ends).
 */
function resetPresenceCache() {
  _lastPresence = { time: 0, result: null };
}

module.exports = { checkTeamsPresence, resetPresenceCache, MEETING_ACTIVITIES, ACTIVE_CALL_ACTIVITIES, PRESENCE_AMBIGUOUS_ACTIVITIES };
