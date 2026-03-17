import pg from 'pg';
const { Client } = pg;

const CONN_STRING = process.env.SUPABASE_DB_URL;
if (!CONN_STRING) {
  console.error('Missing env var: SUPABASE_DB_URL');
  process.exit(1);
}

const client = new Client({
  connectionString: CONN_STRING,
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 15000,
});

await client.connect();

// 1. Overall stats
const stats = await client.query(`
  SELECT 
    COUNT(*) as total_meetings,
    COUNT(*) FILTER (WHERE status = 'processed') as processed,
    COUNT(*) FILTER (WHERE status = 'failed') as failed,
    COUNT(*) FILTER (WHERE email_sent_at IS NOT NULL) as emails_sent,
    COUNT(*) FILTER (WHERE email_sent_at IS NULL) as no_email
  FROM meetings
`);
console.log('\n=== OVERALL STATS ===');
console.log(JSON.stringify(stats.rows[0], null, 2));

// 2. All meetings without emails - detailed view
const noEmail = await client.query(`
  SELECT 
    m.id,
    p.full_name as user_name,
    m.detected_category,
    m.detected_app,
    m.status,
    m.error_message,
    m.teams_transcript_attempt,
    m.email_sent_at,
    m.created_at,
    t.source as transcript_source,
    t.overridden_at,
    t.word_count,
    EXISTS(SELECT 1 FROM summaries s WHERE s.meeting_id = m.id AND s.is_default = true) as has_summary,
    (SELECT content FROM summaries s WHERE s.meeting_id = m.id AND s.is_default = true LIMIT 1) IS NOT NULL as has_summary_content,
    (SELECT COUNT(*) FROM tone_alerts ta WHERE ta.meeting_id = m.id) as tone_alert_count
  FROM meetings m
  LEFT JOIN profiles p ON p.id = m.user_id
  LEFT JOIN transcripts t ON t.meeting_id = m.id
  WHERE m.email_sent_at IS NULL
  ORDER BY m.created_at DESC
`);
console.log('\n=== MEETINGS WITHOUT EMAIL ===');
console.log('Count:', noEmail.rows.length);
for (const row of noEmail.rows) {
  console.log('\n---');
  console.log('ID:', row.id);
  console.log('User:', row.user_name);
  console.log('Category:', row.detected_category);
  console.log('App:', row.detected_app);
  console.log('Status:', row.status);
  console.log('Error:', row.error_message);
  console.log('Teams Attempt:', row.teams_transcript_attempt);
  console.log('Transcript Source:', row.transcript_source);
  console.log('Overridden At:', row.overridden_at);
  console.log('Word Count:', row.word_count);
  console.log('Has Summary:', row.has_summary);
  console.log('Tone Alerts:', row.tone_alert_count);
  console.log('Created:', row.created_at);
}

// 3. Check for meetings that SHOULD have gotten email but didn't
// (processed + has summary + not teams-deferred)
const shouldHaveEmail = await client.query(`
  SELECT 
    m.id,
    p.full_name,
    m.detected_category,
    m.detected_app,
    m.status,
    m.teams_transcript_attempt,
    t.source,
    t.word_count,
    o.emails_enabled as org_emails_enabled,
    p.summary_enabled as user_summary_enabled
  FROM meetings m
  LEFT JOIN profiles p ON p.id = m.user_id
  LEFT JOIN transcripts t ON t.meeting_id = m.id
  LEFT JOIN organizations o ON o.id = m.org_id
  WHERE m.email_sent_at IS NULL
    AND m.status = 'processed'
    AND EXISTS(SELECT 1 FROM summaries s WHERE s.meeting_id = m.id AND s.is_default = true)
  ORDER BY m.created_at DESC
`);
console.log('\n=== PROCESSED WITH SUMMARY BUT NO EMAIL (SHOULD HAVE GOTTEN EMAIL) ===');
console.log('Count:', shouldHaveEmail.rows.length);
for (const row of shouldHaveEmail.rows) {
  console.log('\n---');
  console.log('ID:', row.id);
  console.log('User:', row.full_name);
  console.log('Category:', row.detected_category);
  console.log('App:', row.detected_app);
  console.log('Teams Attempt:', row.teams_transcript_attempt);
  console.log('Source:', row.source);
  console.log('Word Count:', row.word_count);
  console.log('Org Emails Enabled:', row.org_emails_enabled);
  console.log('User Summary Enabled:', row.user_summary_enabled);
}

// 4. Failed meetings breakdown
const failedMeetings = await client.query(`
  SELECT 
    m.id,
    p.full_name,
    m.detected_category,
    m.detected_app,
    m.error_message,
    m.created_at,
    EXISTS(SELECT 1 FROM transcripts t WHERE t.meeting_id = m.id) as has_transcript
  FROM meetings m
  LEFT JOIN profiles p ON p.id = m.user_id
  WHERE m.status = 'failed'
  ORDER BY m.created_at DESC
`);
console.log('\n=== FAILED MEETINGS ===');
console.log('Count:', failedMeetings.rows.length);
for (const row of failedMeetings.rows) {
  console.log('\n---');
  console.log('ID:', row.id);
  console.log('User:', row.full_name);
  console.log('Category:', row.detected_category);
  console.log('App:', row.detected_app);
  console.log('Error:', row.error_message);
  console.log('Has Transcript:', row.has_transcript);
  console.log('Created:', row.created_at);
}

// 5. Check email_logs table if exists
try {
  const emailLogs = await client.query(`
    SELECT * FROM email_logs ORDER BY created_at DESC LIMIT 20
  `);
  console.log('\n=== EMAIL LOGS (last 20) ===');
  console.log('Count:', emailLogs.rows.length);
  for (const row of emailLogs.rows) {
    console.log(JSON.stringify(row));
  }
} catch (e) {
  console.log('\n=== EMAIL LOGS: table does not exist ===');
}

// 6. Check send_summary_email function exists and its definition
const fnCheck = await client.query(`
  SELECT prosrc FROM pg_proc WHERE proname = 'send_summary_email'
`);
console.log('\n=== send_summary_email function exists:', fnCheck.rows.length > 0, '===');

// 7. Teams-deferred meetings that never got their email
const teamsDeferred = await client.query(`
  SELECT 
    m.id,
    p.full_name,
    m.detected_category,
    m.teams_transcript_attempt,
    m.detected_app,
    t.source,
    m.email_sent_at,
    m.status,
    m.error_message
  FROM meetings m
  LEFT JOIN profiles p ON p.id = m.user_id
  LEFT JOIN transcripts t ON t.meeting_id = m.id
  WHERE m.detected_app LIKE 'Microsoft Teams%'
    AND m.status = 'processed'
  ORDER BY m.created_at DESC
`);
console.log('\n=== ALL TEAMS MEETINGS (processed) ===');
for (const row of teamsDeferred.rows) {
  console.log('\n---');
  console.log('ID:', row.id);
  console.log('User:', row.full_name);
  console.log('Category:', row.detected_category);
  console.log('Teams Attempt:', row.teams_transcript_attempt);
  console.log('Source:', row.source);
  console.log('Email Sent:', row.email_sent_at);
  console.log('Error:', row.error_message);
}

await client.end();
console.log('\n=== AUDIT COMPLETE ===');
