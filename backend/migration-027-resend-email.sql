-- migration-027-resend-email.sql
-- Replace Microsoft Graph API email with Resend API (works with any email address).
-- Resend free tier: 100 emails/day, no credit card needed.
--
-- Setup:
--   1. Sign up at https://resend.com and get an API key
--   2. Run: SELECT vault.create_secret('resend_api_key', 'your-key-here');
--   3. In Resend dashboard: verify your sending domain OR use onboarding@resend.dev for testing
--   4. Set sender_email on your organization:
--      UPDATE organizations SET sender_email = 'noreply@yourdomain.com' WHERE id = '...';
--      (Or use 'onboarding@resend.dev' for testing — Resend provides this free)

-- Helper: get Resend API key from vault
CREATE OR REPLACE FUNCTION get_resend_key()
RETURNS TEXT AS $$
DECLARE v_key TEXT;
BEGIN
  SELECT decrypted_secret INTO v_key
  FROM vault.decrypted_secrets
  WHERE name = 'resend_api_key'
  LIMIT 1;
  RETURN v_key;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Replace send_summary_email to use Resend API
CREATE OR REPLACE FUNCTION send_summary_email(
  p_meeting_id UUID,
  p_summary_text TEXT,
  p_tone_count INTEGER DEFAULT 0,
  p_bypass_org_toggle BOOLEAN DEFAULT false
)
RETURNS BOOLEAN AS $$
DECLARE
  v_resend_key TEXT;
  v_sender_email TEXT;
  v_recipient_email TEXT;
  v_user_name TEXT;
  v_org_name TEXT;
  v_emails_enabled BOOLEAN;
  v_user_email_enabled BOOLEAN;
  v_detected_app TEXT;
  v_detected_category TEXT;
  v_meeting_start TIMESTAMPTZ;
  v_meeting_title TEXT;
  v_already_sent TIMESTAMPTZ;
  v_subject TEXT;
  v_html_body TEXT;
  v_summary_html TEXT;
  v_tone_badge TEXT;
  v_request_body JSONB;
  v_http_status INTEGER;
