-- =============================================================================
-- Scriptor — Complete Database Schema (Supabase / PostgreSQL)
-- =============================================================================
-- This is the consolidated schema reference. It reflects the final state after
-- all migrations (002–030) and hotfixes have been applied.
--
-- Extensions required: uuid-ossp, pg_net, pg_cron, pgcrypto, http, vault
-- =============================================================================


-- ─────────────────────────────────────────────────────────────────────────────
-- EXTENSIONS
-- ─────────────────────────────────────────────────────────────────────────────

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
-- pg_net, pg_cron, http, vault — enable via Supabase Dashboard > Database > Extensions


-- ─────────────────────────────────────────────────────────────────────────────
-- HELPER: updated_at trigger function
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;


-- ═════════════════════════════════════════════════════════════════════════════
-- TABLES
-- ═════════════════════════════════════════════════════════════════════════════


-- ─────────────────────────────────────────────────────────────────────────────
-- organizations
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE organizations (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name                        TEXT NOT NULL,
  settings                    JSONB DEFAULT '{}',
  data_retention_days         INTEGER DEFAULT 90,
  azure_tenant_id             TEXT,
  azure_client_id             TEXT,
  authorization_key           TEXT,
  sender_email                TEXT,
  min_meeting_duration_seconds INTEGER DEFAULT 120,
  exclusion_keywords          TEXT[] DEFAULT '{}',
  summaries_enabled           BOOLEAN DEFAULT true,
  emails_enabled              BOOLEAN DEFAULT true,
  emails_enabled_before_off   BOOLEAN DEFAULT true,
  created_at                  TIMESTAMPTZ DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ DEFAULT NOW()
);

CREATE TRIGGER set_updated_at BEFORE UPDATE ON organizations
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();


-- ─────────────────────────────────────────────────────────────────────────────
-- profiles
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE profiles (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  auth_id               UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  org_id                UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  email                 TEXT UNIQUE NOT NULL,
  full_name             TEXT NOT NULL,
  department            TEXT,
  role                  TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('admin', 'user')),
  microsoft_email       TEXT,
  microsoft_user_id     TEXT,
  job_role              TEXT CHECK (job_role IN ('Consultant', 'Designer', 'Developer', 'Project Manager', 'Marketing', 'Other')),
  job_role_custom       TEXT,
  enrolled_at           TIMESTAMPTZ,
  is_active             BOOLEAN DEFAULT true,
  is_locked_out         BOOLEAN DEFAULT false,
  email_enabled         BOOLEAN DEFAULT true,
  summary_enabled       BOOLEAN DEFAULT true,
  consent_given         BOOLEAN DEFAULT false,
  consent_given_at      TIMESTAMPTZ,
  last_agent_heartbeat  TIMESTAMPTZ,
  created_at            TIMESTAMPTZ DEFAULT NOW(),
  updated_at            TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_profiles_org_id            ON profiles (org_id);
CREATE INDEX idx_profiles_email             ON profiles (email);
CREATE INDEX idx_profiles_auth_id           ON profiles (auth_id);
CREATE INDEX idx_profiles_microsoft_email   ON profiles (microsoft_email);
CREATE INDEX idx_profiles_locked_out        ON profiles (id) WHERE is_locked_out = true;
CREATE INDEX idx_profiles_consent           ON profiles (id) WHERE consent_given = true;
CREATE INDEX idx_profiles_org_role_active   ON profiles (org_id, role, is_active);

CREATE TRIGGER set_updated_at BEFORE UPDATE ON profiles
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();


