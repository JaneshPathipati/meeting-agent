// file: scriptor/src/main/index.js
const { app, BrowserWindow, powerMonitor } = require('electron');
const path = require('path');
const log = require('electron-log');
const { initTray, refreshTray } = require('./tray');
const { registerWatchdog, unregisterWatchdog } = require('./watchdog');
const { loadConfig, getConfig, setConfig, getStore } = require('./config');
const { initUpdater } = require('./updater');
const { initMsalAuth, isAuthenticated, validateTokenOrReauth } = require('../auth/msalAuth');
const { startDetectionLoop, stopDetectionLoop } = require('../detection/meetingDetector');
const { initUploadQueue, retryQueuedItems } = require('../api/uploader');
const { startLogUploader } = require('../api/logUploader');
const { getSupabaseClient } = require('../api/supabaseClient');
const { checkTeamsTranscript } = require('../transcription/teamsTranscript');

// Configure logging
log.transports.file.level = 'info';
log.transports.file.maxSize = 10 * 1024 * 1024; // 10MB rotation
log.transports.console.level = process.env.NODE_ENV === 'development' ? 'debug' : false;

// ── Global crash guards ──────────────────────────────────────────────────────
// Keep the agent alive on unhandled errors — silently crashing would miss meetings.
process.on('uncaughtException', (err) => {
  log.error('[Main] Uncaught exception (agent kept running):', err);
});
process.on('unhandledRejection', (reason) => {
  log.warn('[Main] Unhandled promise rejection:', reason);
});

// Required for system audio capture (WASAPI loopback) via desktopCapturer on Windows.
// AudioServiceOutOfProcess puts the audio service in a separate sandbox process which
// blocks loopback capture. Disabling it runs audio in-process and enables system capture.
app.commandLine.appendSwitch('disable-features', 'AudioServiceOutOfProcess');

let setupWindow = null;
let tokenCheckInterval = null;
let heartbeatInterval = null;
let queueRetryInterval = null;

const startHidden = process.argv.includes('--hidden');

app.whenReady().then(async () => {
  log.info('[Main] Application starting...', { hidden: startHidden });

  try {
    // Load encrypted config
    const config = loadConfig();
    log.info('[Main] Config loaded successfully');

    // Initialize upload retry queue
    initUploadQueue();

    // Check if user is enrolled (has profile ID).
    // Profile ID is the enrollment indicator — MSAL auth is supplementary.
    // If MSAL cache is corrupted or token expired, the agent still starts
    // (device-level detection works without MS Graph). MSAL is only needed
    // for Teams transcript override, and the user can re-authenticate via tray.
    let profileId = getConfig('userProfileId');
    let enrolled = !!profileId;

    // ── Auto-recovery: if profileId is lost but we still know the user ──
    // Covers: store corruption recovery, accidental clear, NSIS reinstall
    // that preserved some keys but lost others. Instead of forcing full
    // setup wizard (org key + MS login), silently re-lookup the profile
    // in Supabase using identifiers we may still have (email, MS user ID).
    if (!enrolled) {
      const recoveredId = await tryAutoReEnroll();
      if (recoveredId) {
        profileId = recoveredId;
        enrolled = true;
      }
    }

    if (!enrolled) {
      // Not enrolled: show setup wizard
      log.info('[Main] User not enrolled, showing setup wizard');
      showSetupWindow();
    } else {
      // Already enrolled: start silent operation
      log.info('[Main] Enrolled (profileId exists), starting silent operation');
      registerWatchdog(); // ensure watchdog exists (covers upgrades from older versions)
      startSilentOperation();
    }

    // Initialize system tray
    initTray();

    // Initialize auto-updater
    initUpdater();

  } catch (err) {
    log.error('[Main] Startup failed', { error: err.message });
  }
});

