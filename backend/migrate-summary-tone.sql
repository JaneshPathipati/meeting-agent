-- Migration: Merge summary + tone into single API call
-- Run this in Supabase SQL Editor BEFORE updating the cron function

-- 1. Update the job_type constraint to allow 'summary_tone'
ALTER TABLE processing_jobs DROP CONSTRAINT IF EXISTS processing_jobs_job_type_check;
ALTER TABLE processing_jobs ADD CONSTRAINT processing_jobs_job_type_check
  CHECK (job_type IN ('category', 'summary', 'tone', 'summary_tone'));

-- 2. Drop and recreate the cron function with combined summary+tone logic
-- (Copy the full process_pending_jobs function from cron-jobs.sql)

-- 3. Verify: check existing pending jobs won't break
-- SELECT job_type, status, count(*) FROM processing_jobs GROUP BY job_type, status;