-- ─────────────────────────────────────────────────────────────────────────────
-- meetings
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE meetings (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                   UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  org_id                    UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  start_time                TIMESTAMPTZ NOT NULL,
  end_time                  TIMESTAMPTZ NOT NULL,
  duration_seconds          INTEGER GENERATED ALWAYS AS (EXTRACT(EPOCH FROM end_time - start_time)::INTEGER) STORED,
  detected_app              TEXT NOT NULL DEFAULT 'Unknown',
  detected_category         TEXT CHECK (detected_category IN ('client_conversation', 'consultant_meeting', 'target_company', 'sales_service', 'general')),
  teams_meeting_id          TEXT,
  teams_join_url            TEXT,
  teams_transcript_attempt  INTEGER DEFAULT 0,
  calendar_event_id         TEXT,
  status                    TEXT DEFAULT 'uploaded' CHECK (status IN ('recording', 'uploaded', 'awaiting_teams_transcript', 'processing', 'processed', 'failed')),
  error_message             TEXT,
  title                     TEXT,
  attendees                 JSONB DEFAULT '[]',
  email_sent_at             TIMESTAMPTZ,
  audio_deleted_at          TIMESTAMPTZ,
  created_at                TIMESTAMPTZ DEFAULT NOW(),
  updated_at                TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_meetings_user_id         ON meetings (user_id);
CREATE INDEX idx_meetings_org_id          ON meetings (org_id);
CREATE INDEX idx_meetings_status          ON meetings (status);
CREATE INDEX idx_meetings_created_at      ON meetings (created_at DESC);
CREATE INDEX idx_meetings_org_created     ON meetings (org_id, created_at DESC);
CREATE INDEX idx_meetings_user_created    ON meetings (user_id, created_at DESC);
CREATE INDEX idx_meetings_status_created  ON meetings (status, created_at DESC);
CREATE INDEX idx_meetings_attendees       ON meetings USING GIN (attendees);
CREATE INDEX idx_meetings_title           ON meetings (title);

CREATE TRIGGER set_updated_at BEFORE UPDATE ON meetings
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();


-- ─────────────────────────────────────────────────────────────────────────────
-- transcripts
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE transcripts (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  meeting_id        UUID UNIQUE NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  transcript_json   JSONB NOT NULL,
  source            TEXT NOT NULL DEFAULT 'local' CHECK (source IN ('local', 'teams', 'openai')),
  word_count        INTEGER,
  raw_text          TEXT,
  overridden_at     TIMESTAMPTZ,
  ai_pregenerated   BOOLEAN NOT NULL DEFAULT false,
  transcript_fts    tsvector GENERATED ALWAYS AS (to_tsvector('english', COALESCE(raw_text, ''))) STORED,
  created_at        TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_transcripts_meeting_id      ON transcripts (meeting_id);
CREATE INDEX idx_transcripts_source          ON transcripts (source);
CREATE INDEX idx_transcripts_fts             ON transcripts USING GIN (transcript_fts);
CREATE INDEX idx_transcripts_ai_pregenerated ON transcripts (id) WHERE ai_pregenerated = true;


-- ─────────────────────────────────────────────────────────────────────────────
-- summaries
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE summaries (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  meeting_id      UUID NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  category        TEXT NOT NULL,
  content         TEXT NOT NULL,
  structured_json JSONB,
  is_default      BOOLEAN DEFAULT true,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_summaries_meeting_id       ON summaries (meeting_id);
CREATE INDEX idx_summaries_meeting_default  ON summaries (meeting_id) WHERE is_default = true;
CREATE UNIQUE INDEX uq_summaries_default_per_meeting ON summaries (meeting_id) WHERE is_default = true;


-- ─────────────────────────────────────────────────────────────────────────────
-- tone_alerts
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE tone_alerts (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  meeting_id    UUID NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  org_id        UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  start_time    TEXT NOT NULL,
  speaker       TEXT NOT NULL,
  severity      TEXT NOT NULL CHECK (severity IN ('low', 'medium', 'high')),
  flagged_text  TEXT NOT NULL,
  reason        TEXT,
  is_reviewed   BOOLEAN DEFAULT false,
  reviewed_by   UUID REFERENCES profiles(id),
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_tone_alerts_meeting_id       ON tone_alerts (meeting_id);
CREATE INDEX idx_tone_alerts_org_id           ON tone_alerts (org_id);
CREATE INDEX idx_tone_alerts_severity         ON tone_alerts (severity);
CREATE INDEX idx_tone_alerts_org_created      ON tone_alerts (org_id, created_at DESC);
CREATE INDEX idx_tone_alerts_reviewed_created ON tone_alerts (is_reviewed, created_at DESC);


-- ─────────────────────────────────────────────────────────────────────────────
-- processing_jobs
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE processing_jobs (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  meeting_id        UUID NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  job_type          TEXT NOT NULL CHECK (job_type IN ('category', 'summary', 'tone', 'summary_tone')),
  pg_net_request_id BIGINT,
  status            TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'completed', 'failed')),
  result            JSONB,
  error_message     TEXT,
  attempts          INTEGER DEFAULT 0,
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  updated_at        TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT uq_processing_jobs_meeting_type UNIQUE (meeting_id, job_type)
);

CREATE INDEX idx_processing_jobs_status         ON processing_jobs (status);
CREATE INDEX idx_processing_jobs_request_id     ON processing_jobs (pg_net_request_id);
CREATE INDEX idx_processing_jobs_meeting_id     ON processing_jobs (meeting_id);
CREATE INDEX idx_processing_jobs_pending        ON processing_jobs (job_type, created_at) WHERE status = 'pending';
CREATE INDEX idx_processing_jobs_meeting_status ON processing_jobs (meeting_id, status);

CREATE TRIGGER set_updated_at BEFORE UPDATE ON processing_jobs
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();


-- ─────────────────────────────────────────────────────────────────────────────
-- admin_invites
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE admin_invites (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  code          TEXT NOT NULL UNIQUE,
  created_by    UUID REFERENCES profiles(id) ON DELETE SET NULL,
  expires_at    TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '24 hours'),
  used_at       TIMESTAMPTZ,
  used_by_email TEXT,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_admin_invites_code   ON admin_invites (code);
CREATE INDEX idx_admin_invites_org_id ON admin_invites (org_id);


-- ─────────────────────────────────────────────────────────────────────────────
-- agent_logs
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE agent_logs (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  profile_id  UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  level       TEXT NOT NULL CHECK (level IN ('info', 'warn', 'error')),
  module      TEXT,
  message     TEXT NOT NULL,
  meta        JSONB,
  logged_at   TIMESTAMPTZ NOT NULL,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_agent_logs_profile_id ON agent_logs (profile_id);
CREATE INDEX idx_agent_logs_org_id     ON agent_logs (org_id);
CREATE INDEX idx_agent_logs_logged_at  ON agent_logs (logged_at DESC);
CREATE INDEX idx_agent_logs_level      ON agent_logs (level);


-- ═════════════════════════════════════════════════════════════════════════════
-- ROW LEVEL SECURITY
-- ═════════════════════════════════════════════════════════════════════════════

-- Helper functions for RLS
CREATE OR REPLACE FUNCTION get_my_org_id()
RETURNS UUID AS $$
  SELECT org_id FROM profiles WHERE auth_id = auth.uid() LIMIT 1;
$$ LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public;

CREATE OR REPLACE FUNCTION is_admin()
RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1 FROM profiles
    WHERE auth_id = auth.uid() AND role = 'admin'
  );
$$ LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public;

-- organizations
ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Admins see own org" ON organizations FOR SELECT
  USING (id = get_my_org_id() AND is_admin());

-- profiles
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Admins view org profiles" ON profiles FOR SELECT
  USING (org_id = get_my_org_id() AND is_admin());
CREATE POLICY "Admins insert org profiles" ON profiles FOR INSERT
  WITH CHECK (org_id = get_my_org_id() AND is_admin());
CREATE POLICY "Admins update org profiles" ON profiles FOR UPDATE
  USING (org_id = get_my_org_id() AND is_admin());
CREATE POLICY "Admins delete org profiles" ON profiles FOR DELETE
  USING (org_id = get_my_org_id() AND is_admin());

-- meetings
ALTER TABLE meetings ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Admins view org meetings" ON meetings FOR SELECT
  USING (org_id = get_my_org_id() AND is_admin());

-- transcripts
ALTER TABLE transcripts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Admins view org transcripts" ON transcripts FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM meetings m
      WHERE m.id = transcripts.meeting_id AND m.org_id = get_my_org_id()
    ) AND is_admin()
  );