function showSetupWindow() {
  if (setupWindow) {
    setupWindow.focus();
    return;
  }

  setupWindow = new BrowserWindow({
    width: 480,
    height: 720,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    title: 'Scriptor',
    backgroundColor: '#0a0a0f',
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#0a0a0f',
      symbolColor: '#8888a0',
      height: 32,
    },
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.js')
    }
  });

  setupWindow.loadFile(path.join(__dirname, '..', 'renderer', 'setup.html'));

  setupWindow.on('closed', () => {
    setupWindow = null;
  });
}

/**
 * Auto-re-enroll if profileId is missing but we can identify the user.
 * Tries two recovery paths in order:
 *   1. MSAL silent auth → get email → look up profile in Supabase
 *   2. Stored microsoftEmail (survived partial store loss) → look up profile
 * Returns the recovered profileId, or null if recovery impossible.
 */
async function tryAutoReEnroll() {
  try {
    const supabase = getSupabaseClient();
    if (!supabase) return null;

    // Try to recover using stored email (survived partial store loss).
    // employeeEmail is the email the user entered during setup (Google Meet flow).
    // microsoftEmail is the legacy MSAL-based email (kept for backward compat).
    let email = getConfig('employeeEmail') || getConfig('microsoftEmail');

    // If email not in config, try extracting from MSAL token cache (legacy path)
    if (!email) {
      try {
        const authenticated = await isAuthenticated();
        if (authenticated) {
          const token = await require('../auth/msalAuth').getAccessToken();
          if (token) {
            email = getConfig('microsoftEmail');
          }
        }
      } catch (e) {
        log.debug('[Main] MSAL recovery path failed', { error: e.message });
      }
    }

    if (!email) {
      log.info('[Main] Auto-re-enroll: no email available for recovery');
      return null;
    }

    log.info('[Main] Auto-re-enroll: attempting recovery via email', { email });

    // Look up the profile in Supabase by microsoft_email
    const emailNorm = (email || '').trim().toLowerCase();
    const { data: profiles, error } = await supabase
      .from('profiles')
      .select('id, full_name, is_active, is_locked_out, org_id')
      // Use case-insensitive match because admins may enter emails with different casing
      // (e.g. chanderpal.s@... vs Chanderpal.S@...).
      .ilike('microsoft_email', emailNorm)
      .eq('role', 'user')
      .limit(1);

    if (error || !profiles || profiles.length === 0) {
      log.info('[Main] Auto-re-enroll: no matching profile found', { email });
      return null;
    }

    const profile = profiles[0];

    if (profile.is_locked_out || !profile.is_active) {
      log.warn('[Main] Auto-re-enroll: profile is locked/inactive', { email });
      return null;
    }

    // Recovered! Restore the profileId and display name
    setConfig('userProfileId', profile.id);
    if (profile.full_name) setConfig('userDisplayName', profile.full_name);
    log.info('[Main] Auto-re-enroll: SUCCESS — recovered profileId without login', {
      profileId: profile.id,
      fullName: profile.full_name
    });

    return profile.id;
  } catch (err) {
    log.warn('[Main] Auto-re-enroll failed (non-critical)', { error: err.message });
    return null;
  }
}

// Clean up orphaned meetings stuck in 'recording' status from a previous session.
// When the agent is killed or crashes during a meeting, the meeting row stays in
// 'recording' with end_time = start_time (the early-record placeholder). We fix
// the end_time so duration_seconds computes correctly, then mark them 'failed'.
async function cleanupOrphanedRecordings() {
  try {
    const profileId = getConfig('userProfileId');
    if (!profileId) return;

    const supabase = getSupabaseClient();

    // Only clean up records older than 5 minutes. Records younger than this could
    // belong to the current session (race: detection loop starts before cleanup finishes).
    const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const { data: orphans, error } = await supabase
      .from('meetings')
      .select('id, start_time, updated_at')
      .eq('user_id', profileId)
      .eq('status', 'recording')
      .lt('created_at', fiveMinAgo);

    if (error) {
      log.warn('[Main] Failed to query orphaned recordings', { error: error.message });
      return;
    }

    if (!orphans || orphans.length === 0) return;

    log.info('[Main] Cleaning up orphaned recordings', { count: orphans.length });

    for (const meeting of orphans) {
      // Best guess for end_time: use updated_at (last DB write during the session).
      // This is more accurate than "now" because the meeting may have ended hours ago.
      const endTime = meeting.updated_at || new Date().toISOString();

      const { error: updateErr } = await supabase
        .from('meetings')
        .update({ status: 'failed', end_time: endTime })
        .eq('id', meeting.id);

      if (updateErr) {
        log.error('[Main] Failed to clean up orphaned recording', { meetingId: meeting.id, error: updateErr.message });
      } else {
        log.info('[Main] Cleaned up orphaned recording', { meetingId: meeting.id, endTime });
      }
    }
  } catch (err) {
    log.error('[Main] Orphaned recording cleanup failed', { error: err.message });
  }
}

