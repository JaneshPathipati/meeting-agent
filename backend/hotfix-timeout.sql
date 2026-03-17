-- file: backend/hotfix-timeout.sql
-- HOTFIX: Increase HTTP timeout for OpenAI calls from 5s (default) to 60s
-- The summary+tone call to GPT-4o takes 15-30s, causing timeout failures.
-- Run this in Supabase SQL Editor IMMEDIATELY.

-- 1. Fix the call_openai_sync function with timeout increase
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

  -- Increase HTTP timeout from default 5s to 60s for long OpenAI calls
  BEGIN
    PERFORM http_set_curlopt('CURLOPT_TIMEOUT', '60');
  EXCEPTION WHEN OTHERS THEN
    -- Fallback: try GUC if http_set_curlopt not available
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

  IF v_response.status != 200 THEN
    RAISE WARNING 'OpenAI HTTP %: %', v_response.status, left(v_response.content, 200);
    RETURN NULL;
  END IF;

  v_body := v_response.content::jsonb;
  v_content := v_body->'choices'->0->'message'->>'content';
  RETURN v_content;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 2. Retry failed meetings by re-triggering the full pipeline
-- First clean up old processing artifacts
DO $$
DECLARE
  v_meeting RECORD;
BEGIN
  FOR v_meeting IN
    SELECT m.id FROM meetings m
    WHERE m.status = 'failed'
      AND m.error_message LIKE '%timed out%'
  LOOP
    -- Clean up old results
    DELETE FROM summaries WHERE meeting_id = v_meeting.id;
    DELETE FROM tone_alerts WHERE meeting_id = v_meeting.id;
    DELETE FROM processing_jobs WHERE meeting_id = v_meeting.id;

    -- Reset meeting status to 'uploaded'
    UPDATE meetings SET status = 'uploaded', error_message = NULL, updated_at = NOW()
    WHERE id = v_meeting.id;

    -- Re-write transcript_json to itself to fire the AFTER UPDATE OF transcript_json trigger
    UPDATE transcripts SET transcript_json = transcript_json
    WHERE meeting_id = v_meeting.id;

    RAISE NOTICE 'Retried meeting %', v_meeting.id;
  END LOOP;
END $$;
