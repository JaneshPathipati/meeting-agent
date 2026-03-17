-- migration-007-vault-rpc.sql
-- Allows the agent to retrieve the OpenAI API key from Vault via RPC.
-- The agent uses service_role key, so this function is restricted to service_role only.
-- Whitelisted secrets: only 'openai_api_key' can be retrieved.

CREATE OR REPLACE FUNCTION get_vault_secret_rpc(p_secret_name TEXT)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_secret TEXT;
  v_allowed_names TEXT[] := ARRAY['openai_api_key'];
BEGIN
  -- Only whitelisted secrets can be retrieved
  IF NOT (p_secret_name = ANY(v_allowed_names)) THEN
    RAISE EXCEPTION 'Access denied: secret "%" is not available via RPC', p_secret_name;
  END IF;

  SELECT decrypted_secret
  INTO v_secret
  FROM vault.decrypted_secrets
  WHERE name = p_secret_name
  LIMIT 1;

  IF v_secret IS NULL THEN
    RAISE EXCEPTION 'Secret "%" not found in vault', p_secret_name;
  END IF;

  RETURN v_secret;
END;
$$;

-- Lock down permissions: only service_role can call this
REVOKE EXECUTE ON FUNCTION get_vault_secret_rpc(TEXT) FROM public;
REVOKE EXECUTE ON FUNCTION get_vault_secret_rpc(TEXT) FROM anon;
REVOKE EXECUTE ON FUNCTION get_vault_secret_rpc(TEXT) FROM authenticated;
GRANT EXECUTE ON FUNCTION get_vault_secret_rpc(TEXT) TO service_role;