async function recoverStuckMeetings() {
  try {
    const profileId = getConfig('userProfileId');
    if (!profileId) return;

    const supabase = getSupabaseClient();
    const cutoff = new Date(Date.now() - 75 * 60 * 1000).toISOString(); // 75 min ago

    // Find meetings stuck in 'uploaded' older than 75 min (max transcript polling window is 60 min + buffer).
    // Also recover any legacy 'awaiting_teams_transcript' meetings from before the architecture change.
    const { data: stuck, error } = await supabase
      .from('meetings')
      .select('id, status')
      .eq('user_id', profileId)
      .in('status', ['uploaded', 'awaiting_teams_transcript'])
      .lt('created_at', cutoff);

    if (error) {
      log.warn('[Main] Failed to query stuck meetings', { error: error.message });
      return;
    }

    if (!stuck || stuck.length === 0) return;

    log.info('[Main] Recovering stuck meetings', { count: stuck.length });

    for (const meeting of stuck) {
      // For legacy 'awaiting_teams_transcript': update status to 'uploaded' first
      if (meeting.status === 'awaiting_teams_transcript') {
        await supabase
          .from('meetings')
          .update({ status: 'uploaded', teams_transcript_attempt: 99 })
          .eq('id', meeting.id);
      }

      // Re-write transcript_json to itself to fire the AFTER UPDATE OF transcript_json trigger
      const { data: txRow, error: fetchErr } = await supabase
        .from('transcripts')
        .select('transcript_json')
        .eq('meeting_id', meeting.id)
        .single();

      if (fetchErr || !txRow) {
        log.error('[Main] Failed to fetch transcript for recovery', { meetingId: meeting.id, error: fetchErr?.message });
        continue;
      }

      const { error: touchErr } = await supabase
        .from('transcripts')
        .update({ transcript_json: txRow.transcript_json, overridden_at: new Date().toISOString() })
        .eq('meeting_id', meeting.id);

      if (touchErr) {
        log.error('[Main] Failed to touch transcript for recovery', { meetingId: meeting.id, error: touchErr.message });
      } else {
        log.info('[Main] Recovered stuck meeting', { meetingId: meeting.id, previousStatus: meeting.status });
      }
    }
  } catch (err) {
    log.error('[Main] Stuck meeting recovery failed', { error: err.message });
  }
}

