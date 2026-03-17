-- migration-011-tone-alert-timestamps.sql
-- Fix tone alert timestamps to match actual transcript segment boundaries.
-- OpenAI returns approximate timestamps that may not match the transcript;
-- this migration corrects existing alerts and the cron job now auto-corrects future ones.

-- 1. Retroactively fix all existing tone alerts whose flagged_text appears
--    in a transcript segment at a different timestamp.
UPDATE tone_alerts ta
SET start_time = seg.start_time
FROM (
  SELECT t.meeting_id, s->>'start_time' AS start_time, s->>'text' AS seg_text
  FROM transcripts t,
       LATERAL jsonb_array_elements(t.transcript_json->'segments') AS s
  WHERE s->>'start_time' IS NOT NULL
) seg
WHERE seg.meeting_id = ta.meeting_id
  AND ta.flagged_text IS NOT NULL
  AND seg.seg_text ILIKE '%' || ta.flagged_text || '%'
  AND seg.start_time IS NOT NULL
  AND seg.start_time <> ta.start_time;

-- 2. Replace process_pending_jobs() with the version that auto-corrects
--    tone alert timestamps after insertion (see cron-jobs.sql for full source).
-- The key addition is the UPDATE tone_alerts ... FROM transcripts block
-- right after the INSERT INTO tone_alerts statement.