-- summaries
ALTER TABLE summaries ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Admins view org summaries" ON summaries FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM meetings m
      WHERE m.id = summaries.meeting_id AND m.org_id = get_my_org_id()
    ) AND is_admin()
  );

-- tone_alerts
ALTER TABLE tone_alerts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Admins view org alerts" ON tone_alerts FOR SELECT
  USING (org_id = get_my_org_id() AND is_admin());
CREATE POLICY "Admins review org alerts" ON tone_alerts FOR UPDATE
  USING (org_id = get_my_org_id() AND is_admin());

-- processing_jobs
ALTER TABLE processing_jobs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Admins view org jobs" ON processing_jobs FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM meetings m
      WHERE m.id = processing_jobs.meeting_id AND m.org_id = get_my_org_id()
    ) AND is_admin()
  );
CREATE POLICY "Service role inserts jobs" ON processing_jobs FOR INSERT
  WITH CHECK (true);

-- agent_logs
ALTER TABLE agent_logs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Service role inserts logs" ON agent_logs FOR INSERT
  WITH CHECK (true);
CREATE POLICY "Admins read org logs" ON agent_logs FOR SELECT
  USING (org_id = get_my_org_id() AND is_admin());


-- ═════════════════════════════════════════════════════════════════════════════
-- FUNCTIONS
-- ═════════════════════════════════════════════════════════════════════════════


