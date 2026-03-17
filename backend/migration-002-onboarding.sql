-- file: backend/migration-002-onboarding.sql
-- MeetChamp - Onboarding & Authorization Key Migration
-- Run this in Supabase SQL Editor

-- 1. Add authorization_key to organizations
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS authorization_key TEXT;

-- 2. Add onboarding fields to profiles
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS job_role TEXT;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS job_role_custom TEXT;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS enrolled_at TIMESTAMPTZ;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS is_locked_out BOOLEAN DEFAULT false;

-- 3. Add check constraint for job_role values
ALTER TABLE profiles ADD CONSTRAINT chk_job_role
  CHECK (job_role IS NULL OR job_role IN ('Consultant', 'Designer', 'Developer', 'Project Manager', 'Marketing', 'Other'));

-- 4. Index for lock-out checks (agent heartbeat queries this)
CREATE INDEX IF NOT EXISTS idx_profiles_locked_out ON profiles(is_locked_out) WHERE is_locked_out = true;

-- 5. RPC: validate_authorization_key
--    Called by client-agent during setup step 1.
--    Returns org_id + org_name if key matches, null otherwise.
CREATE OR REPLACE FUNCTION validate_authorization_key(p_key TEXT)
RETURNS TABLE(org_id UUID, org_name TEXT) AS $$
BEGIN
  RETURN QUERY
    SELECT o.id, o.name
    FROM organizations o
    WHERE o.authorization_key = p_key
    LIMIT 1;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 6. RPC: enroll_user
--    Called by client-agent after MS login + profile form.
--    Matches by microsoft_email (pre-configured by admin).
--    Updates the profile with user-provided details and marks enrolled.
CREATE OR REPLACE FUNCTION enroll_user(
  p_microsoft_email TEXT,
  p_org_id UUID,
  p_first_name TEXT,
  p_last_name TEXT,
  p_job_role TEXT,
  p_job_role_custom TEXT DEFAULT NULL,
  p_microsoft_user_id TEXT DEFAULT NULL
)
RETURNS TABLE(profile_id UUID, full_name TEXT) AS $$
DECLARE
  v_profile profiles%ROWTYPE;
BEGIN
  -- Find the pre-configured profile by microsoft_email + org
  SELECT * INTO v_profile
  FROM profiles
  WHERE profiles.microsoft_email = p_microsoft_email
    AND profiles.org_id = p_org_id
    AND profiles.role = 'user'
  LIMIT 1;

  IF v_profile.id IS NULL THEN
    RAISE EXCEPTION 'No matching user profile found for email % in this organization', p_microsoft_email;
  END IF;

  IF v_profile.is_locked_out THEN
    RAISE EXCEPTION 'This account has been locked out. Contact your administrator.';
  END IF;

  IF NOT v_profile.is_active THEN
    RAISE EXCEPTION 'This account has been deactivated. Contact your administrator.';
  END IF;

  -- Update profile with user-provided info
  UPDATE profiles SET
    full_name = p_first_name || ' ' || p_last_name,
    job_role = p_job_role,
    job_role_custom = CASE WHEN p_job_role = 'Other' THEN p_job_role_custom ELSE NULL END,
    microsoft_user_id = COALESCE(p_microsoft_user_id, profiles.microsoft_user_id),
    enrolled_at = COALESCE(profiles.enrolled_at, NOW()),
    is_locked_out = false,
    updated_at = NOW()
  WHERE profiles.id = v_profile.id;

  RETURN QUERY SELECT v_profile.id, (p_first_name || ' ' || p_last_name)::TEXT;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 7. RPC: check_user_status
--    Called by agent on heartbeat to verify user is still active & not locked out.
CREATE OR REPLACE FUNCTION check_user_status(p_profile_id UUID)
RETURNS TABLE(is_active BOOLEAN, is_locked_out BOOLEAN) AS $$
BEGIN
  RETURN QUERY
    SELECT profiles.is_active, profiles.is_locked_out
    FROM profiles
    WHERE profiles.id = p_profile_id
    LIMIT 1;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
