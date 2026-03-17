-- file: backend/migration-003-email.sql
-- MeetChamp - Email Summary Feature Migration
-- Run this in Supabase SQL Editor

-- 1. Add sender_email column to organizations
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS sender_email TEXT;

-- 2. Store Azure credentials in vault for Graph API email sending
-- Client secret for Microsoft Graph Mail.Send (application permission)
-- IMPORTANT: Credentials must be provisioned separately via the Supabase Vault UI or secrets manager.
-- Do NOT commit credential values here. Run these manually with actual values:
-- SELECT vault.create_secret('<azure_client_secret>', 'azure_client_secret');
-- SELECT vault.create_secret('<azure_tenant_id>', 'azure_tenant_id');
-- SELECT vault.create_secret('<azure_client_id>', 'azure_client_id');

-- 3. Helper: get vault secret by name
CREATE OR REPLACE FUNCTION get_vault_secret(p_name TEXT)
RETURNS TEXT AS $$
  SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = p_name LIMIT 1;
$$ LANGUAGE sql SECURITY DEFINER STABLE;

-- 4. Helper: convert markdown to styled HTML for email
-- NOTE: Keep this in sync with migration-021-email-html-fix2.sql.
-- When re-deploying this file, ensure this is the latest version.
CREATE OR REPLACE FUNCTION md_to_email_html(p_md TEXT)
RETURNS TEXT AS $$
DECLARE
  v_lines TEXT[];
  v_line TEXT;
  v_html TEXT := '';
  v_i INTEGER;
  v_in_table BOOLEAN := FALSE;
  v_in_ul BOOLEAN := FALSE;
  v_in_ol BOOLEAN := FALSE;
