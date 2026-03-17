import pg from 'pg';

const CONN_STRING = process.env.SUPABASE_DB_URL;
if (!CONN_STRING) {
  console.error('Missing env var: SUPABASE_DB_URL');
  process.exit(1);
}

const client = new pg.Client({
  connectionString: CONN_STRING,
  ssl: process.env.NODE_ENV === 'production' ? true : { rejectUnauthorized: false },
});

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
  if (tj && tj.metadata) {
    console.log('=== METADATA ===');
    console.log(JSON.stringify(tj.metadata, null, 2));
  } else {
    console.log('=== METADATA === (none)');
  }
  console.log('\n=== SEGMENTS ===');
  if (tj && Array.isArray(tj.segments)) {
    for (const seg of tj.segments) {
      console.log(`[${seg.start_time} - ${seg.end_time}] ${seg.speaker}: ${seg.text}`);
    }
  } else {
    console.log('(no segments)');
  }
} else {
  console.log('No transcripts found');
}

await client.end();
