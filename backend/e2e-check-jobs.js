const path = require('path');
const { createClient } = require(path.join(__dirname, '..', 'client-agent', 'node_modules', '@supabase', 'supabase-js'));
const sb = createClient(
  'https://mlawedxbkijeauzqxkgf.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1sYXdlZHhia2lqZWF1enF4a2dmIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3MDYyNDIwNCwiZXhwIjoyMDg2MjAwMjA0fQ.IInBu48f5UQl9xBKkmDg4E_fKt_7--d_T31I--ivkkI'
);

const IDS = [
  'ff7fca8c-d21d-4fe2-b718-acf31030684c',
  '98478786-eece-4f61-bc86-4db9427e957c',
  '500a73e3-baf6-416c-8623-3c8b8d511438',
  '416a885c-c82b-4bb1-9a9e-07aae732791d',
];

async function main() {
  // Check processing_jobs for these meetings
  const { data: jobs, error } = await sb.from('processing_jobs')
    .select('*')
    .in('meeting_id', IDS)
    .order('created_at');

  console.log('Processing jobs found:', jobs?.length || 0);
  if (jobs?.length > 0) {
    jobs.forEach(j => {
      console.log(`  ${j.meeting_id} | ${j.job_type} | ${j.status} | created: ${j.created_at}`);
    });
  }

  // Also check if cleanup_old_data or process_pending_jobs deletes completed jobs
  const { data: allJobs } = await sb.from('processing_jobs')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(20);

  console.log('\nRecent processing_jobs (last 20):');
  (allJobs || []).forEach(j => {
    console.log(`  ${j.id} | ${j.meeting_id} | ${j.job_type} | ${j.status} | ${j.created_at}`);
  });

  // Verify the actual pipeline result columns (not jobs)
  console.log('\n── Verifying actual pipeline outputs (not jobs) ──');
  for (const id of IDS) {
    const { data: m } = await sb.from('meetings').select('id, status, detected_category, email_sent_at').eq('id', id).single();
    const { data: s } = await sb.from('summaries').select('id').eq('meeting_id', id).single();
    const { data: a } = await sb.from('tone_alerts').select('id').eq('meeting_id', id);
    console.log(`  ${id.slice(0,8)}... | status=${m?.status} | cat=${m?.detected_category} | summary=${s ? 'YES' : 'NO'} | alerts=${a?.length || 0} | email=${m?.email_sent_at ? 'SENT' : 'no'}`);
  }
}

main().catch(console.error);
