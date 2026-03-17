import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { Client } = require('pg');

const CONN_STRING = process.env.SUPABASE_DB_URL;

async function main() {
  if (!CONN_STRING) {
    console.error('Missing env var: SUPABASE_DB_URL');
    process.exit(1);
  }

  const client = new Client({ connectionString: CONN_STRING, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 15000 });
  await client.connect();

  // All meetings with their transcript info
  const { rows } = await client.query(`
    SELECT m.id, m.start_time, m.end_time, m.duration_seconds, m.status, m.detected_app,
           t.source AS transcript_source, m.teams_transcript_attempt,
           p.full_name
    FROM meetings m
    LEFT JOIN transcripts t ON t.meeting_id = m.id
    LEFT JOIN profiles p ON p.id = m.user_id
    ORDER BY m.created_at DESC
    LIMIT 15
  `);

  console.log('=== All recent meetings ===');
  rows.forEach(r => {
    console.log('---');
    console.log('  id:', r.id);
    console.log('  user:', r.full_name);
    console.log('  start:', r.start_time);
    console.log('  end:  ', r.end_time);
    console.log('  same?:', r.start_time?.toISOString() === r.end_time?.toISOString() ? 'YES (0 duration bug)' : 'NO (times differ)');
    console.log('  dur:', r.duration_seconds, '| status:', r.status);
    console.log('  tx_source:', r.transcript_source, '| teams_attempt:', r.teams_transcript_attempt);
  });

  await client.end();
}
main().catch(e => { console.error(e); process.exit(1); });
