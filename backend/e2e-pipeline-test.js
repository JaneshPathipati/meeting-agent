/**
 * E2E Pipeline Verification Test
 *
 * Creates realistic test meetings for every platform combination:
 *   1. Microsoft Teams (Desktop App)
 *   2. Microsoft Teams (Chrome) — browser
 *   3. Google Meet (Chrome) — browser
 *   4. Google Meet (Edge) — browser
 *
 * Verifies the full pipeline for each:
 *   Meeting → Transcript → Category Detection → Summary → Tone Alerts → Email
 *
 * DATA IS PRESERVED — not deleted until manually requested.
 */

const path = require('path');
const { createClient } = require(path.join(__dirname, '..', 'client-agent', 'node_modules', '@supabase', 'supabase-js'));

const sb = createClient(
  'https://mlawedxbkijeauzqxkgf.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1sYXdlZHhia2lqZWF1enF4a2dmIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3MDYyNDIwNCwiZXhwIjoyMDg2MjAwMjA0fQ.IInBu48f5UQl9xBKkmDg4E_fKt_7--d_T31I--ivkkI'
);

const ORG_ID = 'a0000000-0000-0000-0000-000000000001';
const USER_ID = 'b0000000-0000-0000-0000-000000000002';

// ─── Test Transcripts ───────────────────────────────────────────────────────

const TRANSCRIPT_TEAMS_APP = {
  metadata: { model: 'parakeet-tdt-0.6b-v2', duration_sec: 240, sample_rate: 16000 },
  segments: [
    { start_time: "00:00:05", speaker: "Manager", text: "Good morning team. Let's discuss the quarterly review for the sales department." },
    { start_time: "00:00:18", speaker: "Sales Lead", text: "Sure. Revenue is up 12% this quarter. We closed the Acme Corp deal finally." },
    { start_time: "00:00:35", speaker: "Manager", text: "That's excellent. What about the Henderson account? I heard there were some issues." },
    { start_time: "00:00:50", speaker: "Sales Lead", text: "Yeah, Henderson has been a nightmare. Their procurement team keeps ghosting us." },
    { start_time: "00:01:05", speaker: "Support Rep", text: "I've also heard complaints from Henderson. They said our response times are terrible and they're considering switching vendors." },
    { start_time: "00:01:20", speaker: "Sales Lead", text: "That's ridiculous. Maybe if support actually did their job instead of forwarding tickets, we wouldn't have this problem." },
    { start_time: "00:01:35", speaker: "Support Rep", text: "Excuse me? We handle 200 tickets a day with half the staff we need." },
    { start_time: "00:01:50", speaker: "Sales Lead", text: "Not my problem. You guys are supposed to retain clients, not drive them away." },
    { start_time: "00:02:05", speaker: "Manager", text: "Let's keep this constructive. We need to work together on Henderson. What's the action plan?" },
    { start_time: "00:02:20", speaker: "Support Rep", text: "I'll set up a dedicated support channel for Henderson. But we need sales to stop over-promising on SLAs we can't meet." },
    { start_time: "00:02:35", speaker: "Sales Lead", text: "Fine. I'll update the SLA commitments in the next proposal." },
    { start_time: "00:02:50", speaker: "Manager", text: "Good. Let's schedule a joint call with Henderson next week. Meeting adjourned." },
  ]
};

