/**
 * Final comprehensive verification report for all E2E test data.
 * Reads all test meetings and generates detailed status for every pipeline stage.
 */
const path = require('path');
const { createClient } = require(path.join(__dirname, '..', 'client-agent', 'node_modules', '@supabase', 'supabase-js'));

const sb = createClient(
  'https://mlawedxbkijeauzqxkgf.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1sYXdlZHhia2lqZWF1enF4a2dmIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3MDYyNDIwNCwiZXhwIjoyMDg2MjAwMjA0fQ.IInBu48f5UQl9xBKkmDg4E_fKt_7--d_T31I--ivkkI'
);

const TEST_MEETINGS = [
  { id: 'ff7fca8c-d21d-4fe2-b718-acf31030684c', label: 'TC-001: Microsoft Teams (Desktop App)', platform: 'Teams Desktop', isTeams: true, expectFlags: true },
  { id: '98478786-eece-4f61-bc86-4db9427e957c', label: 'TC-002: Microsoft Teams (Chrome Browser)', platform: 'Teams Browser', isTeams: true, expectFlags: true },
  { id: '500a73e3-baf6-416c-8623-3c8b8d511438', label: 'TC-003: Google Meet (Chrome Browser)', platform: 'GMeet Chrome', isTeams: false, expectFlags: true },
  { id: '416a885c-c82b-4bb1-9a9e-07aae732791d', label: 'TC-004: Google Meet (Edge Browser)', platform: 'GMeet Edge', isTeams: false, expectFlags: false },
];

