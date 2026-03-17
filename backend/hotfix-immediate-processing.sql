-- hotfix-immediate-processing.sql
-- Run this in Supabase SQL Editor
--
-- PROBLEM: Teams meetings were uploaded with status 'awaiting_teams_transcript',
-- causing the trigger to SKIP processing the local transcript. The meeting sat
-- invisible (no summary) for 20+ minutes waiting for a Teams transcript that
-- might never come (e.g., transcription not enabled in Teams).
--
-- FIX: Process local transcript IMMEDIATELY on upload. If a Teams transcript
-- arrives later, the UPDATE trigger re-processes with better speaker names.
-- No more blocking on Teams transcript availability.

-- Step 1: Update the trigger function to ALWAYS process on INSERT
-- (remove the awaiting_teams_transcript skip)
CREATE OR REPLACE FUNCTION on_transcript_upserted()
RETURNS TRIGGER AS $$
DECLARE
  v_transcript_text TEXT;
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

  UPDATE transcripts SET word_count = array_length(string_to_array(v_transcript_text, ' '), 1) WHERE id = NEW.id;

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

-- Step 2: Recover ALL meetings currently stuck in 'awaiting_teams_transcript'
-- by touching their transcript_json to fire the UPDATE trigger
DO $$
DECLARE
  stuck_meeting RECORD;
  tx_row RECORD;
BEGIN
  FOR stuck_meeting IN
    SELECT id FROM meetings WHERE status = 'awaiting_teams_transcript'
  LOOP
    -- First update status so trigger doesn't skip
    UPDATE meetings SET status = 'uploaded' WHERE id = stuck_meeting.id;

    -- Touch transcript_json to fire the AFTER UPDATE trigger
    SELECT transcript_json INTO tx_row FROM transcripts WHERE meeting_id = stuck_meeting.id;
    IF tx_row IS NOT NULL THEN
      UPDATE transcripts
      SET transcript_json = tx_row.transcript_json,
          overridden_at = NOW()
      WHERE meeting_id = stuck_meeting.id;

      RAISE NOTICE 'Recovered stuck meeting: %', stuck_meeting.id;
    END IF;
  END LOOP;
END;
$$;
