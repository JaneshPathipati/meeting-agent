-- file: backend/functions.sql
-- MeetChamp - PostgreSQL Functions
-- Run this AFTER rls-policies.sql in Supabase SQL Editor

-- Store OpenAI key (run once manually at Pause Point 3):
-- SELECT vault.create_secret('sk-proj-XXXX', 'openai_api_key');

-- Helper: get OpenAI key from vault
CREATE OR REPLACE FUNCTION get_openai_key()
RETURNS TEXT AS $$
  SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'openai_api_key' LIMIT 1;
$$ LANGUAGE sql SECURITY DEFINER VOLATILE;

-- Function: synchronous OpenAI call via http extension (for use in cron jobs)
-- Returns the assistant message content directly, or NULL on failure
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

  -- Check for API-level error body (e.g., rate limit, quota exceeded, invalid request)
  IF v_body ? 'error' THEN
    RAISE WARNING 'OpenAI API error: %', left(v_body->>'error', 200);
    RETURN NULL;
  END IF;

  -- Validate response structure before extracting
  IF v_body->'choices' IS NULL OR jsonb_array_length(v_body->'choices') = 0 THEN
    RAISE WARNING 'OpenAI response has no choices: %', left(v_response.content, 200);
    RETURN NULL;
  END IF;

  v_content := v_body->'choices'->0->'message'->>'content';
  RETURN v_content;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Function: fire OpenAI request via pg_net (async), track in processing_jobs
-- Used in triggers where blocking is not allowed
CREATE OR REPLACE FUNCTION call_openai(
  p_meeting_id UUID,
  p_job_type TEXT,
  p_system_prompt TEXT,
  p_user_content TEXT,
  p_max_tokens INTEGER DEFAULT 500,
  p_temperature NUMERIC DEFAULT 0.3
)
RETURNS BIGINT AS $$
DECLARE
  v_api_key TEXT;
  v_request_id BIGINT;
BEGIN
  v_api_key := get_openai_key();
  IF v_api_key IS NULL THEN
    RAISE EXCEPTION 'OpenAI API key not found in vault';
  END IF;

  SELECT net.http_post(
    url := 'https://api.openai.com/v1/chat/completions',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || v_api_key,
      'Content-Type', 'application/json'
    ),
    body := jsonb_build_object(
      'model', 'gpt-4o',
      'temperature', p_temperature,
      'max_tokens', p_max_tokens,
      'messages', jsonb_build_array(
        jsonb_build_object('role', 'system', 'content', p_system_prompt),
        jsonb_build_object('role', 'user', 'content', p_user_content)
      )
    )
  ) INTO v_request_id;

  -- Guard: pg_net can return NULL if the HTTP request couldn't be queued (network error, etc.)
  -- An orphaned NULL request_id would permanently block this meeting (cron JOIN never matches).
  IF v_request_id IS NULL THEN
    RAISE EXCEPTION 'pg_net failed to queue HTTP request for meeting % job_type % (null request_id)', p_meeting_id, p_job_type;
  END IF;

  -- ON CONFLICT DO NOTHING: safety net against concurrent duplicate calls for the same meeting+type.
  -- The trigger already deletes old jobs before re-triggering, so conflict = true duplicate.
  INSERT INTO processing_jobs (meeting_id, job_type, pg_net_request_id)
  VALUES (p_meeting_id, p_job_type, v_request_id)
  ON CONFLICT (meeting_id, job_type) DO NOTHING;

  RETURN v_request_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