-- ─────────────────────────────────────────────────────────────────────────────
-- Vault secret helpers
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION get_openai_key()
RETURNS TEXT AS $$
  SELECT decrypted_secret FROM vault.decrypted_secrets
  WHERE name = 'openai_api_key' LIMIT 1;
$$ LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public;

CREATE OR REPLACE FUNCTION get_vault_secret(p_name TEXT)
RETURNS TEXT AS $$
  SELECT decrypted_secret FROM vault.decrypted_secrets
  WHERE name = p_name LIMIT 1;
$$ LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public;

CREATE OR REPLACE FUNCTION get_vault_secret_rpc(p_secret_name TEXT)
RETURNS TEXT AS $$
  SELECT decrypted_secret FROM vault.decrypted_secrets
  WHERE name = p_secret_name LIMIT 1;
$$ LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public;

CREATE OR REPLACE FUNCTION get_resend_key()
RETURNS TEXT AS $$
  SELECT decrypted_secret FROM vault.decrypted_secrets
  WHERE name = 'resend_api_key' LIMIT 1;
$$ LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public;


-- ─────────────────────────────────────────────────────────────────────────────
-- Onboarding & auth
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION validate_authorization_key(p_key TEXT)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_org RECORD;
BEGIN
  SELECT id, name INTO v_org FROM organizations WHERE authorization_key = p_key LIMIT 1;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('valid', false);
  END IF;
  RETURN jsonb_build_object('valid', true, 'org_id', v_org.id, 'org_name', v_org.name);
END;
$$;

CREATE OR REPLACE FUNCTION enroll_user(
  p_org_id UUID,
  p_email TEXT,
  p_first_name TEXT DEFAULT NULL,
  p_last_name TEXT DEFAULT NULL,
  p_job_role TEXT DEFAULT NULL,
  p_job_role_custom TEXT DEFAULT NULL,
  p_consent_given BOOLEAN DEFAULT false,
  p_microsoft_email TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_profile RECORD;
BEGIN
  SELECT * INTO v_profile FROM profiles WHERE email = p_email AND org_id = p_org_id LIMIT 1;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'User not found in this organization');
  END IF;
  IF v_profile.is_locked_out THEN
    RETURN jsonb_build_object('success', false, 'error', 'Account is locked');
  END IF;

  UPDATE profiles SET
    full_name = COALESCE(NULLIF(TRIM(COALESCE(p_first_name, '') || ' ' || COALESCE(p_last_name, '')), ''), full_name),
    job_role = COALESCE(p_job_role, job_role),
    job_role_custom = COALESCE(p_job_role_custom, job_role_custom),
    consent_given = COALESCE(p_consent_given, consent_given),
    consent_given_at = CASE WHEN p_consent_given AND NOT v_profile.consent_given THEN NOW() ELSE consent_given_at END,
    microsoft_email = COALESCE(p_microsoft_email, microsoft_email),
    enrolled_at = COALESCE(enrolled_at, NOW()),
    updated_at = NOW()
  WHERE id = v_profile.id;

  RETURN jsonb_build_object('success', true, 'profile_id', v_profile.id);
END;
$$;

CREATE OR REPLACE FUNCTION check_user_status(p_profile_id UUID)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_profile RECORD;
  v_org RECORD;
