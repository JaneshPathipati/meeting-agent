-- migration-014-admin-management.sql
-- Adds RPCs for admin management:
--   delete_admin_user()  — remove another admin (auth + profile)
--   force_logout_admin() — invalidate all sessions for another admin
-- Run this in Supabase SQL Editor.

-- 1. Delete another admin user
--    Removes both the auth.users entry and the profiles entry.
--    Safety: cannot delete yourself, cannot delete the last admin.
CREATE OR REPLACE FUNCTION delete_admin_user(p_profile_id UUID)
RETURNS JSONB AS $$
DECLARE
  v_target_auth_id UUID;
  v_target_email TEXT;
  v_target_name TEXT;
  v_my_profile_id UUID;
  v_my_org_id UUID;
  v_admin_count INTEGER;
BEGIN
  -- Only admins can call this
  IF NOT is_admin() THEN
    RAISE EXCEPTION 'Only admins can delete admin users';
  END IF;

  v_my_org_id := get_my_org_id();

  -- Get caller's profile ID
  SELECT id INTO v_my_profile_id
  FROM profiles WHERE auth_id = auth.uid();

  -- Cannot delete yourself
  IF p_profile_id = v_my_profile_id THEN
    RAISE EXCEPTION 'You cannot delete your own admin account';
  END IF;

  -- Get target admin info (must be in same org and be an admin)
  SELECT auth_id, email, full_name
  INTO v_target_auth_id, v_target_email, v_target_name
  FROM profiles
  WHERE id = p_profile_id
    AND org_id = v_my_org_id
    AND role = 'admin';

  IF v_target_auth_id IS NULL THEN
    RAISE EXCEPTION 'Admin user not found or not in your organization';
  END IF;

  -- Safety: don't allow deleting the last admin
  SELECT COUNT(*) INTO v_admin_count
  FROM profiles
  WHERE org_id = v_my_org_id AND role = 'admin';

  IF v_admin_count <= 1 THEN
    RAISE EXCEPTION 'Cannot delete the last admin in the organization';
  END IF;

  -- Delete profile first (cascades to meetings, etc. if any)
  DELETE FROM profiles WHERE id = p_profile_id;

  -- Delete auth user (cascades to identities, sessions, refresh_tokens)
  DELETE FROM auth.users WHERE id = v_target_auth_id;

  RETURN jsonb_build_object(
    'success', true,
    'deleted_email', v_target_email,
    'deleted_name', v_target_name
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
   SET search_path = public, auth;

GRANT EXECUTE ON FUNCTION delete_admin_user(UUID) TO authenticated;


-- 2. Force logout another admin (invalidate all sessions)
--    Deletes all sessions and refresh tokens for the target user.
--    Their current access token remains valid until expiry (~1 hour)
--    but they cannot refresh it, so they will be signed out.
CREATE OR REPLACE FUNCTION force_logout_admin(p_profile_id UUID)
RETURNS JSONB AS $$
DECLARE
  v_target_auth_id UUID;
  v_target_name TEXT;
  v_my_profile_id UUID;
  v_my_org_id UUID;
  v_sessions_deleted INTEGER;
BEGIN
  -- Only admins can call this
  IF NOT is_admin() THEN
    RAISE EXCEPTION 'Only admins can force logout other admins';
  END IF;

  v_my_org_id := get_my_org_id();

  -- Get caller's profile ID
  SELECT id INTO v_my_profile_id
  FROM profiles WHERE auth_id = auth.uid();

  -- Cannot force-logout yourself (use normal logout)
  IF p_profile_id = v_my_profile_id THEN
    RAISE EXCEPTION 'Use normal sign-out to log out of your own account';
  END IF;

  -- Get target admin info (must be in same org and be an admin)
  SELECT auth_id, full_name
  INTO v_target_auth_id, v_target_name
  FROM profiles
  WHERE id = p_profile_id
    AND org_id = v_my_org_id
    AND role = 'admin';

  IF v_target_auth_id IS NULL THEN
    RAISE EXCEPTION 'Admin user not found or not in your organization';
  END IF;

  -- Invalidate all sessions
  DELETE FROM auth.sessions WHERE user_id = v_target_auth_id;
  GET DIAGNOSTICS v_sessions_deleted = ROW_COUNT;

  -- Invalidate all refresh tokens
  DELETE FROM auth.refresh_tokens WHERE user_id = v_target_auth_id;

  RETURN jsonb_build_object(
    'success', true,
    'name', v_target_name,
    'sessions_invalidated', v_sessions_deleted
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
   SET search_path = public, auth;

GRANT EXECUTE ON FUNCTION force_logout_admin(UUID) TO authenticated;