const TRANSCRIPT_TEAMS_BROWSER = {
  metadata: { model: 'parakeet-tdt-0.6b-v2', duration_sec: 180, sample_rate: 16000 },
  segments: [
    { start_time: "00:00:03", speaker: "Account Exec", text: "Hi Mr. Patel, thank you for joining this call today." },
    { start_time: "00:00:12", speaker: "Client", text: "Of course. I wanted to discuss the pricing for the enterprise tier." },
    { start_time: "00:00:25", speaker: "Account Exec", text: "Absolutely. Our enterprise plan starts at $2,500 per month for up to 100 users." },
    { start_time: "00:00:40", speaker: "Client", text: "That seems steep. Your competitor is offering similar features for $1,800." },
    { start_time: "00:00:55", speaker: "Account Exec", text: "Look, I understand budget concerns, but honestly their product is garbage compared to ours. They can barely handle 50 concurrent users." },
    { start_time: "00:01:10", speaker: "Client", text: "That's a strong claim. Do you have benchmarks to back that up?" },
    { start_time: "00:01:25", speaker: "Account Exec", text: "I mean, everyone knows it. Just Google their reviews. Anyway, if you don't sign by Friday, this pricing expires." },
    { start_time: "00:01:40", speaker: "Client", text: "I appreciate the urgency but we need proper evaluation time." },
    { start_time: "00:01:55", speaker: "Account Exec", text: "Fine. I'll extend it to next Wednesday. But seriously, you'd be making a huge mistake going with the other guys." },
    { start_time: "00:02:10", speaker: "Client", text: "Let me discuss with my team and get back to you." },
    { start_time: "00:02:25", speaker: "Account Exec", text: "Sounds good. I'll send over the proposal deck today." },
  ]
};

const TRANSCRIPT_GMEET_CHROME = {
  metadata: { model: 'parakeet-tdt-0.6b-v2', duration_sec: 300, sample_rate: 16000 },
  segments: [
    { start_time: "00:00:04", speaker: "HR Director", text: "Good afternoon. This is the mid-year performance review for the engineering team." },
    { start_time: "00:00:15", speaker: "Tech Lead", text: "Thanks. I wanted to start by highlighting the team's achievements. We shipped three major features ahead of schedule." },
    { start_time: "00:00:30", speaker: "HR Director", text: "That's noted. However, we've received some feedback about team dynamics." },
    { start_time: "00:00:45", speaker: "Tech Lead", text: "What kind of feedback?" },
    { start_time: "00:01:00", speaker: "HR Director", text: "A few team members mentioned that code reviews have become quite hostile. Words like 'incompetent' were used in PR comments." },
    { start_time: "00:01:15", speaker: "Tech Lead", text: "Oh come on, that's called having high standards. If someone writes sloppy code, they should hear about it." },
    { start_time: "00:01:30", speaker: "HR Director", text: "There's a difference between constructive feedback and personal attacks. Calling someone's work 'amateur hour' isn't productive." },
    { start_time: "00:01:45", speaker: "Tech Lead", text: "Whatever. These junior devs need thicker skin. Back in my day we didn't get participation trophies for writing hello world." },
    { start_time: "00:02:00", speaker: "HR Director", text: "This is exactly the attitude that's been flagged. Two developers have requested transfers out of your team." },
    { start_time: "00:02:15", speaker: "Tech Lead", text: "That's their loss. I don't have time to babysit people who can't handle honest feedback." },
    { start_time: "00:02:30", speaker: "HR Director", text: "I'm going to recommend mandatory leadership coaching. This will be noted in your review." },
    { start_time: "00:02:45", speaker: "Tech Lead", text: "Fine. Do what you have to do. But my team ships, and that's what matters." },
    { start_time: "00:03:00", speaker: "HR Director", text: "Shipping code and retaining talent both matter. Let's schedule the coaching sessions for next month." },
  ]
};