BEGIN
  SELECT p.*, o.summaries_enabled AS org_summaries, o.emails_enabled AS org_emails,
         o.min_meeting_duration_seconds, o.exclusion_keywords
  INTO v_profile
  FROM profiles p JOIN organizations o ON p.org_id = o.id
  WHERE p.id = p_profile_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('active', false, 'locked_out', true);
  END IF;

  RETURN jsonb_build_object(
    'active', v_profile.is_active,
    'locked_out', v_profile.is_locked_out,
    'consent_given', v_profile.consent_given,
    'org_summaries_enabled', v_profile.org_summaries,
    'org_emails_enabled', v_profile.org_emails,
    'min_meeting_duration_seconds', v_profile.min_meeting_duration_seconds,
    'exclusion_keywords', v_profile.exclusion_keywords
  );
END;
$$;


-- ─────────────────────────────────────────────────────────────────────────────
-- Admin management
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION create_admin_user(
  p_email TEXT,
  p_password TEXT,
  p_full_name TEXT,
  p_org_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_user_id UUID;
  v_profile_id UUID;
BEGIN
  v_user_id := gen_random_uuid();
  INSERT INTO auth.users (id, email, encrypted_password, email_confirmed_at, role, aud, instance_id)
  VALUES (v_user_id, p_email, crypt(p_password, gen_salt('bf')), NOW(), 'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000');

  INSERT INTO profiles (auth_id, org_id, email, full_name, role)
  VALUES (v_user_id, p_org_id, p_email, p_full_name, 'admin')
  RETURNING id INTO v_profile_id;

  RETURN jsonb_build_object('success', true, 'user_id', v_user_id, 'profile_id', v_profile_id);
END;
$$;

CREATE OR REPLACE FUNCTION generate_admin_invite(p_org_id UUID, p_created_by UUID)
RETURNS TEXT
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_code TEXT;
BEGIN
  v_code := upper(substr(md5(random()::text || clock_timestamp()::text), 1, 12));
  INSERT INTO admin_invites (org_id, code, created_by)
  VALUES (p_org_id, v_code, p_created_by);
  RETURN v_code;
END;
$$;

CREATE OR REPLACE FUNCTION redeem_admin_invite(p_code TEXT, p_email TEXT, p_password TEXT, p_full_name TEXT)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_invite RECORD;
  v_result JSONB;
BEGIN
  SELECT * INTO v_invite FROM admin_invites
  WHERE code = p_code AND used_at IS NULL AND expires_at > NOW() LIMIT 1;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Invalid or expired invite code');
  END IF;

  v_result := create_admin_user(p_email, p_password, p_full_name, v_invite.org_id);

  UPDATE admin_invites SET used_at = NOW(), used_by_email = p_email WHERE id = v_invite.id;

  RETURN v_result;
END;
$$;

CREATE OR REPLACE FUNCTION check_admin_invite_code(p_code TEXT)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_invite RECORD;
BEGIN
  SELECT ai.*, o.name AS org_name INTO v_invite
  FROM admin_invites ai JOIN organizations o ON ai.org_id = o.id
  WHERE ai.code = p_code AND ai.used_at IS NULL AND ai.expires_at > NOW() LIMIT 1;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('valid', false);
  END IF;
  RETURN jsonb_build_object('valid', true, 'org_name', v_invite.org_name);
END;
$$;

CREATE OR REPLACE FUNCTION delete_admin_user(p_admin_id UUID, p_requester_id UUID)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_target RECORD;
  v_requester RECORD;
  v_admin_count INTEGER;
BEGIN
  SELECT * INTO v_requester FROM profiles WHERE id = p_requester_id AND role = 'admin';
  IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'error', 'Unauthorized'); END IF;

  SELECT * INTO v_target FROM profiles WHERE id = p_admin_id AND role = 'admin' AND org_id = v_requester.org_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'error', 'Admin not found'); END IF;

  IF p_admin_id = p_requester_id THEN
    RETURN jsonb_build_object('success', false, 'error', 'Cannot delete yourself');
  END IF;

  SELECT COUNT(*) INTO v_admin_count FROM profiles WHERE org_id = v_target.org_id AND role = 'admin';
  IF v_admin_count <= 1 THEN
    RETURN jsonb_build_object('success', false, 'error', 'Cannot delete the last admin');
  END IF;

  IF v_target.auth_id IS NOT NULL THEN
    DELETE FROM auth.users WHERE id = v_target.auth_id;
  END IF;
  DELETE FROM profiles WHERE id = p_admin_id;

  RETURN jsonb_build_object('success', true);
