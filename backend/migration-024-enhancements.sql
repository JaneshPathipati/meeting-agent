-- file: backend/migration-024-enhancements.sql
-- Enhancements: multi-recipient email, full-text search RPC, audio cleanup cron
-- Run AFTER migration-023-feature-batch.sql

-- ── 1. send_summary_email_v2: send to all meeting attendees ──
CREATE OR REPLACE FUNCTION send_summary_email_v2(p_meeting_id UUID)
RETURNS BOOLEAN AS $$
DECLARE
  v_azure_client_id TEXT;
  v_azure_tenant_id TEXT;
  v_azure_client_secret TEXT;
  v_token_response TEXT;
  v_token JSONB;
  v_access_token TEXT;
  v_meeting RECORD;
  v_summary RECORD;
  v_org RECORD;
  v_user RECORD;
  v_html_body TEXT;
  v_recipients JSONB := '[]'::JSONB;
  v_attendee JSONB;
  v_attendee_email TEXT;
  v_email_payload JSONB;
  v_send_result TEXT;
  v_send_status INTEGER;
  v_subject TEXT;
BEGIN
  -- Load Azure credentials
  v_azure_client_id     := get_vault_secret('azure_client_id');
  v_azure_tenant_id     := get_vault_secret('azure_tenant_id');
  v_azure_client_secret := get_vault_secret('azure_client_secret');

  IF v_azure_client_id IS NULL OR v_azure_tenant_id IS NULL OR v_azure_client_secret IS NULL THEN
    RAISE WARNING '[email_v2] Azure credentials not configured in vault';
    RETURN FALSE;
  END IF;

  -- Get meeting details
  SELECT m.*, p.full_name AS employee_name, p.microsoft_email AS employee_email
  INTO v_meeting
  FROM meetings m
  JOIN profiles p ON p.id = m.user_id
  WHERE m.id = p_meeting_id;

  IF NOT FOUND THEN
    RAISE WARNING '[email_v2] Meeting not found: %', p_meeting_id;
    RETURN FALSE;
  END IF;

  -- Get org settings
  SELECT * INTO v_org FROM organizations WHERE id = v_meeting.org_id;
  IF NOT FOUND OR v_org.sender_email IS NULL THEN
    RAISE WARNING '[email_v2] No sender email configured for org %', v_meeting.org_id;
    RETURN FALSE;
  END IF;

  -- Check org emails_enabled
  IF v_org.emails_enabled = FALSE THEN
    RETURN FALSE;
  END IF;

  -- Get user profile to check email_enabled
  SELECT * INTO v_user FROM profiles WHERE id = v_meeting.user_id;
  IF v_user.email_enabled = FALSE THEN
    RETURN FALSE;
  END IF;

  -- Get summary
  SELECT * INTO v_summary FROM summaries WHERE meeting_id = p_meeting_id AND is_default = TRUE LIMIT 1;
  IF NOT FOUND THEN
    RAISE WARNING '[email_v2] No summary found for meeting %', p_meeting_id;
    RETURN FALSE;
  END IF;

  -- Acquire OAuth token
  BEGIN
    SELECT status_code, content::text
    INTO v_send_status, v_token_response
    FROM http((
      'POST',
      'https://login.microsoftonline.com/' || v_azure_tenant_id || '/oauth2/v2.0/token',
      ARRAY[http_header('Content-Type', 'application/x-www-form-urlencoded')],
      'application/x-www-form-urlencoded',
      'grant_type=client_credentials'
        || '&client_id=' || v_azure_client_id
        || '&client_secret=' || v_azure_client_secret
        || '&scope=https%3A%2F%2Fgraph.microsoft.com%2F.default'
    )::http_request);
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING '[email_v2] Token fetch failed: %', SQLERRM;
    RETURN FALSE;
  END;

  IF v_send_status <> 200 THEN
    RAISE WARNING '[email_v2] Token request returned %', v_send_status;
    RETURN FALSE;
  END IF;

  v_token := v_token_response::JSONB;
  v_access_token := v_token->>'access_token';
  IF v_access_token IS NULL THEN
    RAISE WARNING '[email_v2] No access_token in response';
    RETURN FALSE;
  END IF;

  -- Build HTML body from markdown
  v_html_body := md_to_email_html(v_summary.content);

  -- Build recipient list: always include employee, plus any attendees from meetings.attendees
  -- Employee email
  IF v_meeting.employee_email IS NOT NULL AND v_meeting.employee_email <> '' THEN
    v_recipients := v_recipients || jsonb_build_object(
      'emailAddress', jsonb_build_object('address', v_meeting.employee_email)
    );
  END IF;

  -- Add attendees from meetings.attendees JSONB array
  IF v_meeting.attendees IS NOT NULL AND jsonb_array_length(v_meeting.attendees) > 0 THEN
    FOR v_attendee IN SELECT * FROM jsonb_array_elements(v_meeting.attendees)
    LOOP
      v_attendee_email := v_attendee->>'email';
      -- Skip blank emails and the employee (already added)
      IF v_attendee_email IS NOT NULL
        AND v_attendee_email <> ''
        AND v_attendee_email <> v_meeting.employee_email
      THEN
        v_recipients := v_recipients || jsonb_build_object(
          'emailAddress', jsonb_build_object('address', v_attendee_email)
        );
      END IF;
    END LOOP;
  END IF;

  IF jsonb_array_length(v_recipients) = 0 THEN
    RAISE WARNING '[email_v2] No recipients for meeting %', p_meeting_id;
    RETURN FALSE;
  END IF;

  -- Build subject
  v_subject := COALESCE(
    v_meeting.title,
    'Meeting Summary — ' || v_meeting.employee_name || ' — ' || to_char(v_meeting.start_time AT TIME ZONE 'UTC', 'Mon DD, YYYY')
  );

  -- Build email JSON payload
  v_email_payload := jsonb_build_object(
    'message', jsonb_build_object(
      'subject', v_subject,
      'body', jsonb_build_object(
        'contentType', 'HTML',
        'content', '<div style="font-family:Inter,Helvetica,Arial,sans-serif;max-width:700px;margin:0 auto;background:#fff;">'
          || '<div style="background:linear-gradient(135deg,#4f46e5,#7c3aed);padding:32px 40px;">'
          || '<h1 style="color:#fff;margin:0;font-size:24px;">Meeting Summary</h1>'
          || '<p style="color:rgba(255,255,255,0.8);margin:8px 0 0;font-size:14px;">'
          || v_meeting.employee_name || ' · '
          || to_char(v_meeting.start_time AT TIME ZONE 'UTC', 'Mon DD, YYYY HH24:MI') || ' UTC'
          || '</p></div>'
          || '<div style="padding:32px 40px;">'
          || v_html_body
          || '</div>'
          || '<div style="padding:16px 40px;background:#F9FAFB;border-top:1px solid #E5E7EB;font-size:11px;color:#9CA3AF;">'
          || 'Generated by MeetChamp · Do not reply to this email'
          || '</div></div>'
      ),
      'toRecipients', v_recipients
    ),
    'saveToSentItems', 'false'
  );

  -- Send the email
  BEGIN
    SELECT status_code, content::text
    INTO v_send_status, v_send_result
    FROM http((
      'POST',
      'https://graph.microsoft.com/v1.0/users/' || v_org.sender_email || '/sendMail',
      ARRAY[
        http_header('Authorization', 'Bearer ' || v_access_token),
        http_header('Content-Type', 'application/json')
      ],
      'application/json',
      v_email_payload::text
    )::http_request);
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING '[email_v2] sendMail failed: %', SQLERRM;
    RETURN FALSE;
  END;

  IF v_send_status NOT IN (200, 202) THEN
    RAISE WARNING '[email_v2] sendMail returned %: %', v_send_status, left(v_send_result, 200);
    RETURN FALSE;
  END IF;

  -- Mark email sent
  UPDATE meetings SET email_sent_at = NOW() WHERE id = p_meeting_id;

  RETURN TRUE;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ── 2. send_manual_email: RPC for admin dashboard "Send Email" button ──
