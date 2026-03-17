import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { Client } = require('pg');

const CONN = process.env.SUPABASE_DB_URL || process.env.DATABASE_URL;

async function main() {
  if (!CONN) {
    console.error('Missing env var: SUPABASE_DB_URL (or DATABASE_URL)');
    process.exit(1);
  }

  const c = new Client({ connectionString: CONN, ssl: { rejectUnauthorized: false } });
  await c.connect();

  // Check if pg_net extension is enabled
  console.log('\n=== pg_net EXTENSION ===');
  try {
    const ext = await c.query("SELECT extname, extversion FROM pg_extension WHERE extname = 'pg_net'");
    console.table(ext.rows);
    if (ext.rows.length === 0) console.log('*** pg_net NOT INSTALLED ***');
  } catch (e) { console.log('Error:', e.message); }

  // Check if pg_cron extension is enabled
  console.log('\n=== pg_cron EXTENSION ===');
  try {
    const cron = await c.query("SELECT extname, extversion FROM pg_extension WHERE extname = 'pg_cron'");
    console.table(cron.rows);
    if (cron.rows.length === 0) console.log('*** pg_cron NOT INSTALLED ***');
  } catch (e) { console.log('Error:', e.message); }

  // Check cron jobs
  console.log('\n=== CRON JOBS ===');
  try {
    const jobs = await c.query("SELECT jobid, schedule, command, nodename FROM cron.job");
    console.table(jobs.rows);
  } catch (e) { console.log('Error:', e.message); }

  // Check net._http_response schema
  console.log('\n=== net._http_response COLUMNS ===');
  try {
    const cols = await c.query("SELECT column_name, data_type FROM information_schema.columns WHERE table_schema = 'net' AND table_name = '_http_response' ORDER BY ordinal_position");
    console.table(cols.rows);
    if (cols.rows.length === 0) console.log('*** net._http_response table NOT FOUND ***');
  } catch (e) { console.log('Error:', e.message); }

  // Check if any pg_net responses exist
  console.log('\n=== pg_net RESPONSES (sample) ===');
  try {
    const resp = await c.query("SELECT id, status_code, LEFT(content::text, 150) as content_preview FROM net._http_response ORDER BY id DESC LIMIT 5");
    console.table(resp.rows);
  } catch (e) { console.log('Error:', e.message); }

  // Check vault key
  console.log('\n=== VAULT KEY ===');
  try {
    const vault = await c.query("SELECT name, LEFT(decrypted_secret, 15) as key_prefix FROM vault.decrypted_secrets WHERE name = 'openai_api_key'");
    console.table(vault.rows);
    if (vault.rows.length === 0) console.log('*** OpenAI key NOT IN VAULT ***');
  } catch (e) { console.log('Error:', e.message); }

  // Check a sample pg_net request id from processing_jobs
  console.log('\n=== SAMPLE REQUEST IDs ===');
  try {
    const req = await c.query("SELECT pg_net_request_id FROM processing_jobs ORDER BY created_at DESC LIMIT 3");
    console.table(req.rows);
  } catch (e) { console.log('Error:', e.message); }

  await c.end();
}

main().catch(e => { console.error(e.message); process.exit(1); });
