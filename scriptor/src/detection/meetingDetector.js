// file: scriptor/src/detection/meetingDetector.js
const { execSync } = require('child_process');
const fs = require('fs');
const log = require('electron-log');
const path = require('path');
const os = require('os');
const { startMicRecording, stopMicRecording } = require('../audio/micRecorder');
const { startSystemRecording, stopSystemRecording, getRecordingPath } = require('../audio/systemRecorder');
const { hasAudioActivity, resetAudioActivityState } = require('../audio/audioActivityChecker');
const { processMeeting } = require('../pipeline/meetingPipeline');
const { enrichCandidate } = require('../enrichment/preMeetingEnrichment');
const { createMeetingRecord } = require('../api/uploader');
const { getConfig } = require('../main/config');
const { checkTeamsPresence, resetPresenceCache, PRESENCE_AMBIGUOUS_ACTIVITIES } = require('./presenceDetector');
const { setRecordingStatus } = require('../main/tray');

// Detection state machine
const STATE = {
  IDLE: 'IDLE',
  CANDIDATE: 'CANDIDATE',
  RECORDING: 'RECORDING',
  STOPPING: 'STOPPING'
};

let currentState = STATE.IDLE;
let detectionInterval = null;
let candidateTimer = null;
let meetingStartTime = null;
let detectedApp = 'Unknown';
let recordingAppInfo = null; // Stores the app config that triggered recording
let candidateAppConfig = null; // Stores the app config during CANDIDATE debounce
let teamsMeetingInfo = null;
let maxRecordingTimer = null;
let earlyMeetingId = null; // Meeting row ID created at recording start (for dashboard visibility)
let _currentMicPath = null;  // Exact mic recording path for current session
let _currentSysPath = null;  // Exact sys recording path for current session

// Listen-only detection state
let _listenOnlyDetection = false;     // Whether current recording was started without mic
let _candidateIsListenOnly = false;   // Whether current candidate is listen-only
let _listenOnlyStartPriority = 0;     // Which priority signal started the listen-only recording (1-4)
let _presenceNoMicCount = 0;          // Consecutive InAMeeting-only ticks without mic/cam (for Priority 4)
let _teamsUdpHighCount  = 0;          // Consecutive ticks where Teams process-scoped UDP > 30 (for Signal 3.5)
let _presenceEndCount = 0;            // Consecutive non-call ticks during listen-only end detection
let _teamsPresenceMicOffCount = 0;    // Consecutive ticks where Teams mic off + presence null/not-in-meeting (Bug 2 tolerance)
let _lastTitleDefinitive = false;     // Whether last title check was definitively negative (for debounce optimization)
let _lastTickTime = Date.now();       // For sleep/wake detection via time-gap
let _powerSaveBlockerId = null;       // Electron powerSaveBlocker ID during recording
let _candidateEnrichment = null;      // Pre-meeting enrichment data (Layer 3) — populated during CANDIDATE debounce
let _gmeetLastMicActiveTime = 0;     // Timestamp of last mic-active confirmation during Google Meet recording
let _recordingGracePeriodEnd = 0;    // Timestamp until which isMeetingStillActive() always returns true (stabilization)

// Post-meeting cooldown: after a meeting ends, suppress new CANDIDATE creation for the
// same browser process for 30 seconds. This prevents a common false positive where Chrome
// holds the microphone resource ~10-30s after leaving a Google Meet (or any web meeting),
// causing a Teams tab that happens to be open to be falsely detected as a new meeting.
const POST_MEETING_COOLDOWN_MS = 30 * 1000; // 30s — Chrome releases mic within ~10s; 30s is safe margin
let _lastMeetingEndTime = 0;
let _lastMeetingEndProcesses = []; // processes from the most recently ended recording
let _lastMeetingEndAppName = '';   // app name of the most recently ended recording (for cooldown scoping)
let _activeMeetingBrowserProcess = null; // browser process claimed by the active meeting (prevents same browser → two meetings)

// Paths to PowerShell helper scripts
// In production (packaged), bin/ is in extraResources → process.resourcesPath/bin/
// In dev, bin/ is at the project root relative to __dirname
function getBinDir() {
  const { app } = require('electron');
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'bin');
  }
  return path.join(__dirname, '..', '..', 'bin');
}
const _binDir = getBinDir();
const TAB_HELPER_SCRIPT = path.join(_binDir, 'get-browser-tabs.ps1');
const FG_HELPER_SCRIPT = path.join(_binDir, 'get-foreground-window.ps1');
const MIC_HELPER_SCRIPT = path.join(_binDir, 'check-mic-active.ps1');

const POLL_INTERVAL_MS = 3000;
const DEBOUNCE_MS = 10000; // 10s debounce before confirming meeting (reduced from 30s to minimize initial word loss)
const BROWSER_TITLE_DEBOUNCE_MS = 5000; // 5s debounce for browser-based meetings with strong tab title match
const GMEET_MIC_CONFIRMED_DEBOUNCE_MS = 2000; // 2s debounce when mic already active (user already in call) — applies to all apps
const LISTEN_ONLY_DEBOUNCE_MS = 60000; // 60s debounce for weak listen-only signals (InAMeeting-only, Priority 4)
const STOP_DEBOUNCE_MS = 30000; // 30s debounce before ending meeting (title-based apps, was 60s — tightened to reduce post-meeting audio capture)
const BROWSER_DEFINITIVE_STOP_DEBOUNCE_MS = 15000; // 15s debounce when browser tab title definitively gone
const GMEET_STOP_DEBOUNCE_MS = 15000; // 15s debounce for Google Meet end — allows time for brief signal drops without fragmenting
const TEAMS_MIC_STOP_DEBOUNCE_MS = 5000;  // 5s debounce for Teams desktop mic release — Teams 2.0 releases mic on mute,
                                           // but we already tolerate 4 consecutive Presence-null ticks (~28s) before this
                                           // debounce fires, so the combined window (~33s) is enough to survive a brief mute
                                           // without fragmenting the meeting.
const LISTEN_ONLY_STOP_DEBOUNCE_MS = 30000; // 30s debounce for listen-only InACall-based end detection
const LISTEN_ONLY_WEAK_STOP_DEBOUNCE_MS = 60000; // 60s debounce for listen-only InAMeeting-based end detection
const PRESENCE_END_TICKS_REQUIRED = 5; // 5 consecutive non-call ticks (~25s) to confirm end — extra buffer for API blips
const SUSTAINED_PRESENCE_TICKS  = 10; // 10 consecutive ticks (~50s) for weak InAMeeting-only detection (Priority 4)
const TEAMS_UDP_SUSTAINED_TICKS = 5;  // 5 consecutive ticks (~25s) of process-scoped high UDP before Signal 3.5 fires.
                                       // A real Teams call keeps SRTP/ICE ports open continuously; background
                                       // Teams activity (presence updates, notifications) creates short bursts only.
const MIN_MEETING_DURATION_MS = 30000; // Skip meetings shorter than 30s (accidental joins)
const MAX_RECORDING_MS = 4 * 60 * 60 * 1000; // 4 hours
const SLEEP_GAP_THRESHOLD_MS = 30000; // 30s gap between ticks = likely wake from sleep/hibernate
const GMEET_MIC_GRACE_PERIOD_MS = 45000; // 45s — keep Google Meet alive if mic was active within this window
const RECORDING_GRACE_PERIOD_MS = 20000; // 20s — skip end-detection after recording starts (signal stabilization)

// ── Browser + web meeting auto-generation ──
const BROWSERS = [
  { process: 'chrome.exe', label: 'Chrome' },
  { process: 'msedge.exe', label: 'Edge' },
  { process: 'brave.exe', label: 'Brave' },
  { process: 'firefox.exe', label: 'Firefox' },
  { process: 'opera.exe', label: 'Opera' },
  { process: 'vivaldi.exe', label: 'Vivaldi' },
  { process: 'Arc.exe', label: 'Arc' },
];

const BROWSER_PROCESS_SET = new Set(BROWSERS.map(b => b.process.toLowerCase()));

const WEB_MEETINGS = [
  { name: 'Microsoft Teams', titlePatterns: ['teams.microsoft.com', 'teams.live.com', 'teams.cloud.microsoft', 'Meet App |', 'Meeting with', 'Call with', '| Microsoft Teams'], isTeams: true, needsMicConfirm: true },
  { name: 'Google Meet', titlePatterns: ['- Google Meet', 'Google Meet', 'meet - '], isTeams: false, needsMicConfirm: false, isGoogleMeet: true },
  { name: 'Zoom', titlePatterns: ['zoom.us/j', 'zoom.us/wc'], isTeams: false, needsMicConfirm: false },
  { name: 'Webex', titlePatterns: ['webex.com/meet', 'webex.com/join', 'Webex Meeting'], isTeams: false, needsMicConfirm: false },
  { name: 'GoTo Meeting', titlePatterns: ['gotomeet.me', 'goto.com/meeting', 'GoTo Meeting'], isTeams: false, needsMicConfirm: false },
  { name: 'Slack Huddle', titlePatterns: ['Slack | Huddle', 'slack.com/huddle'], isTeams: false, needsMicConfirm: false },
];

const TEAMS_PROCESSES = ['Teams.exe', 'ms-teams.exe', 'ms-teams_modulehost.exe'];
const TEAMS_PROCESS_SET = new Set(TEAMS_PROCESSES.map(p => p.toLowerCase()));

const DESKTOP_APPS = [
  { name: 'Microsoft Teams', processes: TEAMS_PROCESSES, titlePatterns: ['| Microsoft Teams', 'Meet App |', 'Meeting with', 'Call with', 'Microsoft Teams Meeting', 'Microsoft Teams call'], isTeams: true, needsMicConfirm: true },
  { name: 'Zoom', processes: ['Zoom.exe'], titlePatterns: ['Zoom Meeting'], isTeams: false, needsMicConfirm: false },
  { name: 'Webex', processes: ['CiscoCollabHost.exe', 'webexmta.exe'], titlePatterns: ['Webex Meeting', 'Meeting Center'], isTeams: false, needsMicConfirm: false },
  { name: 'Slack', processes: ['slack.exe'], titlePatterns: ['Huddle'], isTeams: false, needsMicConfirm: false },
];

const MEETING_APPS = [
  ...DESKTOP_APPS,
  ...WEB_MEETINGS.flatMap(meeting =>
    BROWSERS.map(browser => ({
      name: `${meeting.name} (${browser.label})`,
      processes: [browser.process],
      titlePatterns: meeting.titlePatterns,
      isTeams: meeting.isTeams,
      needsMicConfirm: meeting.needsMicConfirm,
      isGoogleMeet: meeting.isGoogleMeet || false,
    }))
  ),
];

// Build target process set for quick lookup
const TARGET_PROCESSES = [...new Set(MEETING_APPS.flatMap(a => a.processes))];

// Build a lowercase set for quick lookup
const _targetProcessSet = new Set(TARGET_PROCESSES.map(p => p.toLowerCase()));

// URL/suffix patterns that are unambiguously Teams-only (used in browser Teams detection)
const TEAMS_STRONG_PATTERNS = new Set([
  'teams.microsoft.com', 'teams.live.com', 'teams.cloud.microsoft',
  'meet app |', '| microsoft teams'
]);

// Returns true if the given process list overlaps with the last-ended meeting's processes
// AND we're still within the 90-second post-meeting cooldown window.
// Used to suppress false-positive CANDIDATE creation when Chrome holds the mic
// after leaving a Google Meet (Chrome retains the mic handle ~30s for fast reconnect).
function isInPostMeetingCooldown(processes) {
  if (!_lastMeetingEndTime || _lastMeetingEndProcesses.length === 0) return false;
  if (Date.now() - _lastMeetingEndTime > POST_MEETING_COOLDOWN_MS) return false;
  return processes.some(p =>
    _lastMeetingEndProcesses.some(ep => ep.toLowerCase() === p.toLowerCase())
  );
}

