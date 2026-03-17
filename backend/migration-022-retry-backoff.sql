-- migration-022-retry-backoff.sql
-- Fix: processing pipeline retry logic + rate limit resilience
--
-- Problems fixed:
-- 1. Retry on HTTP 429 re-reads the same cached pg_net response instead of re-firing the request
-- 2. No exponential backoff — retries fire immediately, guaranteeing another 429
-- 3. Ghost meetings with <50 words waste OpenAI quota and contribute to rate limiting
-- 4. LIMIT 10 per cron run can burst 10 simultaneous requests, overwhelming the API tier

-- ============================================================================
-- Part 1: Fix on_transcript_upserted() — skip ultra-short transcripts
-- ============================================================================

CREATE OR REPLACE FUNCTION on_transcript_upserted()
RETURNS TRIGGER AS $$
DECLARE
  v_transcript_text TEXT;
  v_word_count INTEGER;
BEGIN
  -- If this is an UPDATE (Teams transcript override), delete old processing results
  -- so we re-process with the better Teams transcript (has real speaker names)
  IF TG_OP = 'UPDATE' THEN
    DELETE FROM summaries WHERE meeting_id = NEW.meeting_id;
    DELETE FROM tone_alerts WHERE meeting_id = NEW.meeting_id;
    DELETE FROM processing_jobs WHERE meeting_id = NEW.meeting_id;
  END IF;

  UPDATE meetings SET status = 'processing' WHERE id = NEW.meeting_id;

  SELECT string_agg(segment->>'text', ' ')
  INTO v_transcript_text
  FROM jsonb_array_elements(NEW.transcript_json->'segments') AS segment;

  -- Guard: transcript_json exists but has no segments or all segments are empty text.
  -- Sending NULL content to OpenAI wastes quota and produces hallucinated results.
  IF v_transcript_text IS NULL OR length(trim(v_transcript_text)) = 0 THEN
    RAISE WARNING 'on_transcript_upserted: transcript for meeting % has no text content — skipping AI processing', NEW.meeting_id;
    UPDATE meetings SET status = 'failed', error_message = 'Transcript has no text content' WHERE id = NEW.meeting_id;
    RETURN NEW;
  END IF;

  v_word_count := array_length(string_to_array(v_transcript_text, ' '), 1);
  UPDATE transcripts SET word_count = v_word_count WHERE id = NEW.id;

  -- Guard: ultra-short transcripts (<50 words) produce meaningless AI summaries and waste
  -- OpenAI quota. Typical for ghost meetings from detection fragmentation (36-46 second cycles).
  IF v_word_count < 50 THEN
    RAISE WARNING 'on_transcript_upserted: transcript for meeting % has only % words — skipping AI processing', NEW.meeting_id, v_word_count;
    UPDATE meetings SET status = 'failed', error_message = 'Transcript too short (' || v_word_count || ' words)' WHERE id = NEW.meeting_id;
    RETURN NEW;
  END IF;

  PERFORM call_openai(
    NEW.meeting_id,
    'category',
    'You are a meeting categorizer. Return ONLY one category name, nothing else.' || E'\n' ||
    'Categories:' || E'\n' ||
    '- client_conversation: Meeting WITH a client/customer (discussing their needs, requirements, deliverables, feedback)' || E'\n' ||
    '- consultant_meeting: Internal team/consultant meeting (standups, planning, retrospectives, status updates, brainstorming)' || E'\n' ||
    '- target_company: Research or discussion ABOUT a target company/prospect (market analysis, competitive intel, account planning)' || E'\n' ||
    '- sales_service: Sales pitch, demo, or service call (pricing, proposals, objection handling, onboarding)' || E'\n' ||
    '- general: Anything that does not clearly fit the above (casual catch-ups, mixed topics, technical testing)' || E'\n' ||
    'Return ONLY the category name.',
    LEFT(v_transcript_text, 4000),
    50, 0.2
  );

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ============================================================================
-- Part 2: Fix process_pending_jobs() — proper retry with re-fire + backoff
-- ============================================================================

CREATE OR REPLACE FUNCTION process_pending_jobs()
RETURNS void AS $$
DECLARE
  v_job RECORD;
  v_content TEXT;
  v_transcript_text TEXT;
  v_transcript_json JSONB;
  v_category TEXT;
  v_meeting_org_id UUID;
  v_user_name TEXT;
  v_summary_tone_response TEXT;
  v_parsed JSONB;
  v_summary_text TEXT;
  v_tone_arr JSONB;
  v_system_prompt TEXT;
  v_new_request_id BIGINT;
  v_retry_text TEXT;
