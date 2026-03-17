-- hotfix-force-logout-cast.sql
-- Fix 1: auth.refresh_tokens.user_id is `character varying`, not `uuid`.
--   Comparing a UUID variable to it directly fails. Cast to ::text.
-- Fix 2 (key insight from research): JWTs are stateless — no SQL can
--   cryptographically revoke an access token once issued. However, modern
--   Supabase GoTrue validates the session record on EVERY API request, so
--   deleting from auth.sessions immediately causes 401s on subsequent calls.
--   This IS the correct and complete server-side approach.
--   The recommended companion: set JWT expiry to 5-10 minutes in Supabase
--   Dashboard (Auth → JWT expiry), so worst-case window is 5 min, not 1 hour.
-- NOTE: banned_until only blocks new sign-ins, NOT existing JWTs — removed.

CREATE OR REPLACE FUNCTION force_logout_admin(p_profile_id UUID)
RETURNS JSONB AS $$
DECLARE
  v_target_auth_id UUID;
  v_target_name TEXT;
  v_my_profile_id UUID;
  v_my_org_id UUID;
  v_sessions_deleted INTEGER;
BEGIN
  IF NOT is_admin() THEN
    RAISE EXCEPTION 'Only admins can force logout other admins';
  END IF;

  v_my_org_id := get_my_org_id();

  SELECT id INTO v_my_profile_id
  FROM profiles WHERE auth_id = auth.uid();

  IF p_profile_id = v_my_profile_id THEN
    RAISE EXCEPTION 'Use normal sign-out to log out of your own account';
  END IF;

  SELECT auth_id, full_name
  INTO v_target_auth_id, v_target_name
  FROM profiles
  WHERE id = p_profile_id
    AND org_id = v_my_org_id
    AND role = 'admin';

  IF v_target_auth_id IS NULL THEN
    RAISE EXCEPTION 'Admin user not found or not in your organization';
  END IF;

  -- Delete sessions: auth.sessions.user_id is uuid — compare directly.
  -- Modern GoTrue validates the session record on every API request,
  -- so this immediately causes 401s on any subsequent Supabase calls.
  DELETE FROM auth.sessions WHERE user_id = v_target_auth_id;
  GET DIAGNOSTICS v_sessions_deleted = ROW_COUNT;

  -- Delete refresh tokens: user_id is character varying — cast uuid to text.
  -- This prevents the user from obtaining a new access token.
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