END;
$$;


-- ─────────────────────────────────────────────────────────────────────────────
-- AI processing pipeline
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION clean_json_response(raw TEXT)
RETURNS TEXT
LANGUAGE plpgsql IMMUTABLE SET search_path = public AS $$
BEGIN
  raw := TRIM(raw);
  raw := regexp_replace(raw, '^```json\s*', '');
  raw := regexp_replace(raw, '\s*```$', '');
  RETURN TRIM(raw);
END;
$$;

CREATE OR REPLACE FUNCTION call_openai(
  p_meeting_id UUID,
  p_job_type TEXT,
  p_system_prompt TEXT,
  p_user_content TEXT
)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_api_key TEXT;
  v_request_id BIGINT;
BEGIN
  v_api_key := get_openai_key();
  IF v_api_key IS NULL THEN RAISE EXCEPTION 'OpenAI API key not found in vault'; END IF;

  SELECT net.http_post(
    url := 'https://api.openai.com/v1/chat/completions',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || v_api_key
    ),
    body := jsonb_build_object(
      'model', 'gpt-4o',
      'temperature', 0.3,
      'max_tokens', 2000,
      'messages', jsonb_build_array(
        jsonb_build_object('role', 'system', 'content', p_system_prompt),
        jsonb_build_object('role', 'user', 'content', p_user_content)
      )
    )
  ) INTO v_request_id;

  INSERT INTO processing_jobs (meeting_id, job_type, pg_net_request_id, status)
  VALUES (p_meeting_id, p_job_type, v_request_id, 'pending')
  ON CONFLICT (meeting_id, job_type) DO UPDATE SET
    pg_net_request_id = v_request_id,
    status = 'pending',
    attempts = processing_jobs.attempts + 1,
    error_message = NULL,
    updated_at = NOW();
END;
$$;

-- Synchronous OpenAI call via http extension (used by process_pending_jobs)
CREATE OR REPLACE FUNCTION call_openai_sync(
  p_system_prompt TEXT,
  p_user_content TEXT
)
RETURNS TEXT
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_api_key TEXT;
  v_response http_response;
  v_body JSONB;
BEGIN
  v_api_key := get_openai_key();
  IF v_api_key IS NULL THEN RAISE EXCEPTION 'OpenAI key not found'; END IF;

  SELECT * INTO v_response FROM http((
    'POST',
    'https://api.openai.com/v1/chat/completions',
    ARRAY[http_header('Authorization', 'Bearer ' || v_api_key)],
    'application/json',
    jsonb_build_object(
      'model', 'gpt-4o',
      'temperature', 0.3,
      'max_tokens', 2000,
      'messages', jsonb_build_array(
        jsonb_build_object('role', 'system', 'content', p_system_prompt),
        jsonb_build_object('role', 'user', 'content', p_user_content)
      )
    )::text
  )::http_request);

  v_body := v_response.content::jsonb;
  RETURN v_body->'choices'->0->'message'->>'content';
END;
$$;


-- ─────────────────────────────────────────────────────────────────────────────
-- Transcript trigger → AI pipeline
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION on_transcript_upserted()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_raw TEXT;
  v_word_count INTEGER;
BEGIN
  -- Skip if AI already pre-generated by client agent
  IF NEW.ai_pregenerated = true THEN
    UPDATE meetings SET status = 'processed' WHERE id = NEW.meeting_id AND status IN ('uploaded', 'processing');
    RETURN NEW;
  END IF;

  -- Skip if transcript unchanged (update case)
  IF TG_OP = 'UPDATE' AND OLD.transcript_json::text = NEW.transcript_json::text THEN
    RETURN NEW;
  END IF;

  -- Build raw text and count words
  v_raw := array_to_string(
    ARRAY(SELECT elem->>'text' FROM jsonb_array_elements(NEW.transcript_json) AS elem WHERE elem->>'text' IS NOT NULL),
    ' '
  );
  v_word_count := array_length(string_to_array(TRIM(v_raw), ' '), 1);

  UPDATE transcripts SET raw_text = v_raw, word_count = v_word_count WHERE id = NEW.id;

  -- Guard: skip if too short
  IF COALESCE(v_word_count, 0) < 50 THEN
    UPDATE meetings SET status = 'processed', error_message = 'Transcript too short for AI processing'
    WHERE id = NEW.meeting_id;
    RETURN NEW;
  END IF;

  -- Queue category detection via OpenAI
  UPDATE meetings SET status = 'processing' WHERE id = NEW.meeting_id;

  PERFORM call_openai(
    NEW.meeting_id,
    'category',
    'You are a meeting classifier. Classify this transcript into exactly one category: client_conversation, consultant_meeting, target_company, sales_service, or general. Reply with ONLY the category name.',
    LEFT(v_raw, 3000)
  );

  RETURN NEW;