BEGIN
  -- Dedup: check if email already sent (with row lock to prevent race)
  SELECT email_sent_at INTO v_already_sent
  FROM meetings WHERE id = p_meeting_id FOR UPDATE;

  IF v_already_sent IS NOT NULL THEN
    RAISE NOTICE 'Email already sent for meeting %', p_meeting_id;
    RETURN TRUE;
  END IF;

  -- Get Resend API key
  v_resend_key := get_resend_key();
  IF v_resend_key IS NULL OR v_resend_key = '' THEN
    RAISE WARNING 'Resend API key not configured. Run: SELECT vault.create_secret(''resend_api_key'', ''your-key'');';
    RETURN FALSE;
  END IF;

  -- Get meeting + user + org details
  SELECT
    m.detected_app, m.detected_category, m.start_time, m.title,
    p.full_name, p.microsoft_email, COALESCE(p.email_enabled, true),
    o.name, COALESCE(o.emails_enabled, true),
    COALESCE(o.sender_email, 'onboarding@resend.dev')
  INTO
    v_detected_app, v_detected_category, v_meeting_start, v_meeting_title,
    v_user_name, v_recipient_email, v_user_email_enabled,
    v_org_name, v_emails_enabled, v_sender_email
  FROM meetings m
  JOIN profiles p ON p.id = m.user_id
  JOIN organizations o ON o.id = m.org_id
  WHERE m.id = p_meeting_id;

  -- Toggle checks
  IF NOT p_bypass_org_toggle AND NOT v_emails_enabled THEN
    RAISE NOTICE 'Org emails disabled for meeting %', p_meeting_id;
    RETURN FALSE;
  END IF;

  IF NOT v_user_email_enabled THEN
    RAISE NOTICE 'User emails disabled for meeting %', p_meeting_id;
    RETURN FALSE;
  END IF;

  IF v_recipient_email IS NULL OR v_recipient_email = '' THEN
    RAISE WARNING 'No recipient email for meeting %', p_meeting_id;
    RETURN FALSE;
  END IF;

  -- Build email subject
  v_subject := COALESCE(v_meeting_title,
    COALESCE(v_user_name, 'Employee') || '''s Meeting Summary — ' ||
    to_char(v_meeting_start AT TIME ZONE 'UTC', 'Mon DD, YYYY'));

  -- Convert markdown summary to HTML
  v_summary_html := md_to_email_html(p_summary_text);

  -- Tone alerts badge
  IF p_tone_count > 0 THEN
    v_tone_badge := '<div style="background:#fef2f2;border:1px solid #fecaca;border-radius:8px;padding:12px;margin:16px 0;">'
      || '<strong style="color:#dc2626;">⚠ ' || p_tone_count || ' Tone Alert'
      || CASE WHEN p_tone_count > 1 THEN 's' ELSE '' END
      || ' Detected</strong></div>';
  ELSE
    v_tone_badge := '';
  END IF;

  -- Build HTML email body
  v_html_body := '<!DOCTYPE html><html><head><meta charset="utf-8"></head>'
    || '<body style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;margin:0;padding:0;background:#f8fafc;">'
    || '<div style="max-width:640px;margin:0 auto;padding:20px;">'
    -- Header
    || '<div style="background:linear-gradient(135deg,#4f46e5,#7c3aed);border-radius:12px 12px 0 0;padding:24px;text-align:center;">'
    || '<h1 style="color:#fff;margin:0;font-size:20px;">Meeting Summary</h1>'
    || '<p style="color:rgba(255,255,255,0.8);margin:8px 0 0;font-size:13px;">' || COALESCE(v_org_name, 'MeetChamp') || '</p>'
    || '</div>'
    -- Meeting info
    || '<div style="background:#fff;padding:20px;border:1px solid #e2e8f0;">'
    || '<table style="width:100%;font-size:13px;color:#374151;">'
    || '<tr><td style="padding:4px 8px;color:#6b7280;">Employee</td><td style="padding:4px 8px;font-weight:600;">' || COALESCE(v_user_name, 'Unknown') || '</td></tr>'
    || '<tr><td style="padding:4px 8px;color:#6b7280;">Date</td><td style="padding:4px 8px;">' || to_char(v_meeting_start AT TIME ZONE 'UTC', 'Mon DD, YYYY HH12:MI AM') || ' UTC</td></tr>'
    || '<tr><td style="padding:4px 8px;color:#6b7280;">App</td><td style="padding:4px 8px;">' || COALESCE(v_detected_app, 'Unknown') || '</td></tr>'
    || '<tr><td style="padding:4px 8px;color:#6b7280;">Category</td><td style="padding:4px 8px;">'
    || '<span style="background:#eef2ff;color:#4f46e5;padding:2px 8px;border-radius:12px;font-size:12px;">'
    || COALESCE(v_detected_category, 'general') || '</span></td></tr>'
    || '</table>'
    || v_tone_badge
    || '</div>'
    -- Summary content
    || '<div style="background:#fff;padding:20px;border:1px solid #e2e8f0;border-top:0;">'
    || v_summary_html
    || '</div>'
    -- Footer
    || '<div style="text-align:center;padding:16px;font-size:11px;color:#9ca3af;">'
    || 'Generated by MeetChamp — ' || COALESCE(v_org_name, '') || '</div>'
    || '</div></body></html>';

  -- Send via Resend API
  v_request_body := jsonb_build_object(
    'from', v_sender_email,
    'to', jsonb_build_array(v_recipient_email),
    'subject', v_subject,
    'html', v_html_body
  );

  -- Use net.http_post (pg_net extension)
  PERFORM net.http_post(
    url := 'https://api.resend.com/emails',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || v_resend_key,
      'Content-Type', 'application/json'
    ),
    body := v_request_body
  );

  -- Mark email as sent
  UPDATE meetings SET email_sent_at = NOW() WHERE id = p_meeting_id;

  RAISE NOTICE 'Email sent for meeting % to %', p_meeting_id, v_recipient_email;
  RETURN TRUE;

EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'Email send failed for meeting %: %', p_meeting_id, SQLERRM;
  RETURN FALSE;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
