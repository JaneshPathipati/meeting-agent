-- Migration 009: Fix "mutable search_path" security warnings
-- Sets explicit search_path on all functions to prevent search_path hijacking.
-- See: https://supabase.com/docs/guides/database/database-linter#0010_security_definer_view
--
-- Each ALTER is wrapped in an exception handler so functions that don't exist
-- in this environment are silently skipped.

DO $$ BEGIN ALTER FUNCTION public.get_my_org_id() SET search_path = public;
EXCEPTION WHEN undefined_function THEN NULL; END $$;

DO $$ BEGIN ALTER FUNCTION public.is_admin() SET search_path = public;
EXCEPTION WHEN undefined_function THEN NULL; END $$;

DO $$ BEGIN ALTER FUNCTION public.get_openai_key() SET search_path = public;
EXCEPTION WHEN undefined_function THEN NULL; END $$;

DO $$ BEGIN ALTER FUNCTION public.call_openai_sync(TEXT, TEXT, INTEGER, NUMERIC) SET search_path = public;
EXCEPTION WHEN undefined_function THEN NULL; END $$;

DO $$ BEGIN ALTER FUNCTION public.call_openai(UUID, TEXT, TEXT, TEXT, INTEGER, NUMERIC) SET search_path = public;
EXCEPTION WHEN undefined_function THEN NULL; END $$;

DO $$ BEGIN ALTER FUNCTION public.on_transcript_upserted() SET search_path = public;
EXCEPTION WHEN undefined_function THEN NULL; END $$;

DO $$ BEGIN ALTER FUNCTION public.update_updated_at_column() SET search_path = public;
EXCEPTION WHEN undefined_function THEN NULL; END $$;

DO $$ BEGIN ALTER FUNCTION public.process_pending_jobs() SET search_path = public;
EXCEPTION WHEN undefined_function THEN NULL; END $$;

DO $$ BEGIN ALTER FUNCTION public.cleanup_old_data() SET search_path = public;
EXCEPTION WHEN undefined_function THEN NULL; END $$;

DO $$ BEGIN ALTER FUNCTION public.md_to_email_html(TEXT) SET search_path = public;
EXCEPTION WHEN undefined_function THEN NULL; END $$;

DO $$ BEGIN ALTER FUNCTION public.send_summary_email(UUID, TEXT, INTEGER) SET search_path = public;
EXCEPTION WHEN undefined_function THEN NULL; END $$;

DO $$ BEGIN ALTER FUNCTION public.send_deferred_email(UUID) SET search_path = public;
EXCEPTION WHEN undefined_function THEN NULL; END $$;

DO $$ BEGIN ALTER FUNCTION public.send_manual_email(UUID) SET search_path = public;
EXCEPTION WHEN undefined_function THEN NULL; END $$;

DO $$ BEGIN ALTER FUNCTION public.get_vault_secret(TEXT) SET search_path = public;
EXCEPTION WHEN undefined_function THEN NULL; END $$;

DO $$ BEGIN ALTER FUNCTION public.validate_authorization_key(TEXT) SET search_path = public;
EXCEPTION WHEN undefined_function THEN NULL; END $$;

DO $$ BEGIN ALTER FUNCTION public.enroll_user(TEXT, UUID, TEXT, TEXT, TEXT, TEXT, TEXT) SET search_path = public;
EXCEPTION WHEN undefined_function THEN NULL; END $$;

DO $$ BEGIN ALTER FUNCTION public.check_user_status(UUID) SET search_path = public;
EXCEPTION WHEN undefined_function THEN NULL; END $$;

DO $$ BEGIN ALTER FUNCTION public._exec_ddl(TEXT) SET search_path = public;
EXCEPTION WHEN undefined_function THEN NULL; END $$;
