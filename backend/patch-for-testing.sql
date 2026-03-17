-- file: backend/patch-for-testing.sql
-- Run this ONCE in Supabase SQL Editor before starting the agent for testing.
-- Applies all missing columns + updated trigger for local AI (no OpenAI needed).
-- All statements use IF NOT EXISTS so it is safe to run multiple times.

-- ── 1. summaries.structured_json (from migration-023) ────────────────────────
ALTER TABLE summaries
  ADD COLUMN IF NOT EXISTS structured_json JSONB;

-- ── 2. summaries unique index for is_default (prevents duplicate default summaries) ─
CREATE UNIQUE INDEX IF NOT EXISTS uq_summaries_default_per_meeting
  ON summaries (meeting_id) WHERE is_default = true;

-- ── 3. transcripts.ai_pregenerated (from migration-025) ──────────────────────
ALTER TABLE transcripts
  ADD COLUMN IF NOT EXISTS ai_pregenerated BOOLEAN NOT NULL DEFAULT false;

-- ── 4. meetings.attendees, email_sent_at, audio_deleted_at (migration-023) ───
ALTER TABLE meetings
  ADD COLUMN IF NOT EXISTS attendees       JSONB,
  ADD COLUMN IF NOT EXISTS email_sent_at   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS audio_deleted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS title           TEXT;

-- ── 5. profiles.consent_given (migration-023) ────────────────────────────────
ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS consent_given    BOOLEAN,
  ADD COLUMN IF NOT EXISTS consent_given_at TIMESTAMPTZ;

-- ── 6. organizations policy columns (migration-023) ──────────────────────────
ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS min_meeting_duration_seconds INTEGER DEFAULT 120,
  ADD COLUMN IF NOT EXISTS exclusion_keywords           TEXT[];

-- ── 7. Updated transcript trigger: skip OpenAI when ai_pregenerated = true ───
CREATE OR REPLACE FUNCTION on_transcript_upserted()
RETURNS TRIGGER AS $$
DECLARE
  v_transcript_text TEXT;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NOT NEW.ai_pregenerated THEN
      DELETE FROM summaries       WHERE meeting_id = NEW.meeting_id;
      DELETE FROM tone_alerts     WHERE meeting_id = NEW.meeting_id;
      DELETE FROM processing_jobs WHERE meeting_id = NEW.meeting_id;
    END IF;
  END IF;

  -- When AI was generated locally by the client agent, skip OpenAI entirely.
  -- The uploader already inserted summary + tone_alerts + set status = processed.
  IF NEW.ai_pregenerated THEN
    RAISE NOTICE 'ai_pregenerated=true for meeting % — skipping OpenAI', NEW.meeting_id;

    SELECT string_agg(segment->>'text', ' ')
    INTO v_transcript_text
    FROM jsonb_array_elements(NEW.transcript_json->'segments') AS segment;

    IF v_transcript_text IS NOT NULL AND length(trim(v_transcript_text)) > 0 THEN
      UPDATE transcripts
        SET word_count = array_length(string_to_array(v_transcript_text, ' '), 1)
        WHERE id = NEW.id;
    END IF;

    -- Belt-and-suspenders: ensure meeting is marked processed
    UPDATE meetings
      SET status = CASE WHEN status IN ('uploaded','recording') THEN 'processed' ELSE status END
      WHERE id = NEW.meeting_id;

    RETURN NEW;
  END IF;

  -- Standard path: no local AI — call OpenAI via pg_net (requires OpenAI configured)
  UPDATE meetings SET status = 'processing' WHERE id = NEW.meeting_id;

  SELECT string_agg(segment->>'text', ' ')
  INTO v_transcript_text
  FROM jsonb_array_elements(NEW.transcript_json->'segments') AS segment;

  IF v_transcript_text IS NULL OR length(trim(v_transcript_text)) = 0 THEN
    RAISE WARNING 'Transcript for meeting % has no text — skipping AI', NEW.meeting_id;
    UPDATE meetings SET status = 'failed', error_message = 'Transcript has no text content'
    WHERE id = NEW.meeting_id;
    RETURN NEW;
  END IF;

  UPDATE transcripts
    SET word_count = array_length(string_to_array(v_transcript_text, ' '), 1)
    WHERE id = NEW.id;

  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'call_openai') THEN
    PERFORM call_openai(
      NEW.meeting_id, 'category',
      'You are a meeting categorizer. Return ONLY one category name, nothing else.'
      || E'\nCategories: client_conversation, consultant_meeting, target_company, sales_service, general'
      || E'\nReturn ONLY the category name.',
      LEFT(v_transcript_text, 4000), 50, 0.2
    );
  ELSE
    RAISE WARNING 'call_openai not found for meeting % — configure OpenAI or use local AI', NEW.meeting_id;
    UPDATE meetings
      SET status = 'failed',
          error_message = 'OpenAI not configured. Local AI not used (check agent logs).'
      WHERE id = NEW.meeting_id;
  END IF;

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

-- ── 8. FTS on transcripts (migration-023 search) ─────────────────────────────
ALTER TABLE transcripts ADD COLUMN IF NOT EXISTS raw_text TEXT;

-- ── 9. Verify ─────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name='summaries' AND column_name='structured_json'
  ) THEN
    RAISE EXCEPTION 'structured_json column missing on summaries — patch failed';
  END IF;
  RAISE NOTICE '✓ patch-for-testing.sql applied successfully. Ready to start the agent.';
END $$;