function getRunningProcesses() {
  try {
    // Single tasklist call for ALL processes — much faster than per-process /FI spawns.
    // Previously spawned ~20 separate tasklist commands every 5s tick.
    const output = execSync('tasklist /FO CSV /NH', {
      encoding: 'utf8',
      timeout: 5000,
      windowsHide: true
    });
    const found = new Set();
    for (const line of output.split('\n')) {
      const match = line.match(/"([^"]+)"/);
      if (match && !match[1].startsWith('INFO:')) {
        if (_targetProcessSet.has(match[1].toLowerCase())) {
          found.add(match[1]);
        }
      }
    }
    return [...found];
  } catch (err) {
    log.error('[Detector] Failed to get process list', { error: err.message });
    return [];
  }
}

async function getActiveWindowInfo() {
  // Try active-win first (native, fast) — returns title + process name
  try {
    const activeWin = require('active-win');
    const win = await activeWin();
    if (win && win.title) {
      return { title: win.title, processName: (win.owner?.name || '').toLowerCase() };
    }
  } catch (err) {
    // active-win failed, fall through to PowerShell fallback
  }

  // Fallback: PowerShell helper script that returns "title|processname"
  try {
    const output = execSync(
      `powershell -NoProfile -ExecutionPolicy Bypass -File "${FG_HELPER_SCRIPT}"`,
      { encoding: 'utf8', timeout: 5000, windowsHide: true }
    );
    const trimmed = output.trim();
    const sepIdx = trimmed.lastIndexOf('|');
    if (sepIdx > 0) {
      return {
        title: trimmed.substring(0, sepIdx),
        processName: trimmed.substring(sepIdx + 1).toLowerCase()
      };
    }
    return { title: trimmed, processName: '' };
  } catch (err) {
    log.debug('[Detector] Failed to get foreground window info', { error: err.message });
    return { title: '', processName: '' };
  }
}

