-- migration-021-email-html-fix2.sql
-- Fixes remaining raw-markdown leakage in email HTML conversion.
--
-- Gaps fixed (confirmed by live test failures):
--   1. Trailing whitespace on table rows — regex ^\|.+\|$ required a trailing |
--      but AI responses often have trailing spaces → entire table fell through to
--      raw <p>| Owner | Task |</p> output. Fix: trim each line before all checks.
--   2. Table rows without trailing pipe — AI occasionally omits the last |.
--      Fix: relax table detection to ^\|.+ (starts with pipe) instead of ^\|.+\|$.
--   3. # H1 heading — no handler → shows "# Meeting Summary" as raw paragraph text.
--      Fix: add H1 → <h1> handler before the existing H2 handler.
--
-- Safe to re-run (CREATE OR REPLACE + IMMUTABLE).

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
    -- FIX 1: trim every line so trailing spaces never break pattern matching
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

    -- FIX 2: table separator row — relaxed to not require trailing pipe
    -- Matches |---|---| and also |---|--- (no trailing pipe)
    IF v_line ~ '^\|[\s\-:|]+' AND v_line !~ '[^|\s\-:]' THEN
      CONTINUE;
    END IF;

    -- FIX 2: table row — relaxed to ^\|.+ (starts with pipe) instead of ^\|.+\|$
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

    -- FIX 3: # H1 heading
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