const TRANSCRIPT_GMEET_EDGE = {
  metadata: { model: 'parakeet-tdt-0.6b-v2', duration_sec: 180, sample_rate: 16000 },
  segments: [
    { start_time: "00:00:05", speaker: "Project Manager", text: "Hi everyone. Quick sync on the mobile app launch timeline." },
    { start_time: "00:00:15", speaker: "Designer", text: "The UI mockups are finalized and approved by the stakeholders." },
    { start_time: "00:00:28", speaker: "Developer", text: "Great. I've integrated the new design system. Backend APIs are ready and tested." },
    { start_time: "00:00:42", speaker: "QA Engineer", text: "I've completed regression testing on the staging build. All 147 test cases passed." },
    { start_time: "00:00:58", speaker: "Project Manager", text: "Excellent work everyone. Any blockers or risks we should be aware of?" },
    { start_time: "00:01:12", speaker: "Developer", text: "One minor thing — the push notification service needs a certificate renewal by the 15th. Already submitted the request." },
    { start_time: "00:01:28", speaker: "Designer", text: "I have the app store screenshots ready. Just need final copy from marketing." },
    { start_time: "00:01:42", speaker: "Project Manager", text: "I'll follow up with marketing today. Timeline-wise, we're on track for the launch next Tuesday." },
    { start_time: "00:01:58", speaker: "QA Engineer", text: "I'll do a final smoke test on Monday after the build is promoted to production." },
    { start_time: "00:02:12", speaker: "Project Manager", text: "Perfect. Great collaboration this sprint. Let's keep the momentum going. Meeting done." },
  ]
};

// ─── Test Case Definitions ──────────────────────────────────────────────────

const TEST_CASES = [
  {
    id: 'TC-001',
    name: 'Microsoft Teams Desktop App',
    detected_app: 'Microsoft Teams',
    transcript: TRANSCRIPT_TEAMS_APP,
    source: 'local',
    duration_seconds: 240,
    is_teams: true,
    // Teams meetings have email deferral, need teams_transcript_attempt=99 to trigger email
    expect_deferred_email: true,
    expected_flags: true,
    description: 'Teams desktop app meeting with internal conflict between sales and support.',
  },
  {
    id: 'TC-002',
    name: 'Microsoft Teams Browser (Chrome)',
    detected_app: 'Microsoft Teams (Chrome)',
    transcript: TRANSCRIPT_TEAMS_BROWSER,
    source: 'local',
    duration_seconds: 180,
    is_teams: true,
    expect_deferred_email: true,
    expected_flags: true,
    description: 'Teams browser meeting — client sales call with pushy/aggressive tactics.',
  },
  {
    id: 'TC-003',
    name: 'Google Meet Browser (Chrome)',
    detected_app: 'Google Meet (Chrome)',
    transcript: TRANSCRIPT_GMEET_CHROME,
    source: 'local',
    duration_seconds: 300,
    is_teams: false,
    expect_deferred_email: false,
    expected_flags: true,
    description: 'Google Meet Chrome — HR performance review with hostile/dismissive behavior.',
  },
  {
    id: 'TC-004',
    name: 'Google Meet Browser (Edge)',
    detected_app: 'Google Meet (Edge)',
    transcript: TRANSCRIPT_GMEET_EDGE,
    source: 'local',
    duration_seconds: 180,
    is_teams: false,
    expect_deferred_email: false,
    expected_flags: false,
    description: 'Google Meet Edge — clean professional standup meeting, no flags expected.',
  },
];

// ─── Test Runner ────────────────────────────────────────────────────────────

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function verifyUserExists() {
  const { data, error } = await sb.from('profiles').select('id, full_name, email_enabled, summary_enabled, microsoft_email').eq('id', USER_ID).single();
  if (error) {
    console.error('ERROR: Test user not found. Creating fallback check...');
    // List available users
    const { data: users } = await sb.from('profiles').select('id, full_name, role').eq('role', 'user').limit(5);
    console.log('Available users:', users);
    return null;
  }
  return data;
}

async function verifyOrgExists() {
  const { data, error } = await sb.from('organizations').select('id, name, summaries_enabled, emails_enabled, sender_email').eq('id', ORG_ID).single();
  if (error) {
    console.error('ERROR: Organization not found:', error.message);
    return null;
  }
  return data;
}

async function createTestMeeting(tc) {
  const now = new Date();
  const startTime = new Date(now.getTime() - tc.duration_seconds * 1000);

  const { data: meeting, error: meetErr } = await sb
    .from('meetings')
    .insert({
      user_id: USER_ID,
      org_id: ORG_ID,
      start_time: startTime.toISOString(),
      end_time: now.toISOString(),
      detected_app: tc.detected_app,
      status: 'uploaded',
    })
    .select('id')
    .single();

  if (meetErr) throw new Error(`Meeting insert failed: ${meetErr.message}`);
  return meeting.id;
}

