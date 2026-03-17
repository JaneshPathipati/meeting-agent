-- migration-026-fix-constraints.sql
-- Fix 1: Add 'recording' status to meetings (migration-006 was never applied)
ALTER TABLE meetings DROP CONSTRAINT IF EXISTS meetings_status_check;
ALTER TABLE meetings ADD CONSTRAINT meetings_status_check
  CHECK (status IN ('recording', 'uploaded', 'awaiting_teams_transcript', 'processing', 'processed', 'failed'));

-- Fix 2: Add 'openai' to transcripts source (for OpenAI Whisper badge display)
ALTER TABLE transcripts DROP CONSTRAINT IF EXISTS transcripts_source_check;
ALTER TABLE transcripts ADD CONSTRAINT transcripts_source_check
  CHECK (source IN ('local', 'teams', 'openai'));
