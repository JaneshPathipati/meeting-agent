// file: client-agent/src/api/logUploader.js
// Best-effort remote log streaming to Supabase.
// Hooks into electron-log as a custom transport.
// Buffers info/warn/error entries and flushes every 60s (or when buffer hits 100).
// No retry — logs are ephemeral/diagnostic. Failures silently discard.
// Only active once the user is enrolled (userProfileId available in config).

const log = require('electron-log');
const { getSupabaseClient } = require('./supabaseClient');
const { getConfig } = require('../main/config');

const FLUSH_INTERVAL_MS = 60 * 1000; // flush every 60s
const MAX_BUFFER_SIZE = 100;          // also flush when buffer fills up
const UPLOAD_LEVELS = new Set(['info', 'warn', 'error']); // skip debug

let _buffer = [];
let _flushTimer = null;
let _started = false;
let _orgId = null; // cached after first resolve

// ── Parse an electron-log transport message into a DB row ──────────────────
// electron-log transport message shape:
//   msg.level   — 'info' | 'warn' | 'error' | 'debug' | 'verbose'
//   msg.data    — array of args passed to log.info(...args)
//   msg.date    — Date object
//
// Most log calls look like: log.info('[Module] Some text', { context: obj })
// We extract: module = 'Module', message = 'Some text', meta = { context: obj }
function parseLogMessage(msg) {
  const level = msg.level;
  if (!UPLOAD_LEVELS.has(level)) return null;

  const parts = msg.data || [];
  const firstArg = typeof parts[0] === 'string' ? parts[0] : '';

  // Extract [ModuleName] prefix
  const moduleMatch = firstArg.match(/^\[([^\]]+)\]\s*/);
  const module = moduleMatch ? moduleMatch[1] : null;
  const messageText = moduleMatch ? firstArg.slice(moduleMatch[0].length) : firstArg;

  // Additional args → meta (objects, arrays, etc.)
  const metaParts = parts.slice(1).filter(p => p !== null && p !== undefined);
  let meta = null;
  if (metaParts.length > 0) {
    try {
      meta = JSON.parse(JSON.stringify(metaParts.length === 1 ? metaParts[0] : metaParts));
    } catch (_) {
      meta = { raw: String(metaParts) };
    }
  }

  return {
    level,
    module,
    message: messageText.trim() || '(empty)',
    meta,
    logged_at: (msg.date || new Date()).toISOString(),
  };
}

// ── Resolve org_id once at startup (cached) ─────────────────────────────────
async function resolveOrgId(profileId) {
  try {
    const supabase = getSupabaseClient();
    const { data } = await supabase
      .from('profiles')
      .select('org_id')
      .eq('id', profileId)
      .single();
    _orgId = data?.org_id || null;
    if (_orgId) {
      log.info('[LogUploader] org_id resolved, remote logging active');
    }
  } catch (_) {
    // Will retry on next flush if still null
  }
}

// ── Flush buffer → Supabase ──────────────────────────────────────────────────
async function flushBuffer() {
  if (_buffer.length === 0) return;

  const profileId = getConfig('userProfileId');
  if (!profileId) {
    _buffer = []; // not enrolled, discard
    return;
  }

  // Resolve org_id if not yet cached
  if (!_orgId) {
    await resolveOrgId(profileId);
    if (!_orgId) {
      _buffer = []; // can't insert without org_id, discard
      return;
    }
  }

  const batch = _buffer.splice(0); // take all, clear in-place

  try {
    const supabase = getSupabaseClient();
    const rows = batch.map(entry => ({
      ...entry,
      profile_id: profileId,
      org_id: _orgId,
    }));
    await supabase.from('agent_logs').insert(rows);
  } catch (_) {
    // Silently discard on upload failure — never retry logs
  }
}

// ── Public API ───────────────────────────────────────────────────────────────
function startLogUploader() {
  if (_started) return;
  _started = true;

  // Register the custom electron-log transport
  log.transports['supabase'] = (msg) => {
    const entry = parseLogMessage(msg);
    if (!entry) return;
    _buffer.push(entry);
    if (_buffer.length >= MAX_BUFFER_SIZE) {
      flushBuffer(); // fire and forget — don't block transport
    }
  };

  // Kick off periodic flush
  _flushTimer = setInterval(flushBuffer, FLUSH_INTERVAL_MS);

  // Pre-resolve org_id in background (so first flush doesn't need to wait)
  const profileId = getConfig('userProfileId');
  if (profileId) resolveOrgId(profileId);

  log.info('[LogUploader] Remote log upload started');
}

function stopLogUploader() {
  if (_flushTimer) {
    clearInterval(_flushTimer);
    _flushTimer = null;
  }
  if (log.transports['supabase']) {
    delete log.transports['supabase'];
  }
  _started = false;
  _orgId = null;
  _buffer = [];
}

module.exports = { startLogUploader, stopLogUploader };
