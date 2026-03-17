-- migration-012-email-toggle-fix.sql
-- Fix: org-level emails_enabled toggle was not being checked in send_summary_email().
-- The check existed in process_pending_jobs() (migration-004) but was lost when
-- cron-jobs.sql was re-deployed. Moving the check INTO send_summary_email() itself
-- ensures it's always enforced regardless of caller.
--
-- send_manual_email() passes p_bypass_org_toggle=true to allow admin override.

-- 1. Add org-level emails_enabled check to send_summary_email
--    New parameter: p_bypass_org_toggle (default false)
CREATE OR REPLACE FUNCTION send_summary_email(
  p_meeting_id UUID,
  p_summary_text TEXT,
  p_tone_count INTEGER DEFAULT 0,
  p_bypass_org_toggle BOOLEAN DEFAULT false
)
RETURNS BOOLEAN AS $$
DECLARE
  v_tenant_id TEXT;
  v_client_id TEXT;
  v_client_secret TEXT;
  v_sender_email TEXT;
  v_recipient_email TEXT;
  v_user_name TEXT;
  v_meeting_date TEXT;
  v_meeting_app TEXT;
  v_meeting_category TEXT;
  v_org_name TEXT;
  v_token_response extensions.http_response;
  v_access_token TEXT;
  v_mail_response extensions.http_response;
  v_email_subject TEXT;
  v_email_body TEXT;
  v_email_enabled BOOLEAN;
  v_org_emails_enabled BOOLEAN;
  v_email_already_sent_at TIMESTAMPTZ;
