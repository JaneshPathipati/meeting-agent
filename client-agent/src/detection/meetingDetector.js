// file: client-agent/src/detection/meetingDetector.js
const { execSync } = require('child_process');
const log = require('electron-log');
const path = require('path');
const os = require('os');
const { startMicRecording, stopMicRecording } = require('../audio/micRecorder');
const { startSystemRecording, stopSystemRecording, getRecordingPath } = require('../audio/systemRecorder');
const { hasAudioActivity, resetAudioActivityState } = require('../audio/audioActivityChecker');
const { mixAudio, cleanupAudioFiles } = require('../audio/mixer');
const { transcribeAudio } = require('../transcription/parakeet');
const { checkTeamsTranscript, fallbackToLocalTranscript } = require('../transcription/teamsTranscript');
const { uploadMeeting, createMeetingRecord } = require('../api/uploader');
const { generateLocalAI } = require('../ai/localSummary');
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
let _presenceEndCount = 0;            // Consecutive non-call ticks during listen-only end detection
let _teamsPresenceMicOffCount = 0;    // Consecutive ticks where Teams mic off + presence null/not-in-meeting (Bug 2 tolerance)
let _lastTitleDefinitive = false;     // Whether last title check was definitively negative (for debounce optimization)
let _lastTickTime = Date.now();       // For sleep/wake detection via time-gap
let _powerSaveBlockerId = null;       // Electron powerSaveBlocker ID during recording

// Post-meeting cooldown: after a meeting ends, suppress new CANDIDATE creation for the
// same browser process for 90 seconds. This prevents a common false positive where Chrome
// holds the microphone resource ~30s after leaving a Google Meet (or any web meeting),
// causing a Teams tab that happens to be open to be falsely detected as a new meeting.
const POST_MEETING_COOLDOWN_MS = 90 * 1000;
let _lastMeetingEndTime = 0;
let _lastMeetingEndProcesses = []; // processes from the most recently ended recording
let _lastMeetingEndAppName = '';   // app name of the most recently ended recording (for cooldown scoping)

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