// Get ALL open browser tab titles using Windows UI Automation API
// This detects non-active tabs, solving the tab-switching problem entirely
function getBrowserTabTitles() {
  try {
    const output = execSync(
      `powershell -NoProfile -ExecutionPolicy Bypass -File "${TAB_HELPER_SCRIPT}"`,
      { encoding: 'utf8', timeout: 8000, windowsHide: true }
    );
    const trimmed = output.trim();
    if (!trimmed) return [];
    const parsed = JSON.parse(trimmed);
    // PowerShell ConvertTo-Json returns a string for single item, array for multiple
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch (err) {
    log.debug('[Detector] Failed to get browser tabs', { error: err.message });
    return [];
  }
}

// Check if any meeting app is currently using the microphone via Windows Registry.
// HKCU:\...\CapabilityAccessManager\ConsentStore\microphone
// When LastUsedTimeStop == 0, the app is CURRENTLY using the mic.
// Returns { micActive: boolean, apps: string[] }
let _lastMicCheck = { time: 0, result: { micActive: false, apps: [] } };
const MIC_CHECK_CACHE_MS = 3000; // Cache mic check for 3s (matches poll interval) — stale mic data caused false meeting endings

function getMicActiveApps() {
  // Return cached result if recent enough
  const now = Date.now();
  if (now - _lastMicCheck.time < MIC_CHECK_CACHE_MS) {
    return _lastMicCheck.result;
  }

  try {
    const output = execSync(
      `powershell -NoProfile -ExecutionPolicy Bypass -File "${MIC_HELPER_SCRIPT}"`,
      { encoding: 'utf8', timeout: 5000, windowsHide: true }
    );
    const parsed = JSON.parse(output.trim());
    _lastMicCheck = { time: now, result: parsed };
    return parsed;
  } catch (err) {
    log.debug('[Detector] Failed to check mic registry', { error: err.message });
    // On error, assume mic is active to avoid false negatives
    return { micActive: true, apps: [] };
  }
}

// Check if a specific meeting app (by process name) is using the microphone
// Registry stores paths like "C:#Program Files#Google#Chrome#Application#chrome.exe"
// and packaged apps like "MSTeams_8wekyb3d8bbwe"
function isAppUsingMic(appProcesses) {
  const micInfo = getMicActiveApps();
  if (!micInfo.micActive) return false;

  // If micActive is true but apps list is empty, the PowerShell script failed and
  // getMicActiveApps() returned the error fallback { micActive: true, apps: [] }.
  // Honour the intent: assume the app IS using the mic rather than falsely ending the meeting.
  if (micInfo.apps.length === 0) return true;

  const appsLower = micInfo.apps.map(a => a.toLowerCase());
  return appProcesses.some(proc => {
    const procLower = proc.toLowerCase().replace('.exe', '');
    return appsLower.some(app => {
      // NonPackaged: path contains process name (e.g., "c:#...#chrome.exe")
      if (app.includes(procLower)) return true;
      // Packaged: Teams shows as "MSTeams_8wekyb3d8bbwe" or similar
      if (procLower.includes('teams') && app.includes('teams')) return true;
      return false;
    });
  });
}

// Check if a specific meeting app (by process name) is using the webcam
// Uses the same cached getMicActiveApps() call (which now includes camActive/camApps)
function isAppUsingCamera(appProcesses) {
  const micInfo = getMicActiveApps();
  if (!micInfo.camActive) return false;

  const camAppsLower = (micInfo.camApps || []).map(a => a.toLowerCase());
  return appProcesses.some(proc => {
    const procLower = proc.toLowerCase().replace('.exe', '');
    return camAppsLower.some(app => {
      if (app.includes(procLower)) return true;
      if (procLower.includes('teams') && app.includes('teams')) return true;
      return false;
    });
  });
}

// Get window titles from Teams desktop processes (for meeting keyword matching)
// Teams title patterns: "Meeting with ...", "Call with ...", "In a call", etc.
const TEAMS_MEETING_TITLE_KEYWORDS = [
  'meeting', 'call with', 'meet app',
  'in a call', 'on a call', 'meeting in progress', 'is sharing', 'screen sharing',
];

// Stricter keyword set used for meeting START detection (Priority 3 InAMeeting+title check).
// Excludes 'meeting' because Teams channel/group names often contain that word, causing
// false positives when Teams is open on a channels/chat view with no active call.
const TEAMS_CALL_TITLE_KEYWORDS = [
  'call with', 'meet app',
  'in a call', 'on a call', 'meeting in progress', 'is sharing', 'screen sharing',
];

function getTeamsDesktopWindowTitles() {
  try {
    const appProcessNames = TEAMS_PROCESSES.map(p => p.replace('.exe', ''));
    const filter = appProcessNames.map(n => `'${n}'`).join(',');
    const output = execSync(
      `powershell -NoProfile -Command "Get-Process -Name ${filter} -ErrorAction SilentlyContinue | Where-Object {$_.MainWindowTitle} | Select-Object -ExpandProperty MainWindowTitle"`,
      { encoding: 'utf8', timeout: 5000, windowsHide: true }
    );
    return output.split('\n').map(t => t.trim()).filter(Boolean);
  } catch (err) {
    return [];
  }
}

function teamsDesktopTitleHasMeetingKeywords() {
  const titles = getTeamsDesktopWindowTitles();
  return titles.some(title => {
    const lower = title.toLowerCase();
    return TEAMS_MEETING_TITLE_KEYWORDS.some(kw => lower.includes(kw));
  });
}

// Stricter version for meeting START detection — uses TEAMS_CALL_TITLE_KEYWORDS which
// excludes 'meeting' to avoid false positives from channel/group names.
function teamsDesktopTitleHasCallKeywords() {
  const titles = getTeamsDesktopWindowTitles();
  return titles.some(title => {
    const lower = title.toLowerCase();
    return TEAMS_CALL_TITLE_KEYWORDS.some(kw => lower.includes(kw));
  });
}

// Check if a Teams call is active by counting high UDP ephemeral endpoints that belong
// specifically to the ms-teams.exe process.
//
// Filtering to the Teams PID is critical: system-wide UDP counts include Chrome, Outlook,
// and any WebRTC app, which can easily exceed 50 even with no Teams meeting in progress.
// By scoping to ms-teams.exe we only see Teams' own SRTP/ICE media ports:
//   Teams desktop idle    : ~5-20 process-owned UDP ports > 49152
//   Teams desktop in call : ~40-100+ process-owned UDP ports > 49152
// Threshold: > 30 (process-scoped, so lower than the old system-wide 50 is fine).
// Cached for 10s to avoid running a heavyweight PowerShell every tick.
let _lastUdpCheck = { time: 0, active: false, count: 0 };
const UDP_CHECK_CACHE_MS = 10000;

function isTeamsCallActive() {
  const now = Date.now();
  if (now - _lastUdpCheck.time < UDP_CHECK_CACHE_MS) return _lastUdpCheck.active;
  try {
    // Scope the query to ms-teams.exe only — eliminates noise from all other processes.
    const ps = '$p=Get-Process ms-teams -EA SilentlyContinue|Select-Object -First 1;' +
               'if($p){(Get-NetUDPEndpoint -OwningProcess $p.Id|' +
               'Where-Object{$_.LocalPort -gt 49152}).Count}else{0}';
    const result = execSync(
      `powershell -NoProfile -NonInteractive -Command "${ps}"`,
      { timeout: 4000, encoding: 'utf8', windowsHide: true }
    ).trim();
    const udpCount = parseInt(result, 10);
    const active = !isNaN(udpCount) && udpCount > 30;
    _lastUdpCheck = { time: now, active, count: udpCount };
    return active;
  } catch (err) {
    log.debug('[Detector] UDP endpoint check failed', { error: err.message });
    return false;
  }
}

// When a listen-only meeting is detected via the PRIMARY presence block (Teams desktop
// running), the InACall signal is account-level — it fires even if the actual meeting
// is in a browser. This helper checks if a browser has a Teams meeting tab open and
// returns the correct app attribution (e.g., "Microsoft Teams (Chrome)" instead of
// "Microsoft Teams").
function resolveListenOnlyApp(teamsApp, processes) {
  const tabTitles = getBrowserTabTitles();
  for (const browser of BROWSERS) {
    const browserRunning = processes.some(p => p.toLowerCase() === browser.process.toLowerCase());
    if (!browserRunning) continue;

    // Check if this browser has a Teams meeting tab
    const teamsWebConfig = WEB_MEETINGS.find(wm => wm.isTeams);
    if (!teamsWebConfig) continue;

    const hasTeamsTab = teamsWebConfig.titlePatterns.some(pattern =>
      tabTitles.some(title => title.toLowerCase().includes(pattern.toLowerCase()))
    );

    if (hasTeamsTab) {
      const appName = `Microsoft Teams (${browser.label})`;
      const appConfig = MEETING_APPS.find(a => a.name === appName);
      if (appConfig) {
        return { appName, appConfig };
      }
    }
  }
  // No browser tab found — keep desktop attribution
  return { appName: teamsApp.name, appConfig: teamsApp };
}

// Detection for IDLE/CANDIDATE: uses foreground window title + process ownership
// For Teams desktop: uses Graph Presence API as PRIMARY signal (title-independent)
// For other apps: uses foreground title + process matching
let _lastPresenceResult = null; // Cached for use in the same tick

// Background tab scan throttle — avoid running ~1s PowerShell every 5s tick
const BG_TAB_SCAN_INTERVAL_MS = 8000; // Scan tabs every 8s (reduced from 15s for faster Google Meet background tab detection)
let _lastBgTabScanTime = 0;

// Google Meet mic-release end detection:
// When a Google Meet recording is active, track whether the browser's mic was ever active.
// If mic goes from active → inactive while the title signal is also gone, that's a clean
// meeting-end signal. Unlike Teams, Chrome releases the mic handle promptly when leaving Meet.
let _browserMicWasActive = false;  // Mic was active at some point during this Google Meet recording
let _lastBrowserMicReleased = false; // Mic transitioned from active → inactive during this recording

async function detectMeetingSignals(processes, fgTitle, fgProcessName) {
  const titleLower = fgTitle.toLowerCase();
  const fgProcLower = (fgProcessName || '').toLowerCase().replace('.exe', '');

  // Reset per-tick presence cache — stale data from previous ticks can block detection
  _lastPresenceResult = null;

  // ── PRIMARY: Teams process + device signals (mic, camera) — Presence-independent ──
  // If ms-teams.exe is running, check mic/camera FIRST before Presence.
  // Mic/camera active for Teams = definitive meeting signal that works even when
  // the user has manually overridden their Teams status (which suppresses the
  // Presence API InACall/InAMeeting activity fields).
  // Presence API is a SUPPLEMENTARY signal for listen-only detection (mic+camera off).
  const teamsProcessRunning = processes.some(p => TEAMS_PROCESS_SET.has(p.toLowerCase()));
  if (teamsProcessRunning) {
    const presence = await checkTeamsPresence();
    _lastPresenceResult = presence;
    const teamsApp = DESKTOP_APPS.find(a => a.isTeams);

    // ── Signal 1: Teams desktop mic active = meeting ──
    // Use getMicActiveApps() directly so we can distinguish a definitive mic claim
    // (Teams appears in the apps list) from a PowerShell failure fallback (apps: []).
    // When the registry check fails, getMicActiveApps() returns { micActive: true, apps: [] }
    // to avoid falsely ending an already-running meeting — but we must NOT use that
    // error-fallback to START a new meeting, as it causes false positives when Teams
    // is open with no call and the PowerShell script happens to fail.
    const micInfo = getMicActiveApps();
    const micDefinitivelyActive = micInfo.micActive && micInfo.apps.length > 0 &&
      teamsApp.processes.some(proc => {
        const procLower = proc.toLowerCase().replace('.exe', '');
        return micInfo.apps.map(a => a.toLowerCase()).some(app =>
          app.includes(procLower) || (procLower.includes('teams') && app.includes('teams'))
        );
      });

    // If apps list is empty (PowerShell failed), only trust the mic signal if Presence
    // also confirms the user is in a meeting — avoids false starts on registry errors.
    const micActive = micDefinitivelyActive ||
      (micInfo.micActive && micInfo.apps.length === 0 && presence && presence.inMeeting);

    if (micActive) {
      log.info('[Detector] Teams meeting detected via mic active', {
        definitive: micDefinitivelyActive,
        presenceBacked: !micDefinitivelyActive,
        activity: presence ? presence.activity : 'N/A',
        availability: presence ? presence.availability : 'N/A'
      });
      return {
        detected: true,
        appName: teamsApp.name,
        appConfig: teamsApp,
        isTeams: true,
        windowTitle: fgTitle,
        micConfirmed: true,
      };
    }

    // ── Signal 2: Browser mic active while Teams desktop is running ──
    // Presence API is account-level — InACall fires regardless of desktop vs browser.
    // Check if any running browser has mic active → that browser has the Teams meeting.
    // IMPORTANT: Before attributing to Teams, check tab titles. If a non-Teams meeting
    // platform (Google Meet, Zoom, Webex, etc.) is open in that browser, attribute to
    // that platform instead. Teams desktop running alongside Google Meet is common.
    for (const browser of BROWSERS) {
      const browserRunning = processes.some(p => p.toLowerCase() === browser.process.toLowerCase());
      if (!browserRunning) continue;
      if (isAppUsingMic([browser.process])) {
        // Guard: if this browser is already claimed by an active non-Teams meeting
        // (e.g., Google Meet), don't also attribute it to Teams.
        if (_activeMeetingBrowserProcess &&
            _activeMeetingBrowserProcess.toLowerCase() === browser.process.toLowerCase()) {
          log.info('[Detector] Signal 2: browser already claimed by active meeting — skipping', { browser: browser.label });
          continue;
        }

        // Check tab titles for non-Teams meeting platforms first
        const tabTitles = getBrowserTabTitles();

        const nonTeamsWebMeeting = WEB_MEETINGS.filter(wm => !wm.isTeams).find(wm =>
          wm.titlePatterns.some(pattern =>
            tabTitles.some(t => t.toLowerCase().includes(pattern.toLowerCase())) ||
            titleLower.includes(pattern.toLowerCase())
          )
        );
        if (nonTeamsWebMeeting) {
          const nonTeamsAppName = `${nonTeamsWebMeeting.name} (${browser.label})`;
          const nonTeamsAppConfig = MEETING_APPS.find(a => a.name === nonTeamsAppName);
          if (nonTeamsAppConfig) {
            log.info('[Detector] Non-Teams browser meeting detected via browser mic (Teams desktop also running)', {
              platform: nonTeamsWebMeeting.name, browser: browser.label,
              activity: presence ? presence.activity : 'N/A'
            });
            return {
              detected: true,
              appName: nonTeamsAppName,
              appConfig: nonTeamsAppConfig,
              isTeams: false,
              windowTitle: fgTitle,
              micConfirmed: true,
            };
          }
        }

        // Guard: if tab scan returned empty, we can't confirm what's using the mic.
        // Don't default to Teams — it's likely another platform (e.g., Google Meet)
        // whose tab wasn't enumerated due to intermittent PowerShell failure.
        if (tabTitles.length === 0) {
          log.info('[Detector] Signal 2: tab scan returned empty — skipping Teams fallback to avoid false attribution', { browser: browser.label });
          continue;
        }

        // No non-Teams meeting found — attribute to Teams browser meeting
        const appName = `Microsoft Teams (${browser.label})`;
        const appConfig = MEETING_APPS.find(a => a.name === appName);
        if (appConfig) {
          log.info('[Detector] Teams browser meeting detected via browser mic', {
            activity: presence ? presence.activity : 'N/A', browser: browser.label
          });
          return {
            detected: true,
            appName,
            appConfig,
            isTeams: true,
            windowTitle: fgTitle,
            micConfirmed: true,
          };
        }
      }
    }

    // ── Signal 3: Camera active for Teams (Presence-independent) ──
    // Camera on for Teams = strong meeting signal even without Presence confirmation.
    // Works when user has manually overridden their status.
    if (isAppUsingCamera(teamsApp.processes)) {
      const resolved = resolveListenOnlyApp(teamsApp, processes);
      log.info('[Detector] Teams meeting detected via camera active (no mic)', {
        activity: presence ? presence.activity : 'N/A', attributedTo: resolved.appName
      });
      _presenceNoMicCount = 0;
      return {
        detected: true,
        appName: resolved.appName,
        appConfig: resolved.appConfig,
        isTeams: true,
        windowTitle: fgTitle,
        detectedWithoutMic: true,
        listenOnlyPriority: 2
      };
    }

    // ── Signal 3.5: UDP endpoints indicate an active Teams call (Presence may be missing) ──
    // If the user is in a Teams call but mic/camera are off (listen-only) and the
    // Graph Presence API isn't available (no MSAL token / token fetch failure),
    // Presence-based detection won't fire.
    //
    // SAFETY: We require TEAMS_UDP_SUSTAINED_TICKS (~25s) of continuous high UDP
    // from the ms-teams.exe process (process-scoped, not system-wide) before
    // accepting this as a meeting.  This filters out:
    //   - Momentary background bursts when Teams syncs notifications/presence
    //   - False positives from Chrome, Outlook, or other apps using UDP >49152
    //   - Brief spikes when Teams reconnects after a network change
    // A real SRTP/ICE media session keeps the ports open continuously for the
    // duration of the call, so sustained = reliable.
    const udpActive = isTeamsCallActive();
    if (udpActive) {
      _teamsUdpHighCount++;
    } else {
      _teamsUdpHighCount = 0;
    }
    if (udpActive && _teamsUdpHighCount >= TEAMS_UDP_SUSTAINED_TICKS) {
      const resolved = resolveListenOnlyApp(teamsApp, processes);
      log.info('[Detector] Teams meeting detected via sustained UDP endpoints (no mic/cam, Presence optional)', {
        activity: presence ? presence.activity : 'N/A',
        attributedTo: resolved.appName,
        udpTicks: _teamsUdpHighCount,
        teamsUdpCount: _lastUdpCheck.count,
      });
      _presenceNoMicCount = 0;
      _teamsUdpHighCount  = 0; // reset after firing so it doesn't immediately re-trigger
      return {
        detected: true,
        appName: resolved.appName,
        appConfig: resolved.appConfig,
        isTeams: true,
        windowTitle: fgTitle,
        detectedWithoutMic: true,
        listenOnlyPriority: 3
      };
    }

    // ── Signal 4: Presence-based listen-only detection (supplementary, not a gate) ──
    // Only reached when mic AND camera are both off. Presence becomes a boost signal
    // for detecting meetings where the user is listening only.
    if (presence && presence.inMeeting) {
      // Priority 1: InACall/InAConferenceCall — user has ACTUALLY joined (definitive)
      if (presence.isActiveCall) {
        const resolved = resolveListenOnlyApp(teamsApp, processes);
        log.info('[Detector] Listen-only Teams meeting detected via InACall (no mic/camera)', {
          activity: presence.activity, attributedTo: resolved.appName
        });
        _presenceNoMicCount = 0;
        return {
          detected: true,
          appName: resolved.appName,
          appConfig: resolved.appConfig,
          isTeams: true,
          windowTitle: fgTitle,
          detectedWithoutMic: true,
          listenOnlyPriority: 1
        };
      }

      // Priority 3: InAMeeting (calendar) + Teams desktop title has call-specific keywords
      // Uses stricter keyword set (TEAMS_CALL_TITLE_KEYWORDS) to avoid matching channel/group
      // names that contain 'meeting' when Teams is just open with no active call.
      if (teamsDesktopTitleHasCallKeywords()) {
        const resolved = resolveListenOnlyApp(teamsApp, processes);
        log.info('[Detector] Listen-only Teams meeting detected via InAMeeting + title keywords', {
          activity: presence.activity, attributedTo: resolved.appName
        });
        _presenceNoMicCount = 0;
        return {
          detected: true,
          appName: resolved.appName,
          appConfig: resolved.appConfig,
          isTeams: true,
          windowTitle: fgTitle,
          detectedWithoutMic: true,
          listenOnlyPriority: 3
        };
      }

      // Priority 3.5: InAMeeting + high UDP endpoint count (>20 = active media session)
      // Catches minimized/multi-monitor Teams calls where title check can't confirm.
      // Single-tick signal — no sustained requirement needed (UDP count is hard evidence).
      if (isTeamsCallActive()) {
        const resolved = resolveListenOnlyApp(teamsApp, processes);
        log.info('[Detector] Listen-only Teams meeting detected via InAMeeting + UDP endpoints', {
          activity: presence.activity, attributedTo: resolved.appName
        });
        _presenceNoMicCount = 0;
        return {
          detected: true,
          appName: resolved.appName,
          appConfig: resolved.appConfig,
          isTeams: true,
          windowTitle: fgTitle,
          detectedWithoutMic: true,
          listenOnlyPriority: 3,
        };
      }

      // Priority 4: InAMeeting (calendar) + sustained ticks without any other signal
      // This catches browser Teams where we can't verify title.
      // Requires SUSTAINED_PRESENCE_TICKS consecutive ticks to reduce calendar false positives.
      _presenceNoMicCount++;
      if (_presenceNoMicCount >= SUSTAINED_PRESENCE_TICKS) {
        log.info('[Detector] Listen-only Teams meeting detected via sustained InAMeeting', {
          activity: presence.activity, ticks: _presenceNoMicCount
        });
        return {
          detected: true,
          appName: teamsApp.name,
          appConfig: teamsApp,
          isTeams: true,
          windowTitle: fgTitle,
          detectedWithoutMic: true,
          listenOnlyPriority: 4
        };
      }

      log.debug('[Detector] Presence says InAMeeting but no definitive listen-only signal yet', {
        activity: presence.activity, presenceNoMicCount: _presenceNoMicCount
      });
    } else if (presence && !presence.inMeeting) {
      _presenceNoMicCount = 0; // Reset sustained counter when Presence says not in meeting
    }

    // ── NO LONGER SKIPPING Teams desktop title matching ──
    // Previously, when Presence said not-in-meeting, Teams desktop was skipped entirely.
    // This caused missed detections when users manually overrode their Teams status.
    // Now we fall through to the title+process matching below, which handles:
    // - Teams desktop in foreground with meeting title + mic/camera confirmation
    // - This is safe because the title matcher requires needsMicConfirm for Teams
  }

  // ── Ensure presence data is available for browser-only Teams scenarios ──
  // If Teams desktop isn't running, the presence check above was skipped.
  // Fetch it now so listen-only fallbacks in the title/tab sections below have data.
  // The Presence API is account-level — it returns InACall even for browser-only meetings.
  const anyBrowserRunningForPresence = processes.some(p => BROWSER_PROCESS_SET.has(p.toLowerCase()));
  if (!teamsProcessRunning && anyBrowserRunningForPresence && _lastPresenceResult === null) {
    const browserPresence = await checkTeamsPresence();
    _lastPresenceResult = browserPresence;

    // If InACall is confirmed and a browser is running, we can detect listen-only
    // directly here — the user is in a Teams call via browser, no mic needed.
    if (browserPresence && browserPresence.inMeeting) {
      // Find which browser is running to attribute the meeting
      const activeBrowser = BROWSERS.find(b =>
        processes.some(p => p.toLowerCase() === b.process.toLowerCase())
      );
      if (activeBrowser) {
        const appName = `Microsoft Teams (${activeBrowser.label})`;
        const appConfig = MEETING_APPS.find(a => a.name === appName);

        if (appConfig) {
          // Check mic first (standard path)
          if (isAppUsingMic([activeBrowser.process])) {
            log.info('[Detector] Teams browser meeting detected via Presence API + browser mic (no desktop)', {
              activity: browserPresence.activity, browser: activeBrowser.label
            });
            return {
              detected: true,
              appName,
              appConfig,
              isTeams: true,
              windowTitle: fgTitle
            };
          }

          // Listen-only Priority 1: InACall (definitive)
          if (browserPresence.isActiveCall) {
            log.info('[Detector] Listen-only Teams browser meeting detected via InACall (no desktop, no mic)', {
              activity: browserPresence.activity, browser: activeBrowser.label
            });
            _presenceNoMicCount = 0;
            return {
              detected: true,
              appName,
              appConfig,
              isTeams: true,
              windowTitle: fgTitle,
              detectedWithoutMic: true,
              listenOnlyPriority: 1
            };
          }

          // Listen-only Priority 2: Camera active for this browser
          if (isAppUsingCamera([activeBrowser.process])) {
            log.info('[Detector] Listen-only Teams browser meeting detected via camera (no desktop, no mic)', {
              activity: browserPresence.activity, browser: activeBrowser.label
            });
            _presenceNoMicCount = 0;
            return {
              detected: true,
              appName,
              appConfig,
              isTeams: true,
              windowTitle: fgTitle,
              detectedWithoutMic: true,
              listenOnlyPriority: 2
            };
          }

          // Priority 4: Sustained InAMeeting (no InACall, no mic, no camera — browser can't verify title)
          _presenceNoMicCount++;
          if (_presenceNoMicCount >= SUSTAINED_PRESENCE_TICKS) {
            log.info('[Detector] Listen-only Teams browser meeting detected via sustained InAMeeting (no desktop)', {
              activity: browserPresence.activity, ticks: _presenceNoMicCount, browser: activeBrowser.label
            });
            return {
              detected: true,
              appName,
              appConfig,
              isTeams: true,
              windowTitle: fgTitle,
              detectedWithoutMic: true,
              listenOnlyPriority: 4
            };
          }
        }
      }
    } else if (browserPresence && !browserPresence.inMeeting) {
      _presenceNoMicCount = 0;
    }
  }

  // ── FALLBACK: Title + process matching for all apps ──
  // This handles: non-Teams apps, browser-based Teams, and Teams when Graph API is unavailable
  for (const app of MEETING_APPS) {
    // Check 1: the foreground window's process must match this app's processes
    const fgBelongsToApp = app.processes.some(p =>
      fgProcLower === p.toLowerCase().replace('.exe', '')
    );
    if (!fgBelongsToApp) continue;

    // Check 2: the app's process must be in the running processes list
    const processRunning = app.processes.some(p =>
      processes.some(rp => rp.toLowerCase() === p.toLowerCase())
    );
    if (!processRunning) continue;

    // Check 3: the foreground title must match one of this app's title patterns
    const titleMatch = app.titlePatterns.some(pattern =>
      titleLower.includes(pattern.toLowerCase())
    );
    if (!titleMatch) continue;

    // Check 4: For apps that need mic confirmation (e.g., Teams — to distinguish
    // meeting/call from chat/dashboard), verify the app is actively using the mic.
    // This prevents false positives when user opens Teams just for chatting.
    if (app.needsMicConfirm) {
      const micActive = isAppUsingMic(app.processes);
      if (!micActive) {
        // Listen-only fallback for title-matched Teams apps:
        // If InACall is confirmed OR camera is active, accept without mic
        if (_lastPresenceResult && _lastPresenceResult.isActiveCall) {
          log.info('[Detector] Title matched + InACall, accepting listen-only', { app: app.name });
          return {
            detected: true,
            appName: app.name,
            appConfig: app,
            isTeams: app.isTeams,
            windowTitle: fgTitle,
            detectedWithoutMic: true,
            listenOnlyPriority: 1
          };
        }
        if (isAppUsingCamera(app.processes)) {
          log.info('[Detector] Title matched + camera active, accepting listen-only', { app: app.name });
          return {
            detected: true,
            appName: app.name,
            appConfig: app,
            isTeams: app.isTeams,
            windowTitle: fgTitle,
            detectedWithoutMic: true,
            listenOnlyPriority: 2
          };
        }
        log.debug('[Detector] Title matched but mic not active, skipping', { app: app.name });
        continue;
      }
      // Browser Teams with mic active: cross-check Presence to rule out Chrome's
      // lingering mic hold (~30s) after leaving a Google Meet or other web meeting.
      // If Presence confirms the user is NOT in any meeting, skip this detection.
      // Only applies to browser-based Teams (not Teams desktop which owns its mic directly).
      //
      // DND guard: only bypass the Presence skip for STRONG Teams-specific patterns
      // (URL-based: teams.microsoft.com, or unique suffix: | Microsoft Teams).
      // Weak patterns like 'Meeting with'/'Call with' overlap with organizer-named GMeet
      // titles (e.g., "Meet - Meeting with John | Google Meet"). Bypassing the Presence
      // guard for weak patterns when DND is set would cause GMeet to be falsely detected
      // as Teams. Strong patterns are unambiguously Teams-only.
      if (app.isTeams && !app.processes.some(p => TEAMS_PROCESS_SET.has(p.toLowerCase()))) {
        const titleMatchedPattern = app.titlePatterns.find(p => titleLower.includes(p.toLowerCase()));
        const isStrongTeamsMatch = !!titleMatchedPattern &&
          TEAMS_STRONG_PATTERNS.has(titleMatchedPattern.toLowerCase());

        if (_lastPresenceResult !== null &&
            !_lastPresenceResult.inMeeting &&
            (!PRESENCE_AMBIGUOUS_ACTIVITIES.has(_lastPresenceResult.activity) || !isStrongTeamsMatch)) {
          log.debug('[Detector] Browser Teams: mic active but Presence not in meeting — skipping (lingering mic)', {
            app: app.name, activity: _lastPresenceResult.activity, strongMatch: isStrongTeamsMatch
          });
          continue;
        }
      }
    }

    // ── Google Meet: gate broad 'Google Meet' title (pre-join lobby) on mic activity ──
    // The pattern '- Google Meet' is unambiguous (user is in a meeting).
    // The bare 'Google Meet' pattern also matches the waiting-room/lobby page before
    // the user has actually joined. Require mic active for that case to avoid false
    // positives when the user is just looking at the Meet landing page.
    if (app.isGoogleMeet) {
      const strongGMeetMatch = titleLower.includes('- google meet');
      if (!strongGMeetMatch) {
        // Only the broad 'Google Meet' pattern matched — require mic active
        if (!isAppUsingMic(app.processes)) {
          log.debug('[Detector] Google Meet lobby title matched but mic not active — skipping (pre-join)', { app: app.name });
          continue;
        }
        log.info('[Detector] Google Meet detected via lobby title + mic active', { app: app.name });
        return {
          detected: true,
          appName: app.name,
          appConfig: app,
          isTeams: false,
          windowTitle: fgTitle,
          micConfirmed: true,
        };
      }
      // Strong '- Google Meet' match — user is in a meeting, also confirm mic for fast debounce
      const micActive = isAppUsingMic(app.processes);
      return {
        detected: true,
        appName: app.name,
        appConfig: app,
        isTeams: false,
        windowTitle: fgTitle,
        micConfirmed: micActive,
      };
    }

    return {
      detected: true,
      appName: app.name,
      appConfig: app,
      isTeams: app.isTeams,
      windowTitle: fgTitle
    };
  }

  // ── FALLBACK: Browser tab scan for background-tab meetings ──
  // If no foreground match was found, check if any browser is running with a meeting
  // tab in the background. This catches the common case where the user has a Teams/Meet
  // meeting in Chrome but is working in another app (Explorer, VS Code, etc.).
  // Throttled to every ~15s to avoid running the ~1s PowerShell tab enumeration every tick.
  const anyBrowserRunning = processes.some(p => BROWSER_PROCESS_SET.has(p.toLowerCase()));
  const now = Date.now();
  if (anyBrowserRunning && (now - _lastBgTabScanTime > BG_TAB_SCAN_INTERVAL_MS)) {
    _lastBgTabScanTime = now;
    const tabTitles = getBrowserTabTitles();
    if (tabTitles.length > 0) {
      // Check each web meeting pattern against all open tabs
      for (const webMeeting of WEB_MEETINGS) {
        const matchedTab = tabTitles.find(tabTitle => {
          const tabLower = tabTitle.toLowerCase();
          return webMeeting.titlePatterns.some(pattern => tabLower.includes(pattern.toLowerCase()));
        });

        if (!matchedTab) continue;

        // Find which browser has this tab. get-browser-tabs.ps1 returns a flat list
        // with no per-tab browser info, so we can't know which browser owns the tab.
        // Heuristic: prefer the browser that is currently using the mic — it is almost
        // certainly the one with the active meeting. Fall back to the first running browser
        // (for listen-only meetings where no browser has mic).
        const matchedBrowser =
          BROWSERS.find(b =>
            processes.some(p => p.toLowerCase() === b.process.toLowerCase()) &&
            isAppUsingMic([b.process])
          ) ||
          BROWSERS.find(b =>
            processes.some(p => p.toLowerCase() === b.process.toLowerCase())
          );
        if (!matchedBrowser) continue;

        // Guard: if this is a Teams web match and the browser is already claimed by
        // an active non-Teams meeting (e.g., Google Meet), skip — the mic/presence
        // signals belong to the other meeting, not Teams.
        if (webMeeting.isTeams && _activeMeetingBrowserProcess &&
            _activeMeetingBrowserProcess.toLowerCase() === matchedBrowser.process.toLowerCase()) {
          log.info('[Detector] BG tab scan: Teams tab found but browser already claimed by active meeting — skipping', { browser: matchedBrowser.label });
          continue;
        }

        const appName = `${webMeeting.name} (${matchedBrowser.label})`;
        const appConfig = MEETING_APPS.find(a => a.name === appName);
        if (!appConfig) continue;

        // Mic confirmation for browser meetings (e.g., Teams needs mic to distinguish
        // meeting from chat/dashboard tab)
        if (webMeeting.needsMicConfirm) {
          const micActive = isAppUsingMic([matchedBrowser.process]);
          if (!micActive) {
            // Listen-only fallback for browser tab matches:
            // InACall → definitive; camera → strong signal
            if (_lastPresenceResult && _lastPresenceResult.isActiveCall) {
              log.info('[Detector] Background tab matched + InACall, accepting listen-only', {
                app: appName, tab: matchedTab.substring(0, 80)
              });
              return {
                detected: true,
                appName,
                appConfig,
                isTeams: webMeeting.isTeams,
                windowTitle: matchedTab,
                detectedWithoutMic: true,
                listenOnlyPriority: 1
              };
            }
            if (isAppUsingCamera([matchedBrowser.process])) {
              log.info('[Detector] Background tab matched + camera, accepting listen-only', {
                app: appName, tab: matchedTab.substring(0, 80)
              });
              return {
                detected: true,
                appName,
                appConfig,
                isTeams: webMeeting.isTeams,
                windowTitle: matchedTab,
                detectedWithoutMic: true,
                listenOnlyPriority: 2
              };
            }
            log.debug('[Detector] Background tab matched but mic not active, skipping', { app: appName, tab: matchedTab.substring(0, 80) });
            continue;
          }
          // Same Presence cross-check as foreground path: browser retains mic ~30s after
          // leaving a web meeting. Don't attribute a background Teams tab to a new meeting
          // if Presence confirms the user is not currently in any call.
          if (webMeeting.isTeams) {
            if (_lastPresenceResult !== null && !_lastPresenceResult.inMeeting) {
              log.debug('[Detector] BG scan browser Teams: mic active but Presence not in meeting — skipping (lingering mic)', {
                app: appName, activity: _lastPresenceResult.activity
              });
              continue;
            }
          }
        }

        // ── Google Meet background tab: gate broad 'Google Meet' on mic activity ──
        if (webMeeting.isGoogleMeet) {
          const strongGMeetMatch = matchedTab.toLowerCase().includes('- google meet');
          if (!strongGMeetMatch) {
            // Broad 'Google Meet' tab found but user might not have joined yet
            if (!isAppUsingMic([matchedBrowser.process])) {
              log.debug('[Detector] BG Google Meet lobby tab found but mic not active — skipping (pre-join)', { tab: matchedTab.substring(0, 80) });
              continue;
            }
            log.info('[Detector] Google Meet detected via background lobby tab + mic active', { tab: matchedTab.substring(0, 80), browser: matchedBrowser.label });
            return {
              detected: true,
              appName,
              appConfig,
              isTeams: false,
              windowTitle: matchedTab,
              micConfirmed: true,
            };
          }
          // Strong '- Google Meet' background tab — in a meeting
          const micActive = isAppUsingMic([matchedBrowser.process]);
          log.info('[Detector] Google Meet detected via background tab scan', { tab: matchedTab.substring(0, 80), browser: matchedBrowser.label });
          return {
            detected: true,
            appName,
            appConfig,
            isTeams: false,
            windowTitle: matchedTab,
            micConfirmed: micActive,
          };
        }

        log.info('[Detector] Meeting detected via background browser tab scan', {
          app: appName, tab: matchedTab.substring(0, 80)
        });
        return {
          detected: true,
          appName,
          appConfig,
          isTeams: webMeeting.isTeams,
          windowTitle: matchedTab
        };
      }
    }
  }

  return { detected: false };
}

// Determine if a listen-only meeting is still active.
// Called from isMeetingStillActive() when _listenOnlyDetection is true.
// Uses presence API as primary signal since mic is not available.
async function isListenOnlyMeetingStillActive(processes, recordingApp, isTeamsDesktop) {
  // Priority 1: Check if user has unmuted (mic became active)
  // If so, switch back to standard mic-based end detection
  const micNowActive = isAppUsingMic(recordingApp.processes);
  if (micNowActive) {
    log.info('[Detector] Listen-only meeting: mic activated (user unmuted), switching to mic-based detection');
    _listenOnlyDetection = false;
    _presenceEndCount = 0;
    return true; // Meeting is active — mic confirms it
  }

  // Priority 2: Check Presence API for InACall status
  const presence = await checkTeamsPresence();

  if (presence && presence.isActiveCall) {
    // InACall is still true — meeting definitely still active
    _presenceEndCount = 0;
    return true;
  }

  // Priority 3: InACall became false — meeting may have ended
  // Use sustained-tick check to protect against presence flickers
  if (presence && !presence.isActiveCall) {
    _presenceEndCount++;

    // Check camera as a keep-alive signal (overrides single presence flicker)
    if (_presenceEndCount < PRESENCE_END_TICKS_REQUIRED && isAppUsingCamera(recordingApp.processes)) {
      log.debug('[Detector] Listen-only: InACall dropped but camera still active, keeping alive', {
        presenceEndCount: _presenceEndCount, activity: presence.activity
      });
      return true;
    }

    // Check Teams desktop title as keep-alive
    if (_presenceEndCount < PRESENCE_END_TICKS_REQUIRED && isTeamsDesktop && teamsDesktopTitleHasMeetingKeywords()) {
      log.debug('[Detector] Listen-only: InACall dropped but Teams title still shows meeting, keeping alive', {
        presenceEndCount: _presenceEndCount
      });
      return true;
    }

    // Check system audio as keep-alive (when presence is indeterminate)
    // Reset the end counter when audio is active — only SUSTAINED silence (3 consecutive
    // ticks = 15s) should stop a listen-only recording. This prevents false stops from
    // natural silence gaps (slide transitions, pauses) even when DND hides InACall.
    const sysAudioPath = getRecordingPath();
    if (!sysAudioPath) {
      // System audio path not yet available — cannot determine audio state.
      // Treat as keep-alive: we have no evidence of silence so don't advance toward ending.
      _presenceEndCount = 0;
      log.debug('[Detector] Listen-only: system audio path unavailable, keeping alive');
      return true;
    }
    if (hasAudioActivity(sysAudioPath)) {
      _presenceEndCount = 0; // Active audio confirms meeting ongoing — reset end counter
      log.debug('[Detector] Listen-only: InACall absent but system audio active — resetting end counter', {
        activity: presence.activity
      });
      return true;
    }

    if (_presenceEndCount >= PRESENCE_END_TICKS_REQUIRED) {
      log.info('[Detector] Listen-only meeting ended: InACall absent for sustained ticks', {
        presenceEndCount: _presenceEndCount, activity: presence.activity
      });
      return false;
    }

    log.debug('[Detector] Listen-only: InACall absent, incrementing end counter', {
      presenceEndCount: _presenceEndCount, activity: presence.activity
    });
    return true; // Not enough ticks yet, keep alive
  }

  // Priority 7: Presence API failed (null) — assume still active (don't stop on API errors)
  if (presence === null) {
    log.debug('[Detector] Listen-only: Presence API failed, assuming still active');
    // Don't increment _presenceEndCount on API failures
    return true;
  }

  // Presence returned a result but user is not in any meeting state at all
  _presenceEndCount++;
  if (_presenceEndCount >= PRESENCE_END_TICKS_REQUIRED) {
    log.info('[Detector] Listen-only meeting ended: presence shows no meeting activity', {
      presenceEndCount: _presenceEndCount, activity: presence.activity
    });
    return false;
  }
  return true;
}

// Determine if meeting is still active during RECORDING state
// Uses hybrid multi-signal detection:
//   Signal 1 (hard): Meeting app process must be running — if not, meeting is over
//   Signal 2 (primary): Browser tab with meeting URL exists OR desktop window title matches
//   Signal 3 (fallback): System audio RMS > threshold — ONLY used when Signal 2 is indeterminate
//     (UI Automation failed, PowerShell error, Firefox background tabs with empty titles)
// Decision: process AND (title OR (indeterminate AND audio))
async function isMeetingStillActive(processes, recordingApp) {
  // ── Signal 1: Process must be running (hard requirement) ──
  const processRunning = recordingApp.processes.some(p =>
    processes.some(rp => rp.toLowerCase() === p.toLowerCase())
  );
  if (!processRunning) {
    log.info('[Detector] Meeting process exited');
    return false;
  }

  // ── Signal 1b: For Teams (desktop OR browser), check mic or use listen-only end detection ──
  const isTeamsDesktop = recordingApp.isTeams && recordingApp.processes.some(p =>
    TEAMS_PROCESS_SET.has(p.toLowerCase())
  );
  const isTeamsBrowser = recordingApp.isTeams && recordingApp.processes.some(p =>
    BROWSER_PROCESS_SET.has(p.toLowerCase())
  );
  if (isTeamsDesktop || isTeamsBrowser) {
    // If recording was started as listen-only, use presence-based end detection
    if (_listenOnlyDetection) {
      return await isListenOnlyMeetingStillActive(processes, recordingApp, isTeamsDesktop);
    }

    // Mic-based end detection (primary signal for both desktop and browser)
    const teamsMicActive = isAppUsingMic(recordingApp.processes);
    if (!teamsMicActive) {
      // Teams 2.0 releases the Windows mic claim when the user mutes (not only on leave).
      // Cross-check Presence API for BOTH desktop and browser: if still InAMeeting/InACall,
      // the user just muted — keep recording.
      const presence = await checkTeamsPresence();
      if (presence && presence.inMeeting) {
        log.debug('[Detector] Teams mic released but Presence says still in meeting (likely muted)', {
          isDesktop: isTeamsDesktop, isBrowser: isTeamsBrowser
        });
        _teamsPresenceMicOffCount = 0;
        return true;
      }
      // DND/Focusing can hide InACall — Presence is ambiguous. Check camera as a
      // bounded fallback: Teams only holds the camera claim during an active call,
      // so camera active = definitively still in a video call despite ambiguous Presence.
      if (isTeamsDesktop && presence && PRESENCE_AMBIGUOUS_ACTIVITIES.has(presence.activity)) {
        const teamsDesktopApp = DESKTOP_APPS.find(a => a.isTeams);
        if (teamsDesktopApp && isAppUsingCamera(teamsDesktopApp.processes)) {
          log.debug('[Detector] Teams desktop mic released but DND + camera active — keeping recording (muted in video call)', {
            activity: presence.activity
          });
          _teamsPresenceMicOffCount = 0;
          return true;
        }
      }
      // Presence API null means a transient network/API failure — don't end the meeting on the
      // first such failure. Allow one retry tick before committing to end. This prevents the
      // "mic release + Presence blip at the same tick" race (Bug 2) from fragmenting meetings.
      if (presence === null) {
        _teamsPresenceMicOffCount++;
        if (_teamsPresenceMicOffCount <= 3) {
          log.debug('[Detector] Teams mic released and Presence API returned null — tolerating before ending', {
            count: _teamsPresenceMicOffCount, isDesktop: isTeamsDesktop, isBrowser: isTeamsBrowser
          });
          return true;
        }
        log.info('[Detector] Teams mic released + Presence null for 4 consecutive ticks — ending meeting', {
          isDesktop: isTeamsDesktop, isBrowser: isTeamsBrowser
        });
      } else {
        _teamsPresenceMicOffCount = 0;
      }
      log.info('[Detector] Teams mic released — meeting ended', {
        isDesktop: isTeamsDesktop, isBrowser: isTeamsBrowser
      });
      return false;
    }
    _teamsPresenceMicOffCount = 0; // Mic active — reset tolerance counter

    // Teams DESKTOP: mic active = meeting active (definitive).
    // Teams.exe releases mic immediately when user leaves a meeting.
    if (isTeamsDesktop) return true;

    // Teams BROWSER: mic active is NOT definitive — Chrome/Edge hold the mic resource
    // even after the user leaves the meeting via the in-app "Leave" button.
    // Cross-check with Presence API: activity field (InACall/InAConferenceCall) reliably
    // reflects active call state unless user has set an ambiguous status (DND/Focusing/etc),
    // which overrides InACall in the API. Only stop if Presence is definitively not-in-call.
    // When ambiguous: browser will release mic naturally within ~30s when truly ended.
    const presence = await checkTeamsPresence();
    if (presence && !presence.inMeeting && !presence.isActiveCall &&
        !PRESENCE_AMBIGUOUS_ACTIVITIES.has(presence.activity)) {
      log.info('[Detector] Teams browser: mic held but Presence not in call — meeting ended', {
        activity: presence.activity, availability: presence.availability
      });
      return false;
    }
    // Presence says in-meeting, or API failed (null) → trust mic, keep recording
    return true;
  }

  // ── Signal 2: Tab/window title check ──
  let titleSignal = false;
  let titleSignalIndeterminate = false; // true when we couldn't read tabs/titles reliably

  const isBrowserApp = recordingApp.processes.some(p =>
    BROWSER_PROCESS_SET.has(p.toLowerCase())
  );

  let _cachedTabTitles = null; // hoisted for use in GMeet end-detection below
  if (isBrowserApp) {
    // Browser meetings: UI Automation reads ALL tab titles across all browsers
    const tabTitles = getBrowserTabTitles();
    _cachedTabTitles = tabTitles;

    if (tabTitles.length === 0) {
      // UI Automation returned no tabs — can't determine, don't count as positive or negative
      log.debug('[Detector] UI Automation returned 0 tabs, title signal indeterminate');
      titleSignalIndeterminate = true;
    } else {
      titleSignal = recordingApp.titlePatterns.some(pattern =>
        tabTitles.some(title => title.toLowerCase().includes(pattern.toLowerCase()))
      );
      // Firefox returns empty strings for background tab titles.
      // If title didn't match but many tabs are empty, the meeting tab might be
      // a background Firefox tab we can't read — treat as indeterminate.
      if (!titleSignal) {
        const emptyCount = tabTitles.filter(t => !t || !t.trim()).length;
        if (emptyCount > tabTitles.length * 0.3) {
          log.debug('[Detector] Many empty tab titles (likely Firefox), title signal indeterminate');
          titleSignalIndeterminate = true;
        }
      }
    }
  } else {
    // Desktop apps: check window titles from the meeting app's processes
    try {
      const appProcessNames = recordingApp.processes.map(p => p.replace('.exe', ''));
      const filter = appProcessNames.map(n => `'${n}'`).join(',');
      const output = execSync(
        `powershell -NoProfile -Command "Get-Process -Name ${filter} -ErrorAction SilentlyContinue | Where-Object {$_.MainWindowTitle} | Select-Object -ExpandProperty MainWindowTitle"`,
        { encoding: 'utf8', timeout: 5000, windowsHide: true }
      );
      const appTitles = output.toLowerCase();
      titleSignal = recordingApp.titlePatterns.some(pattern =>
        appTitles.includes(pattern.toLowerCase())
      );
    } catch (err) {
      // On error, title signal is indeterminate
      titleSignalIndeterminate = true;
    }
  }

  // ── Signal 3: Audio activity check ──
  // Audio signal is only used as a SUPPLEMENT when title signal is indeterminate
  // (e.g., UI Automation returned 0 tabs, or Firefox background tab).
  // If title signal is definitively false (tab enumeration worked but no match),
  // audio alone should NOT keep the meeting alive — the user may be playing
  // music/YouTube after closing the meeting tab.
  const sysAudioPath = getRecordingPath();
  const audioSignal = hasAudioActivity(sysAudioPath);

  // ── Signal 4: Mic usage check (for Teams and apps with needsMicConfirm) ──
  // If the app required mic confirmation to start, check if it's still using the mic.
  // Teams keeps the tab open after leaving a meeting, but releases the mic immediately.
  // This catches the case where user leaves the meeting but the Teams tab stays open.
  let micSignal = true; // default true for non-Teams apps
  if (recordingApp.needsMicConfirm) {
    micSignal = isAppUsingMic(recordingApp.processes);
  }

  let stillActive;
  if (!micSignal && recordingApp.needsMicConfirm) {
    // Mic was released — for Teams this definitively means the meeting/call ended
    // even if the tab is still open
    stillActive = false;
  } else if (recordingApp.isGoogleMeet) {
    // ── Google Meet: robust multi-signal end detection ──
    // Problem: The broad "Google Meet" title pattern matches both the active meeting
    // AND the post-meeting landing page. The strong "- Google Meet" pattern only matches
    // NAMED meetings — unnamed meetings (join-by-link) don't have it.
    // Solution: Use mic as primary signal with a grace-period buffer, plus audio activity
    // as a secondary keep-alive. Only end when ALL signals are clearly gone.
    const micActive = isAppUsingMic(recordingApp.processes);

    // Track mic-active timestamps for grace period
    if (micActive) {
      _gmeetLastMicActiveTime = Date.now();
      _browserMicWasActive = true;
      _lastBrowserMicReleased = false;
    } else if (_browserMicWasActive && !_lastBrowserMicReleased) {
      _lastBrowserMicReleased = true;
      log.info('[Detector] Google Meet: mic released (tracking for debounce)');
    }

    // Mic was active within the last 45 seconds — assume still in meeting.
    // Handles: mute transitions, brief WebRTC renegotiations, registry lag.
    const micRecentlyActive = _gmeetLastMicActiveTime > 0 &&
      (Date.now() - _gmeetLastMicActiveTime) < GMEET_MIC_GRACE_PERIOD_MS;

    if (micActive) {
      // Mic is active right now → definitely in meeting
      stillActive = true;
    } else if (titleSignalIndeterminate) {
      // Tab scan failed (PowerShell error, UI Automation failure) — can't determine
      // title state. NEVER end a meeting on a failed tab scan. Assume still active.
      stillActive = true;
    } else if (titleSignal && micRecentlyActive) {
      // Broad title matches (some Google Meet tab open) + mic was active recently
      // → user likely still in meeting (just muted or brief mic drop)
      stillActive = true;
    } else if (titleSignal && audioSignal) {
      // Broad title matches + system audio is active (someone talking)
      // → meeting is still going even though local mic is off
      stillActive = true;
    } else {
      // All signals gone: mic not active (for 45+ seconds), no audio activity,
      // AND either no Google Meet title OR tab scan confirmed no match.
      log.info('[Detector] Google Meet: all signals lost — mic inactive for 45s+, no audio, title gone');
      stillActive = false;
    }
  } else if (titleSignal) {
    // Title confirms meeting tab/window exists → definitely active
    stillActive = true;
  } else if (titleSignalIndeterminate) {
    // Tab scan failed (PowerShell error, UI Automation returned 0 tabs, file locked).
    // NEVER end a meeting based on a failed tab scan — this is the #1 cause of
    // meeting fragmentation. The absence of data is NOT evidence the meeting ended.
    // Only end when we have POSITIVE evidence (tab scan succeeded + no match found).
    stillActive = true;
  } else {
    // Title check SUCCEEDED but found no match → tab/window was definitively closed.
    // Use mic as a secondary keep-alive: browser may still hold mic briefly after tab closes.
    const micStillActive = isBrowserApp ? isAppUsingMic(recordingApp.processes) : false;
    if (micStillActive) {
      log.debug('[Detector] Title gone but mic still active — keeping alive briefly');
      stillActive = true;
    } else {
      stillActive = false;
    }
  }

  // Track whether title was definitively negative (for debounce optimization).
  // When title check worked and found no match on a browser app, use shorter debounce.
  _lastTitleDefinitive = !titleSignal && !titleSignalIndeterminate && isBrowserApp;

  if (!stillActive) {
    log.info('[Detector] Meeting signals cold', {
      titleSignal, titleSignalIndeterminate, audioSignal, micSignal, isBrowserApp,
      patterns: recordingApp.titlePatterns
    });
  }

  return stillActive;
}

function getTempDir() {
  const tempDir = path.join(os.tmpdir(), 'scriptor');
  const fs = require('fs');
  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
  }
  return tempDir;
}

