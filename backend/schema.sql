-- file: backend/schema.sql
-- MeetChamp - Database Schema
-- Run this in Supabase SQL Editor

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS pg_net;
CREATE EXTENSION IF NOT EXISTS pg_cron;

-- Organizations
CREATE TABLE organizations (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name TEXT NOT NULL,
  settings JSONB DEFAULT '{}',
  data_retention_days INTEGER DEFAULT 90,
  azure_tenant_id TEXT,
  azure_client_id TEXT,
  authorization_key TEXT,
  sender_email TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Profiles
-- role='admin' -> has Supabase Auth account (auth_id set), can log into dashboard
-- role='user'  -> monitored employee, NO Supabase Auth account, agent writes on their behalf
CREATE TABLE profiles (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  auth_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  email TEXT UNIQUE NOT NULL,
  full_name TEXT NOT NULL,
  department TEXT,
  role TEXT NOT NULL CHECK (role IN ('admin', 'user')) DEFAULT 'user',
  microsoft_email TEXT,
  microsoft_user_id TEXT,
  job_role TEXT,
  job_role_custom TEXT,
  enrolled_at TIMESTAMPTZ,
  is_active BOOLEAN DEFAULT true,
  is_locked_out BOOLEAN DEFAULT false,
  email_enabled BOOLEAN DEFAULT true,
  last_agent_heartbeat TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_profiles_org_id ON profiles(org_id);
CREATE INDEX idx_profiles_email ON profiles(email);
CREATE INDEX idx_profiles_auth_id ON profiles(auth_id);
CREATE INDEX idx_profiles_microsoft_email ON profiles(microsoft_email);

-- Meetings
CREATE TABLE meetings (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  start_time TIMESTAMPTZ NOT NULL,
  end_time TIMESTAMPTZ NOT NULL,
  duration_seconds INTEGER GENERATED ALWAYS AS (
    EXTRACT(EPOCH FROM (end_time - start_time))::INTEGER
  ) STORED,
  detected_app TEXT NOT NULL DEFAULT 'Unknown',
  detected_category TEXT,
  teams_meeting_id TEXT,
  teams_join_url TEXT,
  teams_transcript_attempt INTEGER DEFAULT 0,
  calendar_event_id TEXT,
  status TEXT DEFAULT 'uploaded' CHECK (status IN ('uploaded', 'awaiting_teams_transcript', 'processing', 'processed', 'failed')),
  error_message TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_meetings_user_id ON meetings(user_id);
CREATE INDEX idx_meetings_org_id ON meetings(org_id);
CREATE INDEX idx_meetings_status ON meetings(status);
CREATE INDEX idx_meetings_created_at ON meetings(created_at DESC);

-- Transcripts
CREATE TABLE transcripts (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  meeting_id UUID UNIQUE NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  transcript_json JSONB NOT NULL,
  source TEXT NOT NULL DEFAULT 'local' CHECK (source IN ('local', 'teams')),
  word_count INTEGER,
  overridden_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_transcripts_meeting_id ON transcripts(meeting_id);
CREATE INDEX idx_transcripts_source ON transcripts(source);

-- Summaries
CREATE TABLE summaries (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  meeting_id UUID NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  category TEXT NOT NULL,
  content TEXT NOT NULL,
  is_default BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_summaries_meeting_id ON summaries(meeting_id);

-- Tone Alerts
CREATE TABLE tone_alerts (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  meeting_id UUID NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  start_time TEXT NOT NULL,
  speaker TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('low', 'medium', 'high')),
  flagged_text TEXT NOT NULL,
  reason TEXT,
  is_reviewed BOOLEAN DEFAULT false,
  reviewed_by UUID REFERENCES profiles(id),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_tone_alerts_meeting_id ON tone_alerts(meeting_id);
CREATE INDEX idx_tone_alerts_org_id ON tone_alerts(org_id);
CREATE INDEX idx_tone_alerts_severity ON tone_alerts(severity);

-- Processing Queue (tracks pg_net async responses)
CREATE TABLE processing_jobs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  meeting_id UUID NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  job_type TEXT NOT NULL CHECK (job_type IN ('category', 'summary', 'tone', 'summary_tone')),
  pg_net_request_id BIGINT,
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'completed', 'failed')),
  result JSONB,
  error_message TEXT,
  attempts INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_processing_jobs_status ON processing_jobs(status);
CREATE INDEX idx_processing_jobs_request_id ON processing_jobs(pg_net_request_id);
CREATE INDEX idx_processing_jobs_meeting_id ON processing_jobs(meeting_id);

-- Updated_at trigger (reusable)
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER set_updated_at BEFORE UPDATE ON organizations FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER set_updated_at BEFORE UPDATE ON profiles FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER set_updated_at BEFORE UPDATE ON meetings FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER set_updated_at BEFORE UPDATE ON processing_jobs FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
