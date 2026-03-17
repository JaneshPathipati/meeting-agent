import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { Client } = require('pg');
const { readFileSync } = require('fs');
const { resolve, dirname } = require('path');
const { fileURLToPath } = require('url');

const __dirname = dirname(fileURLToPath(import.meta.url));

const CONN = process.env.SUPABASE_DB_URL;

async function main() {
  if (!CONN) {
    console.error('Missing env var: SUPABASE_DB_URL');
    process.exit(1);
  }

  const c = new Client({ connectionString: CONN, ssl: { rejectUnauthorized: false } });
  await c.connect();
  console.log('Connected. Applying fixed cron-jobs.sql...');

  const sql = readFileSync(resolve(__dirname, 'cron-jobs.sql'), 'utf-8');
  try {
    await c.query(sql);
    console.log('OK: cron-jobs.sql applied successfully');
  } catch (err) {
    console.error('FAIL:', err.message);
  }

  // Verify: manually run process_pending_jobs once
  console.log('\nRunning process_pending_jobs() manually...');
  try {
    await c.query('SELECT process_pending_jobs()');
    console.log('OK: process_pending_jobs() executed');
  } catch (err) {
    console.error('FAIL:', err.message);
  }

  // Check results
  console.log('\n=== PROCESSING JOBS AFTER FIX ===');
  const jobs = await c.query(
    "SELECT job_type, status, COUNT(*) as count FROM processing_jobs GROUP BY job_type, status ORDER BY job_type, status"
  );
  console.table(jobs.rows);

  console.log('\n=== SUMMARIES AFTER FIX ===');
  const summaries = await c.query(
    "SELECT id, meeting_id, category, LEFT(content, 120) as preview FROM summaries ORDER BY created_at DESC LIMIT 5"
  );
  console.table(summaries.rows);

  console.log('\n=== MEETINGS STATUS AFTER FIX ===');
  const meetings = await c.query(
    "SELECT id, detected_app, status, detected_category FROM meetings ORDER BY created_at DESC LIMIT 5"
  );
  console.table(meetings.rows);

  await c.end();
}

main().catch(e => { console.error(e.message); process.exit(1); });