let _startRecordingLock = false;

async function startRecording(appName, isTeams, windowTitle) {
  // Prevent concurrent calls — if already starting, bail out
  if (_startRecordingLock) {
    log.warn('[Detector] startRecording already in progress — ignoring duplicate call', { appName });
    return;
  }
  _startRecordingLock = true;

  const tempDir = getTempDir();
  const timestamp = Date.now();
  const micPath = path.join(tempDir, `mic_${timestamp}.wav`);
  const sysPath = path.join(tempDir, `sys_${timestamp}.wav`);

  meetingStartTime = new Date();
  detectedApp = appName;
  teamsMeetingInfo = isTeams ? { windowTitle } : null;
  _currentMicPath = micPath;
  _currentSysPath = sysPath;

  log.info('[Detector] Starting recording', { appName, isTeams, listenOnly: _listenOnlyDetection });
  try { setRecordingStatus(true); } catch (e) { /* tray may not be initialized yet */ }
  resetAudioActivityState(); // Reset file growth tracking for the new recording

  // Grace period: don't evaluate isMeetingStillActive() for the first 20 seconds.
  // During startup, mic/audio/tab signals need time to stabilize — PowerShell tab
  // scan may return empty, mic registry may not yet reflect the new recording, and
  // system audio capture hasn't started. Without this, false "meeting ended" signals
  // fragment the meeting immediately after it starts.
  _recordingGracePeriodEnd = Date.now() + RECORDING_GRACE_PERIOD_MS;

  // Prevent system from suspending during active recording
  try {
    const { powerSaveBlocker } = require('electron');
    _powerSaveBlockerId = powerSaveBlocker.start('prevent-app-suspension');
    log.info('[Detector] Power save blocker started', { id: _powerSaveBlockerId });
  } catch (e) {
    log.warn('[Detector] Failed to start power save blocker', { error: e.message });
  }

  try {
    if (_listenOnlyDetection) {
      // Listen-only mode: system recording is required, mic is best-effort
      await startSystemRecording(sysPath);
      try {
        await startMicRecording(micPath);
        log.info('[Detector] Listen-only recording: mic started successfully (user may have hardware)');
      } catch (micErr) {
        log.info('[Detector] Listen-only recording: mic unavailable, continuing with system audio only', {
          error: micErr.message
        });
      }
    } else {
      // Standard mode: both mic and system are required.
      // If one fails, clean up the other to prevent orphaned processes.
      try {
        await Promise.all([
          startMicRecording(micPath),
          startSystemRecording(sysPath)
        ]);
      } catch (recordErr) {
        // Clean up any partially-started recordings
        try { stopMicRecording(); } catch (_) {}
        try { await stopSystemRecording(); } catch (_) {}
        throw recordErr;
      }
    }

    // Create meeting row immediately so it's visible in the admin dashboard
    const userId = getConfig('userProfileId');
    if (userId) {
      earlyMeetingId = await createMeetingRecord({
        userId,
        startTime: meetingStartTime.toISOString(),
        detectedApp: appName,
        teamsMeetingInfo
      });
    }

    // Auto-stop after max duration
    maxRecordingTimer = setTimeout(() => {
      log.warn('[Detector] Max recording duration reached, stopping');
      handleMeetingEnd();
    }, MAX_RECORDING_MS);

  } catch (err) {
    log.error('[Detector] Failed to start recording', { error: err.message });
    // Release power save blocker on failure
    if (_powerSaveBlockerId !== null) {
      try {
        const { powerSaveBlocker } = require('electron');
        if (powerSaveBlocker.isStarted(_powerSaveBlockerId)) {
          powerSaveBlocker.stop(_powerSaveBlockerId);
        }
      } catch (_) {}
      _powerSaveBlockerId = null;
    }
    // Mark the orphaned DB record as failed so it doesn't persist as "recording"
    if (earlyMeetingId) {
      try {
        const supabase = require('../api/supabaseClient').getSupabaseClient();
        await supabase.from('meetings').update({ status: 'failed' }).eq('id', earlyMeetingId);
        log.info('[Detector] Marked orphaned meeting record as failed', { meetingId: earlyMeetingId });
      } catch (e) { log.warn('[Detector] Failed to mark orphaned meeting as failed', { error: e.message }); }
    }
    _resetDetectorState();
  }
}

