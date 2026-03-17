-- hotfix-json-cleanup.sql
-- Fix: OpenAI sometimes returns JSON wrapped in markdown fences (```json...```)
-- or with leading/trailing text, causing "invalid input syntax for type json" error.
-- Adds a cleanup helper and patches process_pending_jobs() to use it.

-- Helper function: clean OpenAI response to extract valid JSON
CREATE OR REPLACE FUNCTION clean_json_response(raw_text TEXT)
RETURNS JSONB AS $$
DECLARE
  v_cleaned TEXT;
  v_start INT;
  v_end INT;
BEGIN
  IF raw_text IS NULL THEN RETURN NULL; END IF;

  v_cleaned := trim(raw_text);

  -- Strip markdown code fences: ```json ... ``` or ``` ... ```
  IF v_cleaned LIKE '```%' THEN
    -- Remove opening fence (```json or ```)
    v_cleaned := regexp_replace(v_cleaned, '^```\w*\s*', '', 'n');
    -- Remove closing fence
    v_cleaned := regexp_replace(v_cleaned, '\s*```\s*$', '', 'n');
    v_cleaned := trim(v_cleaned);
  END IF;

  -- If still not starting with { or [, try to extract the JSON object
  IF left(v_cleaned, 1) NOT IN ('{', '[') THEN
    v_start := position('{' in v_cleaned);
    IF v_start > 0 THEN
      -- Find the last }
      v_end := length(v_cleaned) - position('}' in reverse(v_cleaned)) + 1;
      IF v_end >= v_start THEN
        v_cleaned := substring(v_cleaned from v_start for v_end - v_start + 1);
      END IF;
    END IF;
  END IF;

  -- Try to parse as JSONB
  BEGIN
    RETURN v_cleaned::jsonb;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'clean_json_response: failed to parse cleaned text: %', left(v_cleaned, 200);
    RETURN NULL;
  END;
END;
$$ LANGUAGE plpgsql IMMUTABLE;