// Re-trigger Teams transcript fetch for recent meetings that only have local transcripts.
// Covers cases where: (1) agent was restarted mid-polling, (2) old code had broken fetch,
// (3) transcript wasn't available yet but is now.
async function retryTeamsTranscriptForRecent() {
  try {
    const profileId = getConfig('userProfileId');
    if (!profileId) return;

    const supabase = getSupabaseClient();
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();

    // Find recent Teams meetings that were processed with local transcript (source != 'teams')
    // and never got a Teams transcript override. Use LIKE to match both desktop ('Microsoft Teams')
    // and browser variants ('Microsoft Teams (Chrome)', 'Microsoft Teams (Edge)', etc.)
    const { data: candidates, error } = await supabase
      .from('meetings')
      .select('id, start_time, end_time, detected_app, teams_meeting_id')
      .eq('user_id', profileId)
      .like('detected_app', 'Microsoft Teams%')
      .gte('created_at', twoHoursAgo);

    if (error || !candidates || candidates.length === 0) return;

    // Filter to meetings that need a Teams transcript retry:
    // (a) source='local' — never got Teams transcript
    // (b) source='teams' but segments=0 — corrupted by previous bug (empty VTT override)
    for (const meeting of candidates) {
      const { data: tx } = await supabase
        .from('transcripts')
        .select('source, transcript_json')
        .eq('meeting_id', meeting.id)
        .single();

      if (!tx) continue;

      const segments = tx.transcript_json?.segments || [];
      const needsRetry = tx.source === 'local' ||
        (tx.source === 'teams' && segments.length === 0);

      if (needsRetry) {
        log.info('[Main] Retrying Teams transcript for recent meeting', {
          meetingId: meeting.id,
          currentSource: tx.source,
          currentSegments: segments.length
        });
        try {
          await checkTeamsTranscript({
            meetingId: meeting.id,
            startTime: meeting.start_time,
            endTime: meeting.end_time
          }, 1);
        } catch (err) {
          log.warn('[Main] Startup transcript retry failed', { meetingId: meeting.id, error: err.message });
        }
      }
    }
  } catch (err) {
    log.error('[Main] retryTeamsTranscriptForRecent failed', { error: err.message });
  }
}

// Recover failed Teams meetings by fetching official transcripts via MS Graph.
// Runs once on startup with a delay. Uses the user's own delegated MSAL token
// (no Application Access Policy needed). Safe: read-only checks first, then
// delegates to the existing checkTeamsTranscript() function. All errors caught.
async function recoverFailedTeamsMeetings() {
  try {
    const profileId = getConfig('userProfileId');
    if (!profileId) return;

    const supabase = getSupabaseClient();

    // Find this user's failed Teams meetings (no time limit — recovers all)
    const { data: failed, error } = await supabase
      .from('meetings')
      .select('id, start_time, end_time, detected_app')
      .eq('user_id', profileId)
      .eq('status', 'failed')
      .like('detected_app', 'Microsoft Teams%');

    if (error || !failed || failed.length === 0) return;

    log.info('[Main] Found failed Teams meetings to recover', { count: failed.length });

    for (const meeting of failed) {
      try {
        // Check if a transcript with real content already exists — skip if so
        const { data: tx } = await supabase
          .from('transcripts')
          .select('source, transcript_json')
          .eq('meeting_id', meeting.id)
          .single();

        const hasContent = tx && tx.transcript_json?.segments?.some(s => s.text && s.text.length > 0);
        if (hasContent) {
          log.debug('[Main] Skipping failed meeting — transcript already has content', { meetingId: meeting.id });
          continue;
        }

        // Ensure a transcript row exists (checkTeamsTranscript uses .update(), not .upsert())
        if (!tx) {
          await supabase.from('transcripts').insert({
            meeting_id: meeting.id,
            transcript_json: { segments: [], metadata: { source: 'pending_recovery' } },
            source: 'local'
          });
        }

        log.info('[Main] Attempting Teams transcript recovery for failed meeting', {
          meetingId: meeting.id,
          app: meeting.detected_app
        });

        const success = await checkTeamsTranscript({
          meetingId: meeting.id,
          startTime: meeting.start_time,
          endTime: meeting.end_time
        }, 1);

        if (success) {
          log.info('[Main] Recovered failed meeting via Teams transcript', { meetingId: meeting.id });
        } else {
          log.info('[Main] Teams transcript not available for failed meeting', { meetingId: meeting.id });
        }
      } catch (meetingErr) {
        log.warn('[Main] Failed to recover meeting', { meetingId: meeting.id, error: meetingErr.message });
      }
    }
  } catch (err) {
    log.error('[Main] recoverFailedTeamsMeetings failed', { error: err.message });
  }
}

