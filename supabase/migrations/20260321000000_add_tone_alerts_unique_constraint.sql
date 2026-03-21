-- Add unique constraint on tone_alerts to prevent duplicate alerts
-- for the same speaker at the same time in the same meeting.
-- This enables safe upsert patterns and enforces data integrity.

ALTER TABLE tone_alerts
  ADD CONSTRAINT uq_tone_alerts_meeting_start_speaker
  UNIQUE (meeting_id, start_time, speaker);
