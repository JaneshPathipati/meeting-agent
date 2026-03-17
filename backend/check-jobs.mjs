import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { Client } = require('pg');

const CONN = process.env.SUPABASE_DB_URL;

async function main() {
  if (!CONN) {
    console.error('Missing env var: SUPABASE_DB_URL');
    process.exit(1);
  }

  const c = new Client({ connectionString: CONN, ssl: { rejectUnauthorized: false } });
  await c.connect();

  console.log('\n=== PROCESSING JOBS (latest 15) ===');
  const jobs = await c.query(
    'SELECT id, meeting_id, job_type, status, error_message, attempts, created_at FROM processing_jobs ORDER BY created_at DESC LIMIT 15'
  );
  console.table(jobs.rows);

  console.log('\n=== MEETINGS STATUS ===');
  const meetings = await c.query(
    'SELECT id, detected_app, status, detected_category, error_message, created_at FROM meetings ORDER BY created_at DESC LIMIT 10'
  );
  console.table(meetings.rows);

  console.log('\n=== SUMMARIES ===');
  const summaries = await c.query(
    'SELECT id, meeting_id, category, LEFT(content, 100) as content_preview, created_at FROM summaries ORDER BY created_at DESC LIMIT 10'
  );
  console.table(summaries.rows);

  console.log('\n=== PENDING pg_net RESPONSES ===');
  const pending = await c.query(
    "SELECT pj.id, pj.job_type, pj.status, r.status_code, LEFT(r.body::text, 200) as response_preview FROM processing_jobs pj LEFT JOIN net._http_response r ON r.id = pj.pg_net_request_id WHERE pj.status = 'pending' ORDER BY pj.created_at DESC LIMIT 10"
  );
  console.table(pending.rows);

  console.log('\n=== VAULT KEY CHECK ===');
  const vault = await c.query(
    "SELECT name, LEFT(decrypted_secret, 10) as key_prefix FROM vault.decrypted_secrets WHERE name = 'openai_api_key'"
  );
  console.table(vault.rows);

  await c.end();
}

main().catch(e => { console.error(e.message); process.exit(1); });
