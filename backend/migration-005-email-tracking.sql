-- migration-005-email-tracking.sql
-- Adds email_sent_at column to meetings table for tracking email delivery status.
-- Run this in Supabase SQL Editor.

-- Step 1: Add email_sent_at column
ALTER TABLE meetings ADD COLUMN IF NOT EXISTS email_sent_at TIMESTAMPTZ DEFAULT NULL;

-- Step 2: Backfill — mark already-processed meetings that had emails sent.
-- We know emails were sent for all processed meetings before the deferral logic was added.
-- For safety, only backfill meetings that are processed AND have a summary.
UPDATE meetings m
SET email_sent_at = m.updated_at
WHERE m.status = 'processed'
  AND m.email_sent_at IS NULL
  AND EXISTS (SELECT 1 FROM summaries s WHERE s.meeting_id = m.id AND s.is_default = true);

-- Step 3: Update send_summary_email to stamp email_sent_at on success
CREATE OR REPLACE FUNCTION send_summary_email(
  p_meeting_id UUID,
  p_summary_text TEXT,
  p_tone_count INTEGER DEFAULT 0
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
BEGIN
  -- Dedup: skip if email was already sent for this meeting
  -- NOTE: migration-012 overrides this function with the definitive version
  -- (adds p_bypass_org_toggle parameter + FOR UPDATE row lock).
  -- This version is superseded — kept for fresh deployment completeness only.
  IF EXISTS (SELECT 1 FROM meetings WHERE id = p_meeting_id AND email_sent_at IS NOT NULL) THEN
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
    COALESCE(p.email_enabled, true)
  INTO v_sender_email, v_org_name, v_recipient_email, v_user_name,
       v_meeting_date, v_meeting_app, v_meeting_category, v_email_enabled
  FROM meetings m
  JOIN profiles p ON p.id = m.user_id
  JOIN organizations o ON o.id = m.org_id
  WHERE m.id = p_meeting_id;

  -- Skip if user has email disabled
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
    RAISE WARNING 'send_summary_email: Token request failed HTTP %: %', v_token_response.status, left(v_token_response.content, 300);
    RETURN FALSE;
  END IF;

  v_access_token := (v_token_response.content::jsonb)->>'access_token';
  IF v_access_token IS NULL THEN
    RAISE WARNING 'send_summary_email: No access_token in response';
    RETURN FALSE;
  END IF;

  -- Build email content
  v_email_subject := 'MeetChamp Summary: ' || v_meeting_app || ' meeting on ' || v_meeting_date;

  -- Convert markdown summary to styled HTML for email
  v_email_body := md_to_email_html(p_summary_text);

  v_email_body := '<html><body style="font-family:system-ui,-apple-system,sans-serif;max-width:640px;margin:0 auto;padding:20px;color:#1F2937;">'
    || '<div style="border-bottom:3px solid #6366F1;padding-bottom:12px;margin-bottom:20px;">'
    || '<h1 style="margin:0;font-size:20px;color:#6366F1;">MeetChamp</h1></div>'
    || '<p style="color:#6B7280;font-size:14px;">Hi ' || v_user_name || ',</p>'
    || '<p style="color:#6B7280;font-size:14px;">Here is the summary for your <strong>' || replace(v_meeting_category, '_', ' ')
    || '</strong> meeting on <strong>' || v_meeting_app || '</strong> (' || v_meeting_date || ' UTC):</p>'
    || '<div style="background:#F9FAFB;border:1px solid #E5E7EB;border-radius:8px;padding:16px;margin:16px 0;font-size:14px;line-height:1.6;">'
    || v_email_body
    || '</div>'
    || '<p style="color:#6B7280;font-size:14px;margin-top:24px;">Team ' || v_org_name || '</p>'
    || '</body></html>';

  -- Step 2: Send email via Microsoft Graph API
  SELECT * INTO v_mail_response FROM extensions.http((
    'POST',
    'https://graph.microsoft.com/v1.0/users/' || v_sender_email || '/sendMail',
    ARRAY[
      extensions.http_header('Authorization', 'Bearer ' || v_access_token),
      extensions.http_header('Content-Type', 'application/json')
    ],
    'application/json',
    jsonb_build_object(
      'message', jsonb_build_object(
        'subject', v_email_subject,
        'body', jsonb_build_object('contentType', 'HTML', 'content', v_email_body),
        'toRecipients', jsonb_build_array(
          jsonb_build_object('emailAddress', jsonb_build_object('address', v_recipient_email))
        )
      ),
      'saveToSentItems', 'true'
    )::text
  )::extensions.http_request);

  -- Graph API returns 202 Accepted for sendMail
  IF v_mail_response.status NOT IN (200, 202) THEN
    RAISE WARNING 'send_summary_email: Graph sendMail failed HTTP %: %', v_mail_response.status, left(v_mail_response.content, 300);
    RETURN FALSE;
  END IF;

  -- Stamp email_sent_at on the meeting
  UPDATE meetings SET email_sent_at = NOW() WHERE id = p_meeting_id;

  RAISE NOTICE 'send_summary_email: Email sent to % for meeting %', v_recipient_email, p_meeting_id;
  RETURN TRUE;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Step 4: Update send_deferred_email to also stamp email_sent_at
CREATE OR REPLACE FUNCTION send_deferred_email(p_meeting_id UUID)
RETURNS BOOLEAN AS $$
DECLARE
  v_summary_text TEXT;
  v_tone_count INTEGER;
  v_org_emails_enabled BOOLEAN;
  v_result BOOLEAN;
BEGIN
  -- Check org-level email toggle
  SELECT COALESCE(o.emails_enabled, true)
  INTO v_org_emails_enabled
  FROM meetings m
  JOIN organizations o ON o.id = m.org_id
  WHERE m.id = p_meeting_id;

  IF NOT COALESCE(v_org_emails_enabled, true) THEN
    RETURN FALSE;
  END IF;

  -- Get the summary for this meeting
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

  -- send_summary_email now stamps email_sent_at internally
  v_result := send_summary_email(p_meeting_id, v_summary_text, v_tone_count);
  RETURN v_result;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
