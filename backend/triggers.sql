-- file: backend/triggers.sql
-- MeetChamp - Triggers
-- Run this AFTER functions.sql in Supabase SQL Editor

-- Trigger: when a transcript is inserted (or updated via override), kick off AI processing
CREATE OR REPLACE FUNCTION on_transcript_upserted()
RETURNS TRIGGER AS $$
DECLARE
  v_transcript_text TEXT;
BEGIN
  -- If this is an UPDATE (Teams transcript override), delete old processing results
  -- so we re-process with the better Teams transcript (has real speaker names).
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

  -- Guard: transcript_json exists but has no segments or all segments are empty text.
  -- Sending NULL content to OpenAI wastes quota and produces hallucinated results.
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

DROP TRIGGER IF EXISTS trigger_transcript_inserted ON transcripts;
CREATE TRIGGER trigger_transcript_inserted
AFTER INSERT ON transcripts
FOR EACH ROW EXECUTE FUNCTION on_transcript_upserted();

DROP TRIGGER IF EXISTS trigger_transcript_updated ON transcripts;
CREATE TRIGGER trigger_transcript_updated
AFTER UPDATE OF transcript_json ON transcripts
FOR EACH ROW EXECUTE FUNCTION on_transcript_upserted();
