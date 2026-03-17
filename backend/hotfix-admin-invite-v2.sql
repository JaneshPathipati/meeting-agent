-- hotfix-admin-invite-v2.sql
-- Fix redeem_admin_invite():
--   1. provider_id must be the email (not user UUID) for GoTrue email/password sign-in
--   2. bcrypt cost changed from default 6 → 10 (matches GoTrue's default)
-- Also repairs the one already-broken test user created with the old code.

-- ── Repair existing broken user ─────────────────────────────────────────────
-- The test user was created with provider_id=UUID and cost-6 bcrypt.
-- Fix both in-place so they can log in without re-registering.
UPDATE auth.identities
SET provider_id = u.email
FROM auth.users u
WHERE auth.identities.user_id = u.id
  AND auth.identities.provider = 'email'
  AND auth.identities.provider_id = u.id::text  -- was set to UUID, not email
;

-- Re-hash the test user's password with cost-10 bcrypt so GoTrue can verify it.
-- We reset it to the same password they chose: ritvik1234567890
-- (They will need to change it or we can prompt; for now just make it work.)
UPDATE auth.users
SET encrypted_password = crypt('ritvik1234567890', gen_salt('bf', 10))
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

  -- Validate invite code (strip dashes on both sides)
  SELECT * INTO v_invite
  FROM admin_invites
  WHERE replace(code, '-', '') = upper(replace(trim(p_code), '-', ''))
    AND used_at IS NULL
    AND expires_at > NOW();

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
  -- cost=10 matches GoTrue's default — required for signInWithPassword to work
  v_encrypted_pw := crypt(p_password, gen_salt('bf', 10));

  -- Create auth user
  INSERT INTO auth.users (
    instance_id, id, aud, role, email, encrypted_password,
    email_confirmed_at, confirmation_sent_at,
    raw_app_meta_data, raw_user_meta_data,
    is_sso_user,
    created_at, updated_at
  ) VALUES (
    '00000000-0000-0000-0000-000000000000',
    v_user_id, 'authenticated', 'authenticated',
    lower(trim(p_email)), v_encrypted_pw,
    NOW(), NOW(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    jsonb_build_object('full_name', trim(p_full_name)),
    false,
    NOW(), NOW()
  );

  -- Create identity — provider_id MUST be the email for GoTrue email/password auth
  INSERT INTO auth.identities (
    id, user_id, identity_data, provider, provider_id,
    last_sign_in_at, created_at, updated_at
  ) VALUES (
    gen_random_uuid(), v_user_id,
    jsonb_build_object('sub', v_user_id::text, 'email', lower(trim(p_email))),
    'email', lower(trim(p_email)),   -- ← email, not user UUID
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
