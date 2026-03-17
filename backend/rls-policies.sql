-- file: backend/rls-policies.sql
-- MeetChamp - Row Level Security Policies
-- Run this AFTER schema.sql in Supabase SQL Editor

ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE meetings ENABLE ROW LEVEL SECURITY;
ALTER TABLE transcripts ENABLE ROW LEVEL SECURITY;
ALTER TABLE summaries ENABLE ROW LEVEL SECURITY;
ALTER TABLE tone_alerts ENABLE ROW LEVEL SECURITY;
ALTER TABLE processing_jobs ENABLE ROW LEVEL SECURITY;

-- Helper: get current admin's org_id
CREATE OR REPLACE FUNCTION get_my_org_id()
RETURNS UUID AS $$
  SELECT p.org_id FROM profiles p WHERE p.auth_id = auth.uid();
$$ LANGUAGE sql SECURITY DEFINER STABLE;

-- Helper: check if current user is admin
CREATE OR REPLACE FUNCTION is_admin()
RETURNS BOOLEAN AS $$
  SELECT p.role = 'admin' FROM profiles p WHERE p.auth_id = auth.uid();
$$ LANGUAGE sql SECURITY DEFINER STABLE;

-- NOTE: All read policies are ADMIN-ONLY. Employees have NO Supabase Auth accounts.
-- Agent writes use service role key which bypasses RLS entirely.

-- Organizations: admins see own org
CREATE POLICY "Admins see own org" ON organizations FOR SELECT
  USING (id = get_my_org_id());

CREATE POLICY "Admins update own org" ON organizations FOR UPDATE
  USING (id = get_my_org_id() AND is_admin());

-- Profiles: admins see all in their org
CREATE POLICY "Admins view profiles" ON profiles FOR SELECT
  USING (org_id = get_my_org_id() AND is_admin());

CREATE POLICY "Admins insert profiles" ON profiles FOR INSERT
  WITH CHECK (org_id = get_my_org_id() AND is_admin());

CREATE POLICY "Admins update profiles" ON profiles FOR UPDATE
  USING (org_id = get_my_org_id() AND is_admin());

CREATE POLICY "Admins delete profiles" ON profiles FOR DELETE
  USING (org_id = get_my_org_id() AND is_admin());

-- Meetings: admins see all in their org
CREATE POLICY "Admins view meetings" ON meetings FOR SELECT
  USING (org_id = get_my_org_id() AND is_admin());

-- Transcripts: admins see all in their org
CREATE POLICY "Admins view transcripts" ON transcripts FOR SELECT
  USING (meeting_id IN (SELECT id FROM meetings WHERE org_id = get_my_org_id()) AND is_admin());

-- Summaries: admins see all in their org
CREATE POLICY "Admins view summaries" ON summaries FOR SELECT
  USING (meeting_id IN (SELECT id FROM meetings WHERE org_id = get_my_org_id()) AND is_admin());

-- Tone alerts: admins see all in their org
CREATE POLICY "Admins view alerts" ON tone_alerts FOR SELECT
  USING (org_id = get_my_org_id() AND is_admin());

CREATE POLICY "Admins update alerts" ON tone_alerts FOR UPDATE
  USING (org_id = get_my_org_id() AND is_admin());

-- Processing jobs: admin read, service role write
CREATE POLICY "Admins view jobs" ON processing_jobs FOR SELECT
  USING (meeting_id IN (SELECT id FROM meetings WHERE org_id = get_my_org_id()) AND is_admin());