let _handleMeetingEndLock = false;

async function handleMeetingEnd() {
  if (currentState !== STATE.RECORDING) return;
  if (_handleMeetingEndLock) {
    log.warn('[Detector] handleMeetingEnd already in progress — ignoring duplicate call');
    return;
  }
  _handleMeetingEndLock = true;
  currentState = STATE.STOPPING;

  if (maxRecordingTimer) {
    clearTimeout(maxRecordingTimer);
    maxRecordingTimer = null;
  }
  if (stopDebounceTimer) {
    clearTimeout(stopDebounceTimer);
    stopDebounceTimer = null;
  }

  // Release power save blocker
  if (_powerSaveBlockerId !== null) {
    try {
      const { powerSaveBlocker } = require('electron');
      if (powerSaveBlocker.isStarted(_powerSaveBlockerId)) {
        powerSaveBlocker.stop(_powerSaveBlockerId);
        log.info('[Detector] Power save blocker released', { id: _powerSaveBlockerId });
      }
    } catch (e) { /* ignore */ }
    _powerSaveBlockerId = null;
  }

  const meetingEndTime = new Date();
  const tempDir = getTempDir();
  const fs = require('fs');

  const durationMs = meetingEndTime - meetingStartTime;
  const durationSec = Math.round(durationMs / 1000);
  log.info('[Detector] Meeting ended, processing audio', {
    app: detectedApp,
    duration: durationSec
  });

  // Skip very short meetings below configured minimum — accidental joins or false positives
  const configuredMinSec = getConfig('minMeetingDurationSeconds') || 120;
  const effectiveMinMs = configuredMinSec * 1000;
  if (durationMs < effectiveMinMs) {
    log.warn('[Detector] Meeting too short, skipping upload', { duration: durationSec });
    try { stopMicRecording(); } catch (e) { /* ignore */ }
    try { await stopSystemRecording(); } catch (e) { /* ignore */ }
    // Delete the early meeting record since the meeting was too short
    if (earlyMeetingId) {
      try {
        const supabase = require('../api/supabaseClient').getSupabaseClient();
        await supabase.from('meetings').delete().eq('id', earlyMeetingId);
        log.info('[Detector] Deleted short meeting record', { meetingId: earlyMeetingId });
      } catch (e) { log.warn('[Detector] Failed to delete short meeting record', { error: e.message }); }
    }
    // Record which process/app just ended (for post-meeting cooldown) before nulling state
    _lastMeetingEndTime = Date.now();
    _lastMeetingEndProcesses = recordingAppInfo ? [...recordingAppInfo.processes] : [];
    _lastMeetingEndAppName = recordingAppInfo ? (recordingAppInfo.name || '') : '';
    _resetDetectorState();
    return;
  }

  try {
    // Stop both streams in parallel — mic waits for ffmpeg to write the final WAV header,
    // system waits for WebM→WAV conversion. Running together saves 5-10s.
    await Promise.all([
      stopMicRecording(),      // waits for ffmpeg exit + WAV header written
      stopSystemRecording(),   // waits for WebM→WAV ffmpeg conversion
    ]);

    // Use the exact paths from startRecording() — never scan the directory,
    // which can pick up stale files from previous sessions.
    const micPath = _currentMicPath;
    const sysPath = _currentSysPath;

    if (!micPath && !sysPath) {
      log.error('[Detector] No audio file paths set from recording');
      if (earlyMeetingId) {
        try {
          const supabase = require('../api/supabaseClient').getSupabaseClient();
          await supabase.from('meetings').update({ status: 'failed' }).eq('id', earlyMeetingId);
          log.info('[Detector] Marked meeting as failed (no audio paths)', { meetingId: earlyMeetingId });
        } catch (e) { log.warn('[Detector] Failed to mark meeting as failed', { error: e.message }); }
      }
      _resetDetectorState();
      return;
    }

    // Verify files actually exist
    const micExists = micPath && fs.existsSync(micPath);
    const sysExists = sysPath && fs.existsSync(sysPath);

    if (!micExists && !sysExists) {
      log.error('[Detector] No audio files found at expected paths', { micPath, sysPath });
      if (earlyMeetingId) {
        try {
          const supabase = require('../api/supabaseClient').getSupabaseClient();
          await supabase.from('meetings').update({ status: 'failed' }).eq('id', earlyMeetingId);
          log.info('[Detector] Marked meeting as failed (no audio files)', { meetingId: earlyMeetingId });
        } catch (e) { log.warn('[Detector] Failed to mark meeting as failed', { error: e.message }); }
      }
      _resetDetectorState();
      return;
    }

    // Log file sizes for diagnostics
    const micSize = micExists ? (fs.statSync(micPath).size || 0) : 0;
    const sysSize = sysExists ? (fs.statSync(sysPath).size || 0) : 0;
    log.info('[Detector] Audio file sizes', { micSize, sysSize });

    // Treat 0-byte files as missing
    const effectiveMicPath = micSize > 0 ? micPath : null;
    const effectiveSysPath = sysSize > 0 ? sysPath : null;

    if (!effectiveMicPath && !effectiveSysPath) {
      log.error('[Detector] Both audio files are empty');
      if (earlyMeetingId) {
        try {
          const supabase = require('../api/supabaseClient').getSupabaseClient();
          await supabase.from('meetings').update({ status: 'failed' }).eq('id', earlyMeetingId);
          log.info('[Detector] Marked meeting as failed (empty audio)', { meetingId: earlyMeetingId });
        } catch (e) { log.warn('[Detector] Failed to mark meeting as failed', { error: e.message }); }
      }
      _resetDetectorState();
      return;
    }

    // ── Snapshot all state needed for background processing ─────────────────
    // Global state is reset immediately below so the detection loop can resume.
    const bgCtx = {
      micPath,
      sysPath,
      effectiveMicPath,
      effectiveSysPath,
      meetingStartTime,
      meetingEndTime,
      detectedApp,
      teamsMeetingInfo,
      earlyMeetingId,
      tempDir,
      enrichment: _candidateEnrichment || { knownValues: [], attendeeCount: 0, meetingSubject: null },
    };

    // ── Reset detection state NOW — do not wait for transcription/upload ─────
    // AssemblyAI transcription takes 1-5 minutes. Keeping state in STOPPING
    // would block detection of any new meeting started during that time.
    _lastMeetingEndTime      = Date.now();
    _lastMeetingEndProcesses = recordingAppInfo ? [...recordingAppInfo.processes] : [];
    _lastMeetingEndAppName   = recordingAppInfo ? (recordingAppInfo.name || '')   : '';
    _resetDetectorState();
    log.info('[Detector] Detection state reset — background processing started');

    // Fire-and-forget: all heavy work (mono mix, AssemblyAI, AI summary, Supabase)
    // runs in _backgroundProcessMeeting without blocking future meeting detection.
    _backgroundProcessMeeting(bgCtx).catch(async (err) => {
      log.error('[Detector] Unhandled background processing error', { error: err.message || String(err) });
      // Mark meeting as failed in DB so it doesn't stay as orphaned 'recording'
      if (bgCtx.earlyMeetingId) {
        try {
          const supabase = require('../api/supabaseClient').getSupabaseClient();
          await supabase.from('meetings')
            .update({ status: 'failed', error_message: (err.message || String(err)).slice(0, 500) })
            .eq('id', bgCtx.earlyMeetingId);
        } catch (_) { /* best effort */ }
      }
    });

  } catch (err) {
    // Errors here are from audio-stop or file-validation only (fast path).
    // Post-processing errors are caught inside _backgroundProcessMeeting.
    log.error('[Detector] Audio stop / file validation failed: ' + err.message);
    if (earlyMeetingId) {
      try {
        const supabase = require('../api/supabaseClient').getSupabaseClient();
        await supabase.from('meetings')
          .update({ status: 'failed', end_time: new Date().toISOString(), error_message: err.message })
          .eq('id', earlyMeetingId);
      } catch (_e) { /* best effort */ }
    }
  } finally {
    // Safety net: ensure state is always IDLE regardless of which code path ran.
    if (currentState !== STATE.IDLE) {
      _lastMeetingEndTime      = Date.now();
      _lastMeetingEndProcesses = recordingAppInfo ? [...recordingAppInfo.processes] : [];
      _lastMeetingEndAppName   = recordingAppInfo ? (recordingAppInfo.name || '')   : '';
      _resetDetectorState();
    }
  }
}

