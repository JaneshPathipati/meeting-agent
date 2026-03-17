-- migration-015-super-admin-protection.sql
-- Designates ritvik.vasundh@utilitarianlabs.com as the permanent super admin.
-- No other admin — including themselves — can delete or force-logout this account.
-- Run this in Supabase SQL Editor.

-- Re-create delete_admin_user with super admin guard
CREATE OR REPLACE FUNCTION delete_admin_user(p_profile_id UUID)
RETURNS JSONB AS $$
DECLARE
  v_target_auth_id UUID;
  v_target_email TEXT;
  v_target_name TEXT;
  v_my_profile_id UUID;
  v_my_org_id UUID;
  v_admin_count INTEGER;
  SUPER_ADMIN_EMAIL CONSTANT TEXT := 'ritvik.vasundh@utilitarianlabs.com';
BEGIN
  IF NOT is_admin() THEN
    RAISE EXCEPTION 'Only admins can delete admin users';
  END IF;

  v_my_org_id := get_my_org_id();

  SELECT id INTO v_my_profile_id
  FROM profiles WHERE auth_id = auth.uid();

  -- Cannot delete yourself
  IF p_profile_id = v_my_profile_id THEN
    RAISE EXCEPTION 'You cannot delete your own admin account';
  END IF;

  -- Get target info (must be in same org, must be admin)
  SELECT auth_id, email, full_name
  INTO v_target_auth_id, v_target_email, v_target_name
  FROM profiles
  WHERE id = p_profile_id
    AND org_id = v_my_org_id
    AND role = 'admin';

  IF v_target_auth_id IS NULL THEN
    RAISE EXCEPTION 'Admin user not found or not in your organization';
  END IF;

  -- Super admin is permanently protected — no one can delete this account
  IF lower(trim(v_target_email)) = lower(SUPER_ADMIN_EMAIL) THEN
    RAISE EXCEPTION 'This account is protected and cannot be deleted';
  END IF;

  -- Safety: cannot delete the last admin
  SELECT COUNT(*) INTO v_admin_count
  FROM profiles
  WHERE org_id = v_my_org_id AND role = 'admin';

  IF v_admin_count <= 1 THEN
    RAISE EXCEPTION 'Cannot delete the last admin in the organization';
  END IF;

  DELETE FROM profiles WHERE id = p_profile_id;
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


-- Re-create force_logout_admin with super admin guard
CREATE OR REPLACE FUNCTION force_logout_admin(p_profile_id UUID)
RETURNS JSONB AS $$
DECLARE
  v_target_auth_id UUID;
  v_target_name TEXT;
  v_target_email TEXT;
  v_my_profile_id UUID;
  v_my_org_id UUID;
  v_sessions_deleted INTEGER;
  SUPER_ADMIN_EMAIL CONSTANT TEXT := 'ritvik.vasundh@utilitarianlabs.com';
BEGIN
  IF NOT is_admin() THEN
    RAISE EXCEPTION 'Only admins can force logout other admins';
  END IF;

  v_my_org_id := get_my_org_id();

  SELECT id INTO v_my_profile_id
  FROM profiles WHERE auth_id = auth.uid();

  -- Cannot force-logout yourself
  IF p_profile_id = v_my_profile_id THEN
    RAISE EXCEPTION 'Use normal sign-out to log out of your own account';
  END IF;

  -- Get target info
  SELECT auth_id, full_name, email
  INTO v_target_auth_id, v_target_name, v_target_email
  FROM profiles
  WHERE id = p_profile_id
    AND org_id = v_my_org_id
    AND role = 'admin';

  IF v_target_auth_id IS NULL THEN
    RAISE EXCEPTION 'Admin user not found or not in your organization';
  END IF;

  -- Super admin sessions are permanently protected
  IF lower(trim(v_target_email)) = lower(SUPER_ADMIN_EMAIL) THEN
    RAISE EXCEPTION 'This account is protected and cannot be signed out remotely';
  END IF;

  DELETE FROM auth.sessions WHERE user_id = v_target_auth_id;
  GET DIAGNOSTICS v_sessions_deleted = ROW_COUNT;

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
