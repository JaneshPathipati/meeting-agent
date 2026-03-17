-- migration-016-admin-invites.sql
-- Implements admin invite code system.
-- Existing admins generate a one-time code; new admins use it to self-register.
-- Run this in Supabase SQL Editor.

-- 1. Invite codes table
CREATE TABLE IF NOT EXISTS admin_invites (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  code TEXT NOT NULL UNIQUE,
  created_by UUID REFERENCES profiles(id) ON DELETE SET NULL,
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '24 hours'),
  used_at TIMESTAMPTZ,
  used_by_email TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_admin_invites_code ON admin_invites(code);
CREATE INDEX IF NOT EXISTS idx_admin_invites_org_id ON admin_invites(org_id);

-- 2. generate_admin_invite() — called by existing admin to produce a code
CREATE OR REPLACE FUNCTION generate_admin_invite()
RETURNS JSONB AS $$
DECLARE
  v_org_id UUID;
  v_profile_id UUID;
  v_code TEXT;
  v_expires_at TIMESTAMPTZ;
  v_chars TEXT := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  v_raw TEXT := '';
  i INTEGER;
BEGIN
  IF NOT is_admin() THEN
    RAISE EXCEPTION 'Only admins can generate invite codes';
  END IF;

  v_org_id := get_my_org_id();
  SELECT id INTO v_profile_id FROM profiles WHERE auth_id = auth.uid();

  -- Expire any previous unused invites for this org to keep things tidy
  UPDATE admin_invites
  SET expires_at = NOW()
  WHERE org_id = v_org_id
    AND used_at IS NULL
    AND expires_at > NOW();

  -- Generate a 12-char code: XXXX-XXXX-XXXX
  FOR i IN 1..12 LOOP
    v_raw := v_raw || substr(v_chars, floor(random() * length(v_chars) + 1)::int, 1);
  END LOOP;
  v_code := substr(v_raw, 1, 4) || '-' || substr(v_raw, 5, 4) || '-' || substr(v_raw, 9, 4);

  v_expires_at := NOW() + INTERVAL '24 hours';

  INSERT INTO admin_invites (org_id, code, created_by, expires_at)
  VALUES (v_org_id, v_code, v_profile_id, v_expires_at);

  RETURN jsonb_build_object(
    'code', v_code,
    'expires_at', v_expires_at
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
   SET search_path = public, auth;

GRANT EXECUTE ON FUNCTION generate_admin_invite() TO authenticated;


-- 3. redeem_admin_invite() — called by unauthenticated new admin on the login page
--    Validates the invite code, creates auth user + profile, marks invite used.
CREATE OR REPLACE FUNCTION redeem_admin_invite(
  p_code TEXT,
  p_email TEXT,
  p_password TEXT,
  p_full_name TEXT
)
RETURNS JSONB AS $$
DECLARE
  v_invite admin_invites%ROWTYPE;
  v_user_id UUID;
  v_profile_id UUID;
  v_encrypted_pw TEXT;
BEGIN
  -- Validate inputs
  IF p_email IS NULL OR length(trim(p_email)) < 5 THEN
    RAISE EXCEPTION 'Invalid email address';
  END IF;
  IF p_password IS NULL OR length(p_password) < 8 THEN
    RAISE EXCEPTION 'Password must be at least 8 characters';
  END IF;
  IF p_full_name IS NULL OR length(trim(p_full_name)) < 2 THEN
    RAISE EXCEPTION 'Full name is required';
  END IF;

  -- Validate invite code (FOR UPDATE prevents concurrent redemptions of the same code)
  SELECT * INTO v_invite
  FROM admin_invites
  WHERE code = upper(trim(p_code))
    AND used_at IS NULL
    AND expires_at > NOW()
  FOR UPDATE;

  IF v_invite.id IS NULL THEN
    RAISE EXCEPTION 'Invalid or expired invite code';
  END IF;

  -- Check email not already taken
  IF EXISTS (SELECT 1 FROM auth.users WHERE email = lower(trim(p_email))) THEN
    RAISE EXCEPTION 'An account with this email already exists';
  END IF;

  IF EXISTS (SELECT 1 FROM profiles WHERE email = lower(trim(p_email))) THEN
    RAISE EXCEPTION 'A profile with this email already exists';
  END IF;

  v_user_id := gen_random_uuid();
  v_encrypted_pw := crypt(p_password, gen_salt('bf'));

  -- Create auth user
  INSERT INTO auth.users (
    instance_id, id, aud, role, email, encrypted_password,
    email_confirmed_at, confirmation_sent_at,
    raw_app_meta_data, raw_user_meta_data,
    created_at, updated_at
  ) VALUES (
    '00000000-0000-0000-0000-000000000000',
    v_user_id, 'authenticated', 'authenticated',
    lower(trim(p_email)), v_encrypted_pw,
    NOW(), NOW(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    jsonb_build_object('full_name', trim(p_full_name)),
    NOW(), NOW()
  );

  -- Create identity (required for email/password login)
  INSERT INTO auth.identities (
    id, user_id, identity_data, provider, provider_id,
    last_sign_in_at, created_at, updated_at
  ) VALUES (
    gen_random_uuid(), v_user_id,
    jsonb_build_object('sub', v_user_id::text, 'email', lower(trim(p_email))),
    'email', v_user_id::text,
    NOW(), NOW(), NOW()
  );

  -- Create admin profile in same org as invite
  INSERT INTO profiles (id, org_id, email, full_name, role, auth_id)
  VALUES (gen_random_uuid(), v_invite.org_id, lower(trim(p_email)), trim(p_full_name), 'admin', v_user_id)
  RETURNING id INTO v_profile_id;

  -- Mark invite as used
  UPDATE admin_invites
  SET used_at = NOW(), used_by_email = lower(trim(p_email))
  WHERE id = v_invite.id;

  RETURN jsonb_build_object(
    'success', true,
    'email', lower(trim(p_email)),
    'full_name', trim(p_full_name)
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
   SET search_path = public, auth, extensions;

-- Allow unauthenticated (anon) users to call this via RPC on the login page
GRANT EXECUTE ON FUNCTION redeem_admin_invite(TEXT, TEXT, TEXT, TEXT) TO anon;
GRANT EXECUTE ON FUNCTION redeem_admin_invite(TEXT, TEXT, TEXT, TEXT) TO authenticated;