/**
 * Reset all meeting-detector global state back to IDLE.
 * Called on the normal path (right after audio stops) and as a safety net in finally.
 */
function _resetDetectorState() {
  currentState             = STATE.IDLE;
  _startRecordingLock      = false;
  _handleMeetingEndLock    = false;
  meetingStartTime         = null;
  detectedApp              = 'Unknown';
  recordingAppInfo         = null;
  candidateAppConfig       = null;
  teamsMeetingInfo         = null;
  earlyMeetingId           = null;
  _currentMicPath          = null;
  _currentSysPath          = null;
  _listenOnlyDetection     = false;
  _candidateIsListenOnly   = false;
  _listenOnlyStartPriority = 0;
  _presenceNoMicCount      = 0;
  _teamsUdpHighCount       = 0;
  _presenceEndCount        = 0;
  _teamsPresenceMicOffCount = 0;
  _lastTitleDefinitive     = false;
  _browserMicWasActive     = false;
  _lastBrowserMicReleased  = false;
  _gmeetLastMicActiveTime  = 0;
  _recordingGracePeriodEnd = 0;
  _lastMicCheck            = { time: 0, result: { micActive: false, apps: [] } };
  _candidateEnrichment     = null;
  _activeMeetingBrowserProcess = null;
  resetPresenceCache();
  try { setRecordingStatus(false); } catch (_e) { /* ignore */ }
}

