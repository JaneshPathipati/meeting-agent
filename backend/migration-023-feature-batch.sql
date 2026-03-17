-- file: backend/migration-023-feature-batch.sql
-- Feature batch: structured summaries, attendees, consent, org policies, FTS, audio cleanup
-- Run in Supabase SQL Editor

-- ── organizations: configurable recording policies ──
ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS min_meeting_duration_seconds INTEGER DEFAULT 120,
  ADD COLUMN IF NOT EXISTS exclusion_keywords TEXT[] DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS summaries_enabled BOOLEAN DEFAULT true,
  ADD COLUMN IF NOT EXISTS emails_enabled BOOLEAN DEFAULT true,
  ADD COLUMN IF NOT EXISTS emails_enabled_before_off BOOLEAN DEFAULT true;

-- ── profiles: employee consent ──
ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS consent_given BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS consent_given_at TIMESTAMPTZ;

-- ── meetings: attendees list + title + audio cleanup marker ──
ALTER TABLE meetings
  ADD COLUMN IF NOT EXISTS title TEXT,
  ADD COLUMN IF NOT EXISTS attendees JSONB DEFAULT '[]',
  ADD COLUMN IF NOT EXISTS email_sent_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS audio_deleted_at TIMESTAMPTZ;

-- ── summaries: structured JSON alongside markdown ──
ALTER TABLE summaries
  ADD COLUMN IF NOT EXISTS structured_json JSONB;

-- ── transcripts: full-text search vector ──
ALTER TABLE transcripts
  ADD COLUMN IF NOT EXISTS transcript_fts tsvector
    GENERATED ALWAYS AS (
      to_tsvector('english', COALESCE(raw_text, ''))
    ) STORED;

CREATE INDEX IF NOT EXISTS idx_transcripts_fts ON transcripts USING GIN(transcript_fts);

-- Backfill: populate raw_text from transcript_json segments if raw_text is empty
UPDATE transcripts
SET raw_text = (
  SELECT string_agg(seg->>'text', ' ')
  FROM jsonb_array_elements(transcript_json->'segments') AS seg
)
WHERE (raw_text IS NULL OR raw_text = '')
  AND transcript_json IS NOT NULL
  AND jsonb_array_length(COALESCE(transcript_json->'segments', '[]')) > 0;

-- ── indexes ──
CREATE INDEX IF NOT EXISTS idx_meetings_attendees ON meetings USING GIN(attendees);
CREATE INDEX IF NOT EXISTS idx_meetings_title ON meetings(title);
CREATE INDEX IF NOT EXISTS idx_profiles_consent ON profiles(consent_given);