async function startSilentOperation() {
  log.info('[Main] Starting silent operation mode');

  // Clear any existing intervals to prevent duplicates on re-call
  if (queueRetryInterval) { clearInterval(queueRetryInterval); queueRetryInterval = null; }
  if (tokenCheckInterval) { clearInterval(tokenCheckInterval); tokenCheckInterval = null; }
  if (heartbeatInterval)  { clearInterval(heartbeatInterval);  heartbeatInterval  = null; }

  // Start meeting detection loop immediately — do NOT let startup network calls block it.
  startDetectionLoop();

  // Retry any queued uploads from previous sessions (non-blocking, best-effort)
  retryQueuedItems().catch(e => log.error('[Main] retryQueuedItems failed', { error: e.message }));

  // Clean up orphaned recordings from previous session (non-blocking, best-effort)
  cleanupOrphanedRecordings().catch(e => log.error('[Main] cleanupOrphanedRecordings failed', { error: e.message }));

  // Recover meetings stuck in 'uploaded' or legacy 'awaiting_teams_transcript' (non-blocking)
  recoverStuckMeetings().catch(e => log.error('[Main] recoverStuckMeetings failed', { error: e.message }));

  // Re-try Teams transcript fetch for recent meetings (last 2h) that only have local transcripts
  // Delayed 30s to let auth tokens settle
  setTimeout(() => retryTeamsTranscriptForRecent().catch(e => log.error('[Main] Startup transcript retry error', { error: e.message })), 30 * 1000);

  // Recover failed Teams meetings — delayed 60s to let MSAL tokens fully settle.
  // Uses delegated token (user's own permissions), not app-only.
  setTimeout(() => recoverFailedTeamsMeetings().catch(e => log.error('[Main] Failed meeting recovery error', { error: e.message })), 60 * 1000);

  // Start remote log upload (best-effort, info/warn/error → Supabase, 2-day retention)
  startLogUploader();

  // Periodic retry of queued uploads (every 5 minutes)
  queueRetryInterval = setInterval(async () => {
    try {
      await retryQueuedItems();
    } catch (err) {
      log.error('[Main] Queue retry failed', { error: err.message });
    }
  }, 5 * 60 * 1000);

  // Periodic token health check (every 30 minutes)
  // On failure: log warning but do NOT force logout. Agent continues running with
  // device-level detection (mic, camera, process). MSAL tokens are only needed for
  // Teams transcript override (MS Graph API). User can re-authenticate via tray menu.
  tokenCheckInterval = setInterval(async () => {
    try {
      const valid = await validateTokenOrReauth();
      if (!valid) {
        log.warn('[Main] Token refresh failed — Teams features degraded, re-auth needed via tray');
      }
    } catch (err) {
      log.error('[Main] Token check failed', { error: err.message });
    }
  }, 30 * 60 * 1000);

  // Heartbeat: update last_agent_heartbeat + check lock-out/deactivation (every 5 minutes)
  heartbeatInterval = setInterval(async () => {
    try {
      await performHeartbeat();
    } catch (err) {
      log.error('[Main] Heartbeat failed', { error: err.message });
    }
  }, 5 * 60 * 1000);

  // Immediate first heartbeat
  performHeartbeat().catch(() => {});

  // ── Power management: suspend/resume handling ──
  // Layer 1: Electron powerMonitor events (best-effort, unreliable on W11 24H2 Modern Standby).
  // Layer 2: Time-gap detection in detectionTick() handles the case where these events don't fire.
  powerMonitor.on('suspend', () => {
    log.info('[Main] System suspending — pausing detection');
    stopDetectionLoop();
  });

  powerMonitor.on('resume', () => {
    log.info('[Main] System resumed — restarting detection in 5s');
    // Short delay for hardware to settle (Wi-Fi reconnect, audio devices re-enumerate)
    setTimeout(() => {
      const profileId = getConfig('userProfileId');
      if (profileId) {
        log.info('[Main] Restarting detection loop after resume');
        startDetectionLoop();
      }
    }, 5000);
  });

  powerMonitor.on('lock-screen', () => {
    log.info('[Main] Screen locked');
  });

  powerMonitor.on('unlock-screen', () => {
    log.info('[Main] Screen unlocked');
  });
}