/**
 * Process a completed meeting in the background.
 * Delegates to the meeting pipeline (src/pipeline/meetingPipeline.js).
 * Runs detached from the detection loop so back-to-back meetings are detected correctly.
 *
 * @param {object} ctx - Snapshot of recording context captured before state reset
 */
async function _backgroundProcessMeeting(ctx) {
  const {
    micPath, sysPath, effectiveMicPath, effectiveSysPath,
    meetingStartTime, meetingEndTime, detectedApp, teamsMeetingInfo, earlyMeetingId,
    enrichment,
  } = ctx;

  const fs = require('fs');

  try {
    // Delegate to the meeting pipeline — handles transcription routing,
    // speaker identification, AI summary, upload, and Teams transcript polling.
    await processMeeting({
      effectiveMicPath,
      effectiveSysPath,
      meetingStartTime,
      meetingEndTime,
      detectedApp,
      teamsMeetingInfo,
      earlyMeetingId,
      enrichment,
    });

    // Cleanup audio files after successful processing
    cleanupAudioFiles(micPath, sysPath);

  } catch (err) {
    log.error('[Detector] Post-meeting processing failed', { error: err.message });

    if (earlyMeetingId) {
      try {
        const supabase = require('../api/supabaseClient').getSupabaseClient();
        await supabase.from('meetings')
          .update({ status: 'failed', end_time: new Date().toISOString(), error_message: err.message })
          .eq('id', earlyMeetingId);
      } catch (_e) { /* best effort */ }
    }

    // Best-effort audio cleanup
    try { cleanupAudioFiles(micPath, sysPath); } catch (_e) { /* ignore */ }
  }
}

/**
 * Delete audio files (utility, moved from mixer.js).
 */
function cleanupAudioFiles(...filePaths) {
  for (const filePath of filePaths) {
    try {
      if (filePath && fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        log.debug('[Detector] Deleted audio file', { filePath });
      }
    } catch (err) {
      log.error('[Detector] Failed to delete audio file', { filePath, error: err.message });
    }
  }
}

let stopDebounceTimer = null;

let tickCount = 0;

