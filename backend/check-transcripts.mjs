import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { Client } = require('pg');

const CONN = process.env.SUPABASE_DB_URL;

async function main() {
  if (!CONN) {
    console.error('Missing env var: SUPABASE_DB_URL');
    process.exit(1);
  }

  const c = new Client({ connectionString: CONN, ssl: process.env.NODE_ENV === 'production' ? true : { rejectUnauthorized: false } });
  await c.connect();

  console.log('\n=== MEETINGS WITH TIMESTAMPS ===');
  const meetings = await c.query(`
    SELECT m.id, m.detected_app, m.status, m.start_time, m.end_time,
           EXTRACT(EPOCH FROM (m.end_time - m.start_time))::int as duration_secs,
           m.detected_category, m.created_at
    FROM meetings m
    ORDER BY m.created_at DESC
  `);
  console.table(meetings.rows);

  console.log('\n=== TRANSCRIPTS CONTENT (first 300 chars each) ===');
  const transcripts = await c.query(`
    SELECT t.meeting_id, t.source, t.word_count,
           LEFT(
             (SELECT string_agg(seg->>'text', ' ')
              FROM jsonb_array_elements(t.transcript_json->'segments') AS seg),
             300
           ) as text_preview,
           t.created_at
    FROM transcripts t
    ORDER BY t.created_at DESC
  `);
  for (const row of transcripts.rows) {
    console.log(`\n--- Meeting: ${row.meeting_id} ---`);
    console.log(`Source: ${row.source} | Words: ${row.word_count} | Created: ${row.created_at}`);
    console.log(`Text: ${row.text_preview || '(empty)'}`);
  }

  console.log('\n=== SUMMARIES CONTENT ===');
  const summaries = await c.query(`
    SELECT s.meeting_id, s.category, LEFT(s.content, 200) as content_preview
    FROM summaries s
    ORDER BY s.created_at DESC
  `);
  for (const row of summaries.rows) {
    console.log(`\n--- Meeting: ${row.meeting_id} ---`);
    console.log(`Category: ${row.category}`);
    console.log(`Summary: ${row.content_preview}`);
  }

  await c.end();
}

main().catch(e => { console.error(e.message); process.exit(1); });
