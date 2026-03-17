-- migration-029-restore-graph-email.sql
-- Restore Microsoft Graph API email sending (replaces Resend version from migration-027).
-- Requires: azure_tenant_id, azure_client_id, azure_client_secret in vault,
--           Mail.Send application permission, sender_email on organization.
--
-- SETUP:
--   1. Azure Portal → App registrations → MeetChamp → API permissions → Add:
--      Microsoft Graph → Application permissions → Mail.Send → Grant admin consent
--   2. Run in Supabase SQL Editor:
--      SELECT vault.create_secret('YOUR_CLIENT_SECRET', 'azure_client_secret');
--      SELECT vault.create_secret('9d94cb2f-05ce-4ac3-96a0-8a8a97437d2a', 'azure_tenant_id');
--      SELECT vault.create_secret('41bb61d6-c277-4a44-9d0b-6634f4813f97', 'azure_client_id');
--   3. Set sender email:
--      UPDATE organizations SET sender_email = 'your@microsoft-mailbox.com'
--        WHERE id = 'a0000000-0000-0000-0000-000000000001';

-- Ensure http extension is enabled
CREATE EXTENSION IF NOT EXISTS http WITH SCHEMA extensions;

-- Helper to get vault secrets
CREATE OR REPLACE FUNCTION get_vault_secret(p_name TEXT)
RETURNS TEXT AS $$
DECLARE v_val TEXT;
BEGIN
  SELECT decrypted_secret INTO v_val
  FROM vault.decrypted_secrets
  WHERE name = p_name
  LIMIT 1;
  RETURN v_val;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Restore Graph API send_summary_email
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
  -- Dedup: lock row and check
  SELECT email_sent_at INTO v_email_already_sent_at
  FROM meetings WHERE id = p_meeting_id FOR UPDATE;

  IF v_email_already_sent_at IS NOT NULL THEN
    RAISE NOTICE 'Email already sent for meeting %', p_meeting_id;
    RETURN TRUE;
  END IF;

  -- Get Azure credentials from vault
  v_tenant_id := get_vault_secret('azure_tenant_id');
  v_client_id := get_vault_secret('azure_client_id');
  v_client_secret := get_vault_secret('azure_client_secret');

  IF v_tenant_id IS NULL OR v_client_id IS NULL OR v_client_secret IS NULL THEN
    RAISE WARNING 'send_summary_email: Azure credentials not found in vault. Store them with: SELECT vault.create_secret(value, name);';
    RETURN FALSE;
  END IF;

  -- Get meeting + org + user info
  SELECT
    o.sender_email, o.name,
    p.microsoft_email, p.full_name,
    to_char(m.start_time AT TIME ZONE 'UTC', 'Mon DD, YYYY HH12:MI AM'),
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

  -- Toggle checks
  IF NOT p_bypass_org_toggle AND NOT COALESCE(v_org_emails_enabled, true) THEN
    RETURN FALSE;
  END IF;
  IF NOT COALESCE(v_email_enabled, true) THEN
    RETURN FALSE;
  END IF;
  IF v_sender_email IS NULL OR v_sender_email = '' THEN
    RAISE WARNING 'send_summary_email: No sender_email on organization';
    RETURN FALSE;
  END IF;
  IF v_recipient_email IS NULL OR v_recipient_email = '' THEN
    RAISE WARNING 'send_summary_email: No email for user %', v_user_name;
    RETURN FALSE;
  END IF;

  -- Step 1: Get OAuth2 token via client credentials
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
    RAISE WARNING 'send_summary_email: Token failed (HTTP %), body: %', v_token_response.status, LEFT(v_token_response.content, 300);
    RETURN FALSE;
  END IF;

  v_access_token := (v_token_response.content::jsonb)->>'access_token';
  IF v_access_token IS NULL THEN
    RAISE WARNING 'send_summary_email: No access_token in response';
    RETURN FALSE;
  END IF;

  -- Build email
  v_email_subject := COALESCE(v_user_name, 'Employee') || '''s Meeting Summary - ' || v_meeting_date;
  v_email_body := '<html><body style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;background:#f8fafc;padding:24px;margin:0;">'
    || '<div style="max-width:680px;margin:0 auto;background:#fff;border-radius:12px;border:1px solid #e2e8f0;overflow:hidden;">'
    || '<div style="background:linear-gradient(135deg,#4f46e5,#6366f1);padding:24px 32px;">'
    || '<h1 style="color:#fff;margin:0;font-size:20px;">Meeting Summary</h1>'
    || '<p style="color:#c7d2fe;margin:4px 0 0;font-size:14px;">' || COALESCE(v_org_name, 'MeetChamp') || '</p>'
    || '</div>'
    || '<div style="padding:24px 32px;">'
    || '<table style="width:100%;border-collapse:collapse;margin-bottom:20px;">'
    || '<tr><td style="padding:6px 12px;color:#64748b;font-size:13px;">Employee</td><td style="padding:6px 12px;font-size:13px;font-weight:600;">' || COALESCE(v_user_name,'Unknown') || '</td></tr>'
    || '<tr><td style="padding:6px 12px;color:#64748b;font-size:13px;">Date</td><td style="padding:6px 12px;font-size:13px;">' || COALESCE(v_meeting_date,'N/A') || ' UTC</td></tr>'
    || '<tr><td style="padding:6px 12px;color:#64748b;font-size:13px;">App</td><td style="padding:6px 12px;font-size:13px;">' || COALESCE(v_meeting_app,'Unknown') || '</td></tr>'
    || '<tr><td style="padding:6px 12px;color:#64748b;font-size:13px;">Category</td><td style="padding:6px 12px;font-size:13px;"><span style="background:#eef2ff;color:#4f46e5;padding:2px 8px;border-radius:4px;font-size:12px;">' || COALESCE(v_meeting_category,'general') || '</span></td></tr>'
    || CASE WHEN p_tone_count > 0 THEN '<tr><td style="padding:6px 12px;color:#64748b;font-size:13px;">Tone Alerts</td><td style="padding:6px 12px;font-size:13px;"><span style="background:#fef2f2;color:#dc2626;padding:2px 8px;border-radius:4px;font-size:12px;font-weight:600;">' || p_tone_count || ' alert(s)</span></td></tr>' ELSE '' END
    || '</table>'
    || '<div style="border-top:1px solid #e2e8f0;padding-top:20px;">'
    || '<h2 style="font-size:16px;color:#1e293b;margin:0 0 12px;">AI Summary</h2>'
    || '<div style="font-size:14px;line-height:1.6;color:#334155;">' || md_to_email_html(p_summary_text) || '</div>'
    || '</div></div></div>'
    || '<p style="margin:20px 0 0;font-size:13px;color:#64748b;text-align:center;">Generated by MeetChamp</p>'
    || '</body></html>';

  -- Step 2: Send via Microsoft Graph API
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
      'saveToSentItems', true
    )::text
  )::extensions.http_request);

  IF v_mail_response.status BETWEEN 200 AND 299 THEN
    UPDATE meetings SET email_sent_at = NOW() WHERE id = p_meeting_id;
    RAISE NOTICE 'Email sent for meeting % to %', p_meeting_id, v_recipient_email;
    RETURN TRUE;
  ELSE
    RAISE WARNING 'send_summary_email: Graph API error (HTTP %), body: %', v_mail_response.status, LEFT(v_mail_response.content, 500);
    RETURN FALSE;
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
   SET search_path = public, extensions, net, vault;

-- Restore send_deferred_email
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

  IF v_summary_text IS NULL OR v_summary_text = '' THEN
    RETURN FALSE;
  END IF;

  SELECT COUNT(*) INTO v_tone_count
  FROM tone_alerts WHERE meeting_id = p_meeting_id;

  RETURN send_summary_email(p_meeting_id, v_summary_text, v_tone_count);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Restore send_manual_email
CREATE OR REPLACE FUNCTION send_manual_email(p_meeting_id UUID)
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
    RETURN FALSE;
  END IF;

  SELECT COUNT(*) INTO v_tone_count
  FROM tone_alerts WHERE meeting_id = p_meeting_id;

  UPDATE meetings SET email_sent_at = NULL WHERE id = p_meeting_id;
  RETURN send_summary_email(p_meeting_id, v_summary_text, v_tone_count, true);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
