-- Migration 017: Agent logs table for remote diagnostics
-- Electron agent uploads info/warn/error logs every 60s.
-- Admins can view per-user device logs from the admin panel.
-- Auto-deleted after 2 days via pg_cron.

-- Create agent_logs table
CREATE TABLE IF NOT EXISTS agent_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  profile_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  level text NOT NULL CHECK (level IN ('info', 'warn', 'error')),
  module text,                     -- e.g. 'Detector', 'Uploader', 'MSALAuth'
  message text NOT NULL,
  meta jsonb,                      -- additional context objects from log call
  logged_at timestamptz NOT NULL,  -- device-local timestamp when log was emitted
  created_at timestamptz DEFAULT now()
);

-- Indexes for common admin queries
CREATE INDEX IF NOT EXISTS idx_agent_logs_profile_id ON agent_logs(profile_id);
CREATE INDEX IF NOT EXISTS idx_agent_logs_org_id     ON agent_logs(org_id);
CREATE INDEX IF NOT EXISTS idx_agent_logs_logged_at  ON agent_logs(logged_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_logs_level      ON agent_logs(level);

-- RLS
ALTER TABLE agent_logs ENABLE ROW LEVEL SECURITY;

-- Service role (Electron agent) can insert
CREATE POLICY "Service role insert agent_logs" ON agent_logs
  FOR INSERT TO service_role WITH CHECK (true);

-- Admin can read their org's logs only
CREATE POLICY "Admins read org agent_logs" ON agent_logs
  FOR SELECT USING (
    org_id = get_my_org_id() AND is_admin()
  );

-- pg_cron: delete logs older than 2 days (runs every 30 min for tighter TTL compliance)
SELECT cron.schedule(
  'cleanup-agent-logs',
  '*/30 * * * *',
  $$DELETE FROM agent_logs WHERE created_at < now() - interval '2 days'$$
);
