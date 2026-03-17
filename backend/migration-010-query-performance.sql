-- Migration 010: Query Performance Optimizations
--
-- Optimizations:
--   1. Early exit in process_pending_jobs() when nothing to process (~99% of cron runs)
--   2. Composite indexes for common frontend + backend query patterns
--   3. Partial index for pending processing jobs (tiny, fast)
--   4. Drop redundant single-column indexes superseded by composites
--
-- Safe to re-run: all statements use IF NOT EXISTS / IF EXISTS guards.

-- ============================================================
-- SECTION A: INDEX OPTIMIZATIONS
-- ============================================================

-- A1. processing_jobs: partial index for pending jobs only
--     The main cron query filters (status='pending', job_type='category').
--     This index is tiny (only pending rows) and serves the hot path perfectly.
CREATE INDEX IF NOT EXISTS idx_processing_jobs_pending
  ON processing_jobs(job_type, created_at)
  WHERE status = 'pending';

-- A2. processing_jobs: composite for EXISTS/NOT EXISTS subqueries
--     Replaces idx_processing_jobs_meeting_id (leading column still meeting_id).
CREATE INDEX IF NOT EXISTS idx_processing_jobs_meeting_status
  ON processing_jobs(meeting_id, status);

-- A3. meetings: composite for RLS scope + sort (replaces idx_meetings_org_id)
--     Every frontend query filters by org_id (RLS) and sorts by created_at DESC.
CREATE INDEX IF NOT EXISTS idx_meetings_org_created
  ON meetings(org_id, created_at DESC);

-- A4. meetings: composite for user detail page
--     Replaces idx_meetings_user_id (leading column still user_id).
CREATE INDEX IF NOT EXISTS idx_meetings_user_created
  ON meetings(user_id, created_at DESC);

-- A5. tone_alerts: composite for RLS scope + sort (replaces idx_tone_alerts_org_id)
CREATE INDEX IF NOT EXISTS idx_tone_alerts_org_created
  ON tone_alerts(org_id, created_at DESC);

-- A6. tone_alerts: unreviewed alerts filter + sort
--     Dashboard "Unreviewed" tab filters is_reviewed=false, sorts by date.
CREATE INDEX IF NOT EXISTS idx_tone_alerts_reviewed_created
  ON tone_alerts(is_reviewed, created_at DESC);

-- A7. summaries: lookup by meeting + default flag
--     Partial index on is_default=true keeps it tiny.
CREATE INDEX IF NOT EXISTS idx_summaries_meeting_default
  ON summaries(meeting_id)
  WHERE is_default = true;

-- A8. profiles: user list with role/active filter
--     Dashboard Users page filters by org_id, role='user', is_active.
CREATE INDEX IF NOT EXISTS idx_profiles_org_role_active
  ON profiles(org_id, role, is_active);

-- A9. Drop redundant single-column indexes now covered by composites.
--     Each composite has the same leading column, so equality lookups still work.
DROP INDEX IF EXISTS idx_meetings_org_id;           -- covered by idx_meetings_org_created
DROP INDEX IF EXISTS idx_meetings_user_id;           -- covered by idx_meetings_user_created
DROP INDEX IF EXISTS idx_tone_alerts_org_id;         -- covered by idx_tone_alerts_org_created
DROP INDEX IF EXISTS idx_processing_jobs_meeting_id; -- covered by idx_processing_jobs_meeting_status


-- ============================================================
-- SECTION B: FUNCTION OPTIMIZATION — process_pending_jobs()
-- ============================================================
-- Adds an early exit when no meetings are processing and no jobs are pending.
-- This skips all 3 heavyweight operations (~99% of cron runs).

CREATE OR REPLACE FUNCTION process_pending_jobs()
RETURNS void AS $$
DECLARE
  v_job RECORD;
  v_content TEXT;
  v_transcript_text TEXT;
  v_transcript_json JSONB;
  v_category TEXT;
  v_meeting_org_id UUID;
  v_summary_tone_response TEXT;
  v_parsed JSONB;
  v_summary_text TEXT;
  v_tone_arr JSONB;
  v_system_prompt TEXT;
