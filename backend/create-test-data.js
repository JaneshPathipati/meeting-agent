// Create persistent test meeting with tone alerts for manual reference
const path = require('path');
const { createClient } = require(path.join(__dirname, '..', 'client-agent', 'node_modules', '@supabase', 'supabase-js'));

const sb = createClient(
  'https://mlawedxbkijeauzqxkgf.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1sYXdlZHhia2lqZWF1enF4a2dmIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3MDYyNDIwNCwiZXhwIjoyMDg2MjAwMjA0fQ.IInBu48f5UQl9xBKkmDg4E_fKt_7--d_T31I--ivkkI'
);

const testTranscript = {
  segments: [
    { start_time: "00:00:05", speaker: "Alice", text: "Good morning everyone. Let's get started with the project update." },
    { start_time: "00:00:15", speaker: "Bob", text: "Sure. So I've been working on the backend API and it's about 80% done." },
    { start_time: "00:00:30", speaker: "Alice", text: "That's great progress. What about the frontend, Charlie?" },
    { start_time: "00:00:45", speaker: "Charlie", text: "Well, I've been trying to get the design right but honestly the requirements keep changing every day." },
    { start_time: "00:01:00", speaker: "Bob", text: "Oh come on, that's such a lame excuse. Maybe if you actually paid attention in the meetings you'd know what to build." },
    { start_time: "00:01:15", speaker: "Charlie", text: "Excuse me? I've been in every single meeting. The specs literally changed three times this week." },
    { start_time: "00:01:30", speaker: "Bob", text: "Whatever. Some of us actually deliver on time instead of whining about it." },
    { start_time: "00:01:45", speaker: "Alice", text: "Let's keep this professional. Bob, that's not helpful." },
    { start_time: "00:02:00", speaker: "Bob", text: "Fine, fine. I'm just saying, for someone who's been here two years, you'd think they could handle a simple UI change." },
    { start_time: "00:02:15", speaker: "Diana", text: "Can we move on? I have the QA report. We found 12 critical bugs in the API, Bob." },
    { start_time: "00:02:30", speaker: "Bob", text: "Oh great, another person who thinks they know better. Those aren't bugs, they're edge cases nobody cares about." },
    { start_time: "00:02:45", speaker: "Diana", text: "They're in the acceptance criteria. Users will hit them." },
    { start_time: "00:03:00", speaker: "Bob", text: "Look, I don't have time for this nonsense. Just mark them as won't fix." },
    { start_time: "00:03:15", speaker: "Alice", text: "Bob, we need to address critical bugs. Diana, can you prioritize the top 5 for this sprint?" },
    { start_time: "00:03:30", speaker: "Diana", text: "Already done. I'll share the list after the meeting." },
    { start_time: "00:03:45", speaker: "Alice", text: "Perfect. Let's wrap up. Action items: Charlie finishes the UI by Friday, Bob fixes top 5 bugs, Diana does regression testing." },
  ]
};

async function main() {
  const ORG_ID = 'a0000000-0000-0000-0000-000000000001';
  const USER_ID = 'b0000000-0000-0000-0000-000000000002';

  console.log('Creating persistent test meeting...');

  const { data: meeting, error: meetErr } = await sb
    .from('meetings')
    .insert({
      user_id: USER_ID, org_id: ORG_ID,
      start_time: new Date().toISOString(),
      end_time: new Date(Date.now() + 15 * 60000).toISOString(),
      detected_app: 'test-reference',
      status: 'uploaded'
    })
    .select('id').single();

  if (meetErr) { console.log('FAILED:', meetErr.message); return; }
  console.log('Meeting ID:', meeting.id);

  const { error: transErr } = await sb.from('transcripts').insert({
    meeting_id: meeting.id, transcript_json: testTranscript, source: 'local'
  });
  if (transErr) { console.log('Transcript FAILED:', transErr.message); return; }
  console.log('Transcript inserted. Pipeline triggered.');

  // Wait for processing
  console.log('Waiting for pipeline to complete...');
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 10000));
    const { data: m } = await sb.from('meetings').select('status, detected_category').eq('id', meeting.id).single();
    console.log(`  [${(i+1)*10}s] ${m.status} (${m.detected_category || '-'})`);
    if (m.status === 'processed' || m.status === 'failed') break;
  }

  // Print results
  const { data: m } = await sb.from('meetings').select('*').eq('id', meeting.id).single();
  const { data: summary } = await sb.from('summaries').select('*').eq('meeting_id', meeting.id).single();
  const { data: alerts } = await sb.from('tone_alerts').select('*').eq('meeting_id', meeting.id).order('start_time');

  console.log('\n=== PERSISTENT TEST DATA ===');
  console.log('Meeting ID:', meeting.id);
  console.log('Status:', m.status);
  console.log('Category:', m.detected_category);
  console.log('\nSummary:');
  console.log(summary?.content || 'NONE');
  console.log('\nTone Alerts:', alerts?.length || 0);
  (alerts || []).forEach(a => {
    console.log(`  [${a.severity.toUpperCase()}] ${a.start_time} ${a.speaker}: "${a.flagged_text}"`);
    console.log(`    Reason: ${a.reason}`);
  });
  console.log('\n>>> This data is NOT deleted. You can view it in the admin dashboard. <<<');
}

main().catch(console.error);
