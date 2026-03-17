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

// Set to true when Graph API returns 404 for /me/presence — means no Teams license.
// Skip presence checks for the rest of this session to avoid log spam.
let _teamsLicenseAbsent = false;

/**
 * Check if the user is currently in a Teams meeting via Graph Presence API.
 * Returns { inMeeting: boolean, activity: string, availability: string } or null on error.
 */
async function checkTeamsPresence() {
  // Skip if we've already confirmed this user has no Teams license
  if (_teamsLicenseAbsent) return null;

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
    const status = err.statusCode || err.status || err.code;

    if (status === 401 || status === 403) {
      // Token expired — attempt silent refresh so next tick works
      log.warn('[Presence] Token expired (401/403), attempting silent refresh');
      try {
        const { validateTokenOrReauth } = require('../auth/msalAuth');
        await validateTokenOrReauth();
      } catch (refreshErr) {
        log.debug('[Presence] Silent token refresh failed', { error: refreshErr.message });
      }
    } else if (status === 404) {
      // User has no Teams license — presence API unavailable for this account
      log.info('[Presence] User has no Teams license (404) — disabling presence checks');
      _teamsLicenseAbsent = true;
    }

    log.debug('[Presence] API call failed', { error: err.message, status });
    _lastPresence = { time: now, result: null };
    return null;
  }
}

/**
 * Reset the presence cache (e.g., after meeting ends).
 */
function resetPresenceCache() {
  _lastPresence = { time: 0, result: null };
  // Don't reset _teamsLicenseAbsent — if the user has no license it won't change this session
}

module.exports = { checkTeamsPresence, resetPresenceCache, MEETING_ACTIVITIES, ACTIVE_CALL_ACTIVITIES, PRESENCE_AMBIGUOUS_ACTIVITIES };