async function performHeartbeat() {
  const profileId = getConfig('userProfileId');
  if (!profileId) return;

  try {
    const supabase = getSupabaseClient();

    // Update heartbeat
    const { error: hbErr } = await supabase
      .from('profiles')
      .update({ last_agent_heartbeat: new Date().toISOString() })
      .eq('id', profileId);
    if (hbErr) log.warn('[Heartbeat] Failed to update heartbeat', { error: hbErr.message });

    // Check if user is locked out or deactivated
    const { data, error } = await supabase
      .from('profiles')
      .select('is_active, is_locked_out, org_id, consent_given')
      .eq('id', profileId)
      .single();

    if (error) {
      log.warn('[Main] Heartbeat status check failed', { error: error.message });
      return;
    }

    if (data && (data.is_locked_out || !data.is_active)) {
      const reason = data.is_locked_out ? 'Account locked out by admin' : 'Account deactivated by admin';
      log.warn('[Main] User status changed, forcing logout', { reason });
      await handleForceLogout(reason);
    }

    // Sync consent_given from DB to local config
    if (data && data.consent_given !== undefined) {
      setConfig('consentGiven', !!data.consent_given);
    }

    // Fetch org-level recording policies and store locally for the detector
    if (data && data.org_id) {
      const { data: orgData } = await supabase
        .from('organizations')
        .select('min_meeting_duration_seconds, exclusion_keywords')
        .eq('id', data.org_id)
        .single();
      if (orgData) {
        if (orgData.min_meeting_duration_seconds != null) {
          setConfig('minMeetingDurationSeconds', orgData.min_meeting_duration_seconds);
        }
        if (Array.isArray(orgData.exclusion_keywords)) {
          setConfig('exclusionKeywords', orgData.exclusion_keywords);
        }
      }
    }
  } catch (err) {
    log.error('[Main] Heartbeat error', { error: err.message });
  }
}

async function handleForceLogout(reason) {
  log.info('[Main] Force logout', { reason });

  // NOTE: Do NOT disable auto-start here. Auto-start is only disabled when the user
  // explicitly logs out via the tray menu. For admin lockout/deactivation, the agent
  // should still auto-start on reboot so it can re-check status (admin may unlock later).

  // Stop detection
  stopDetectionLoop();

  // Clear intervals
  if (tokenCheckInterval) {
    clearInterval(tokenCheckInterval);
    tokenCheckInterval = null;
  }
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
  }

  // Clear local credentials (keep supabase/azure config, clear user-specific data)
  clearUserCredentials();

  // Update tray status to Not Active
  refreshTray();

  // Show setup window for re-enrollment
  showSetupWindow();
}

function clearUserCredentials() {
  const store = getStore();
  store.delete('userProfileId');
  store.delete('microsoftUserId');
  store.delete('microsoftEmail');
  store.delete('employeeEmail');
  store.delete('userDisplayName');
  store.delete('msalCache');
  log.info('[Main] User credentials cleared');
}

// Handle IPC from setup/login renderer
const { ipcMain } = require('electron');

// Step 1: Verify authorization key against Supabase
ipcMain.handle('setup:verify-key', async (_event, key) => {
  try {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from('organizations')
      .select('id, name')
      .eq('authorization_key', key)
      .limit(1)
      .single();

    if (error || !data) {
      return { success: false, error: 'Invalid authorization key. Please check with your admin.' };
    }

    // Store org info temporarily
    setConfig('pendingOrgId', data.id);
    setConfig('pendingOrgName', data.name);

    log.info('[Main] Authorization key verified', { orgName: data.name });
    return { success: true, orgId: data.id, orgName: data.name };
  } catch (err) {
    log.error('[Main] Key verification failed', { error: err.message });
    return { success: false, error: 'Verification failed: ' + err.message };
  }
});