BEGIN
  -- OPTIMIZATION: Fast exit when there is nothing to process.
  -- Both checks hit existing indexes and are O(1).
  IF NOT EXISTS (SELECT 1 FROM processing_jobs WHERE status = 'pending' LIMIT 1)
     AND NOT EXISTS (SELECT 1 FROM meetings WHERE status = 'processing' LIMIT 1) THEN
    RETURN;
  END IF;

  -- Fail stale pending jobs whose pg_net response was garbage-collected
  UPDATE processing_jobs
  SET status = CASE WHEN attempts >= 2 THEN 'failed' ELSE 'pending' END,
      attempts = attempts + 1,
      error_message = 'pg_net response expired (TTL)',
      updated_at = NOW()
  WHERE status = 'pending'
    AND created_at < NOW() - INTERVAL '5 minutes'
    AND NOT EXISTS (SELECT 1 FROM net._http_response r WHERE r.id = pg_net_request_id);

  -- Mark meetings as failed if all their jobs are done but some failed
  UPDATE meetings SET status = 'failed', error_message = 'Processing failed: API responses expired'
  WHERE status = 'processing'
    AND NOT EXISTS (SELECT 1 FROM processing_jobs WHERE meeting_id = meetings.id AND status = 'pending')
    AND EXISTS (SELECT 1 FROM processing_jobs WHERE meeting_id = meetings.id AND status = 'failed');

  -- Process pending category jobs (async pg_net responses)
  FOR v_job IN
    SELECT pj.*, r.status_code, r.content::jsonb as response_body
    FROM processing_jobs pj
    JOIN net._http_response r ON r.id = pj.pg_net_request_id
    WHERE pj.status = 'pending'
      AND pj.job_type = 'category'
    ORDER BY pj.created_at ASC
    LIMIT 10
  LOOP
    IF v_job.status_code = 200 THEN
      v_content := v_job.response_body->'choices'->0->'message'->>'content';
      v_category := trim(both ' "' from v_content);
      IF v_category NOT IN ('client_conversation', 'consultant_meeting', 'target_company', 'sales_service', 'general') THEN
        v_category := 'general';
      END IF;

      UPDATE meetings SET detected_category = v_category WHERE id = v_job.meeting_id;
      UPDATE processing_jobs SET status = 'completed', result = jsonb_build_object('category', v_category) WHERE id = v_job.id;

      -- Get transcript and org info for summary+tone
      SELECT t.transcript_json INTO v_transcript_json
      FROM transcripts t WHERE t.meeting_id = v_job.meeting_id;

      SELECT m.org_id INTO v_meeting_org_id
      FROM meetings m WHERE m.id = v_job.meeting_id;

      SELECT string_agg(
        '[' || (seg->>'start_time') || '] ' || (seg->>'speaker') || ': ' || (seg->>'text'),
        E'\n'
      ) INTO v_transcript_text
      FROM jsonb_array_elements(v_transcript_json->'segments') AS seg;

      -- Build the summary+tone prompt
      v_system_prompt :=
        'You are a senior workplace meeting analyst. Respond with valid JSON only, no markdown fences.' || E'\n' ||
        'Return exactly this structure:' || E'\n' ||
        '{"summary":"<markdown summary>","tone_alerts":[{"start_time":"HH:MM:SS","speaker":"name","severity":"low|medium|high","flagged_text":"exact quote","reason":"brief explanation"}]}' || E'\n\n' ||
        '=== SUMMARY FORMAT ===' || E'\n' ||
        'The summary MUST use this exact markdown structure with all sections:' || E'\n\n' ||
        '## Meeting Overview' || E'\n' ||
        '**Type:** [category in plain English]' || E'\n' ||
        '**Participants:** [list all speakers identified in transcript with roles if apparent]' || E'\n\n' ||
        '## Key Discussion Points' || E'\n' ||
        '- **[Topic]:** [2-3 sentence detail with speaker attribution and context]' || E'\n' ||
        '(list every significant topic discussed, not just surface-level bullets)' || E'\n\n' ||
        '## Decisions Made' || E'\n' ||
        '1. [Decision with context on why it was made]' || E'\n' ||
        '(if no explicit decisions, write "No formal decisions were recorded.")' || E'\n\n' ||
        '## Action Items' || E'\n' ||
        '| Owner | Task | Deadline |' || E'\n' ||
        '|-------|------|----------|' || E'\n' ||
        '| [name] | [specific task] | [deadline or "TBD"] |' || E'\n' ||
        '(if no action items, write "No action items were assigned.")' || E'\n\n' ||
        '## Key Takeaways' || E'\n' ||
        '- [The "so what" — what is the overall status, what is at risk, what went well]' || E'\n' ||
        '(2-4 high-level insights a manager would care about)' || E'\n\n' ||
        '## Follow-Up Questions' || E'\n' ||
        '- [Questions that should be addressed in the next meeting based on open threads]' || E'\n' ||
        '(2-4 forward-looking questions)' || E'\n\n' ||
        '=== CATEGORY-SPECIFIC FOCUS (' || v_category || ') ===' || E'\n' ||
        CASE v_category
          WHEN 'client_conversation' THEN
            'This is a CLIENT meeting. Pay special attention to:' || E'\n' ||
            '- Client needs, pain points, and sentiment (satisfied/frustrated/neutral)' || E'\n' ||
            '- Proposed solutions and whether the client agreed' || E'\n' ||
            '- Commitments made to the client with deadlines' || E'\n' ||
            '- Any risks to the client relationship' || E'\n' ||
            'Add a "## Client Sentiment" section after Key Takeaways: one line summarizing overall client mood and relationship health.'
          WHEN 'consultant_meeting' THEN
            'This is an INTERNAL/CONSULTANT meeting. Pay special attention to:' || E'\n' ||
            '- Project status and progress percentages where mentioned' || E'\n' ||
            '- Blockers and dependencies between team members' || E'\n' ||
            '- Sprint/milestone deadlines and whether they are at risk' || E'\n' ||
            '- Resource or capacity concerns raised'
          WHEN 'target_company' THEN
            'This is a TARGET COMPANY research/discussion. Pay special attention to:' || E'\n' ||
            '- Company profile and market position' || E'\n' ||
            '- Key decision makers and stakeholders identified' || E'\n' ||
            '- Opportunity size and competitive landscape' || E'\n' ||
            '- Recommended approach and next steps for engagement' || E'\n' ||
            'Add a "## Opportunity Assessment" section: brief SWOT-style assessment.'
          WHEN 'sales_service' THEN
            'This is a SALES/SERVICE call. Pay special attention to:' || E'\n' ||
            '- Pitch points that resonated vs fell flat' || E'\n' ||
            '- Objections raised and how they were handled' || E'\n' ||
            '- Pricing or commercial terms discussed' || E'\n' ||
            '- Deal stage and probability of close' || E'\n' ||
            'Add a "## Deal Status" section: current stage, next step to advance, and risk factors.'
          ELSE
            'This is a GENERAL meeting. Cover all discussion points thoroughly with speaker attribution.'
        END || E'\n\n' ||
        '=== QUALITY REQUIREMENTS ===' || E'\n' ||
        '- Be thorough and detailed. A good summary is 400-800 words.' || E'\n' ||
        '- Always attribute statements to speakers when the transcript identifies them.' || E'\n' ||
        '- Use specific numbers, dates, and names from the transcript — do not generalize.' || E'\n' ||
        '- The Action Items table must have concrete tasks, not vague intentions.' || E'\n' ||
        '- Follow-Up Questions should be specific and actionable, not generic.' || E'\n\n' ||
        '=== TONE ALERTS ===' || E'\n' ||
        'Analyze the transcript for problematic workplace communication. Flag instances of:' || E'\n' ||
        '- Aggressive or hostile language (threats, yelling, intimidation, personal attacks)  → severity: high' || E'\n' ||
        '- Discriminatory language or microaggressions (bias based on gender, race, age, etc.)  → severity: high' || E'\n' ||
        '- Condescending or patronizing tone (talking down, belittling contributions)  → severity: medium' || E'\n' ||
        '- Passive-aggressive remarks (backhanded compliments, veiled criticism, guilt-tripping)  → severity: medium' || E'\n' ||
        '- Dismissive behavior (cutting off, ignoring input, shutting down ideas without consideration)  → severity: medium' || E'\n' ||
        '- Sarcastic or mocking tone (ridiculing ideas, eye-roll language)  → severity: low' || E'\n' ||
        '- Frustrated or impatient outbursts (snapping, exasperated sighs expressed in words)  → severity: low' || E'\n' ||
        '- Unprofessional language (profanity, inappropriate jokes, off-color remarks)  → severity: medium' || E'\n' ||
        'Be sensitive but not over-sensitive. Normal disagreements and direct feedback are fine. Only flag genuinely problematic communication.' || E'\n' ||
        'If no issues found, return empty array [].';

      -- SYNCHRONOUS call via http extension — no more pg_net GC race condition
      BEGIN
        v_summary_tone_response := call_openai_sync(
          v_system_prompt,
          LEFT(v_transcript_text, 8000),
          4000, 0.3
        );

        IF v_summary_tone_response IS NOT NULL THEN
          v_parsed := v_summary_tone_response::jsonb;
          v_summary_text := v_parsed->>'summary';
          v_tone_arr := COALESCE(v_parsed->'tone_alerts', '[]'::jsonb);

          IF v_summary_text IS NOT NULL AND length(v_summary_text) > 0 THEN
            INSERT INTO summaries (meeting_id, category, content, is_default)
            VALUES (v_job.meeting_id, COALESCE(v_category, 'general'), v_summary_text, true);
          END IF;

          IF jsonb_array_length(v_tone_arr) > 0 THEN
            INSERT INTO tone_alerts (meeting_id, org_id, start_time, speaker, severity, flagged_text, reason)
            SELECT
              v_job.meeting_id, v_meeting_org_id,
              alert->>'start_time', alert->>'speaker',
              CASE WHEN (alert->>'severity') IN ('low','medium','high') THEN alert->>'severity' ELSE 'low' END,
              alert->>'flagged_text', alert->>'reason'
            FROM jsonb_array_elements(v_tone_arr) AS alert;
          END IF;

          -- Record summary_tone as a completed job for audit trail
          INSERT INTO processing_jobs (meeting_id, job_type, status, result)
          VALUES (v_job.meeting_id, 'summary_tone', 'completed',
            jsonb_build_object('summary_length', length(v_summary_text), 'tone_count', jsonb_array_length(v_tone_arr)));

          UPDATE meetings SET status = 'processed', updated_at = NOW() WHERE id = v_job.meeting_id;

          -- Best-effort email notification (failure does not affect pipeline)
          <<email_block>>
          DECLARE
            v_tx_source TEXT;
            v_tx_attempt INTEGER;
            v_det_app TEXT;
          BEGIN
            SELECT t.source, m.teams_transcript_attempt, m.detected_app
            INTO v_tx_source, v_tx_attempt, v_det_app
            FROM transcripts t
            JOIN meetings m ON m.id = t.meeting_id
            WHERE t.meeting_id = v_job.meeting_id;

            IF v_det_app LIKE 'Microsoft Teams%'
               AND COALESCE(v_tx_source, 'local') = 'local'
               AND COALESCE(v_tx_attempt, 0) < 99 THEN
              RAISE NOTICE 'Deferring email for Teams meeting % (awaiting potential transcript override)', v_job.meeting_id;
            ELSE
              PERFORM send_summary_email(v_job.meeting_id, v_summary_text, jsonb_array_length(v_tone_arr)::integer);
            END IF;
          EXCEPTION WHEN OTHERS THEN
            RAISE WARNING 'Email send failed for meeting %: %', v_job.meeting_id, SQLERRM;
          END email_block;
        ELSE
          -- Sync call returned NULL (HTTP error logged via RAISE WARNING)
          INSERT INTO processing_jobs (meeting_id, job_type, status, error_message)
          VALUES (v_job.meeting_id, 'summary_tone', 'failed', 'OpenAI sync call returned NULL');
          UPDATE meetings SET status = 'failed', error_message = 'Summary generation failed' WHERE id = v_job.meeting_id;
        END IF;
      EXCEPTION WHEN OTHERS THEN
        INSERT INTO processing_jobs (meeting_id, job_type, status, error_message)
        VALUES (v_job.meeting_id, 'summary_tone', 'failed', SQLERRM);
        UPDATE meetings SET status = 'failed', error_message = 'Summary generation error: ' || SQLERRM WHERE id = v_job.meeting_id;
      END;

    ELSE
      -- Non-200 category response: retry up to 3 times
      UPDATE processing_jobs
      SET status = CASE WHEN attempts >= 3 THEN 'failed' ELSE 'pending' END,
          attempts = attempts + 1,
          error_message = 'HTTP ' || v_job.status_code,
          updated_at = NOW()
      WHERE id = v_job.id;

      IF (SELECT attempts FROM processing_jobs WHERE id = v_job.id) >= 3 THEN
        UPDATE meetings SET status = 'failed', error_message = 'Category detection failed after retries' WHERE id = v_job.meeting_id;
      END IF;
    END IF;
  END LOOP;
END;
$$ LANGUAGE plpgsql
SET search_path = public;


-- ============================================================
-- SECTION C: CLEANUP — Purge old completed processing jobs
-- ============================================================
-- Old completed/failed jobs accumulate and slow down status checks.
-- Add cleanup to the existing daily cleanup function.

CREATE OR REPLACE FUNCTION cleanup_old_data()
RETURNS void AS $$
BEGIN
  -- Delete meetings older than org-configured retention
  DELETE FROM meetings m
  USING organizations o
  WHERE m.org_id = o.id
    AND m.created_at < NOW() - (o.data_retention_days || ' days')::INTERVAL;

  -- Purge completed/failed processing jobs older than 7 days
  -- (These are audit records; the meeting/summary data is preserved separately)
  DELETE FROM processing_jobs
  WHERE status IN ('completed', 'failed')
    AND created_at < NOW() - INTERVAL '7 days';
END;
$$ LANGUAGE plpgsql
SET search_path = public;