async function detectionTick() {
  if (currentState === STATE.STOPPING) return;

  // ── Sleep/wake detection via time-gap ──
  // If the gap since the last tick exceeds the threshold, the system likely slept.
  // This is a bulletproof fallback — powerMonitor events are unreliable on W11 24H2,
  // and Modern Standby (DAM) freezes all desktop processes without firing suspend events.
  const now = Date.now();
  const tickGap = now - _lastTickTime;
  _lastTickTime = now;

  if (tickGap > SLEEP_GAP_THRESHOLD_MS) {
    log.warn('[Detector] Time gap detected (likely sleep/wake)', {
      gapMs: tickGap, gapSec: Math.round(tickGap / 1000), state: currentState
    });

    // If recording, end the meeting — user closed lid or went to sleep
    if (currentState === STATE.RECORDING) {
      log.info('[Detector] Ending recording due to system sleep gap');
      handleMeetingEnd();
      return;
    }

    // If in CANDIDATE, cancel it — the candidate signal is stale
    if (currentState === STATE.CANDIDATE) {
      if (candidateTimer) {
        clearTimeout(candidateTimer);
        candidateTimer = null;
      }
      candidateAppConfig = null;
      _candidateIsListenOnly = false;
      currentState = STATE.IDLE;
      log.info('[Detector] Cancelled candidate due to system sleep gap');
    }

    // Reset stale caches
    resetPresenceCache();
    _lastPresenceResult = null;
    _lastMicCheck = { time: 0, result: { micActive: false, apps: [] } };
    _lastBgTabScanTime = 0;
    _lastMeetingEndTime = 0;
    _lastMeetingEndProcesses = [];
    _lastMeetingEndAppName = '';
  }

  try {
    const processes = getRunningProcesses();
    const fgInfo = await getActiveWindowInfo();

    // Log every 12th tick (~60s) or when processes found, for diagnostics
    tickCount++;
    if (tickCount % 12 === 1 || processes.length > 0) {
      log.info('[Detector] Tick', { tick: tickCount, processes, fgProcess: fgInfo.processName, titleSnippet: fgInfo.title.substring(0, 100), state: currentState });
    }

    const signals = await detectMeetingSignals(processes, fgInfo.title, fgInfo.processName);

  switch (currentState) {
    case STATE.IDLE:
      if (signals.detected) {
        // Consent check: if the employee has not given consent, do not record
        if (!getConfig('consentGiven')) {
          log.info('[Detector] Suppressing CANDIDATE — employee consent not given');
          break;
        }

        // Exclusion keyword check: if the meeting title contains any excluded keyword, skip
        const exclusionKeywords = getConfig('exclusionKeywords') || [];
        if (exclusionKeywords.length > 0 && signals.windowTitle) {
          const titleLowerExcl = signals.windowTitle.toLowerCase();
          const matchedKw = exclusionKeywords.find(kw =>
            kw && titleLowerExcl.includes(kw.toLowerCase())
          );
          if (matchedKw) {
            log.info('[Detector] Suppressing CANDIDATE — title matches exclusion keyword', {
              keyword: matchedKw, title: signals.windowTitle.substring(0, 80)
            });
            break;
          }
        }

        // Post-meeting cooldown gate: if the same process AND same app just ended a
        // meeting within the cooldown window, suppress the new CANDIDATE — UNLESS mic is
        // confirmed active, which means the user is genuinely in a new (or continuing) meeting.
        // Mic-active bypass is critical for back-to-back meetings on the same platform.
        const candidateProcesses = signals.appConfig ? signals.appConfig.processes : [];
        const isSameApp = _lastMeetingEndAppName && signals.appName === _lastMeetingEndAppName;
        if (signals.appConfig && isSameApp && !signals.micConfirmed && isInPostMeetingCooldown(candidateProcesses)) {
          log.debug('[Detector] Suppressing CANDIDATE — same app+process in post-meeting cooldown (mic not confirmed)', {
            app: signals.appName,
            lastApp: _lastMeetingEndAppName,
            cooldownRemainingSec: Math.round((POST_MEETING_COOLDOWN_MS - (Date.now() - _lastMeetingEndTime)) / 1000)
          });
          break;
        }
        const isListenOnly = !!signals.detectedWithoutMic;
        const priority = signals.listenOnlyPriority || 0;
        // Debounce selection:
        //   - Mic already active (user already in call): 2s fast start
        //   - Weak listen-only Priority 4 (sustained InAMeeting only): 60s
        //   - Browser-based meetings with strong tab title match: 5s
        //   - All other cases: 10s standard
        const isBrowserApp = signals.appConfig && signals.appConfig.processes.some(
          p => BROWSER_PROCESS_SET.has(p.toLowerCase())
        );
        const debounceMs = signals.micConfirmed ? GMEET_MIC_CONFIRMED_DEBOUNCE_MS
          : (isListenOnly && priority >= 4) ? LISTEN_ONLY_DEBOUNCE_MS
          : isBrowserApp ? BROWSER_TITLE_DEBOUNCE_MS
          : DEBOUNCE_MS;
        log.info('[Detector] Meeting candidate detected', {
          app: signals.appName, listenOnly: isListenOnly, priority, debounceMs
        });
        currentState = STATE.CANDIDATE;
        candidateAppConfig = signals.appConfig;
        _candidateIsListenOnly = isListenOnly;
        // Track which browser process is claimed by this meeting to prevent
        // the same browser from being attributed to a second meeting (e.g., Teams false positive).
        _activeMeetingBrowserProcess = (signals.appConfig && signals.appConfig.processes)
          ? signals.appConfig.processes.find(p => BROWSER_PROCESS_SET.has(p.toLowerCase())) || null
          : null;
        _presenceEndCount   = 0; // Reset listen-only end counter for new candidate
        _presenceNoMicCount = 0; // Reset sustained presence counter to prevent stale Priority 4 detection
        _teamsUdpHighCount  = 0; // Reset UDP sustained counter — a stronger signal already fired

        // ── Layer 3: Pre-meeting enrichment ──
        // Fire enrichCandidate() in background during debounce window.
        // Enrichment runs concurrently with the debounce timer so it's ready
        // when recording starts. Failures are non-critical (empty enrichment).
        _candidateEnrichment = null;
        enrichCandidate(signals.appName, signals.isTeams, signals.appConfig?.isGoogleMeet || false)
          .then(enrichment => { _candidateEnrichment = enrichment; })
          .catch(err => {
            log.warn('[Detector] Pre-meeting enrichment failed (non-critical)', { error: err.message });
            _candidateEnrichment = { knownValues: [], attendeeCount: 0, meetingSubject: null };
          });

        candidateTimer = setTimeout(async () => {
          candidateTimer = null;
          if (currentState !== STATE.CANDIDATE) {
            log.warn('[Detector] candidateTimer fired but state is not CANDIDATE — ignoring', { state: currentState });
            return;
          }
          if (_startRecordingLock) {
            log.warn('[Detector] candidateTimer fired but recording lock active — ignoring');
            return;
          }
          log.info('[Detector] Meeting confirmed, starting recording', {
            app: signals.appName, listenOnly: _candidateIsListenOnly
          });
          currentState = STATE.RECORDING;
          recordingAppInfo = signals.appConfig;
          _listenOnlyDetection = _candidateIsListenOnly;
          _listenOnlyStartPriority = priority;
          _presenceEndCount = 0;
          candidateAppConfig = null;
          _candidateIsListenOnly = false;
          try {
            await startRecording(signals.appName, signals.isTeams, signals.windowTitle);
          } catch (err) {
            log.error('[Detector] Failed to start recording, reverting to IDLE', { error: err.message });
            _resetDetectorState();
          }
        }, debounceMs);
      }
      break;

    case STATE.CANDIDATE:
      if (!signals.detected) {
        // Foreground check failed — before dropping to IDLE, check fallbacks
        let candidateStillValid = false;

        if (candidateAppConfig) {
          // For Teams desktop: check Graph Presence API
          const isTeamsDesktopCandidate = candidateAppConfig.isTeams &&
            candidateAppConfig.processes.some(p => TEAMS_PROCESS_SET.has(p.toLowerCase()));
          if (isTeamsDesktopCandidate && _lastPresenceResult && _lastPresenceResult.inMeeting) {
            candidateStillValid = true;
            log.debug('[Detector] Candidate fg lost but Presence API says still in meeting');
          }

          // For browser apps: check tab titles as fallback
          if (!candidateStillValid) {
            const isBrowser = candidateAppConfig.processes.some(p =>
              BROWSER_PROCESS_SET.has(p.toLowerCase())
            );
            if (isBrowser) {
              const tabTitles = getBrowserTabTitles();
              candidateStillValid = candidateAppConfig.titlePatterns.some(pattern =>
                tabTitles.some(title => title.toLowerCase().includes(pattern.toLowerCase()))
              );
              if (candidateStillValid) {
                log.debug('[Detector] Candidate fg lost but tab still open, keeping CANDIDATE');
              }
            }
          }
        }

        if (!candidateStillValid) {
          log.info('[Detector] Meeting candidate lost, returning to IDLE');
          clearTimeout(candidateTimer);
          candidateTimer = null;
          candidateAppConfig = null;
          _candidateIsListenOnly = false;
          _activeMeetingBrowserProcess = null;
          currentState = STATE.IDLE;
        }
      }
      break;

    case STATE.RECORDING: {
      // Grace period: skip end-detection for the first 20s after recording starts.
      // Signals (mic, tabs, audio) need time to stabilize; checking too early causes
      // false "meeting ended" events that fragment a single meeting into multiple short ones.
      if (Date.now() < _recordingGracePeriodEnd) {
        log.debug('[Detector] Recording grace period active — skipping end-detection');
        break;
      }

      // During recording, check if the SPECIFIC meeting app is still active
      // Browser meetings: UI Automation reads ALL tab titles (immune to tab switching)
      // Desktop meetings: checks all window titles for meeting keywords
      const stillActive = recordingAppInfo
        ? await isMeetingStillActive(processes, recordingAppInfo)
        : signals.detected; // fallback if no app info stored

      if (!stillActive) {
        if (!stopDebounceTimer) {
          const isTeamsRecording = recordingAppInfo && recordingAppInfo.isTeams;
          let debounceMs;
          if (_listenOnlyDetection) {
            // Listen-only: use InACall-based debounce (30s) for strong signals, 60s for weak
            debounceMs = (_listenOnlyStartPriority <= 2)
              ? LISTEN_ONLY_STOP_DEBOUNCE_MS
              : LISTEN_ONLY_WEAK_STOP_DEBOUNCE_MS;
          } else if (isTeamsRecording) {
            // Standard Teams: mic release is definitive, use short debounce
            debounceMs = TEAMS_MIC_STOP_DEBOUNCE_MS;
          } else if (recordingAppInfo && recordingAppInfo.isGoogleMeet) {
            // Google Meet: both strong title and mic are gone (combined signal).
            // Use dedicated debounce to allow brief signal drops without fragmenting.
            debounceMs = GMEET_STOP_DEBOUNCE_MS;
          } else {
            // Non-Teams: use shorter debounce if tab title was definitively negative
            // (UI Automation confirmed no matching tab). Full 30s only when indeterminate.
            debounceMs = _lastTitleDefinitive
              ? BROWSER_DEFINITIVE_STOP_DEBOUNCE_MS
              : STOP_DEBOUNCE_MS;
          }
          log.info('[Detector] Meeting no longer active, starting stop debounce', {
            debounceMs, isTeams: !!isTeamsRecording, listenOnly: _listenOnlyDetection
          });
          stopDebounceTimer = setTimeout(async () => {
            stopDebounceTimer = null;
            if (currentState !== STATE.RECORDING) return;

            // Final re-verification: do one fresh check before actually ending.
            // Signals may have recovered during the debounce window (mic reconnected,
            // tab scan returned results, etc.). This prevents ending meetings that
            // only had a brief signal dropout.
            if (recordingAppInfo) {
              // Invalidate mic cache to get a truly fresh read
              _lastMicCheck = { time: 0, result: { micActive: false, apps: [] } };
              const freshProcesses = getRunningProcesses();
              const freshStillActive = await isMeetingStillActive(freshProcesses, recordingAppInfo);
              if (freshStillActive) {
                log.info('[Detector] Stop debounce expired but fresh re-check says meeting is still active — cancelling end');
                return;
              }
            }

            handleMeetingEnd();
          }, debounceMs);
        }
      } else {
        if (stopDebounceTimer) {
          clearTimeout(stopDebounceTimer);
          stopDebounceTimer = null;
        }
      }
      break;
    }
  }
  } catch (err) {
    log.error('[Detector] Detection tick error', { error: err.message });
  }
}

let _detectionLoopRunning = false;

function startDetectionLoop() {
  // Guard: stop any existing loop before starting a new one.
  // Prevents duplicate parallel loops when called from multiple paths
  // (startup, re-enrollment, resume from suspend).
  if (_detectionLoopRunning) {
    log.warn('[Detector] Detection loop already running — restarting');
    stopDetectionLoop();
  }
  log.info('[Detector] Starting meeting detection loop');
  _detectionLoopRunning = true;
  _lastTickTime = Date.now(); // Reset sleep-gap baseline
  scheduleNextTick();
}

function scheduleNextTick() {
  if (!_detectionLoopRunning) return;
  detectionInterval = setTimeout(async () => {
    await detectionTick();
    scheduleNextTick(); // Schedule next only AFTER current tick completes (no overlap)
  }, POLL_INTERVAL_MS);
}

function stopDetectionLoop() {
  log.info('[Detector] Stopping meeting detection loop');
  _detectionLoopRunning = false;
  if (detectionInterval) {
    clearTimeout(detectionInterval);
    detectionInterval = null;
  }
  if (candidateTimer) {
    clearTimeout(candidateTimer);
    candidateTimer = null;
  }
  if (stopDebounceTimer) {
    clearTimeout(stopDebounceTimer);
    stopDebounceTimer = null;
  }
}

module.exports = { startDetectionLoop, stopDetectionLoop };