// Step 2: Email verification — employee enters their work email (no Microsoft OAuth needed)
// The admin pre-creates a profile row with the employee's email in profiles.microsoft_email
ipcMain.handle('auth:verify-email', async (_event, email) => {
  try {
    const orgId = getConfig('pendingOrgId');
    if (!orgId) {
      return { success: false, error: 'Organization not set. Please restart setup.' };
    }

    const supabase = getSupabaseClient();
    const emailNorm = (email || '').trim().toLowerCase();
    const { data: profiles, error: findErr } = await supabase
      .from('profiles')
      .select('id, full_name, is_active, is_locked_out, enrolled_at')
      // Use case-insensitive matching because email case can differ.
      .ilike('microsoft_email', emailNorm)
      .eq('org_id', orgId)
      .eq('role', 'user')
      .limit(1);

    if (findErr || !profiles || profiles.length === 0) {
      log.warn('[Main] Verify-email: email not found in org', { email, orgId });
      return {
        success: false,
        error: `No profile found for ${email} in this organization. Ask your admin to add your email first.`
      };
    }

    const profile = profiles[0];

    if (profile.is_locked_out) {
      return { success: false, error: 'This account has been locked out. Contact your administrator.' };
    }
    if (!profile.is_active) {
      return { success: false, error: 'This account has been deactivated. Contact your administrator.' };
    }

    log.info('[Main] Email verified in org', { email, profileId: profile.id });

    // Store email for re-enrollment recovery
    setConfig('employeeEmail', email);

    // Returning user: already enrolled — skip profile form and consent
    if (profile.enrolled_at) {
      log.info('[Main] Returning user, auto-completing enrollment', { profileId: profile.id });

      await supabase
        .from('profiles')
        .update({ last_agent_heartbeat: new Date().toISOString() })
        .eq('id', profile.id);

      setConfig('userProfileId', profile.id);
      setConfig('userDisplayName', profile.full_name);

      const store = getStore();
      store.delete('pendingOrgId');
      store.delete('pendingOrgName');

      app.setLoginItemSettings({ openAtLogin: true, openAsHidden: true, args: ['--hidden'] });
      registerWatchdog();

      // Attempt silent MSAL token refresh for Teams features (Graph API)
      try {
        const { isAuthenticated } = require('../auth/msalAuth');
        const hasMsToken = await isAuthenticated();
        if (!hasMsToken) {
          log.info('[Main] Returning user has no MSAL token — Teams transcript features unavailable until Microsoft sign-in');
        } else {
          log.info('[Main] Returning user has valid MSAL token — Teams features active');
        }
      } catch (msalErr) {
        log.debug('[Main] MSAL check skipped', { error: msalErr.message });
      }

      startSilentOperation();
      refreshTray();

      return { success: true, alreadyEnrolled: true, fullName: profile.full_name, needsMicrosoftSignIn: true };
    }

    return { success: true, alreadyEnrolled: false };
  } catch (err) {
    log.error('[Main] Email verification failed', { error: err.message });
    return { success: false, error: err.message };
  }
});

