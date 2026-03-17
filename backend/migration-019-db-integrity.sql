-- migration-019-db-integrity.sql
-- Integrity constraints and performance indexes from security audit.
-- Run this in Supabase SQL Editor AFTER all previous migrations.
--
-- IMPORTANT DEPLOYMENT NOTE:
-- After running this migration, re-run the following files in the SQL Editor
-- to activate ON CONFLICT guards that depend on these new constraints:
--   1. backend/functions.sql        (call_openai uses ON CONFLICT on processing_jobs)
--   2. backend/cron-jobs.sql        (process_pending_jobs uses ON CONFLICT on summaries)
-- On a fresh deployment, run all migrations (including this one) before
-- any transcripts are uploaded — the ON CONFLICT clauses are no-ops until
-- the constraints below exist.

-- ──────────────────────────────────────────────────────────────────────────────
-- NEW-2: Unique constraint on processing_jobs(meeting_id, job_type)
-- ──────────────────────────────────────────────────────────────────────────────
-- Prevents duplicate AI jobs for the same meeting when concurrent cron runs
-- or a trigger re-fires without first deleting the existing job.
-- NOT deferrable: ON CONFLICT DO NOTHING in call_openai() requires a non-deferrable
-- constraint as the arbiter (PostgreSQL limitation). The trigger does DELETE first,
-- then INSERT in the same transaction — so there is no mid-transaction conflict and
-- deferral is not needed.

-- Step 1: Remove any existing duplicate (meeting_id, job_type) rows, keeping the latest.
-- Required before adding the UNIQUE constraint to avoid failures on live data.
DELETE FROM processing_jobs pj
WHERE pj.id NOT IN (
  SELECT DISTINCT ON (meeting_id, job_type) id
  FROM processing_jobs
  ORDER BY meeting_id, job_type, created_at DESC
);

-- Drop existing constraint if it was previously created as DEFERRABLE (re-run safe)
ALTER TABLE processing_jobs
  DROP CONSTRAINT IF EXISTS uq_processing_jobs_meeting_type;

ALTER TABLE processing_jobs
  ADD CONSTRAINT uq_processing_jobs_meeting_type
  UNIQUE (meeting_id, job_type);

-- ──────────────────────────────────────────────────────────────────────────────
-- NEW-3: Unique partial index on summaries WHERE is_default = true
-- ──────────────────────────────────────────────────────────────────────────────
-- Prevents two default summaries being inserted for the same meeting
-- (e.g., concurrent cron runs both winning the FOR UPDATE SKIP LOCKED race
-- on separate category jobs for the same meeting).
-- cron-jobs.sql uses ON CONFLICT DO NOTHING as the runtime safety net.

-- Step 1: Remove duplicate default summaries, keeping the most recent one.
DELETE FROM summaries s
WHERE s.is_default = true
  AND s.id NOT IN (
    SELECT DISTINCT ON (meeting_id) id
    FROM summaries
    WHERE is_default = true
    ORDER BY meeting_id, created_at DESC
  );

CREATE UNIQUE INDEX IF NOT EXISTS uq_summaries_default_per_meeting
  ON summaries(meeting_id) WHERE is_default = true;

-- ──────────────────────────────────────────────────────────────────────────────
-- NEW-7: Combined index for meetings filtered by status and sorted by date
-- ──────────────────────────────────────────────────────────────────────────────
-- Dashboard queries filter by status ('processed', 'failed', etc.) and sort by
-- created_at DESC. The existing separate indexes on status and created_at are
-- not used together efficiently — this composite index covers both in one scan.
CREATE INDEX IF NOT EXISTS idx_meetings_status_created
  ON meetings(status, created_at DESC);