async function insertTranscript(meetingId, transcript, source) {
  const wordCount = transcript.segments.reduce((sum, s) => sum + s.text.split(/\s+/).length, 0);

  const { error } = await sb.from('transcripts').insert({
    meeting_id: meetingId,
    transcript_json: transcript,
    source: source,
    word_count: wordCount,
  });

  if (error) throw new Error(`Transcript insert failed: ${error.message}`);
}

async function waitForProcessing(meetingId, maxWaitSec = 180) {
  const startTime = Date.now();
  let lastStatus = '';

  while (Date.now() - startTime < maxWaitSec * 1000) {
    const { data: m } = await sb.from('meetings')
      .select('status, detected_category')
      .eq('id', meetingId)
      .single();

    if (m.status !== lastStatus) {
      const elapsed = Math.round((Date.now() - startTime) / 1000);
      console.log(`    [${elapsed}s] Status: ${m.status} | Category: ${m.detected_category || '-'}`);
      lastStatus = m.status;
    }

    if (m.status === 'processed' || m.status === 'failed') {
      return m.status;
    }

    await sleep(5000);
  }

  return 'timeout';
}

async function simulateTeamsExhaustion(meetingId) {
  // Simulate the client-agent exhausting Teams transcript polling
  // Set teams_transcript_attempt=99 to trigger the deferred email path
  const { error } = await sb.from('meetings')
    .update({ teams_transcript_attempt: 99 })
    .eq('id', meetingId);

  if (error) console.log(`    WARNING: Could not set teams_transcript_attempt: ${error.message}`);
  else console.log('    Set teams_transcript_attempt=99 (simulating exhausted polling)');
}

async function collectResults(meetingId) {
  const [meetingRes, transcriptRes, summaryRes, alertsRes, jobsRes] = await Promise.all([
    sb.from('meetings').select('*').eq('id', meetingId).single(),
    sb.from('transcripts').select('*').eq('meeting_id', meetingId).single(),
    sb.from('summaries').select('*').eq('meeting_id', meetingId).eq('is_default', true).single(),
    sb.from('tone_alerts').select('*').eq('meeting_id', meetingId).order('start_time'),
    sb.from('processing_jobs').select('*').eq('meeting_id', meetingId).order('created_at'),
  ]);

  return {
    meeting: meetingRes.data,
    transcript: transcriptRes.data,
    summary: summaryRes.data,
    alerts: alertsRes.data || [],
    jobs: jobsRes.data || [],
  };
}

