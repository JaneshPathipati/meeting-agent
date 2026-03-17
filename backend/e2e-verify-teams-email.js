/**
 * Verify Teams deferred email path by calling send_deferred_email RPC
 * This simulates what the client-agent does when Teams transcript polling exhausts.
 */
const path = require('path');
const { createClient } = require(path.join(__dirname, '..', 'client-agent', 'node_modules', '@supabase', 'supabase-js'));

const sb = createClient(
  'https://mlawedxbkijeauzqxkgf.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1sYXdlZHhia2lqZWF1enF4a2dmIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3MDYyNDIwNCwiZXhwIjoyMDg2MjAwMjA0fQ.IInBu48f5UQl9xBKkmDg4E_fKt_7--d_T31I--ivkkI'
);

const TEAMS_MEETING_IDS = [
  { id: 'ff7fca8c-d21d-4fe2-b718-acf31030684c', name: 'TC-001: Microsoft Teams Desktop' },
  { id: '98478786-eece-4f61-bc86-4db9427e957c', name: 'TC-002: Microsoft Teams (Chrome)' },
];

async function main() {
  console.log('── Teams Deferred Email Verification ──');
  console.log('Calling send_deferred_email() RPC for Teams meetings...\n');

  for (const tm of TEAMS_MEETING_IDS) {
    console.log(`${tm.name} (${tm.id}):`);

    // Check current state
    const { data: meeting } = await sb.from('meetings')
      .select('email_sent_at, teams_transcript_attempt, status')
      .eq('id', tm.id).single();

    console.log(`  Status: ${meeting?.status}, attempt: ${meeting?.teams_transcript_attempt}, email_sent_at: ${meeting?.email_sent_at || 'null'}`);

    if (meeting?.email_sent_at) {
      console.log('  Email already sent. Skipping.\n');
      continue;
    }

    // Call the RPC
    const { data: result, error: rpcErr } = await sb.rpc('send_deferred_email', {
      p_meeting_id: tm.id
    });

    if (rpcErr) {
      console.log(`  RPC ERROR: ${rpcErr.message}`);
      console.log(`  Details: ${JSON.stringify(rpcErr)}`);
    } else {
      console.log(`  RPC result: ${result}`);
    }

    // Re-check email_sent_at
    const { data: after } = await sb.from('meetings')
      .select('email_sent_at')
      .eq('id', tm.id).single();

    console.log(`  email_sent_at after RPC: ${after?.email_sent_at || 'null'}`);
    console.log(`  Email sent: ${after?.email_sent_at ? 'YES' : 'NO'}\n`);
  }
}

main().catch(console.error);
