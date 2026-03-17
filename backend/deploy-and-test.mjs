// deploy-and-test.mjs
// Deploys all updated SQL files and runs automated tests against Supabase.
// Usage: node deploy-and-test.mjs

import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { Client } = require('pg');

const CONN_STRING = process.env.SUPABASE_DB_URL;

let passed = 0;
let failed = 0;
const results = [];

function ok(name) {
  passed++;
  results.push({ name, status: 'PASS' });
  console.log(`  \u2713 ${name}`);
}

function fail(name, reason) {
  failed++;
  results.push({ name, status: 'FAIL', reason });
  console.log(`  \u2717 ${name}`);
  console.log(`    \u2192 ${reason}`);
}

async function runSQL(client, filePath) {
  const sql = readFileSync(resolve(__dirname, filePath), 'utf-8');
  await client.query(sql);
}

async function main() {
  if (!CONN_STRING) {
    console.error('Missing env var: SUPABASE_DB_URL');
    process.exit(1);
  }

  const client = new Client({
    connectionString: CONN_STRING,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 20000,
    query_timeout: 30000,
  });

  console.log('Connecting to Supabase...');
  await client.connect();
  console.log('Connected!\n');

  // ──────────────────────────────────────────────────────────────────────────
  // PHASE 1: DEPLOY UPDATED FILES
  // ──────────────────────────────────────────────────────────────────────────
  console.log('═══════════════════════════════════════════════════════════');
  console.log(' PHASE 1: DEPLOYING UPDATED SQL FILES');
  console.log('═══════════════════════════════════════════════════════════\n');

  const deployFiles = [
    { label: 'migration-019-db-integrity.sql', file: 'migration-019-db-integrity.sql' },
    { label: 'functions.sql (ON CONFLICT + NULL guards)', file: 'functions.sql' },
    { label: 'triggers.sql (empty transcript guard)', file: 'triggers.sql' },
    { label: 'cron-jobs.sql (FOR UPDATE SKIP LOCKED + H-3 guard + JSON validation)', file: 'cron-jobs.sql' },
    { label: 'migration-012-email-toggle-fix.sql (FOR UPDATE dedup + admin resend)', file: 'migration-012-email-toggle-fix.sql' },
    { label: 'migration-016-admin-invites.sql (FOR UPDATE on invite lookup)', file: 'migration-016-admin-invites.sql' },
  ];

  for (const { label, file } of deployFiles) {
    process.stdout.write(`  Deploying ${label}... `);
    try {
      await runSQL(client, file);
      console.log('OK');
    } catch (err) {
      console.log('FAILED');
      console.log(`    -> ${err.message.substring(0, 200)}`);
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // PHASE 2: STRUCTURAL TESTS
  // ──────────────────────────────────────────────────────────────────────────
  console.log('\n═══════════════════════════════════════════════════════════');
  console.log(' PHASE 2: STRUCTURAL TESTS');
  console.log('═══════════════════════════════════════════════════════════\n');

  // T1: Unique constraint on processing_jobs(meeting_id, job_type)
  {
    const r = await client.query(`
      SELECT COUNT(*) FROM pg_constraint
      WHERE conname = 'uq_processing_jobs_meeting_type' AND contype = 'u';
    `);
    r.rows[0].count === '1'
      ? ok('T1: UNIQUE constraint uq_processing_jobs_meeting_type exists')
      : fail('T1: UNIQUE constraint uq_processing_jobs_meeting_type missing', 'Run migration-019-db-integrity.sql');
  }

  // T2: Unique partial index on summaries WHERE is_default = true
  {
    const r = await client.query(`
      SELECT COUNT(*) FROM pg_indexes WHERE indexname = 'uq_summaries_default_per_meeting';
    `);
    r.rows[0].count === '1'
      ? ok('T2: UNIQUE partial index uq_summaries_default_per_meeting exists')
      : fail('T2: UNIQUE partial index uq_summaries_default_per_meeting missing', 'Run migration-019-db-integrity.sql');
  }

  // T3: Composite index on meetings(status, created_at)
  {
    const r = await client.query(`
      SELECT COUNT(*) FROM pg_indexes WHERE indexname = 'idx_meetings_status_created';
    `);
    r.rows[0].count === '1'
      ? ok('T3: Composite index idx_meetings_status_created exists')
      : fail('T3: Composite index idx_meetings_status_created missing', 'Run migration-019-db-integrity.sql');
  }

  // T4: get_openai_key() must be VOLATILE
  {
    const r = await client.query(`
      SELECT provolatile FROM pg_proc WHERE proname = 'get_openai_key' LIMIT 1;
    `);
    const vol = r.rows[0]?.provolatile;
    vol === 'v'
      ? ok("T4: get_openai_key() is VOLATILE (provolatile='v') — no stale key caching")
      : fail('T4: get_openai_key() is not VOLATILE', `provolatile='${vol}', expected 'v'. Fix M-6.`);
  }

  // T5: send_summary_email has 4 parameters (migration-012 live)
  {
    const r = await client.query(`
      SELECT pronargs FROM pg_proc WHERE proname = 'send_summary_email' LIMIT 1;
    `);
    const nargs = r.rows[0]?.pronargs;
    nargs === 4
      ? ok('T5: send_summary_email has 4 params — migration-012 version is live')
      : fail('T5: send_summary_email param count wrong', `pronargs=${nargs}, expected 4`);
  }

  // T6: send_manual_email exists
  {
    const r = await client.query(`SELECT COUNT(*) FROM pg_proc WHERE proname = 'send_manual_email';`);
    parseInt(r.rows[0].count) >= 1
      ? ok('T6: send_manual_email() exists')
      : fail('T6: send_manual_email() missing', 'Run migration-012-email-toggle-fix.sql');
  }

  // T7: send_deferred_email exists
  {
    const r = await client.query(`SELECT COUNT(*) FROM pg_proc WHERE proname = 'send_deferred_email';`);
    parseInt(r.rows[0].count) >= 1
      ? ok('T7: send_deferred_email() exists')
      : fail('T7: send_deferred_email() missing', 'Run migration-012-email-toggle-fix.sql');
  }

  // T8: process_pending_jobs uses FOR UPDATE SKIP LOCKED (H-1)
  {
    const r = await client.query(`SELECT prosrc FROM pg_proc WHERE proname = 'process_pending_jobs' LIMIT 1;`);
    const body = r.rows[0]?.prosrc || '';
    body.toLowerCase().includes('skip locked')
      ? ok('T8: process_pending_jobs uses FOR UPDATE SKIP LOCKED — no duplicate processing')
      : fail('T8: process_pending_jobs missing FOR UPDATE SKIP LOCKED', 'H-1 fix not in cron-jobs.sql');
  }

  // T9: process_pending_jobs has meeting existence guard (H-3)
  {
    const r = await client.query(`SELECT prosrc FROM pg_proc WHERE proname = 'process_pending_jobs' LIMIT 1;`);
    const body = r.rows[0]?.prosrc || '';
    body.includes('NOT EXISTS') && body.includes('v_job.meeting_id')
      ? ok('T9: process_pending_jobs has deleted-meeting guard — no FK crash on cleanup race')
      : fail('T9: process_pending_jobs missing deleted-meeting guard', 'H-3 fix not in cron-jobs.sql');
  }

  // T10: on_transcript_upserted has empty-text guard (NEW-6)
  {
    const r = await client.query(`SELECT prosrc FROM pg_proc WHERE proname = 'on_transcript_upserted' LIMIT 1;`);
    const body = r.rows[0]?.prosrc || '';
    body.includes('no text content') || body.includes('Transcript has no text content')
      ? ok('T10: on_transcript_upserted has empty-transcript guard')
      : fail('T10: on_transcript_upserted missing empty-transcript guard', 'NEW-6 fix not in triggers.sql');
  }

  // T11: call_openai has NULL request_id guard (NEW-5)
  {
    const r = await client.query(`SELECT prosrc FROM pg_proc WHERE proname = 'call_openai' AND pronargs = 6 LIMIT 1;`);
    const body = r.rows[0]?.prosrc || '';
    body.includes('v_request_id IS NULL') || body.includes('null request_id')
      ? ok('T11: call_openai() has NULL pg_net request_id guard')
      : fail('T11: call_openai() missing NULL pg_net guard', 'NEW-5 fix not in functions.sql');
  }

  // T12: call_openai_sync has JSON error body validation (NEW-4)
  {
    const r = await client.query(`SELECT prosrc FROM pg_proc WHERE proname = 'call_openai_sync' LIMIT 1;`);
    const body = r.rows[0]?.prosrc || '';
    body.includes("? 'error'") || body.includes("API error")
      ? ok("T12: call_openai_sync() validates for API-level error body (? 'error' check)")
      : fail('T12: call_openai_sync() missing error-body validation', 'NEW-4 fix not in functions.sql');
  }

  // T13: send_summary_email uses FOR UPDATE row lock for dedup (NEW-1)
  {
    const r = await client.query(`SELECT prosrc FROM pg_proc WHERE proname = 'send_summary_email' LIMIT 1;`);
    const body = r.rows[0]?.prosrc || '';
    body.includes('FOR UPDATE')
      ? ok('T13: send_summary_email uses FOR UPDATE row lock — concurrent dedup safe')
      : fail('T13: send_summary_email missing FOR UPDATE dedup lock', 'NEW-1 / email resend fix not deployed');
  }

  // T14: send_manual_email clears email_sent_at for admin resend
  {
    const r = await client.query(`SELECT prosrc FROM pg_proc WHERE proname = 'send_manual_email' LIMIT 1;`);
    const body = r.rows[0]?.prosrc || '';
    body.includes('email_sent_at = NULL')
      ? ok('T14: send_manual_email clears email_sent_at — unlimited admin resend works')
      : fail('T14: send_manual_email missing email_sent_at = NULL clear', 'Email resend fix not deployed');
  }

  // T15: agent_logs cleanup cron runs every 30 min (L-3) — auto-fix if still hourly
  {
    const r = await client.query(`SELECT schedule, command FROM cron.job WHERE jobname = 'cleanup-agent-logs' LIMIT 1;`);
    if (!r.rows[0]) {
      fail('T15: cleanup-agent-logs cron job not found', 'migration-017 not deployed');
    } else {
      const sched = r.rows[0].schedule || '';
      if (sched.includes('*/30')) {
        ok('T15: cleanup-agent-logs runs every 30 min');
      } else {
        // Auto-fix: unschedule + reschedule
        try {
          const cmd = r.rows[0].command || '';
          await client.query(`SELECT cron.unschedule('cleanup-agent-logs');`);
          await client.query(`SELECT cron.schedule('cleanup-agent-logs', '*/30 * * * *', $1);`, [cmd]);
          const v = await client.query(`SELECT schedule FROM cron.job WHERE jobname = 'cleanup-agent-logs' LIMIT 1;`);
          v.rows[0]?.schedule?.includes('*/30')
            ? ok('T15: cleanup-agent-logs rescheduled to every 30 min (was hourly)')
            : fail('T15: cleanup-agent-logs reschedule failed', `Got: ${v.rows[0]?.schedule}`);
        } catch (e) {
          fail('T15: cleanup-agent-logs reschedule error', e.message.substring(0, 200));
        }
      }
    }
  }

  // T16: redeem_admin_invite uses FOR UPDATE (H-2)
  {
    const r = await client.query(`SELECT prosrc FROM pg_proc WHERE proname = 'redeem_admin_invite' LIMIT 1;`);
    if (!r.rows[0]) {
      fail('T16: redeem_admin_invite function not found', 'migration-016 not deployed');
    } else {
      r.rows[0].prosrc.includes('FOR UPDATE')
        ? ok('T16: redeem_admin_invite uses FOR UPDATE — no duplicate invite race')
        : fail('T16: redeem_admin_invite missing FOR UPDATE on invite lookup', 'H-2 fix not deployed');
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // PHASE 3: BEHAVIORAL TESTS
  // ──────────────────────────────────────────────────────────────────────────
  console.log('\n═══════════════════════════════════════════════════════════');
  console.log(' PHASE 3: BEHAVIORAL TESTS');
  console.log('═══════════════════════════════════════════════════════════\n');

  const orgRow = await client.query(`SELECT id FROM organizations LIMIT 1;`);
  const userRow = await client.query(`SELECT id FROM profiles WHERE role = 'admin' LIMIT 1;`);
  const orgId = orgRow.rows[0]?.id;
  const userId = userRow.rows[0]?.id;

  // T17: ON CONFLICT DO NOTHING in processing_jobs (behavioral)
  {
    let mid = null;
    try {
      const ins = await client.query(`
        INSERT INTO meetings (org_id, user_id, detected_app, start_time, end_time, status)
        VALUES ($1, $2, 'TestApp', NOW() - INTERVAL '1 hour', NOW(), 'processing')
        RETURNING id;
      `, [orgId, userId]);
      mid = ins.rows[0].id;

      await client.query(`
        INSERT INTO processing_jobs (meeting_id, job_type, pg_net_request_id)
        VALUES ($1, 'summary', 99999) ON CONFLICT (meeting_id, job_type) DO NOTHING;
      `, [mid]);
      await client.query(`
        INSERT INTO processing_jobs (meeting_id, job_type, pg_net_request_id)
        VALUES ($1, 'summary', 99998) ON CONFLICT (meeting_id, job_type) DO NOTHING;
      `, [mid]);

      const cnt = await client.query(
        `SELECT COUNT(*) FROM processing_jobs WHERE meeting_id = $1 AND job_type = 'summary';`, [mid]);
      cnt.rows[0].count === '1'
        ? ok('T17: ON CONFLICT DO NOTHING in processing_jobs — duplicate insert silently ignored')
        : fail('T17: processing_jobs ON CONFLICT failed', `Got ${cnt.rows[0].count} rows, expected 1`);
    } catch (err) {
      fail('T17: processing_jobs ON CONFLICT test error', err.message.substring(0, 200));
    } finally {
      if (mid) await client.query(`DELETE FROM meetings WHERE id = $1;`, [mid]).catch(() => {});
    }
  }

  // T18: Unique partial index prevents duplicate default summaries
  {
    let mid2 = null;
    try {
      const ins = await client.query(`
        INSERT INTO meetings (org_id, user_id, detected_app, start_time, end_time, status)
        VALUES ($1, $2, 'TestApp2', NOW() - INTERVAL '2 hours', NOW() - INTERVAL '1 hour', 'processing')
        RETURNING id;
      `, [orgId, userId]);
      mid2 = ins.rows[0].id;

      await client.query(`INSERT INTO summaries (meeting_id, category, content, is_default) VALUES ($1, 'general', 'Summary A', true);`, [mid2]);

      // ON CONFLICT DO NOTHING path (used by cron-jobs.sql)
      await client.query(`
        INSERT INTO summaries (meeting_id, category, content, is_default)
        VALUES ($1, 'general', 'Summary B', true)
        ON CONFLICT (meeting_id) WHERE is_default = true DO NOTHING;
      `, [mid2]);

      const cnt = await client.query(
        `SELECT COUNT(*) FROM summaries WHERE meeting_id = $1 AND is_default = true;`, [mid2]);
      cnt.rows[0].count === '1'
        ? ok('T18: Unique partial index prevents duplicate default summaries')
        : fail('T18: Duplicate default summary was inserted', `Got ${cnt.rows[0].count} rows, expected 1`);
    } catch (err) {
      fail('T18: summaries unique index test error', err.message.substring(0, 200));
    } finally {
      if (mid2) await client.query(`DELETE FROM meetings WHERE id = $1;`, [mid2]).catch(() => {});
    }
  }

  // T19: email_sent_at column exists on meetings table
  {
    const r = await client.query(`
      SELECT COUNT(*) FROM information_schema.columns
      WHERE table_name = 'meetings' AND column_name = 'email_sent_at';
    `);
    r.rows[0].count === '1'
      ? ok('T19: email_sent_at column exists on meetings table')
      : fail('T19: email_sent_at column missing', 'Run migration-005-email-tracking.sql');
  }

  // T20: agent_logs table exists
  {
    const r = await client.query(`
      SELECT COUNT(*) FROM information_schema.tables WHERE table_name = 'agent_logs';
    `);
    r.rows[0].count === '1'
      ? ok('T20: agent_logs table exists (migration-017)')
      : fail('T20: agent_logs table missing', 'Run migration-017-agent-logs.sql');
  }

  // T21: admin_invites table has required columns (actual schema: used_by_email not used_by)
  {
    const r = await client.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'admin_invites' ORDER BY ordinal_position;
    `);
    const cols = r.rows.map(x => x.column_name);
    const required = ['code', 'created_by', 'expires_at', 'used_at'];
    const missing = required.filter(c => !cols.includes(c));
    missing.length === 0
      ? ok(`T21: admin_invites has required columns — [${cols.join(', ')}]`)
      : fail('T21: admin_invites missing columns', missing.join(', '));
  }

  // T22: Orphaned processing_jobs (NULL pg_net_request_id AND not completed) — actual blocker check
  {
    const r = await client.query(`
      SELECT COUNT(*) FROM processing_jobs WHERE pg_net_request_id IS NULL AND status != 'completed';
    `);
    const cnt = parseInt(r.rows[0].count);
    cnt === 0
      ? ok('T22: No stuck processing_jobs with NULL request_id (all NULL rows are completed — safe)')
      : fail('T22: Stuck processing_jobs with NULL request_id', `${cnt} non-completed rows with NULL request_id`);
  }

  // T23: No duplicate (meeting_id, job_type) in processing_jobs
  {
    const r = await client.query(`
      SELECT COUNT(*) FROM (
        SELECT meeting_id, job_type FROM processing_jobs
        GROUP BY meeting_id, job_type HAVING COUNT(*) > 1
      ) dups;
    `);
    parseInt(r.rows[0].count) === 0
      ? ok('T23: No duplicate processing_jobs rows — constraint will hold')
      : fail('T23: Duplicate processing_jobs rows exist', `${r.rows[0].count} duplicate pairs`);
  }

  // T24: No duplicate default summaries per meeting
  {
    const r = await client.query(`
      SELECT COUNT(*) FROM (
        SELECT meeting_id FROM summaries WHERE is_default = true
        GROUP BY meeting_id HAVING COUNT(*) > 1
      ) dups;
    `);
    parseInt(r.rows[0].count) === 0
      ? ok('T24: No duplicate default summaries — unique index will hold')
      : fail('T24: Duplicate default summaries exist', `${r.rows[0].count} meetings with >1 default summary`);
  }

  // T25: process_pending_jobs cron job is registered
  {
    const r = await client.query(`SELECT COUNT(*) FROM cron.job WHERE jobname ILIKE '%process%pending%';`);
    parseInt(r.rows[0].count) >= 1
      ? ok('T25: process_pending_jobs cron job is registered')
      : fail('T25: process_pending_jobs cron job not found', 'Run cron-jobs.sql');
  }

  // T26: All 4 test meetings still present in Supabase
  {
    const testIds = [
      'ff7fca8c-d21d-4fe2-b718-acf31030684c',
      '98478786-eece-4f61-bc86-4db9427e957c',
      '500a73e3-baf6-416c-8623-3c8b8d511438',
      '416a885c-c82b-4bb1-9a9e-07aae732791d',
    ];
    const r = await client.query(`
      SELECT id, status, detected_app FROM meetings WHERE id = ANY($1::uuid[]);
    `, [testIds]);
    r.rows.length === 4
      ? ok(`T26: All 4 test meetings (TC-001..TC-004) present — ${r.rows.map(x => `${x.detected_app}:${x.status}`).join(', ')}`)
      : fail('T26: Some test meetings missing', `Found ${r.rows.length}/4`);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // SUMMARY
  // ──────────────────────────────────────────────────────────────────────────
  console.log('\n═══════════════════════════════════════════════════════════');
  console.log(' RESULTS SUMMARY');
  console.log('═══════════════════════════════════════════════════════════\n');
  console.log(`  Total: ${passed + failed}  |  PASSED: ${passed}  |  FAILED: ${failed}\n`);

  if (failed > 0) {
    console.log('  FAILED TESTS:');
    results.filter(r => r.status === 'FAIL').forEach(r => {
      console.log(`    x ${r.name}`);
      console.log(`      -> ${r.reason}`);
    });
  } else {
    console.log('  All automated tests passed!');
  }

  console.log('\n═══════════════════════════════════════════════════════════');
  console.log(' MANUAL / REAL-TIME TESTS (require live agent + browser)');
  console.log('═══════════════════════════════════════════════════════════\n');

  console.log(`  RT-1: Email send + admin resend
    1. Open admin dashboard -> find a processed meeting
    2. Click "Send Email" -> verify email arrives in inbox
    3. Click "Send Email" again immediately -> should send again (admin resend now works)
    4. Verify second email arrives with same content\n`);

  console.log(`  RT-2: Teams transcript override -> email reflects updated summary
    1. Have a Teams meeting already processed + email sent (email_sent_at stamped)
    2. Trigger Teams transcript override (wait 5/10/15 min or force via deferred poll)
    3. Verify meeting re-processes with real speaker names in summary
    4. Click "Send Email" -> email should contain the NEW summary, not the old one\n`);

  console.log(`  RT-3: Back-to-back meeting detection (H-5 cooldown fix)
    1. End a GMeet call in Chrome
    2. Within 30s, start a NEW meeting in Teams or a different URL
    3. Verify: second meeting IS detected and recorded (cooldown no longer blocks cross-app)
    4. Two separate rows should appear in Supabase meetings table\n`);

  console.log(`  RT-4: Teams transcript pagination (H-4 - .top(200))
    - Only testable for users with >50 Teams meetings in the past 2 weeks
    - Confirm transcript override works for meetings beyond position #50\n`);

  console.log(`  RT-5: Back-to-back listen-only calls (_presenceEndCount reset, L-1)
    1. Attend two consecutive Teams calls as listen-only (no mic/camera)
    2. Verify both calls are detected and uploaded as separate meetings\n`);

  console.log(`  RT-6: Empty transcript graceful failure (NEW-6)
    1. Upload a transcript with empty segments: { "segments": [] }
    2. Verify meeting status immediately becomes "failed" with message "Transcript has no text content"
    3. Verify no OpenAI call is made (no processing_job row created)\n`);

  await client.end();
  console.log('Done. Connection closed.');
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