END;
$$;

CREATE TRIGGER trigger_transcript_inserted
  AFTER INSERT ON transcripts
  FOR EACH ROW EXECUTE FUNCTION on_transcript_upserted();

CREATE TRIGGER trigger_transcript_updated
  AFTER UPDATE OF transcript_json ON transcripts
  FOR EACH ROW EXECUTE FUNCTION on_transcript_upserted();


-- ─────────────────────────────────────────────────────────────────────────────
-- Cron: process pending jobs (poll pg_net responses, generate summaries+tone)
-- ─────────────────────────────────────────────────────────────────────────────

-- process_pending_jobs() is a large function that:
--   1. Polls pg_net responses for completed category jobs
--   2. On category success: stores category, calls OpenAI sync for summary+tone
--   3. Parses summary JSON, inserts into summaries table
--   4. Parses tone alerts JSON, inserts into tone_alerts table
--   5. Marks meeting as 'processed', sends email if enabled
--   6. Handles failures with retry backoff (max 3 attempts)
-- Runs every minute via pg_cron.


-- ─────────────────────────────────────────────────────────────────────────────
-- Email helpers
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION md_to_email_html(p_md TEXT)
RETURNS TEXT
LANGUAGE plpgsql IMMUTABLE SET search_path = public AS $$
DECLARE
  v_html TEXT := '';
  v_line TEXT;
  v_in_list BOOLEAN := false;
  v_trimmed TEXT;
BEGIN
  FOR v_line IN SELECT unnest(string_to_array(p_md, E'\n')) LOOP
    v_trimmed := TRIM(v_line);
    -- Handle headers
    IF v_trimmed LIKE '### %' THEN
      IF v_in_list THEN v_html := v_html || '</ul>'; v_in_list := false; END IF;
      v_html := v_html || '<h3 style="font-size:14px;font-weight:600;margin:16px 0 8px;color:#1F2937;">' || substr(v_trimmed, 5) || '</h3>';
    ELSIF v_trimmed LIKE '## %' THEN
      IF v_in_list THEN v_html := v_html || '</ul>'; v_in_list := false; END IF;
      v_html := v_html || '<h2 style="font-size:16px;font-weight:600;margin:16px 0 8px;color:#1F2937;">' || substr(v_trimmed, 4) || '</h2>';
    ELSIF v_trimmed LIKE '# %' THEN
      IF v_in_list THEN v_html := v_html || '</ul>'; v_in_list := false; END IF;
      v_html := v_html || '<h1 style="font-size:18px;font-weight:700;margin:16px 0 8px;color:#1F2937;">' || substr(v_trimmed, 3) || '</h1>';
    -- Handle list items
    ELSIF v_trimmed LIKE '- %' OR v_trimmed LIKE '* %' THEN
      IF NOT v_in_list THEN v_html := v_html || '<ul style="margin:8px 0;padding-left:20px;">'; v_in_list := true; END IF;
      v_html := v_html || '<li style="margin:4px 0;color:#374151;">' || substr(v_trimmed, 3) || '</li>';
    -- Handle bold
    ELSIF v_trimmed LIKE '**%' THEN
      IF v_in_list THEN v_html := v_html || '</ul>'; v_in_list := false; END IF;
      v_html := v_html || '<p style="margin:8px 0;color:#374151;"><strong>' || replace(replace(v_trimmed, '**', ''), ':', ':') || '</strong></p>';
    -- Empty line
    ELSIF v_trimmed = '' THEN
      IF v_in_list THEN v_html := v_html || '</ul>'; v_in_list := false; END IF;
    -- Regular paragraph
    ELSE
      IF v_in_list THEN v_html := v_html || '</ul>'; v_in_list := false; END IF;
      v_html := v_html || '<p style="margin:8px 0;color:#374151;">' || v_trimmed || '</p>';
    END IF;
  END LOOP;
  IF v_in_list THEN v_html := v_html || '</ul>'; END IF;
  RETURN v_html;