async function main() {
  console.log('');
  console.log('╔════════════════════════════════════════════════════════════════════════╗');
  console.log('║           MEETCHAMP E2E PIPELINE — FINAL VERIFICATION REPORT          ║');
  console.log('╠════════════════════════════════════════════════════════════════════════╣');
  console.log('║  Date: ' + new Date().toISOString().padEnd(63) + '║');
  console.log('╚════════════════════════════════════════════════════════════════════════╝');
  console.log('');

  const allChecks = [];

  for (const tm of TEST_MEETINGS) {
    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    console.log(`  ${tm.label}`);
    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);

    // Fetch all data
    const [meetingRes, transcriptRes, summaryRes, alertsRes, jobsRes] = await Promise.all([
      sb.from('meetings').select('*').eq('id', tm.id).single(),
      sb.from('transcripts').select('id, source, word_count, created_at, overridden_at').eq('meeting_id', tm.id).single(),
      sb.from('summaries').select('id, content, is_default, created_at').eq('meeting_id', tm.id).eq('is_default', true).single(),
      sb.from('tone_alerts').select('id, severity, speaker, start_time, flagged_text, reason, is_reviewed').eq('meeting_id', tm.id).order('start_time'),
      sb.from('processing_jobs').select('*').eq('meeting_id', tm.id).order('created_at'),
    ]);

    const meeting = meetingRes.data;
    const transcript = transcriptRes.data;
    const summary = summaryRes.data;
    const alerts = alertsRes.data || [];
    const jobs = jobsRes.data || [];

    const checks = [];

    // ── Stage 1: Meeting Record ──
    const s1 = !!meeting;
    checks.push({ stage: 'Meeting Record', pass: s1, confidence: s1 ? 100 : 0,
      detail: s1 ? `Status=${meeting.status}, App=${meeting.detected_app}, Category=${meeting.detected_category}` : 'MISSING' });

    // ── Stage 2: Transcript ──
    const s2 = !!transcript;
    checks.push({ stage: 'Transcript Stored', pass: s2, confidence: s2 ? 100 : 0,
      detail: s2 ? `Source=${transcript.source}, Words=${transcript.word_count}, Created=${transcript.created_at}` : 'MISSING' });

    // ── Stage 3: Category Detection (Async pg_net) ──
    const catJob = jobs.find(j => j.job_type === 'category');
    const hasCat = !!meeting?.detected_category;
    const catCompleted = catJob?.status === 'completed';
    const s3pass = hasCat && catCompleted;
    checks.push({ stage: 'Category Detection (pg_net async)', pass: s3pass, confidence: s3pass ? 100 : hasCat ? 80 : 0,
      detail: `Category=${meeting?.detected_category || 'NONE'}, Job=${catJob ? catJob.status : 'NOT FOUND'}` });

    // ── Stage 4: Summary Generation (sync http) ──
    const sumJob = jobs.find(j => j.job_type === 'summary_tone');
    const hasSummary = !!summary?.content;
    const sumCompleted = sumJob?.status === 'completed';
    const s4pass = hasSummary && sumCompleted;
    checks.push({ stage: 'Summary Generation (sync http)', pass: s4pass, confidence: s4pass ? 100 : hasSummary ? 80 : 0,
      detail: `SummaryLen=${summary?.content?.length || 0}chars, Job=${sumJob ? sumJob.status : 'NOT FOUND'}` });

    // ── Stage 5: Tone Analysis ──
    const hasAlerts = alerts.length > 0;
    const alertsCorrect = tm.expectFlags ? hasAlerts : !hasAlerts;
    checks.push({ stage: 'Tone Analysis', pass: alertsCorrect, confidence: alertsCorrect ? 90 : 40,
      detail: `Found=${alerts.length} alerts, Expected=${tm.expectFlags ? '>0' : '0'}, Severities=[${alerts.map(a => a.severity).join(',')}]` });

    // ── Stage 6: Email Delivery ──
    const emailSent = !!meeting?.email_sent_at;
    checks.push({ stage: 'Email Delivery', pass: emailSent, confidence: emailSent ? 100 : 0,
      detail: emailSent ? `Sent at: ${meeting.email_sent_at}` : 'NOT SENT' });

    // ── Stage 7: Teams Deferral (Teams only) ──
    if (tm.isTeams) {
      const attempt = meeting?.teams_transcript_attempt || 0;
      const deferralCorrect = attempt >= 99;
      checks.push({ stage: 'Teams Email Deferral', pass: deferralCorrect, confidence: deferralCorrect ? 100 : 30,
        detail: `teams_transcript_attempt=${attempt} (99=exhausted, email sent via RPC)` });
    }

    // ── Stage 8: Final Status ──
    const isProcessed = meeting?.status === 'processed';
    checks.push({ stage: 'Final Status = processed', pass: isProcessed, confidence: isProcessed ? 100 : 0,
      detail: `Status: ${meeting?.status}` });

    // Print
    console.log('');
    const passCount = checks.filter(c => c.pass).length;
    const totalCount = checks.length;
    const avgConf = (checks.reduce((s, c) => s + c.confidence, 0) / totalCount).toFixed(1);

    checks.forEach(c => {
      const icon = c.pass ? 'PASS' : 'FAIL';
      console.log(`  [${icon}]  ${c.stage.padEnd(35)}  Confidence: ${String(c.confidence + '%').padStart(4)}  |  ${c.detail}`);
    });

    console.log('');
    console.log(`  Score: ${passCount}/${totalCount} passed  |  Average Confidence: ${avgConf}%`);

    // Tone alert details
    if (alerts.length > 0) {
      console.log('');
      console.log('  Tone Alerts:');
      alerts.forEach((a, i) => {
        console.log(`    ${i + 1}. [${a.severity.toUpperCase()}] ${a.start_time} — ${a.speaker}`);
        console.log(`       Text: "${a.flagged_text}"`);
        console.log(`       Reason: ${a.reason}`);
      });
    }

    // Summary excerpt
    if (summary?.content) {
      const lines = summary.content.split('\n').slice(0, 4).join('\n');
      console.log('');
      console.log('  Summary (excerpt):');
      console.log(`    ${lines.replace(/\n/g, '\n    ')}`);
    }

    console.log('');
    allChecks.push({ testCase: tm, checks, passCount, totalCount, avgConf });
  }

  // ═══════════════════════════════════════════════════════════════════════
  // GRAND SUMMARY
  // ═══════════════════════════════════════════════════════════════════════
  console.log('');
  console.log('╔════════════════════════════════════════════════════════════════════════╗');
  console.log('║                        GRAND SUMMARY                                 ║');
  console.log('╚════════════════════════════════════════════════════════════════════════╝');
  console.log('');

  const grandTotal = allChecks.reduce((s, r) => s + r.totalCount, 0);
  const grandPassed = allChecks.reduce((s, r) => s + r.passCount, 0);
  const grandConf = (allChecks.reduce((s, r) => s + parseFloat(r.avgConf) * r.totalCount, 0) / grandTotal).toFixed(1);

  console.log('┌──────────────────────────────────────┬───────┬────────────────────┐');
  console.log('│ Test Case                            │ Score │ Avg Confidence     │');
  console.log('├──────────────────────────────────────┼───────┼────────────────────┤');
  allChecks.forEach(r => {
    const name = r.testCase.label.substring(0, 36).padEnd(36);
    const score = `${r.passCount}/${r.totalCount}`.padEnd(5);
    const conf = `${r.avgConf}%`.padEnd(18);
    console.log(`│ ${name} │ ${score} │ ${conf} │`);
  });
  console.log('├──────────────────────────────────────┼───────┼────────────────────┤');
  console.log(`│ ${'OVERALL'.padEnd(36)} │ ${(grandPassed+'/'+grandTotal).padEnd(5)} │ ${(grandConf+'%').padEnd(18)} │`);
  console.log('└──────────────────────────────────────┴───────┴────────────────────┘');

  // Per-stage aggregation
  console.log('');
  console.log('── Pipeline Stage Results (All Platforms) ──');
  console.log('');
  const stageNames = ['Meeting Record', 'Transcript Stored', 'Category Detection (pg_net async)',
    'Summary Generation (sync http)', 'Tone Analysis', 'Email Delivery', 'Final Status = processed'];
  stageNames.forEach(stage => {
    const stageChecks = allChecks.flatMap(r => r.checks.filter(c => c.stage === stage));
    if (stageChecks.length === 0) return;
    const sPassed = stageChecks.filter(c => c.pass).length;
    const sConf = (stageChecks.reduce((s, c) => s + c.confidence, 0) / stageChecks.length).toFixed(0);
    const bar = 'X'.repeat(sPassed) + '-'.repeat(stageChecks.length - sPassed);
    console.log(`  ${stage.padEnd(38)} [${bar}] ${sPassed}/${stageChecks.length}  Conf: ${sConf}%`);
  });

  // Teams-specific
  const teamsChecks = allChecks.flatMap(r => r.checks.filter(c => c.stage === 'Teams Email Deferral'));
  if (teamsChecks.length > 0) {
    const tPassed = teamsChecks.filter(c => c.pass).length;
    const tConf = (teamsChecks.reduce((s, c) => s + c.confidence, 0) / teamsChecks.length).toFixed(0);
    console.log(`  ${'Teams Email Deferral'.padEnd(38)} [${('X'.repeat(tPassed) + '-'.repeat(teamsChecks.length - tPassed))}] ${tPassed}/${teamsChecks.length}  Conf: ${tConf}%`);
  }

  console.log('');
  console.log('── Platform Coverage Matrix ──');
  console.log('');
  console.log('  Platform                    │ Record │ Transcript │ Category │ Summary │ Alerts │ Email │ Status');
  console.log('  ────────────────────────────┼────────┼────────────┼──────────┼─────────┼────────┼───────┼───────');
  allChecks.forEach(r => {
    const p = r.testCase.platform.padEnd(28);
    const vals = stageNames.map(stage => {
      const c = r.checks.find(ch => ch.stage === stage);
      return c ? (c.pass ? '  OK  ' : ' FAIL ') : '  --  ';
    });
    console.log(`  ${p}│${vals.join('│')}`);
  });

  console.log('');
  console.log('── Data Retention ──');
  console.log('');
  console.log('  All test data is PRESERVED in the database:');
  TEST_MEETINGS.forEach(tm => {
    console.log(`    ${tm.label}: ${tm.id}`);
  });
  console.log('');
  console.log('  These meetings are visible in the admin dashboard at /meetings');
  console.log('  and in the User Detail page at /users/:id');
  console.log('  Data will NOT be deleted until manually requested.');
  console.log('');

  // Verdict
  const allPassed = grandPassed === grandTotal;
  console.log('═══════════════════════════════════════════════════════════════════════');
  if (allPassed) {
    console.log('  VERDICT: ALL CHECKS PASSED — Pipeline is fully operational.');
  } else {
    console.log(`  VERDICT: ${grandPassed}/${grandTotal} checks passed — Review failures above.`);
  }
  console.log(`  OVERALL CONFIDENCE: ${grandConf}%`);
  console.log('═══════════════════════════════════════════════════════════════════════');
  console.log('');
}

main().catch(console.error);
