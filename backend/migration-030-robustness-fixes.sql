-- migration-030-robustness-fixes.sql
-- Robustness and correctness fixes applied across triggers, functions, and cron jobs.
-- Run this in Supabase SQL Editor AFTER all previous migrations (migration-029).

-- ─────────────────────────────────────────────────────────────────────────────
-- Fix 1: call_openai_sync — NULL guard for http extension response
-- Prevents a NULL dereference crash when the http extension fails to connect.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION call_openai_sync(
  p_system_prompt TEXT,
  p_user_content TEXT,
  p_max_tokens INTEGER DEFAULT 500,
  p_temperature NUMERIC DEFAULT 0.3
)
RETURNS TEXT AS $$
DECLARE
  v_api_key TEXT;
  v_response extensions.http_response;
  v_body JSONB;
  v_content TEXT;
BEGIN
  v_api_key := get_openai_key();
  IF v_api_key IS NULL THEN
    RAISE EXCEPTION 'OpenAI API key not found in vault';
  END IF;

  BEGIN
    PERFORM http_set_curlopt('CURLOPT_TIMEOUT', '60');
  EXCEPTION WHEN OTHERS THEN
    BEGIN
      SET LOCAL http.timeout_msec = 60000;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'Could not set HTTP timeout: %', SQLERRM;
    END;
  END;

  SELECT * INTO v_response FROM extensions.http((
    'POST',
    'https://api.openai.com/v1/chat/completions',
    ARRAY[
      extensions.http_header('Authorization', 'Bearer ' || v_api_key),
      extensions.http_header('Content-Type', 'application/json')
    ],
    'application/json',
    jsonb_build_object(
      'model', 'gpt-4o',
      'temperature', p_temperature,
      'max_tokens', p_max_tokens,
      'messages', jsonb_build_array(
        jsonb_build_object('role', 'system', 'content', p_system_prompt),
        jsonb_build_object('role', 'user', 'content', p_user_content)
      )
    )::text
  )::extensions.http_request);

  -- Guard: http extension may return NULL record if the request could not be made
  IF v_response IS NULL THEN
    RAISE WARNING 'call_openai_sync: http extension returned NULL response (network or extension error)';
    RETURN NULL;
  END IF;

  IF v_response.status != 200 THEN
    RAISE WARNING 'OpenAI HTTP %: %', v_response.status, left(v_response.content, 200);
    RETURN NULL;
  END IF;

  v_body := v_response.content::jsonb;

  IF v_body ? 'error' THEN
    RAISE WARNING 'OpenAI API error: %', left(v_body->>'error', 200);
    RETURN NULL;
  END IF;

  IF v_body->'choices' IS NULL OR jsonb_array_length(v_body->'choices') = 0 THEN
    RAISE WARNING 'OpenAI response has no choices: %', left(v_response.content, 200);
    RETURN NULL;
  END IF;

  v_content := v_body->'choices'->0->'message'->>'content';
  RETURN v_content;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ─────────────────────────────────────────────────────────────────────────────
-- Fix 2: on_transcript_upserted trigger — skip re-fire when transcript_json unchanged
-- Prevents double OpenAI calls from concurrent no-op UPDATE touches.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION on_transcript_upserted()
RETURNS TRIGGER AS $$
DECLARE
  v_transcript_text TEXT;
BEGIN
  -- Guard: skip re-fire if transcript_json is unchanged (prevents duplicate OpenAI calls
  -- from concurrent updates or accidental no-op touches).
  IF TG_OP = 'UPDATE' THEN
    IF OLD.transcript_json IS NOT DISTINCT FROM NEW.transcript_json THEN
      RETURN NEW;
    END IF;
    DELETE FROM summaries WHERE meeting_id = NEW.meeting_id;
    DELETE FROM tone_alerts WHERE meeting_id = NEW.meeting_id;
    DELETE FROM processing_jobs WHERE meeting_id = NEW.meeting_id;
  END IF;

  UPDATE meetings SET status = 'processing' WHERE id = NEW.meeting_id;

  SELECT string_agg(segment->>'text', ' ')
  INTO v_transcript_text
  FROM jsonb_array_elements(NEW.transcript_json->'segments') AS segment;

  IF v_transcript_text IS NULL OR length(trim(v_transcript_text)) = 0 THEN
    RAISE WARNING 'on_transcript_upserted: transcript for meeting % has no text content — skipping AI processing', NEW.meeting_id;
    UPDATE meetings SET status = 'failed', error_message = 'Transcript has no text content' WHERE id = NEW.meeting_id;
    RETURN NEW;
  END IF;

  -- Filter empty strings from double-spaces to get accurate word count
  UPDATE transcripts
  SET word_count = array_length(
    array_remove(string_to_array(v_transcript_text, ' '), ''), 1
  )
  WHERE id = NEW.id;

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

-- Re-attach triggers (idempotent — DROP IF EXISTS before CREATE)
DROP TRIGGER IF EXISTS trigger_transcript_inserted ON transcripts;
CREATE TRIGGER trigger_transcript_inserted
AFTER INSERT ON transcripts
FOR EACH ROW EXECUTE FUNCTION on_transcript_upserted();

DROP TRIGGER IF EXISTS trigger_transcript_updated ON transcripts;
CREATE TRIGGER trigger_transcript_updated
AFTER UPDATE OF transcript_json ON transcripts
FOR EACH ROW EXECUTE FUNCTION on_transcript_upserted();

-- ─────────────────────────────────────────────────────────────────────────────
-- Fix 3: cleanup_old_data — use safe INTERVAL arithmetic instead of string concat
-- Prevents potential type coercion issues with data_retention_days column.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION cleanup_old_data()
RETURNS void AS $$
BEGIN
  DELETE FROM meetings m
  USING organizations o
  WHERE m.org_id = o.id
    AND m.created_at < NOW() - (INTERVAL '1 day' * o.data_retention_days);
END;
$$ LANGUAGE plpgsql;
