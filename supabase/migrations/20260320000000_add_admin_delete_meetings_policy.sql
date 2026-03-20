-- Allow admins to delete meetings in their org
-- This was missing, causing silent failures when admins tried to delete sessions.
CREATE POLICY "Admins delete org meetings" ON meetings FOR DELETE
  USING (org_id = get_my_org_id() AND is_admin());

-- Allow admins to update meeting records (e.g. category, status corrections)
CREATE POLICY "Admins update org meetings" ON meetings FOR UPDATE
  USING (org_id = get_my_org_id() AND is_admin());
