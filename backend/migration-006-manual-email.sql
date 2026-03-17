-- migration-006-manual-email.sql
-- Adds send_manual_email() RPC for admin-triggered email sending.
-- Bypasses org-level emails_enabled toggle (admin override).
-- Run this in Supabase SQL Editor.

CREATE OR REPLACE FUNCTION send_manual_email(p_meeting_id UUID)
RETURNS BOOLEAN AS $$
DECLARE
  v_summary_text TEXT;
  v_tone_count INTEGER;
  v_result BOOLEAN;
BEGIN
  -- Only admins can call this
  IF NOT is_admin() THEN
    RAISE EXCEPTION 'send_manual_email: caller is not an admin';
  END IF;

  -- Get the default summary for this meeting
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

  -- Directly call send_summary_email — no org-level toggle check
  v_result := send_summary_email(p_meeting_id, v_summary_text, v_tone_count);
  RETURN v_result;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Allow authenticated users (admins) to call via RPC
GRANT EXECUTE ON FUNCTION send_manual_email(UUID) TO authenticated;
