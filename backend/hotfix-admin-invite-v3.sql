-- hotfix-admin-invite-v3.sql
-- Root cause of "Database error querying schema":
--   GoTrue's Go User struct uses `string` (not `*string`) for token fields.
--   When PostgreSQL returns NULL for confirmation_token / recovery_token /
--   email_change / email_change_token_new, the Go SQL scanner throws a
--   "converting NULL to string is unsupported" error, wrapped as
--   "Database error querying schema".
-- Fix: set all token fields to '' (empty string) in the INSERT, matching what
--   GoTrue sets when it creates users via the Admin API.

-- ── Repair existing broken test user in-place ────────────────────────────────
UPDATE auth.users
SET
  confirmation_token    = COALESCE(confirmation_token, ''),
  recovery_token        = COALESCE(recovery_token, ''),
  email_change          = COALESCE(email_change, ''),
  email_change_token_new = COALESCE(email_change_token_new, '')
WHERE email = 'eng22am0125@dsu.ediu.in';


-- ── Fix the function for all future signups ──────────────────────────────────
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
  IF p_email IS NULL OR length(trim(p_email)) < 5 THEN
    RAISE EXCEPTION 'Invalid email address';
  END IF;
  IF p_password IS NULL OR length(p_password) < 8 THEN
    RAISE EXCEPTION 'Password must be at least 8 characters';
  END IF;
  IF p_full_name IS NULL OR length(trim(p_full_name)) < 2 THEN
    RAISE EXCEPTION 'Full name is required';
  END IF;

  -- Validate invite code (strip dashes on both sides)
  SELECT * INTO v_invite
  FROM admin_invites
  WHERE replace(code, '-', '') = upper(replace(trim(p_code), '-', ''))
    AND used_at IS NULL
    AND expires_at > NOW();

  IF v_invite.id IS NULL THEN
    RAISE EXCEPTION 'Invalid or expired invite code';
  END IF;

  IF EXISTS (SELECT 1 FROM auth.users WHERE email = lower(trim(p_email))) THEN
    RAISE EXCEPTION 'An account with this email already exists';
  END IF;

  IF EXISTS (SELECT 1 FROM profiles WHERE email = lower(trim(p_email))) THEN
    RAISE EXCEPTION 'A profile with this email already exists';
  END IF;

  v_user_id := gen_random_uuid();
  -- cost=10 matches GoTrue's default
  v_encrypted_pw := crypt(p_password, gen_salt('bf', 10));

  -- Insert auth user with ALL token fields as empty strings (not NULL).
  -- GoTrue scans these into Go `string` fields (not `*string`), so NULL causes
  -- "converting NULL to string is unsupported" → "Database error querying schema".
  INSERT INTO auth.users (
    instance_id, id, aud, role, email, encrypted_password,
    email_confirmed_at, confirmation_sent_at,
    raw_app_meta_data, raw_user_meta_data,
    is_sso_user, is_anonymous,
    -- Token fields must be '' not NULL (GoTrue Go struct uses string, not *string)
    confirmation_token, recovery_token,
    email_change, email_change_token_new,
    created_at, updated_at
  ) VALUES (
    '00000000-0000-0000-0000-000000000000',
    v_user_id, 'authenticated', 'authenticated',
    lower(trim(p_email)), v_encrypted_pw,
    NOW(), NOW(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    jsonb_build_object('full_name', trim(p_full_name)),
    false, false,
    '', '',
    '', '',
    NOW(), NOW()
  );

  -- Identity: provider_id = email (required by newer GoTrue for email/password auth)
  INSERT INTO auth.identities (
    id, user_id, identity_data, provider, provider_id,
    last_sign_in_at, created_at, updated_at
  ) VALUES (
    gen_random_uuid(), v_user_id,
    jsonb_build_object('sub', v_user_id::text, 'email', lower(trim(p_email))),
    'email', lower(trim(p_email)),
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

GRANT EXECUTE ON FUNCTION redeem_admin_invite(TEXT, TEXT, TEXT, TEXT) TO anon;
GRANT EXECUTE ON FUNCTION redeem_admin_invite(TEXT, TEXT, TEXT, TEXT) TO authenticated;
