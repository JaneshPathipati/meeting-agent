-- migration-018-super-admin-only-actions.sql
-- Restricts delete_admin_user() and force_logout_admin() so that ONLY the
-- super admin can call them. Regular admins can view the admin list but
-- cannot modify or remove other admins.
-- Also carries forward the ::text cast fix for auth.refresh_tokens.user_id.

DO $$
DECLARE
  SUPER_ADMIN_EMAIL CONSTANT TEXT := 'ritvik.vasundh@utilitarianlabs.com';
BEGIN
  NULL; -- constant defined here for documentation; used inline below
END $$;


-- ── delete_admin_user: caller must be super admin ──────────────────────────
CREATE OR REPLACE FUNCTION delete_admin_user(p_profile_id UUID)
RETURNS JSONB AS $$
DECLARE
  v_target_auth_id UUID;
  v_target_email TEXT;
  v_target_name TEXT;
  v_my_profile_id UUID;
  v_my_org_id UUID;
  v_caller_email TEXT;
  v_admin_count INTEGER;
  SUPER_ADMIN_EMAIL CONSTANT TEXT := 'ritvik.vasundh@utilitarianlabs.com';
BEGIN
  IF NOT is_admin() THEN
    RAISE EXCEPTION 'Only admins can delete admin users';
  END IF;

  -- Only the super admin may delete other admins
  SELECT email INTO v_caller_email
  FROM auth.users WHERE id = auth.uid();

  IF lower(trim(v_caller_email)) != lower(SUPER_ADMIN_EMAIL) THEN
    RAISE EXCEPTION 'Only the super admin can delete other administrators';
  END IF;

  v_my_org_id := get_my_org_id();

  SELECT id INTO v_my_profile_id
  FROM profiles WHERE auth_id = auth.uid();

  IF p_profile_id = v_my_profile_id THEN
    RAISE EXCEPTION 'You cannot delete your own admin account';
  END IF;

  SELECT auth_id, email, full_name
  INTO v_target_auth_id, v_target_email, v_target_name
  FROM profiles
  WHERE id = p_profile_id
    AND org_id = v_my_org_id
    AND role = 'admin';

  IF v_target_auth_id IS NULL THEN
    RAISE EXCEPTION 'Admin user not found or not in your organization';
  END IF;

  IF lower(trim(v_target_email)) = lower(SUPER_ADMIN_EMAIL) THEN
    RAISE EXCEPTION 'This account is protected and cannot be deleted';
  END IF;

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


-- ── force_logout_admin: caller must be super admin ─────────────────────────
CREATE OR REPLACE FUNCTION force_logout_admin(p_profile_id UUID)
RETURNS JSONB AS $$
DECLARE
  v_target_auth_id UUID;
  v_target_name TEXT;
  v_target_email TEXT;
  v_my_profile_id UUID;
  v_my_org_id UUID;
  v_caller_email TEXT;
  v_sessions_deleted INTEGER;
  SUPER_ADMIN_EMAIL CONSTANT TEXT := 'ritvik.vasundh@utilitarianlabs.com';
BEGIN
  IF NOT is_admin() THEN
    RAISE EXCEPTION 'Only admins can force logout other admins';
  END IF;

  -- Only the super admin may force-logout other admins
  SELECT email INTO v_caller_email
  FROM auth.users WHERE id = auth.uid();

  IF lower(trim(v_caller_email)) != lower(SUPER_ADMIN_EMAIL) THEN
    RAISE EXCEPTION 'Only the super admin can force sign out other administrators';
  END IF;

  v_my_org_id := get_my_org_id();

  SELECT id INTO v_my_profile_id
  FROM profiles WHERE auth_id = auth.uid();

  IF p_profile_id = v_my_profile_id THEN
    RAISE EXCEPTION 'Use normal sign-out to log out of your own account';
  END IF;

  SELECT auth_id, full_name, email
  INTO v_target_auth_id, v_target_name, v_target_email
  FROM profiles
  WHERE id = p_profile_id
    AND org_id = v_my_org_id
    AND role = 'admin';

  IF v_target_auth_id IS NULL THEN
    RAISE EXCEPTION 'Admin user not found or not in your organization';
  END IF;

  IF lower(trim(v_target_email)) = lower(SUPER_ADMIN_EMAIL) THEN
    RAISE EXCEPTION 'This account is protected and cannot be signed out remotely';
  END IF;

  -- auth.sessions.user_id is uuid
  DELETE FROM auth.sessions WHERE user_id = v_target_auth_id;
  GET DIAGNOSTICS v_sessions_deleted = ROW_COUNT;

  -- auth.refresh_tokens.user_id is character varying — cast to text
  DELETE FROM auth.refresh_tokens WHERE user_id = v_target_auth_id::text;

  RETURN jsonb_build_object(
    'success', true,
    'name', v_target_name,
    'sessions_invalidated', v_sessions_deleted
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
   SET search_path = public, auth;

GRANT EXECUTE ON FUNCTION force_logout_admin(UUID) TO authenticated;
