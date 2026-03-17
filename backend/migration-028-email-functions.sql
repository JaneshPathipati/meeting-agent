-- migration-028-email-functions.sql
-- Creates missing email helper functions: send_deferred_email and send_manual_email
-- Run this AFTER migration-027-resend-email.sql

-- send_deferred_email: called by client-agent after uploading a meeting with pre-generated summary
CREATE OR REPLACE FUNCTION send_deferred_email(p_meeting_id UUID)
RETURNS BOOLEAN AS $$
DECLARE
  v_summary_text TEXT;
  v_tone_count INTEGER;
  v_org_emails_enabled BOOLEAN;
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

  -- Get the default summary for this meeting
  SELECT content INTO v_summary_text
  FROM summaries
  WHERE meeting_id = p_meeting_id AND is_default = true
  LIMIT 1;

  IF v_summary_text IS NULL OR v_summary_text = '' THEN
    RAISE NOTICE 'send_deferred_email: No summary found for meeting %', p_meeting_id;
    RETURN FALSE;
  END IF;

  SELECT COUNT(*) INTO v_tone_count
  FROM tone_alerts
  WHERE meeting_id = p_meeting_id;

  RETURN send_summary_email(p_meeting_id, v_summary_text, v_tone_count);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- send_manual_email: called from admin panel "Send Email" button
CREATE OR REPLACE FUNCTION send_manual_email(p_meeting_id UUID)
RETURNS BOOLEAN AS $$
DECLARE
  v_summary_text TEXT;
  v_tone_count INTEGER;
BEGIN
  -- Get the default summary
  SELECT content INTO v_summary_text
  FROM summaries
  WHERE meeting_id = p_meeting_id AND is_default = true
  LIMIT 1;

  IF v_summary_text IS NULL OR v_summary_text = '' THEN
    RETURN FALSE;
  END IF;

  SELECT COUNT(*) INTO v_tone_count
  FROM tone_alerts
  WHERE meeting_id = p_meeting_id;

  -- Clear email_sent_at to allow re-send
  UPDATE meetings SET email_sent_at = NULL WHERE id = p_meeting_id;

  -- Send with bypass_org_toggle = true (admin override)
  RETURN send_summary_email(p_meeting_id, v_summary_text, v_tone_count, true);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