END;
$$;

-- send_summary_email() sends meeting summary via Microsoft Graph API
-- Uses vault secrets: graph_client_id, graph_client_secret, graph_tenant_id
-- Looks up org sender_email, builds styled HTML, sends via Graph /sendMail

-- send_manual_email(p_meeting_id UUID) — admin RPC to resend a summary email


-- ─────────────────────────────────────────────────────────────────────────────
-- Full-text search
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION search_meetings(
  p_org_id UUID,
  p_query TEXT,
  p_limit INTEGER DEFAULT 50
)
RETURNS TABLE (
  meeting_id UUID,
  start_time TIMESTAMPTZ,
  detected_app TEXT,
  detected_category TEXT,
  user_name TEXT,
  title TEXT,
  rank REAL
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  RETURN QUERY
  SELECT m.id, m.start_time, m.detected_app, m.detected_category, p.full_name, m.title,
         ts_rank(t.transcript_fts, websearch_to_tsquery('english', p_query)) AS rank
  FROM meetings m
  JOIN transcripts t ON t.meeting_id = m.id
  JOIN profiles p ON p.id = m.user_id
  WHERE m.org_id = p_org_id
    AND t.transcript_fts @@ websearch_to_tsquery('english', p_query)
  ORDER BY rank DESC
  LIMIT p_limit;
END;
$$;


-- ─────────────────────────────────────────────────────────────────────────────
-- Data cleanup cron jobs
-- ─────────────────────────────────────────────────────────────────────────────

-- cleanup_old_data(): runs daily at 3 AM UTC
--   Deletes meetings older than org.data_retention_days
--   Purges completed/failed processing_jobs older than 7 days

-- cleanup_processed_audio(): runs daily
--   Sets audio_deleted_at on meetings older than 24 hours (signals agent to delete local audio)

-- cleanup_agent_logs: runs every 30 min
--   Deletes agent_logs older than 2 days


-- ═════════════════════════════════════════════════════════════════════════════
-- CRON SCHEDULE
-- ═════════════════════════════════════════════════════════════════════════════

-- SELECT cron.schedule('process-pending-jobs', '* * * * *', $$SELECT process_pending_jobs()$$);
-- SELECT cron.schedule('cleanup-old-data', '0 3 * * *', $$SELECT cleanup_old_data()$$);
-- SELECT cron.schedule('cleanup-agent-logs', '*/30 * * * *', $$DELETE FROM agent_logs WHERE created_at < NOW() - INTERVAL '2 days'$$);


-- ═════════════════════════════════════════════════════════════════════════════
-- SEED DATA (example — customize before running)
-- ═════════════════════════════════════════════════════════════════════════════

-- INSERT INTO organizations (id, name, azure_tenant_id, azure_client_id)
-- VALUES ('a0000000-0000-0000-0000-000000000001', 'Scriptor', '<tenant-id>', '<client-id>');
--
-- INSERT INTO profiles (id, auth_id, org_id, email, full_name, role)
-- VALUES ('b0000000-0000-0000-0000-000000000001', '<auth-user-uuid>', 'a0000000-0000-0000-0000-000000000001', 'admin@example.com', 'Admin Name', 'admin');


-- ═════════════════════════════════════════════════════════════════════════════
-- VAULT SECRETS (run manually in SQL Editor)
-- ═════════════════════════════════════════════════════════════════════════════

-- SELECT vault.create_secret('sk-proj-XXXX', 'openai_api_key');
-- SELECT vault.create_secret('re_XXXX', 'resend_api_key');          -- if using Resend
-- SELECT vault.create_secret('<client-id>', 'graph_client_id');      -- if using Graph email
-- SELECT vault.create_secret('<client-secret>', 'graph_client_secret');
-- SELECT vault.create_secret('<tenant-id>', 'graph_tenant_id');