BEGIN
  -- Dedup: lock the row first, then check — prevents concurrent auto-sends from
  -- both reading NULL and both proceeding. Manual resends clear email_sent_at before
  -- calling this function, so the lock is acquired on a NULL row and passes through.
  SELECT email_sent_at INTO v_email_already_sent_at
  FROM meetings WHERE id = p_meeting_id
  FOR UPDATE;

  IF v_email_already_sent_at IS NOT NULL THEN
    RAISE NOTICE 'send_summary_email: Email already sent for meeting %, skipping duplicate', p_meeting_id;
    RETURN FALSE;
  END IF;

  -- Get Azure credentials from vault
  v_tenant_id := get_vault_secret('azure_tenant_id');
  v_client_id := get_vault_secret('azure_client_id');
  v_client_secret := get_vault_secret('azure_client_secret');

  IF v_tenant_id IS NULL OR v_client_id IS NULL OR v_client_secret IS NULL THEN
    RAISE WARNING 'send_summary_email: Azure credentials not found in vault';
    RETURN FALSE;
  END IF;

  -- Get meeting + org + user info
  SELECT
    o.sender_email, o.name,
    p.microsoft_email, p.full_name,
    to_char(m.start_time AT TIME ZONE 'UTC', 'Mon DD, YYYY HH24:MI'),
    m.detected_app, COALESCE(m.detected_category, 'general'),
    COALESCE(p.email_enabled, true),
    COALESCE(o.emails_enabled, true)
  INTO v_sender_email, v_org_name, v_recipient_email, v_user_name,
       v_meeting_date, v_meeting_app, v_meeting_category, v_email_enabled,
       v_org_emails_enabled
  FROM meetings m
  JOIN profiles p ON p.id = m.user_id
  JOIN organizations o ON o.id = m.org_id
  WHERE m.id = p_meeting_id;

  -- Check org-level email toggle (unless admin bypass)
  IF NOT p_bypass_org_toggle AND NOT COALESCE(v_org_emails_enabled, true) THEN
    RAISE NOTICE 'send_summary_email: Org-level emails disabled, skipping for meeting %', p_meeting_id;
    RETURN FALSE;
  END IF;

  -- Check per-user email toggle
  IF NOT COALESCE(v_email_enabled, true) THEN
    RAISE NOTICE 'send_summary_email: Email disabled for user %', v_user_name;
    RETURN FALSE;
  END IF;

  -- Skip if no sender or recipient configured
  IF v_sender_email IS NULL OR v_sender_email = '' THEN
    RAISE WARNING 'send_summary_email: No sender_email configured for org';
    RETURN FALSE;
  END IF;

  IF v_recipient_email IS NULL OR v_recipient_email = '' THEN
    RAISE WARNING 'send_summary_email: No microsoft_email for user %', v_user_name;
    RETURN FALSE;
  END IF;

  -- Step 1: Get OAuth2 access token via client credentials flow
  SELECT * INTO v_token_response FROM extensions.http((
    'POST',
    'https://login.microsoftonline.com/' || v_tenant_id || '/oauth2/v2.0/token',
    ARRAY[]::extensions.http_header[],
    'application/x-www-form-urlencoded',
    'client_id=' || v_client_id ||
    '&scope=https%3A%2F%2Fgraph.microsoft.com%2F.default' ||
    '&client_secret=' || v_client_secret ||
    '&grant_type=client_credentials'
  )::extensions.http_request);

  IF v_token_response.status != 200 THEN
    RAISE WARNING 'send_summary_email: Token request failed with status %', v_token_response.status;
    RETURN FALSE;
  END IF;

  v_access_token := (v_token_response.content::jsonb)->>'access_token';

  IF v_access_token IS NULL THEN
    RAISE WARNING 'send_summary_email: No access_token in response';
    RETURN FALSE;
  END IF;

  -- Build email
  v_email_subject := v_user_name || '''s Meeting Summary - ' || v_meeting_date;
  v_email_body := '<html><body style="font-family: -apple-system, BlinkMacSystemFont, ''Segoe UI'', Roboto, sans-serif; background-color: #f8fafc; padding: 24px; margin: 0;">'
    || '<div style="max-width: 680px; margin: 0 auto; background: #ffffff; border-radius: 12px; border: 1px solid #e2e8f0; overflow: hidden;">'
    || '<div style="background: linear-gradient(135deg, #4f46e5, #6366f1); padding: 24px 32px;">'
    || '<h1 style="color: #ffffff; margin: 0; font-size: 20px;">Meeting Summary</h1>'
    || '<p style="color: #c7d2fe; margin: 4px 0 0 0; font-size: 14px;">' || v_org_name || '</p>'
    || '</div>'
    || '<div style="padding: 24px 32px;">'
    || '<table style="width: 100%; border-collapse: collapse; margin-bottom: 20px;">'
    || '<tr><td style="padding: 6px 12px; color: #64748b; font-size: 13px;">User</td><td style="padding: 6px 12px; font-size: 13px; font-weight: 600;">' || COALESCE(v_user_name, 'Unknown') || '</td></tr>'
    || '<tr><td style="padding: 6px 12px; color: #64748b; font-size: 13px;">Date</td><td style="padding: 6px 12px; font-size: 13px;">' || COALESCE(v_meeting_date, 'N/A') || '</td></tr>'
    || '<tr><td style="padding: 6px 12px; color: #64748b; font-size: 13px;">App</td><td style="padding: 6px 12px; font-size: 13px;">' || COALESCE(v_meeting_app, 'Unknown') || '</td></tr>'
    || '<tr><td style="padding: 6px 12px; color: #64748b; font-size: 13px;">Category</td><td style="padding: 6px 12px; font-size: 13px;"><span style="background: #eef2ff; color: #4f46e5; padding: 2px 8px; border-radius: 4px; font-size: 12px;">' || COALESCE(v_meeting_category, 'general') || '</span></td></tr>'
    || CASE WHEN p_tone_count > 0 THEN '<tr><td style="padding: 6px 12px; color: #64748b; font-size: 13px;">Tone Alerts</td><td style="padding: 6px 12px; font-size: 13px;"><span style="background: #fef2f2; color: #dc2626; padding: 2px 8px; border-radius: 4px; font-size: 12px; font-weight: 600;">' || p_tone_count || ' alert(s)</span></td></tr>' ELSE '' END
    || '</table>'
    || '<div style="border-top: 1px solid #e2e8f0; padding-top: 20px;">'
    || '<h2 style="font-size: 16px; color: #1e293b; margin: 0 0 12px 0;">AI Summary</h2>'
    || '<div style="font-size: 14px; line-height: 1.6; color: #334155;">' || md_to_email_html(p_summary_text) || '</div>'
    || '</div></div></div>'
    || '<p style="margin: 20px 0 0 0; font-size: 13px; color: #64748b; text-align: center;">Team Utilitarian Labs</p>'
    || '</body></html>';

  -- Step 2: Send email via MS Graph
  SELECT * INTO v_mail_response FROM extensions.http((
    'POST',
    'https://graph.microsoft.com/v1.0/users/' || v_sender_email || '/sendMail',
    ARRAY[extensions.http_header('Authorization', 'Bearer ' || v_access_token),
          extensions.http_header('Content-Type', 'application/json')],
    'application/json',
    jsonb_build_object(
      'message', jsonb_build_object(
        'subject', v_email_subject,
        'body', jsonb_build_object('contentType', 'HTML', 'content', v_email_body),
        'toRecipients', jsonb_build_array(
          jsonb_build_object('emailAddress', jsonb_build_object('address', v_recipient_email))
        )
      ),
      'saveToSentItems', TRUE
    )::text
  )::extensions.http_request);

  IF v_mail_response.status BETWEEN 200 AND 299 THEN
    RAISE NOTICE 'send_summary_email: Email sent for meeting %', p_meeting_id;
    UPDATE meetings SET email_sent_at = NOW() WHERE id = p_meeting_id;
    RETURN TRUE;
  ELSE
    RAISE WARNING 'send_summary_email: Graph API returned %, body: %', v_mail_response.status, LEFT(v_mail_response.content, 500);
    RETURN FALSE;
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
   SET search_path = public, extensions, net, vault;

-- 2. Update send_manual_email to pass bypass flag
CREATE OR REPLACE FUNCTION send_manual_email(p_meeting_id UUID)
RETURNS BOOLEAN AS $$
DECLARE
  v_summary_text TEXT;
  v_tone_count INTEGER;
  v_result BOOLEAN;
BEGIN
  IF NOT is_admin() THEN
    RAISE EXCEPTION 'send_manual_email: caller is not an admin';
  END IF;

  -- Always use the current default summary — important when Teams transcript
  -- has overridden the local one and the summary was regenerated.
  SELECT content INTO v_summary_text
  FROM summaries
  WHERE meeting_id = p_meeting_id AND is_default = true
  LIMIT 1;

  IF v_summary_text IS NULL THEN
    RAISE NOTICE 'send_manual_email: No summary found for meeting %', p_meeting_id;
    RETURN FALSE;
  END IF;

  SELECT COUNT(*) INTO v_tone_count
  FROM tone_alerts
  WHERE meeting_id = p_meeting_id;

  -- Clear email_sent_at so the dedup guard in send_summary_email passes.
  -- Admin can resend as many times as needed (e.g., user didn't receive it,
  -- or summary was updated after Teams transcript override).
  -- send_summary_email will re-stamp email_sent_at = NOW() on success.
  UPDATE meetings SET email_sent_at = NULL WHERE id = p_meeting_id;

  -- Admin override: bypass org-level email toggle
  v_result := send_summary_email(p_meeting_id, v_summary_text, v_tone_count, true);
  RETURN v_result;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION send_manual_email(UUID) TO authenticated;

-- 3. Update send_deferred_email — no longer needs its own check since
--    send_summary_email() now handles it (but keep for extra safety)
CREATE OR REPLACE FUNCTION send_deferred_email(p_meeting_id UUID)
RETURNS BOOLEAN AS $$
DECLARE
  v_summary_text TEXT;
  v_tone_count INTEGER;
BEGIN
  SELECT content INTO v_summary_text
  FROM summaries
  WHERE meeting_id = p_meeting_id AND is_default = true
  LIMIT 1;

  IF v_summary_text IS NULL THEN
    RAISE NOTICE 'send_deferred_email: No summary found for meeting %', p_meeting_id;
    RETURN FALSE;
  END IF;

  SELECT COUNT(*) INTO v_tone_count
  FROM tone_alerts
  WHERE meeting_id = p_meeting_id;

  -- Calls send_summary_email which checks org toggle internally
  RETURN send_summary_email(p_meeting_id, v_summary_text, v_tone_count);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
