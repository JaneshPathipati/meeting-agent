-- migration-006-recording-status.sql
-- Adds 'recording' status to meetings table so the admin dashboard can see
-- meetings in progress (before transcription/upload completes).

-- Drop the existing CHECK constraint and add the new one with 'recording'
ALTER TABLE meetings DROP CONSTRAINT IF EXISTS meetings_status_check;
ALTER TABLE meetings ADD CONSTRAINT meetings_status_check
  CHECK (status IN ('recording', 'uploaded', 'awaiting_teams_transcript', 'processing', 'processed', 'failed'));