BEGIN
  IF p_md IS NULL OR p_md = '' THEN RETURN ''; END IF;

  -- Normalise line endings: strip \r so trailing-space / CRLF issues don't
  -- break the regex anchors (e.g. ^\|.+\|$ failing on "| foo |\r").
  p_md := regexp_replace(p_md, E'\\r', '', 'g');

  v_lines := string_to_array(p_md, E'\n');

  FOR v_i IN 1..array_length(v_lines, 1) LOOP
    -- Trim every line so trailing spaces never break pattern matching
    v_line := trim(v_lines[v_i]);

    -- Close open list if line is not a list item
    IF v_in_ul AND v_line !~ '^\s*[-*]\s' THEN
      v_html := v_html || '</ul>';
      v_in_ul := FALSE;
    END IF;
    IF v_in_ol AND v_line !~ '^\s*\d+\.\s' THEN
      v_html := v_html || '</ol>';
      v_in_ol := FALSE;
    END IF;

    -- Table separator row — relaxed to not require trailing pipe
    -- Matches |---|---| and also |---|--- (no trailing pipe)
    IF v_line ~ '^\|[\s\-:|]+' AND v_line !~ '[^|\s\-:]' THEN
      CONTINUE;
    END IF;

    -- Table row — relaxed to ^\|.+ (starts with pipe) instead of ^\|.+\|$
    -- This handles both "| a | b |" and "| a | b" (no trailing pipe)
    IF v_line ~ '^\|.+' THEN
      IF NOT v_in_table THEN
        v_in_table := TRUE;
        v_html := v_html || '<table style="width:100%;border-collapse:collapse;margin:12px 0;font-size:13px;">';
        -- First table row = header
        v_line := regexp_replace(v_line, '^\|', '');
        v_line := regexp_replace(v_line, '\|$', '');
        v_html := v_html || '<tr>';
        DECLARE v_cell TEXT;
        BEGIN
          FOREACH v_cell IN ARRAY string_to_array(v_line, '|') LOOP
            v_cell := regexp_replace(trim(v_cell), '\*\*([^*]+)\*\*', '<strong style="color:#4338CA;">\1</strong>', 'g');
            v_html := v_html || '<th style="background:#EEF2FF;color:#4338CA;padding:8px 12px;border:1px solid #E5E7EB;text-align:left;font-weight:600;">' || v_cell || '</th>';
          END LOOP;
        END;
        v_html := v_html || '</tr>';
      ELSE
        v_line := regexp_replace(v_line, '^\|', '');
        v_line := regexp_replace(v_line, '\|$', '');
        v_html := v_html || '<tr>';
        DECLARE v_cell TEXT;
        BEGIN
          FOREACH v_cell IN ARRAY string_to_array(v_line, '|') LOOP
            v_cell := regexp_replace(trim(v_cell), '\*\*([^*]+)\*\*', '<strong style="color:#1F2937;">\1</strong>', 'g');
            v_html := v_html || '<td style="padding:8px 12px;border:1px solid #E5E7EB;">' || v_cell || '</td>';
          END LOOP;
        END;
        v_html := v_html || '</tr>';
      END IF;
      CONTINUE;
    ELSE
      IF v_in_table THEN
        v_html := v_html || '</table>';
        v_in_table := FALSE;
      END IF;
    END IF;

    -- Empty line
    IF trim(v_line) = '' THEN
      CONTINUE;
    END IF;

    -- ### H3 heading (must be before ## H2 check)
    IF v_line ~ '^###\s+' THEN
      v_line := regexp_replace(v_line, '^###\s+', '');
      v_line := regexp_replace(v_line, '\*\*([^*]+)\*\*', '\1', 'g');
      v_html := v_html || '<h3 style="margin:16px 0 6px 0;font-size:14px;font-weight:700;color:#374151;">' || v_line || '</h3>';
      CONTINUE;
    END IF;

    -- ## H2 heading (must be before # H1 check — ## starts with # but is more specific)
    IF v_line ~ '^##\s+' THEN
      v_line := regexp_replace(v_line, '^##\s+', '');
      v_line := regexp_replace(v_line, '\*\*([^*]+)\*\*', '\1', 'g');
      v_html := v_html || '<h2 style="margin:20px 0 8px 0;font-size:16px;font-weight:700;color:#1F2937;border-bottom:2px solid #E5E7EB;padding-bottom:6px;">' || v_line || '</h2>';
      CONTINUE;
    END IF;

    -- # H1 heading
    IF v_line ~ '^#\s+' THEN
      v_line := regexp_replace(v_line, '^#\s+', '');
      v_line := regexp_replace(v_line, '\*\*([^*]+)\*\*', '\1', 'g');
      v_html := v_html || '<h1 style="margin:0 0 12px 0;font-size:18px;font-weight:700;color:#1F2937;">' || v_line || '</h1>';
      CONTINUE;
    END IF;

    -- Bullet list item (- or *)
    IF v_line ~ '^\s*[-*]\s' THEN
      v_line := regexp_replace(v_line, '^\s*[-*]\s+', '');
      v_line := regexp_replace(v_line, '\*\*([^*]+)\*\*', '<strong style="color:#1F2937;">\1</strong>', 'g');
      IF NOT v_in_ul THEN
        v_html := v_html || '<ul style="margin:6px 0;padding-left:20px;">';
        v_in_ul := TRUE;
      END IF;
      v_html := v_html || '<li style="margin:3px 0;color:#374151;">' || v_line || '</li>';
      CONTINUE;
    END IF;

    -- Numbered list item
    IF v_line ~ '^\s*\d+\.\s' THEN
      v_line := regexp_replace(v_line, '^\s*\d+\.\s+', '');
      v_line := regexp_replace(v_line, '\*\*([^*]+)\*\*', '<strong style="color:#1F2937;">\1</strong>', 'g');
      IF NOT v_in_ol THEN
        v_html := v_html || '<ol style="margin:6px 0;padding-left:20px;">';
        v_in_ol := TRUE;
      END IF;
      v_html := v_html || '<li style="margin:3px 0;color:#374151;">' || v_line || '</li>';
      CONTINUE;
    END IF;

    -- Regular paragraph — apply bold
    v_line := regexp_replace(v_line, '\*\*([^*]+)\*\*', '<strong style="color:#1F2937;">\1</strong>', 'g');
    v_html := v_html || '<p style="margin:4px 0;color:#374151;">' || v_line || '</p>';
  END LOOP;

  -- Close any open tags
  IF v_in_ul THEN v_html := v_html || '</ul>'; END IF;
  IF v_in_ol THEN v_html := v_html || '</ol>'; END IF;
  IF v_in_table THEN v_html := v_html || '</table>'; END IF;

  RETURN v_html;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- 5. Function: send email via Microsoft Graph API
-- Uses client credentials flow (application permission Mail.Send)
-- Sender = org's sender_email, Recipient = user's microsoft_email
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
      'saveToSentItems', TRUE
    )::text
  )::extensions.http_request);

  -- Graph API returns 202 Accepted for sendMail
  IF v_mail_response.status NOT IN (200, 202) THEN
    RAISE WARNING 'send_summary_email: Graph sendMail failed HTTP %: %', v_mail_response.status, left(v_mail_response.content, 300);
    RETURN FALSE;
  END IF;

  RAISE NOTICE 'send_summary_email: Email sent to % for meeting %', v_recipient_email, p_meeting_id;
  RETURN TRUE;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
