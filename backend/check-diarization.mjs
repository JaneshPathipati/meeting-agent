import pg from 'pg';

const CONN_STRING = process.env.SUPABASE_DB_URL;
if (!CONN_STRING) {
  console.error('Missing env var: SUPABASE_DB_URL');
  process.exit(1);
}

const client = new pg.Client(CONN_STRING);

await client.connect();

const { rows } = await client.query(`
  SELECT t.transcript_json
  FROM transcripts t
  JOIN meetings m ON m.id = t.meeting_id
  ORDER BY m.start_time DESC
  LIMIT 1
`);

if (rows.length > 0) {
  const tj = rows[0].transcript_json;
  console.log('=== METADATA ===');
  console.log(JSON.stringify(tj.metadata, null, 2));
  console.log('\n=== SEGMENTS ===');
  for (const seg of tj.segments) {
    console.log(`[${seg.start_time} - ${seg.end_time}] ${seg.speaker}: ${seg.text}`);
  }
} else {
  console.log('No transcripts found');
}

await client.end();