BEGIN
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
  -- FOR UPDATE SKIP LOCKED prevents concurrent cron runs from processing the same job twice
  -- Exponential backoff: skip jobs that were retried recently (wait attempts * 2 minutes)
  -- LIMIT 5 (down from 10) to reduce burst pressure on OpenAI API
  FOR v_job IN
    SELECT pj.*, r.status_code, r.content::jsonb as response_body
    FROM (
      SELECT * FROM processing_jobs
      WHERE status = 'pending'
        AND job_type = 'category'
        AND (attempts = 0 OR updated_at <= NOW() - (attempts * INTERVAL '2 minutes'))
      ORDER BY created_at ASC
      LIMIT 5
      FOR UPDATE SKIP LOCKED
    ) pj
    JOIN net._http_response r ON r.id = pj.pg_net_request_id
    ORDER BY pj.created_at ASC
  LOOP
    -- Guard: skip if meeting was deleted by cleanup_old_data() during this cron run
    IF NOT EXISTS (SELECT 1 FROM meetings WHERE id = v_job.meeting_id) THEN
      DELETE FROM processing_jobs WHERE id = v_job.id;
      CONTINUE;
    END IF;

    IF v_job.status_code = 200 THEN
      -- Validate response structure (API may return 200 with an error body on quota/rate errors)
      IF v_job.response_body ? 'error' OR v_job.response_body->'choices' IS NULL
          OR jsonb_array_length(v_job.response_body->'choices') = 0 THEN
        RAISE WARNING 'OpenAI category response invalid for meeting %: %',
          v_job.meeting_id, left(v_job.response_body::text, 200);
        UPDATE processing_jobs
        SET status = 'failed', error_message = 'OpenAI response structure invalid', updated_at = NOW()
        WHERE id = v_job.id;
        CONTINUE;
      END IF;
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

      SELECT m.org_id, p.full_name
      INTO v_meeting_org_id, v_user_name
      FROM meetings m
      JOIN profiles p ON p.id = m.user_id
      WHERE m.id = v_job.meeting_id;

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
        '=== SPEAKER CONTEXT ===' || E'\n' ||
        'The employee being monitored is ' || COALESCE(v_user_name, 'the employee') || '. ' ||
        'In the transcript they appear as ''' || COALESCE(v_user_name, 'the employee') || '''. ' ||
        'Remote participants appear as ''Remote Speaker'' or ''Remote Speaker N''.' || E'\n' ||
        'Always refer to all participants by their names throughout the summary. ' ||
        'Never use ''the speaker'', ''the first participant'', ''the employee'', or similar generic labels.' || E'\n\n' ||
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
          -- Clean up OpenAI response: strip markdown fences, extract JSON object
          v_parsed := clean_json_response(v_summary_tone_response);
          IF v_parsed IS NULL THEN
            INSERT INTO processing_jobs (meeting_id, job_type, status, error_message)
            VALUES (v_job.meeting_id, 'summary_tone', 'failed', 'OpenAI response not valid JSON: ' || left(v_summary_tone_response, 200))
            ON CONFLICT (meeting_id, job_type) DO UPDATE
              SET status = 'failed', error_message = EXCLUDED.error_message, updated_at = NOW();
            UPDATE meetings SET status = 'failed', error_message = 'Summary generation error: invalid JSON from OpenAI' WHERE id = v_job.meeting_id;
            CONTINUE;
          END IF;
          v_summary_text := v_parsed->>'summary';
          v_tone_arr := COALESCE(v_parsed->'tone_alerts', '[]'::jsonb);

          IF v_summary_text IS NOT NULL AND length(v_summary_text) > 0 THEN
            -- ON CONFLICT: uq_summaries_default_per_meeting prevents duplicate default summaries
            INSERT INTO summaries (meeting_id, category, content, is_default)
            VALUES (v_job.meeting_id, COALESCE(v_category, 'general'), v_summary_text, true)
            ON CONFLICT (meeting_id) WHERE is_default = true DO NOTHING;
          END IF;

          IF jsonb_array_length(v_tone_arr) > 0 THEN
            INSERT INTO tone_alerts (meeting_id, org_id, start_time, speaker, severity, flagged_text, reason)
            SELECT
              v_job.meeting_id, v_meeting_org_id,
              alert->>'start_time', alert->>'speaker',
              CASE WHEN (alert->>'severity') IN ('low','medium','high') THEN alert->>'severity' ELSE 'low' END,
              alert->>'flagged_text', alert->>'reason'
            FROM jsonb_array_elements(v_tone_arr) AS alert;

            -- Correct alert timestamps: OpenAI returns approximate HH:MM:SS times that
            -- may not match actual transcript segment boundaries. Cross-reference each
            -- alert's flagged_text against transcript segments and fix the start_time.
            UPDATE tone_alerts ta
            SET start_time = seg.start_time
            FROM (
              SELECT s->>'start_time' AS start_time, s->>'text' AS seg_text
              FROM transcripts t,
                   LATERAL jsonb_array_elements(t.transcript_json->'segments') AS s
              WHERE t.meeting_id = v_job.meeting_id
            ) seg
            WHERE ta.meeting_id = v_job.meeting_id
              AND ta.flagged_text IS NOT NULL
              AND length(ta.flagged_text) > 10
              AND seg.seg_text ILIKE '%' || ta.flagged_text || '%'
              AND seg.start_time IS NOT NULL
              AND seg.start_time <> ta.start_time;
          END IF;

          -- Record summary_tone as a completed job for audit trail
          INSERT INTO processing_jobs (meeting_id, job_type, status, result)
          VALUES (v_job.meeting_id, 'summary_tone', 'completed',
            jsonb_build_object('summary_length', length(v_summary_text), 'tone_count', jsonb_array_length(v_tone_arr)))
          ON CONFLICT (meeting_id, job_type) DO UPDATE
            SET status = 'completed', result = EXCLUDED.result, updated_at = NOW();

          UPDATE meetings SET status = 'processed', updated_at = NOW() WHERE id = v_job.meeting_id;

          -- Best-effort email notification
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
          VALUES (v_job.meeting_id, 'summary_tone', 'failed', 'OpenAI sync call returned NULL')
          ON CONFLICT (meeting_id, job_type) DO UPDATE
            SET status = 'failed', error_message = EXCLUDED.error_message, updated_at = NOW();
          UPDATE meetings SET status = 'failed', error_message = 'Summary generation failed' WHERE id = v_job.meeting_id;
        END IF;
      EXCEPTION WHEN OTHERS THEN
        INSERT INTO processing_jobs (meeting_id, job_type, status, error_message)
        VALUES (v_job.meeting_id, 'summary_tone', 'failed', SQLERRM)
        ON CONFLICT (meeting_id, job_type) DO UPDATE
          SET status = 'failed', error_message = EXCLUDED.error_message, updated_at = NOW();
        UPDATE meetings SET status = 'failed', error_message = 'Summary generation error: ' || SQLERRM WHERE id = v_job.meeting_id;
      END;

    ELSE
      -- Non-200 category response (e.g., 429 rate limit, 500 server error)
      -- The old logic just re-read the same cached pg_net response on retry (useless).
      -- New logic: delete old response, re-fire the request, exponential backoff via updated_at.
      IF v_job.attempts >= 5 THEN
        -- Max retries reached — mark as permanently failed
        UPDATE processing_jobs
        SET status = 'failed',
            attempts = v_job.attempts + 1,
            error_message = 'HTTP ' || v_job.status_code || ' after ' || (v_job.attempts + 1) || ' attempts',
            updated_at = NOW()
        WHERE id = v_job.id;
        UPDATE meetings SET status = 'failed', error_message = 'Category detection failed after retries' WHERE id = v_job.meeting_id;
      ELSE
        -- Retry: delete old pg_net response and re-fire the request
        BEGIN
          DELETE FROM net._http_response WHERE id = v_job.pg_net_request_id;
        EXCEPTION WHEN OTHERS THEN
          -- Ignore if already cleaned up
          NULL;
        END;

        -- Get transcript text for re-fire
        SELECT string_agg(segment->>'text', ' ') INTO v_retry_text
        FROM transcripts t,
             LATERAL jsonb_array_elements(t.transcript_json->'segments') AS segment
        WHERE t.meeting_id = v_job.meeting_id;

        IF v_retry_text IS NOT NULL AND length(trim(v_retry_text)) > 0 THEN
          -- Fire new pg_net request directly (can't use call_openai() — ON CONFLICT DO NOTHING)
          SELECT net.http_post(
            url := 'https://api.openai.com/v1/chat/completions',
            headers := jsonb_build_object(
              'Authorization', 'Bearer ' || get_openai_key(),
              'Content-Type', 'application/json'
            ),
            body := jsonb_build_object(
              'model', 'gpt-4o',
              'temperature', 0.2,
              'max_tokens', 50,
              'messages', jsonb_build_array(
                jsonb_build_object('role', 'system', 'content',
                  'You are a meeting categorizer. Return ONLY one category name, nothing else.' || E'\n' ||
                  'Categories:' || E'\n' ||
                  '- client_conversation: Meeting WITH a client/customer' || E'\n' ||
                  '- consultant_meeting: Internal team/consultant meeting' || E'\n' ||
                  '- target_company: Research or discussion ABOUT a target company/prospect' || E'\n' ||
                  '- sales_service: Sales pitch, demo, or service call' || E'\n' ||
                  '- general: Anything else' || E'\n' ||
                  'Return ONLY the category name.'
                ),
                jsonb_build_object('role', 'user', 'content', LEFT(v_retry_text, 4000))
              )
            )
          ) INTO v_new_request_id;

          IF v_new_request_id IS NOT NULL THEN
            UPDATE processing_jobs
            SET pg_net_request_id = v_new_request_id,
                attempts = v_job.attempts + 1,
                error_message = 'HTTP ' || v_job.status_code || ' — retrying (attempt ' || (v_job.attempts + 1) || ')',
                updated_at = NOW()
            WHERE id = v_job.id;
          ELSE
            -- pg_net failed to queue — mark as failed
            UPDATE processing_jobs
            SET status = 'failed',
                error_message = 'HTTP ' || v_job.status_code || ' — pg_net retry failed',
                updated_at = NOW()
            WHERE id = v_job.id;
            UPDATE meetings SET status = 'failed', error_message = 'Category detection retry failed' WHERE id = v_job.meeting_id;
          END IF;
        ELSE
          -- No transcript text available for retry
          UPDATE processing_jobs
          SET status = 'failed',
              error_message = 'No transcript text for retry',
              updated_at = NOW()
          WHERE id = v_job.id;
          UPDATE meetings SET status = 'failed', error_message = 'Category detection retry failed (no transcript)' WHERE id = v_job.meeting_id;
        END IF;
      END IF;
    END IF;
  END LOOP;
END;
$$ LANGUAGE plpgsql;

-- ============================================================================
-- Part 3: One-time reprocess of today's failed meetings
-- Re-trigger category detection for meetings stuck in 'failed' due to HTTP 429.
-- Only retrigger meetings that have actual transcript content (>50 words).
-- ============================================================================

DO $$
DECLARE
  v_meeting RECORD;
  v_transcript_text TEXT;
  v_word_count INTEGER;
BEGIN
  FOR v_meeting IN
    SELECT m.id as meeting_id
    FROM meetings m
    JOIN transcripts t ON t.meeting_id = m.id
    WHERE m.status = 'failed'
      AND m.error_message LIKE 'Category detection failed%'
      AND m.start_time >= NOW() - INTERVAL '2 days'
      AND t.word_count IS NOT NULL
      AND t.word_count >= 50
  LOOP
    -- Clean up old failed jobs
    DELETE FROM processing_jobs WHERE meeting_id = v_meeting.meeting_id;
    DELETE FROM summaries WHERE meeting_id = v_meeting.meeting_id;
    DELETE FROM tone_alerts WHERE meeting_id = v_meeting.meeting_id;

    -- Reset meeting status
    UPDATE meetings SET status = 'processing', error_message = NULL WHERE id = v_meeting.meeting_id;

    -- Get transcript text
    SELECT string_agg(segment->>'text', ' ') INTO v_transcript_text
    FROM transcripts t,
         LATERAL jsonb_array_elements(t.transcript_json->'segments') AS segment
    WHERE t.meeting_id = v_meeting.meeting_id;

    IF v_transcript_text IS NOT NULL AND length(trim(v_transcript_text)) > 0 THEN
      PERFORM call_openai(
        v_meeting.meeting_id,
        'category',
        'You are a meeting categorizer. Return ONLY one category name, nothing else.' || E'\n' ||
        'Categories:' || E'\n' ||
        '- client_conversation: Meeting WITH a client/customer (discussing their needs, requirements, deliverables, feedback)' || E'\n' ||
        '- consultant_meeting: Internal team/consultant meeting (standups, planning, retrospectives, status updates, brainstorming)' || E'\n' ||
        '- target_company: Research or discussion ABOUT a target company/prospect (market analysis, competitive intel, account planning)' || E'\n' ||
        '- sales_service: Sales pitch, demo, or service call (pricing, proposals, objection handling, onboarding)' || E'\n' ||
        '- general: Anything that does not clearly fit the above (casual catch-ups, mixed topics, technical testing)' || E'\n' ||
        'Return ONLY the category name.',
        LEFT(v_transcript_text, 4000),
        50, 0.2
      );
      RAISE NOTICE 'Reprocessing meeting %', v_meeting.meeting_id;
    ELSE
      RAISE WARNING 'Skipping meeting % — no transcript text', v_meeting.meeting_id;
    END IF;
  END LOOP;
END $$;
