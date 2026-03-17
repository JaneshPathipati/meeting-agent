-- migration-013-create-admin-rpc.sql
-- Adds create_admin_user() RPC so existing admins can add new admins
-- from the dashboard Danger Zone section.
-- Run this in Supabase SQL Editor.

-- Ensure pgcrypto is available for password hashing
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE OR REPLACE FUNCTION create_admin_user(
  p_email TEXT,
  p_password TEXT,
  p_full_name TEXT
)
RETURNS JSONB AS $$
DECLARE
  v_user_id UUID;
  v_profile_id UUID;
  v_encrypted_pw TEXT;
  v_my_org_id UUID;
BEGIN
  -- Only admins can call this
  IF NOT is_admin() THEN
    RAISE EXCEPTION 'Only admins can create admin users';
  END IF;

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

  -- Check if email already exists in auth
  IF EXISTS (SELECT 1 FROM auth.users WHERE email = lower(trim(p_email))) THEN
    RAISE EXCEPTION 'An account with this email already exists';
  END IF;

  -- Check if profile already exists
  IF EXISTS (SELECT 1 FROM profiles WHERE email = lower(trim(p_email))) THEN
    RAISE EXCEPTION 'A profile with this email already exists';
  END IF;

  v_my_org_id := get_my_org_id();
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

  -- Create identity record (required for email/password login)
  INSERT INTO auth.identities (
    id, user_id, identity_data, provider, provider_id,
    last_sign_in_at, created_at, updated_at
  ) VALUES (
    gen_random_uuid(), v_user_id,
    jsonb_build_object('sub', v_user_id::text, 'email', lower(trim(p_email))),
    'email', v_user_id::text,
    NOW(), NOW(), NOW()
  );

  -- Create admin profile in same org
  INSERT INTO profiles (id, org_id, email, full_name, role, auth_id)
  VALUES (gen_random_uuid(), v_my_org_id, lower(trim(p_email)), trim(p_full_name), 'admin', v_user_id)
  RETURNING id INTO v_profile_id;

  RETURN jsonb_build_object(
    'success', true,
    'profile_id', v_profile_id,
    'auth_id', v_user_id,
    'email', lower(trim(p_email)),
    'full_name', trim(p_full_name)
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
   SET search_path = public, auth, extensions;

-- Allow authenticated users (admins) to call via RPC
GRANT EXECUTE ON FUNCTION create_admin_user(TEXT, TEXT, TEXT) TO authenticated;