const POLL_INTERVAL_MS = 5000;
const DEBOUNCE_MS = 30000; // 30s debounce before confirming meeting
const GMEET_MIC_CONFIRMED_DEBOUNCE_MS = 2000; // 2s debounce when mic already active (user already in call) — applies to all apps
const LISTEN_ONLY_DEBOUNCE_MS = 60000; // 60s debounce for weak listen-only signals (InAMeeting-only, Priority 4)
const STOP_DEBOUNCE_MS = 30000; // 30s debounce before ending meeting (title-based apps, was 60s — tightened to reduce post-meeting audio capture)
const BROWSER_DEFINITIVE_STOP_DEBOUNCE_MS = 15000; // 15s debounce when browser tab title definitively gone
const GMEET_STOP_DEBOUNCE_MS = 8000; // 8s debounce when Google Meet mic released + tab title gone (fast, clean end signal)
const TEAMS_MIC_STOP_DEBOUNCE_MS = 30000; // 30s debounce for Teams desktop mic release (Teams 2.0 releases mic on mute)
const LISTEN_ONLY_STOP_DEBOUNCE_MS = 30000; // 30s debounce for listen-only InACall-based end detection
const LISTEN_ONLY_WEAK_STOP_DEBOUNCE_MS = 60000; // 60s debounce for listen-only InAMeeting-based end detection
const PRESENCE_END_TICKS_REQUIRED = 5; // 5 consecutive non-call ticks (~25s) to confirm end — extra buffer for API blips
const SUSTAINED_PRESENCE_TICKS = 3; // 3 consecutive ticks (~15s) for weak InAMeeting-only detection (Priority 4)
const MIN_MEETING_DURATION_MS = 30000; // Skip meetings shorter than 30s (accidental joins)
const MAX_RECORDING_MS = 4 * 60 * 60 * 1000; // 4 hours
const SLEEP_GAP_THRESHOLD_MS = 30000; // 30s gap between ticks = likely wake from sleep/hibernate

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
const MIC_CHECK_CACHE_MS = 10000; // Cache mic check for 10s to avoid hammering registry

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
// Teams title patterns: "Meeting with ...", "Call with ...", etc.
const TEAMS_MEETING_TITLE_KEYWORDS = ['meeting', 'call with', 'meet app'];

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

    // ── Signal 1: Teams desktop mic active = meeting (Presence-independent) ──
    const micActive = isAppUsingMic(teamsApp.processes);
    if (micActive) {
      log.info('[Detector] Teams meeting detected via mic active', {
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

      // Priority 3: InAMeeting (calendar) + Teams desktop title has meeting keywords
      if (teamsDesktopTitleHasMeetingKeywords()) {
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
        if (_teamsPresenceMicOffCount <= 1) {
          log.debug('[Detector] Teams mic released and Presence API returned null — tolerating one tick before ending', {
            count: _teamsPresenceMicOffCount, isDesktop: isTeamsDesktop, isBrowser: isTeamsBrowser
          });
          return true;
        }
        log.info('[Detector] Teams mic released + Presence null for 2 consecutive ticks — ending meeting', {
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
  } else if (recordingApp.isGoogleMeet && _lastBrowserMicReleased) {
    // Google Meet releases the Windows mic claim immediately when the user clicks "Leave".
    // Unlike Teams, Google Meet does not hold the mic after leaving.
    // Once mic has been active during the recording (_browserMicWasActive) and then released,
    // treat the meeting as ended — no need to check tab titles (the end-page tab persists).
    log.info('[Detector] Google Meet: mic released — meeting ended');
    stillActive = false;
  } else if (titleSignal) {
    // Title confirms meeting tab/window exists → definitely active
    stillActive = true;
  } else if (titleSignalIndeterminate) {
    // Couldn't read tabs/titles reliably (UI Automation failed, PowerShell error)
    // Use audio as fallback — better to keep recording than miss content
    stillActive = audioSignal;
  } else {
    // Title check worked but found no match → meeting window/tab was closed
    // Audio alone is NOT enough (user may be playing music/YouTube)
    stillActive = false;
  }

  // ── Google Meet: track mic-release as a fast end-of-meeting signal ──
  // Google Meet (unlike Teams) releases the browser's Windows mic claim immediately
  // when the user clicks "Leave". Track mic state transitions so the stop debounce
  // can be shortened (GMEET_STOP_DEBOUNCE_MS) when both mic AND title are gone.
  if (recordingApp.isGoogleMeet) {
    const micCurrentlyActive = isAppUsingMic(recordingApp.processes);
    if (micCurrentlyActive) {
      _browserMicWasActive = true;
      _lastBrowserMicReleased = false; // Reset: mic is active, no release yet
    } else if (_browserMicWasActive && !_lastBrowserMicReleased) {
      _lastBrowserMicReleased = true;
      log.info('[Detector] Google Meet: mic released (likely left the call)');
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
  const tempDir = path.join(os.tmpdir(), 'meetchamp');
  const fs = require('fs');
  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
  }
  return tempDir;
}

async function startRecording(appName, isTeams, windowTitle) {
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
      // Standard mode: both mic and system are required
      await Promise.all([
        startMicRecording(micPath),
        startSystemRecording(sysPath)
      ]);
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
    currentState = STATE.IDLE;
  }
}

async function handleMeetingEnd() {
  if (currentState !== STATE.RECORDING) return;
  currentState = STATE.STOPPING;

  if (maxRecordingTimer) {
    clearTimeout(maxRecordingTimer);
    maxRecordingTimer = null;
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
    currentState = STATE.IDLE;
    meetingStartTime = null;
    detectedApp = 'Unknown';
    recordingAppInfo = null;
    candidateAppConfig = null;
    teamsMeetingInfo = null;
    earlyMeetingId = null;
    _currentMicPath = null;
    _currentSysPath = null;
    _listenOnlyDetection = false;
    _candidateIsListenOnly = false;
    _listenOnlyStartPriority = 0;
    _presenceNoMicCount = 0;
    _presenceEndCount = 0;
    _teamsPresenceMicOffCount = 0;
    _lastTitleDefinitive = false;
    _browserMicWasActive = false;
    _lastBrowserMicReleased = false;
    _lastMicCheck = { time: 0, result: { micActive: false, apps: [] } };
    resetPresenceCache();
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
      currentState = STATE.IDLE;
      return;
    }

    // Verify files actually exist
    const micExists = micPath && fs.existsSync(micPath);
    const sysExists = sysPath && fs.existsSync(sysPath);

    if (!micExists && !sysExists) {
      log.error('[Detector] No audio files found at expected paths', { micPath, sysPath });
      currentState = STATE.IDLE;
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
      currentState = STATE.IDLE;
      return;
    }

    // Convert each stream to 16kHz mono WAV for transcription (required by Parakeet)
    const micMonoPath = effectiveMicPath ? path.join(tempDir, `mic_mono_${Date.now()}.wav`) : null;
    const sysMonoPath = effectiveSysPath ? path.join(tempDir, `sys_mono_${Date.now()}.wav`) : null;

    if (effectiveMicPath) {
      await mixAudio(effectiveMicPath, null, micMonoPath);
    }
    if (effectiveSysPath) {
      await mixAudio(null, effectiveSysPath, sysMonoPath);
    }

    // Dual-stream transcription: mic as user, system audio diarized for remote speakers
    log.info('[Detector] Starting dual-stream transcription + diarization');
    const userName = getConfig('userDisplayName') || getConfig('userName') || 'You';
    const transcript = await transcribeAudio(micMonoPath, sysMonoPath, userName);

    // Local AI: generate category, summary, structured JSON, and tone alerts
    // All processing happens on-device — no cloud API required.
    // Models download once on first use (~500 MB total) then run offline.
    log.info('[Detector] Starting local AI summary + tone analysis');
    let aiData = null;
    try {
      aiData = await generateLocalAI(transcript, userName, earlyMeetingId);
      log.info('[Detector] Local AI complete', {
        category:   aiData.category,
        summaryLen: aiData.summary?.length || 0,
        toneAlerts: aiData.toneAlerts?.length || 0,
      });
    } catch (aiErr) {
      log.error('[Detector] Local AI failed (meeting will still upload without summary)', {
        error: aiErr.message,
      });
    }

    // ── Post-AI fixups ──────────────────────────────────────────────────────

    // 1. Always override structuredJson.participants with ACTUAL speakers from transcript.
    //    GPT tends to extract mentioned names as participants (e.g., "Janesh sent mail to Srivastava"
    //    → Srivastava listed as participant). The transcript segments have the real speaker labels.
    const actualSpeakers = transcript.segments && transcript.segments.length > 0
      ? [...new Set(transcript.segments.map(s => s.speaker).filter(Boolean))]
      : [];

    if (actualSpeakers.length > 0) {
      if (!aiData) aiData = { category: 'general', summary: '', structuredJson: null, toneAlerts: [] };
      if (!aiData.structuredJson) aiData.structuredJson = {};
      aiData.structuredJson.participants = actualSpeakers;
      log.info('[Detector] Participants overridden from transcript speakers', { speakers: actualSpeakers });
    }

    // 2. If AI summary is still empty, build a guaranteed fallback from transcript content.
    if (aiData && !aiData.summary?.trim() && transcript.segments?.length > 0) {
      const speakers = actualSpeakers.length > 0 ? actualSpeakers : [userName];
      const sampleText = transcript.segments.slice(0, 8).map(s => s.text).join(' ');
      const truncated = sampleText.length > 300 ? sampleText.slice(0, 297) + '...' : sampleText;
      aiData.summary = `${speakers.join(' and ')} had a meeting. Conversation excerpt: "${truncated}"`;
      log.info('[Detector] Fallback summary built from transcript', { summaryLen: aiData.summary.length });
    }

    // Prepare meeting data
    const meetingData = {
      meetingId: earlyMeetingId, // If set, uploader will update instead of insert
      userId: getConfig('userProfileId'),
      startTime: meetingStartTime.toISOString(),
      endTime: meetingEndTime.toISOString(),
      detectedApp,
      transcript,
      source: transcript?.metadata?.source || 'local',
      teamsMeetingInfo,
      aiData, // Pre-generated summary/category/toneAlerts from local HF models
    };

    // Upload to Supabase
    await uploadMeeting(meetingData);

    // If Teams meeting, schedule transcript override check.
    // Skip ultra-short meetings (< 2 min) — likely ghost meetings from detection fragmentation.
    // No real meeting produces a meaningful Teams transcript in under 2 minutes.
    const meetingDurationSec = (new Date(meetingData.endTime) - new Date(meetingData.startTime)) / 1000;
    if (teamsMeetingInfo && meetingDurationSec >= 120) {
      scheduleTeamsTranscriptCheck(meetingData);
    } else if (teamsMeetingInfo) {
      log.info('[Detector] Skipping Teams transcript check for ultra-short meeting', {
        durationSec: Math.round(meetingDurationSec),
        meetingId: meetingData.meetingId
      });
    }

    // Cleanup audio files
    cleanupAudioFiles(micPath, sysPath, micMonoPath, sysMonoPath);

  } catch (err) {
    log.error('[Detector] Post-meeting processing failed', { error: err.message });

    // Capture before finally nulls them
    const failedTeamsInfo = teamsMeetingInfo;
    const failedMeetingId = earlyMeetingId;

    // Mark the early meeting record as failed so it doesn't stay in 'recording' forever
    if (failedMeetingId) {
      try {
        const supabase = require('../api/supabaseClient').getSupabaseClient();
        await supabase.from('meetings')
          .update({ status: 'failed', end_time: new Date().toISOString(), error_message: err.message })
          .eq('id', failedMeetingId);
      } catch (e) { /* best effort */ }

      // For Teams meetings: insert placeholder transcript + schedule MS Graph polling.
      // teamsTranscript.js uses .update() (not .upsert()), so a transcript row must exist
      // for the Teams transcript override to succeed.
      if (failedTeamsInfo) {
        // Skip ultra-short meetings (< 2 min) — ghost meetings from fragmentation
        const failedDurationSec = meetingStartTime
          ? (Date.now() - meetingStartTime.getTime()) / 1000
          : 0;

        if (failedDurationSec >= 120) {
          log.info('[Detector] Scheduling Teams transcript recovery after local failure');
          try {
            const supabase = require('../api/supabaseClient').getSupabaseClient();
            await supabase.from('transcripts').upsert({
              meeting_id: failedMeetingId,
              transcript_json: { segments: [], metadata: { source: 'pending_teams_recovery' } },
              source: 'local'
            }, { onConflict: 'meeting_id' });
          } catch (e) {
            log.warn('[Detector] Failed to insert placeholder transcript', { error: e.message });
          }

          scheduleTeamsTranscriptCheck({
            meetingId: failedMeetingId,
            userId: getConfig('userProfileId'),
            startTime: meetingStartTime ? meetingStartTime.toISOString() : new Date().toISOString(),
            endTime: new Date().toISOString(),
            detectedApp,
            teamsMeetingInfo: failedTeamsInfo
          });
        } else {
          log.info('[Detector] Skipping Teams transcript recovery for ultra-short meeting', {
            durationSec: Math.round(failedDurationSec),
            meetingId: failedMeetingId
          });
        }
      }
    }
  } finally {
    // Release power save blocker if still held
    if (_powerSaveBlockerId !== null) {
      try {
        const { powerSaveBlocker } = require('electron');
        if (powerSaveBlocker.isStarted(_powerSaveBlockerId)) {
          powerSaveBlocker.stop(_powerSaveBlockerId);
        }
      } catch (e) { /* ignore */ }
      _powerSaveBlockerId = null;
    }

    // Record which process/app just ended (for post-meeting cooldown) before nulling state
    _lastMeetingEndTime = Date.now();
    _lastMeetingEndProcesses = recordingAppInfo ? [...recordingAppInfo.processes] : [];
    _lastMeetingEndAppName = recordingAppInfo ? (recordingAppInfo.name || '') : '';
    currentState = STATE.IDLE;
    meetingStartTime = null;
    detectedApp = 'Unknown';
    recordingAppInfo = null;
    candidateAppConfig = null;
    teamsMeetingInfo = null;
    earlyMeetingId = null;
    _currentMicPath = null;
    _currentSysPath = null;
    _listenOnlyDetection = false;
    _candidateIsListenOnly = false;
    _listenOnlyStartPriority = 0;
    _presenceNoMicCount = 0;
    _presenceEndCount = 0;
    _teamsPresenceMicOffCount = 0;
    _lastTitleDefinitive = false;
    _browserMicWasActive = false;
    _lastBrowserMicReleased = false;
    _lastMicCheck = { time: 0, result: { micActive: false, apps: [] } };
    resetPresenceCache();
    try { setRecordingStatus(false); } catch (e) { /* ignore */ }
  }
}

function scheduleTeamsTranscriptCheck(meetingData) {
  // Dynamic delays based on meeting duration.
  // Microsoft Graph transcript availability scales with meeting length:
  //   < 15 min:  typically ready in 3-8 min
  //   15-60 min: typically ready in 5-15 min
  //   1-3 hours: can take 15-30 min
  //   3+ hours:  can take 30-45+ min
  //
  // Strategy: first check early (3 min), then spread remaining checks across
  // a total window proportional to meeting duration.
  //   Total window = clamp(meetingDuration * 0.5, 20 min, 60 min)
  //   Number of checks = 4-6 depending on window size
  //   First check always at 3 min (catch fast transcripts)
  const meetingDurationMs = new Date(meetingData.endTime) - new Date(meetingData.startTime);
  const meetingDurationMin = meetingDurationMs / 60000;

  // Total polling window: 50% of meeting duration, floored at 20 min, capped at 60 min
  const totalWindowMin = Math.min(60, Math.max(20, meetingDurationMin * 0.5));

  // Number of checks: 4 for short, up to 6 for long windows
  const numChecks = totalWindowMin <= 20 ? 4 : totalWindowMin <= 40 ? 5 : 6;

  // First check at 3 min, remaining checks evenly spread across the rest of the window
  const firstCheckMin = 3;
  const remainingWindowMin = totalWindowMin - firstCheckMin;
  const gapMin = remainingWindowMin / (numChecks - 1);

  const delays = [firstCheckMin * 60 * 1000];
  for (let i = 1; i < numChecks; i++) {
    delays.push(Math.round((firstCheckMin + gapMin * i) * 60 * 1000));
  }

  log.info('[Detector] Scheduling Teams transcript checks', {
    meetingDurationMin: Math.round(meetingDurationMin),
    totalWindowMin: Math.round(totalWindowMin),
    attempts: delays.length,
    delaysMin: delays.map(d => Math.round(d / 60000 * 10) / 10)
  });

  // Sequential scheduling: only schedule the NEXT attempt after the current one completes.
  // This prevents all overdue timers from firing simultaneously after system sleep/resume.
  // With parallel setTimeout, sleeping during the polling window causes ALL remaining timers
  // to fire at once (within milliseconds), creating race conditions in the Graph API calls.
  let currentAttempt = 0;

  function scheduleNext() {
    if (currentAttempt >= delays.length) return;

    // Calculate delay for THIS attempt: absolute delay minus previous absolute delay
    const absoluteDelay = delays[currentAttempt];
    const previousAbsoluteDelay = currentAttempt > 0 ? delays[currentAttempt - 1] : 0;
    const relativeDelay = absoluteDelay - previousAbsoluteDelay;

    setTimeout(async () => {
      currentAttempt++;
      const attempt = currentAttempt;
      const isLastAttempt = attempt === delays.length;

      try {
        log.info('[Detector] Teams transcript check attempt', { attempt, of: delays.length });
        const success = await checkTeamsTranscript(meetingData, attempt);

        if (success) {
          log.info('[Detector] Teams transcript override succeeded on attempt', { attempt });
          // Done — don't schedule more attempts
        } else if (isLastAttempt) {
          log.info('[Detector] All Teams transcript checks exhausted, falling back to local');
          await fallbackToLocalTranscript(meetingData);
        } else {
          scheduleNext(); // Schedule next only after current completes
        }
      } catch (err) {
        log.error('[Detector] Teams transcript check failed', {
          attempt,
          error: err.message
        });
        if (isLastAttempt) {
          log.info('[Detector] Final attempt failed, falling back to local');
          await fallbackToLocalTranscript(meetingData);
        } else {
          scheduleNext(); // Schedule next even after failure
        }
      }
    }, currentAttempt === 0 ? absoluteDelay : relativeDelay);
  }

  scheduleNext();
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

        // Post-meeting cooldown gate: if the same browser process AND same app just ended a
        // meeting within the last 90s, suppress the new CANDIDATE. Scoped to same app name
        // so that back-to-back different meetings (e.g., GMeet → Teams Browser, both in Chrome)
        // are not blocked — only same-app repeats (e.g., GMeet → GMeet) are suppressed.
        const candidateProcesses = signals.appConfig ? signals.appConfig.processes : [];
        const isSameApp = !_lastMeetingEndAppName || signals.appName === _lastMeetingEndAppName;
        if (signals.appConfig && (signals.appConfig.needsMicConfirm || signals.appConfig.isGoogleMeet) && isSameApp && isInPostMeetingCooldown(candidateProcesses)) {
          log.debug('[Detector] Suppressing CANDIDATE — same app+process in post-meeting cooldown', {
            app: signals.appName,
            lastApp: _lastMeetingEndAppName,
            cooldownRemainingSec: Math.round((POST_MEETING_COOLDOWN_MS - (Date.now() - _lastMeetingEndTime)) / 1000)
          });
          break;
        }
        const isListenOnly = !!signals.detectedWithoutMic;
        const priority = signals.listenOnlyPriority || 0;
        // Debounce selection:
        //   - Google Meet with mic confirmed (user already active in call): 8s — first 30s was being missed
        //   - Weak listen-only Priority 4 (sustained InAMeeting only): 60s
        //   - All other cases: 30s standard
        const debounceMs = signals.micConfirmed ? GMEET_MIC_CONFIRMED_DEBOUNCE_MS
          : (isListenOnly && priority >= 4) ? LISTEN_ONLY_DEBOUNCE_MS
          : DEBOUNCE_MS;
        log.info('[Detector] Meeting candidate detected', {
          app: signals.appName, listenOnly: isListenOnly, priority, debounceMs
        });
        currentState = STATE.CANDIDATE;
        candidateAppConfig = signals.appConfig;
        _candidateIsListenOnly = isListenOnly;
        _presenceEndCount = 0; // Reset listen-only end counter for new candidate
        candidateTimer = setTimeout(() => {
          candidateTimer = null;
          if (currentState === STATE.CANDIDATE) {
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
            startRecording(signals.appName, signals.isTeams, signals.windowTitle);
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
          currentState = STATE.IDLE;
        }
      }
      break;

    case STATE.RECORDING: {
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
          } else if (_lastBrowserMicReleased) {
            // Google Meet: mic released — Google Meet releases the Windows mic claim
            // immediately when the user clicks "Leave", unlike Teams which holds it.
            // The "Google Meet" lobby tab persists on the post-call page, so we don't
            // require the title to be gone — mic release alone is sufficient.
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
          stopDebounceTimer = setTimeout(() => {
            if (currentState === STATE.RECORDING) {
              handleMeetingEnd();
            }
            stopDebounceTimer = null;
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