// Step 3: Complete enrollment — match user profile in Supabase
ipcMain.handle('setup:complete-enrollment', async (_event, data) => {
  try {
    const supabase = getSupabaseClient();
    const orgId = data.orgId || getConfig('pendingOrgId');

    if (!orgId) {
      return { success: false, error: 'Organization not set. Please restart setup.' };
    }

    // Find the pre-configured profile by microsoft_email + org
    const msEmailNorm = (data.msEmail || '').trim().toLowerCase();
    const { data: profiles, error: findError } = await supabase
      .from('profiles')
      .select('id, full_name, is_active, is_locked_out')
      // Use case-insensitive matching because email case can differ.
      .ilike('microsoft_email', msEmailNorm)
      .eq('org_id', orgId)
      .eq('role', 'user')
      .limit(1);

    if (findError) {
      return { success: false, error: 'Database error: ' + findError.message };
    }

    if (!profiles || profiles.length === 0) {
      return {
        success: false,
        error: 'No user profile found for ' + data.msEmail + ' in this organization. Ask your admin to add you first.'
      };
    }

    const profile = profiles[0];

    if (profile.is_locked_out) {
      return { success: false, error: 'This account has been locked out. Contact your administrator.' };
    }

    if (!profile.is_active) {
      return { success: false, error: 'This account has been deactivated. Contact your administrator.' };
    }

    // Update profile with user-provided info
    const fullName = data.firstName + ' ' + data.lastName;
    const consentGiven = data.consentGiven === true;
    const { error: updateError } = await supabase
      .from('profiles')
      .update({
        full_name: fullName,
        job_role: data.role,
        job_role_custom: data.role === 'Other' ? data.customRole : null,
        microsoft_user_id: data.msUserId || null,
        enrolled_at: new Date().toISOString(),
        is_locked_out: false,
        last_agent_heartbeat: new Date().toISOString(),
        consent_given: consentGiven,
        consent_given_at: consentGiven ? new Date().toISOString() : null,
      })
      .eq('id', profile.id);

    if (updateError) {
      return { success: false, error: 'Failed to update profile: ' + updateError.message };
    }

    // Store profile ID, display name, consent, and email in local config
    setConfig('userProfileId', profile.id);
    setConfig('userDisplayName', fullName);
    setConfig('consentGiven', consentGiven);
    if (data.msEmail) setConfig('employeeEmail', data.msEmail);

    // Clean up pending config
    const store = getStore();
    store.delete('pendingOrgId');
    store.delete('pendingOrgName');

    log.info('[Main] Enrollment complete', { profileId: profile.id, fullName });

    // Enable auto-start on Windows boot so the agent survives reboots
    app.setLoginItemSettings({
      openAtLogin: true,
      openAsHidden: true,
      args: ['--hidden']
    });
    registerWatchdog();
    log.info('[Main] Auto-start + watchdog enabled');

    // Start silent operation
    startSilentOperation();
    refreshTray();

    return { success: true, profileId: profile.id };
  } catch (err) {
    log.error('[Main] Enrollment failed', { error: err.message });
    return { success: false, error: 'Enrollment failed: ' + err.message };
  }
});

// Close setup window
ipcMain.handle('setup:close', async () => {
  if (setupWindow) {
    setupWindow.close();
  }
  return { success: true };
});

ipcMain.handle('auth:microsoft-signin', async () => {
  try {
    const { initMsalAuth } = require('../auth/msalAuth');
    const result = await initMsalAuth();
    if (result.success) {
      log.info('[Setup] Microsoft sign-in successful', {
        email: result.account?.username,
        displayName: result.account?.name,
      });
    }
    return result;
  } catch (err) {
    log.error('[Setup] Microsoft sign-in error', { error: err.message });
    return { success: false, error: err.message };
  }
});

ipcMain.handle('auth:status', async () => {
  const profileId = getConfig('userProfileId');
  const enrolled = !!profileId;
  return { authenticated: enrolled, enrolled };
});

// Prevent multiple instances
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}

// Keep app running in tray when window closed
app.on('window-all-closed', (e) => {
  // Do not quit — agent runs in background
});

app.on('before-quit', (event) => {
  log.info('[Main] Application quitting — running graceful shutdown');

  // Stop all periodic timers first
  if (tokenCheckInterval) { clearInterval(tokenCheckInterval); tokenCheckInterval = null; }
  if (heartbeatInterval)  { clearInterval(heartbeatInterval);  heartbeatInterval  = null; }
  if (queueRetryInterval) { clearInterval(queueRetryInterval); queueRetryInterval = null; }

  // Stop detection (flushes any in-progress segment write)
  stopDetectionLoop();

  // Close SQLite queue (flushes WAL, prevents corruption on hard shutdown)
  try {
    const { cleanup } = require('../database/queue');
    cleanup();
  } catch (err) {
    log.error('[Main] Queue cleanup failed', { error: err.message });
  }

  log.info('[Main] Graceful shutdown complete');
});

module.exports = { showSetupWindow, startSilentOperation, handleForceLogout };
