-- Prevent duplicate "recording" status records for the same meeting.
-- App-layer dedup is the primary guard; this index is a safety net
-- in case the app-layer check fails (network error, race condition, restart).
CREATE UNIQUE INDEX IF NOT EXISTS idx_meetings_recording_dedup
ON meetings (user_id, detected_app, start_time)
WHERE status = 'recording';