-- Calls send_summary_email_v2 instead of old single-recipient function
CREATE OR REPLACE FUNCTION send_manual_email(p_meeting_id UUID)
RETURNS BOOLEAN AS $$
  SELECT send_summary_email_v2(p_meeting_id);
$$ LANGUAGE sql SECURITY DEFINER;

-- ── 3. search_meetings: full-text search across transcripts + meeting metadata ──
CREATE OR REPLACE FUNCTION search_meetings(
  p_org_id UUID,
  p_query TEXT,
  p_limit INTEGER DEFAULT 20,
  p_offset INTEGER DEFAULT 0
)
RETURNS TABLE (
  meeting_id UUID,
  user_id UUID,
  full_name TEXT,
  start_time TIMESTAMPTZ,
  detected_app TEXT,
  detected_category TEXT,
  status TEXT,
  rank REAL
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    m.id AS meeting_id,
    m.user_id,
    p.full_name,
    m.start_time,
    m.detected_app,
    m.detected_category,
    m.status,
    ts_rank(t.transcript_fts, plainto_tsquery('english', p_query)) AS rank
  FROM meetings m
  JOIN profiles p ON p.id = m.user_id
  JOIN transcripts t ON t.meeting_id = m.id
  WHERE m.org_id = p_org_id
    AND t.transcript_fts @@ plainto_tsquery('english', p_query)
  ORDER BY rank DESC, m.start_time DESC
  LIMIT p_limit
  OFFSET p_offset;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER STABLE;

-- ── 4. cleanup_processed_audio: pg_cron job to mark old audio for deletion ──
-- Runs daily. Marks meetings whose audio has been processed >7 days ago.
-- The Electron agent checks this flag and deletes the local audio files.
CREATE OR REPLACE FUNCTION cleanup_processed_audio()
RETURNS void AS $$
BEGIN
  -- Mark meetings where audio should be deleted
  -- (processed more than 7 days ago, audio not yet marked deleted)
  UPDATE meetings
  SET audio_deleted_at = NOW()
  WHERE status = 'processed'
    AND audio_deleted_at IS NULL
    AND updated_at < NOW() - INTERVAL '7 days';

  RAISE LOG '[cleanup_audio] Marked % meetings for audio deletion',
    (SELECT COUNT(*) FROM meetings WHERE audio_deleted_at IS NOT NULL);
END;
$$ LANGUAGE plpgsql;

-- Schedule daily audio cleanup at 3 AM UTC
SELECT cron.schedule(
  'cleanup-processed-audio',
  '0 3 * * *',
  $$SELECT cleanup_processed_audio()$$
);