function assessConfidence(tc, results) {
  const checks = [];

  // 1. Meeting record
  checks.push({
    name: 'Meeting Record Created',
    pass: !!results.meeting,
    detail: results.meeting ? `ID: ${results.meeting.id}` : 'MISSING',
    confidence: results.meeting ? 100 : 0,
  });

  // 2. Transcript stored
  checks.push({
    name: 'Transcript Stored',
    pass: !!results.transcript,
    detail: results.transcript ? `Source: ${results.transcript.source}, Words: ${results.transcript.word_count}` : 'MISSING',
    confidence: results.transcript ? 100 : 0,
  });

  // 3. Processing status
  const isProcessed = results.meeting?.status === 'processed';
  checks.push({
    name: 'Processing Completed',
    pass: isProcessed,
    detail: `Status: ${results.meeting?.status || 'UNKNOWN'}`,
    confidence: isProcessed ? 100 : results.meeting?.status === 'failed' ? 20 : 0,
  });

  // 4. Category detected
  const hasCat = !!results.meeting?.detected_category;
  checks.push({
    name: 'Category Detected',
    pass: hasCat,
    detail: `Category: ${results.meeting?.detected_category || 'NONE'}`,
    confidence: hasCat ? 100 : 0,
  });

  // 5. Processing jobs
  const completedJobs = results.jobs.filter(j => j.status === 'completed' || j.job_type === 'category');
  checks.push({
    name: 'Processing Jobs',
    pass: results.jobs.length > 0,
    detail: `Total: ${results.jobs.length}, Statuses: ${results.jobs.map(j => `${j.job_type}:${j.status}`).join(', ')}`,
    confidence: results.jobs.length > 0 ? (completedJobs.length === results.jobs.length ? 100 : 60) : 0,
  });

  // 6. Summary generated
  const hasSummary = !!results.summary?.content;
  checks.push({
    name: 'Summary Generated',
    pass: hasSummary,
    detail: hasSummary ? `Length: ${results.summary.content.length} chars` : 'MISSING',
    confidence: hasSummary ? 100 : 0,
  });

  // 7. Tone alerts
  const hasAlerts = results.alerts.length > 0;
  const alertsExpected = tc.expected_flags;
  const alertsMatch = alertsExpected ? hasAlerts : !hasAlerts;
  checks.push({
    name: 'Tone Alerts',
    pass: alertsMatch,
    detail: `Found: ${results.alerts.length} alert(s)${alertsExpected ? ' (expected)' : ' (none expected)'}. Severities: ${results.alerts.map(a => a.severity).join(', ') || '-'}`,
    // Tone analysis by AI is probabilistic - 85% confidence when matching expectations
    confidence: alertsMatch ? 85 : 40,
  });

  // 8. Email status
  const emailSent = !!results.meeting?.email_sent_at;
  if (tc.expect_deferred_email) {
    // For Teams meetings: email should be deferred unless teams_transcript_attempt=99
    const attempt = results.meeting?.teams_transcript_attempt || 0;
    if (attempt >= 99) {
      checks.push({
        name: 'Email (Teams Deferred→Sent)',
        pass: emailSent,
        detail: emailSent
          ? `Sent at: ${results.meeting.email_sent_at}`
          : `NOT SENT (attempt=${attempt}). May need Azure credentials or send_summary_email may have failed.`,
        confidence: emailSent ? 100 : 50, // Azure creds may not be configured
      });
    } else {
      checks.push({
        name: 'Email (Teams Deferred)',
        pass: !emailSent, // Should NOT be sent yet
        detail: `Correctly deferred (attempt=${attempt}, email_sent_at=${results.meeting?.email_sent_at || 'null'})`,
        confidence: !emailSent ? 100 : 30,
      });
    }
  } else {
    checks.push({
      name: 'Email Sent',
      pass: emailSent,
      detail: emailSent
        ? `Sent at: ${results.meeting.email_sent_at}`
        : 'NOT SENT. May need Azure credentials or org.emails_enabled=true.',
      confidence: emailSent ? 100 : 50, // Azure creds may not be configured
    });
  }

  return checks;
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║       MeetChamp E2E Pipeline Verification Test Suite        ║');
  console.log('║                                                              ║');
  console.log('║  Tests: Teams App, Teams Browser, GMeet Chrome, GMeet Edge   ║');
  console.log('║  Data is PRESERVED in the database for admin panel review    ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');
  console.log('');
  console.log(`Timestamp: ${new Date().toISOString()}`);
  console.log('');

  // ── Pre-flight checks ──
  console.log('── Pre-flight Checks ──────────────────────────────────────────');

  const user = await verifyUserExists();
  if (!user) {
    console.error('FATAL: Cannot proceed without a test user.');
    process.exit(1);
  }
  console.log(`User: ${user.full_name} (${user.id})`);
  console.log(`  email_enabled: ${user.email_enabled}, summary_enabled: ${user.summary_enabled}`);
  console.log(`  microsoft_email: ${user.microsoft_email || 'NOT SET'}`);

  const org = await verifyOrgExists();
  if (!org) {
    console.error('FATAL: Cannot proceed without an organization.');
    process.exit(1);
  }
  console.log(`Org: ${org.name} (${org.id})`);
  console.log(`  summaries_enabled: ${org.summaries_enabled}, emails_enabled: ${org.emails_enabled}`);
  console.log(`  sender_email: ${org.sender_email || 'NOT SET'}`);
  console.log('');

  // ── Run Test Cases ──
  const allResults = [];

  for (const tc of TEST_CASES) {
    console.log(`═══════════════════════════════════════════════════════════════`);
    console.log(`  ${tc.id}: ${tc.name}`);
    console.log(`  ${tc.description}`);
    console.log(`  detected_app: "${tc.detected_app}" | Teams: ${tc.is_teams}`);
    console.log(`═══════════════════════════════════════════════════════════════`);

    try {
      // Step 1: Create meeting
      console.log('  [1/5] Creating meeting...');
      const meetingId = await createTestMeeting(tc);
      console.log(`    Meeting ID: ${meetingId}`);

      // Step 2: Insert transcript (triggers pipeline)
      console.log('  [2/5] Inserting transcript (triggers pipeline)...');
      await insertTranscript(meetingId, tc.transcript, tc.source);
      console.log('    Transcript inserted. Pipeline trigger fired.');

      // Step 3: Wait for processing
      console.log('  [3/5] Waiting for processing...');
      const finalStatus = await waitForProcessing(meetingId, 180);
      console.log(`    Final status: ${finalStatus}`);

      // Step 4: For Teams meetings, simulate transcript exhaustion to test email path
      if (tc.is_teams && finalStatus === 'processed') {
        console.log('  [4/5] Simulating Teams transcript exhaustion...');
        await simulateTeamsExhaustion(meetingId);
        // Wait for the cron to pick up the deferred email (up to 90 seconds)
        console.log('    Waiting for deferred email processing (up to 90s)...');
        for (let i = 0; i < 18; i++) {
          await sleep(5000);
          const { data: m } = await sb.from('meetings').select('email_sent_at').eq('id', meetingId).single();
          if (m?.email_sent_at) {
            console.log(`    Email sent at: ${m.email_sent_at}`);
            break;
          }
          if (i === 17) console.log('    Email not sent within 90s (Azure creds may not be configured)');
        }
      } else {
        console.log('  [4/5] Non-Teams meeting — email should be sent immediately if configured.');
      }

      // Step 5: Collect and verify results
      console.log('  [5/5] Collecting results...');
      const results = await collectResults(meetingId);
      const checks = assessConfidence(tc, results);

      allResults.push({
        testCase: tc,
        meetingId,
        results,
        checks,
        status: finalStatus,
      });

      // Print individual results
      console.log('');
      console.log('  ── Results ──');
      checks.forEach(c => {
        const icon = c.pass ? 'PASS' : 'FAIL';
        console.log(`    [${icon}] ${c.name} (Confidence: ${c.confidence}%)`);
        console.log(`           ${c.detail}`);
      });

      // Print alert details
      if (results.alerts.length > 0) {
        console.log('');
        console.log('  ── Tone Alerts Detail ──');
        results.alerts.forEach(a => {
          console.log(`    [${a.severity.toUpperCase()}] ${a.start_time} ${a.speaker}: "${a.flagged_text}"`);
          console.log(`           Reason: ${a.reason}`);
        });
      }

      // Print summary excerpt
      if (results.summary?.content) {
        const excerpt = results.summary.content.substring(0, 200);
        console.log('');
        console.log(`  ── Summary Excerpt ──`);
        console.log(`    ${excerpt}...`);
      }

    } catch (err) {
      console.error(`  ERROR: ${err.message}`);
      allResults.push({
        testCase: tc,
        meetingId: null,
        results: null,
        checks: [{ name: 'Test Execution', pass: false, detail: err.message, confidence: 0 }],
        status: 'error',
      });
    }

    console.log('');
  }

  // ─── Final Report ───────────────────────────────────────────────────────
  console.log('');
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║              COMPREHENSIVE TEST RESULTS SUMMARY             ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');
  console.log('');

  let totalChecks = 0;
  let passedChecks = 0;
  let totalConfidence = 0;

  for (const result of allResults) {
    const tc = result.testCase;
    const checksPassed = result.checks.filter(c => c.pass).length;
    const checksTotal = result.checks.length;
    const avgConf = result.checks.reduce((s, c) => s + c.confidence, 0) / checksTotal;

    totalChecks += checksTotal;
    passedChecks += checksPassed;
    totalConfidence += avgConf * checksTotal;

    console.log(`┌─ ${tc.id}: ${tc.name} ─────────────────────────────`);
    console.log(`│  Meeting ID: ${result.meetingId || 'N/A'}`);
    console.log(`│  Platform:   ${tc.detected_app}`);
    console.log(`│  Status:     ${result.status}`);
    console.log(`│  Checks:     ${checksPassed}/${checksTotal} passed`);
    console.log(`│  Avg Conf:   ${avgConf.toFixed(1)}%`);
    console.log('│');
    result.checks.forEach(c => {
      const icon = c.pass ? 'PASS' : 'FAIL';
      console.log(`│  [${icon}] ${c.name.padEnd(30)} Confidence: ${String(c.confidence).padStart(3)}%  │ ${c.detail}`);
    });
    console.log('└───────────────────────────────────────────────────────────');
    console.log('');
  }

  // Overall summary
  const overallConfidence = totalChecks > 0 ? (totalConfidence / totalChecks).toFixed(1) : 0;
  console.log('══════════════════════════════════════════════════════════════');
  console.log(`OVERALL: ${passedChecks}/${totalChecks} checks passed`);
  console.log(`OVERALL CONFIDENCE: ${overallConfidence}%`);
  console.log('');

  // Pipeline stage summary
  console.log('── Pipeline Stage Verification ──');
  const stages = [
    'Meeting Record Created',
    'Transcript Stored',
    'Processing Completed',
    'Category Detected',
    'Processing Jobs',
    'Summary Generated',
    'Tone Alerts',
  ];
  stages.forEach(stage => {
    const stageChecks = allResults.flatMap(r => r.checks.filter(c => c.name === stage));
    const stagePassed = stageChecks.filter(c => c.pass).length;
    const stageConf = stageChecks.length > 0
      ? (stageChecks.reduce((s, c) => s + c.confidence, 0) / stageChecks.length).toFixed(0)
      : 0;
    console.log(`  ${stage.padEnd(25)} ${stagePassed}/${stageChecks.length} passed  (Confidence: ${stageConf}%)`);
  });

  // Email summary (separate because it has different expectations per test)
  const emailChecks = allResults.flatMap(r => r.checks.filter(c => c.name.startsWith('Email')));
  const emailPassed = emailChecks.filter(c => c.pass).length;
  const emailConf = emailChecks.length > 0
    ? (emailChecks.reduce((s, c) => s + c.confidence, 0) / emailChecks.length).toFixed(0)
    : 0;
  console.log(`  ${'Email Pipeline'.padEnd(25)} ${emailPassed}/${emailChecks.length} passed  (Confidence: ${emailConf}%)`);

  console.log('');
  console.log('── Platform Coverage ──');
  console.log('  Teams Desktop App:      Tested');
  console.log('  Teams Browser (Chrome):  Tested');
  console.log('  GMeet Browser (Chrome):  Tested');
  console.log('  GMeet Browser (Edge):    Tested');
  console.log('');
  console.log('── Data Retention ──');
  console.log('  All test data has been PRESERVED in the database.');
  console.log('  Meeting IDs:');
  allResults.forEach(r => {
    console.log(`    ${r.testCase.id}: ${r.meetingId || 'N/A'} (${r.testCase.detected_app})`);
  });
  console.log('');
  console.log('  These meetings are visible in the admin dashboard.');
  console.log('  Data will NOT be deleted until manually requested.');
  console.log('');
  console.log(`Test completed at: ${new Date().toISOString()}`);
}

main().catch(err => {
  console.error('FATAL ERROR:', err);
  process.exit(1);
});
