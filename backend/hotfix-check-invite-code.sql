-- hotfix-check-invite-code.sql
-- Lightweight function to verify an invite code is valid (not used, not expired)
-- WITHOUT consuming it. Called by the frontend step-1 code verification UX.
CREATE OR REPLACE FUNCTION check_admin_invite_code(p_code TEXT)
RETURNS JSONB AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM admin_invites
    WHERE replace(code, '-', '') = upper(replace(trim(p_code), '-', ''))
      AND used_at IS NULL
      AND expires_at > NOW()
  ) THEN
    RAISE EXCEPTION 'Invalid or expired invite code';
  END IF;
  RETURN jsonb_build_object('valid', true);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
   SET search_path = public;

GRANT EXECUTE ON FUNCTION check_admin_invite_code(TEXT) TO anon;
GRANT EXECUTE ON FUNCTION check_admin_invite_code(TEXT) TO authenticated;
