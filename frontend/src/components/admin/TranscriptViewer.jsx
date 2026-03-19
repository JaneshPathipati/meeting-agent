// file: frontend/src/components/admin/TranscriptViewer.jsx
import React, { useMemo, useEffect, useState } from 'react';
import { FileText, Cpu, Cloud, ChevronDown, ChevronUp } from 'lucide-react';
import EmptyState from '../shared/EmptyState';

const highlightStyles = {
  high:   'bg-red-100/80 border-b-2 border-red-400 rounded-sm px-0.5',
  medium: 'bg-orange-100/80 border-b-2 border-orange-400 rounded-sm px-0.5',
  low:    'bg-yellow-100/80 border-b-2 border-yellow-400 rounded-sm px-0.5',
};

function renderHighlightedText(text, segmentAlerts) {
  if (!segmentAlerts || segmentAlerts.length === 0) return text;

  const matches = [];
  segmentAlerts.forEach(alert => {
    if (!alert.flagged_text) return;
    const lowerText = text.toLowerCase();
    const lowerFlagged = alert.flagged_text.toLowerCase();
    const idx = lowerText.indexOf(lowerFlagged);
    if (idx !== -1) matches.push({ start: idx, end: idx + alert.flagged_text.length, severity: alert.severity });
  });

  if (matches.length === 0) {
    const highestSeverity = segmentAlerts.reduce((h, a) => {
      const order = { high: 3, medium: 2, low: 1 };
      return (order[a.severity] || 0) > (order[h] || 0) ? a.severity : h;
    }, 'low');
    return <mark className={highlightStyles[highestSeverity]}>{text}</mark>;
  }

  matches.sort((a, b) => a.start - b.start);
  const merged = [];
  for (const m of matches) {
    if (merged.length === 0 || m.start >= merged[merged.length - 1].end) merged.push({ ...m });
  }

  const parts = [];
  let lastIdx = 0;
  merged.forEach((m, i) => {
    if (m.start > lastIdx) parts.push(<span key={`t-${i}`}>{text.slice(lastIdx, m.start)}</span>);
    parts.push(<mark key={`h-${i}`} className={highlightStyles[m.severity] || highlightStyles.low}>{text.slice(m.start, m.end)}</mark>);
    lastIdx = m.end;
  });
  if (lastIdx < text.length) parts.push(<span key="tail">{text.slice(lastIdx)}</span>);
  return parts;
}

/* ── Speaker Talk-Time Breakdown ─────────────────────────────────── */
const SPEAKER_COLORS = ['#F97316', '#3B82F6', '#10B981', '#8B5CF6', '#F59E0B', '#EC4899', '#14B8A6'];

function SpeakerBreakdown({ segments }) {
  const [expanded, setExpanded] = useState(false);

  const stats = useMemo(() => {
    const map = {};
    segments.forEach(seg => {
      const speaker = seg.speaker || 'Unknown';
      if (!map[speaker]) map[speaker] = { words: 0, segments: 0 };
      map[speaker].words += (seg.text || '').split(/\s+/).filter(Boolean).length;
      map[speaker].segments += 1;
    });
    const entries = Object.entries(map).sort((a, b) => b[1].words - a[1].words);
    const totalWords = entries.reduce((s, [, v]) => s + v.words, 0);
    return entries.map(([name, v]) => ({
      name,
      words: v.words,
      segments: v.segments,
      pct: totalWords > 0 ? Math.round((v.words / totalWords) * 100) : 0,
    }));
  }, [segments]);

  if (stats.length < 2) return null;

  const topTwo = stats.slice(0, 2);
  const rest = stats.slice(2);

  return (
    <div
      className="px-5 py-4"
      style={{ background: '#F9F8F6', borderBottom: '1px solid rgba(226,232,240,0.8)' }}
    >
      <div className="flex items-center justify-between mb-3">
        <p className="text-[10px] uppercase tracking-[0.28em] font-semibold text-[#94A3B8]">Speaker Breakdown</p>
        {rest.length > 0 && (
          <button
            onClick={() => setExpanded(e => !e)}
            className="flex items-center gap-0.5 text-[10px] text-[#94A3B8] hover:text-[#64748B] transition-colors"
          >
            {expanded ? 'Less' : `+${rest.length} more`}
            {expanded ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
          </button>
        )}
      </div>
      <div className="space-y-2">
        {(expanded ? stats : topTwo).map((s, i) => (
          <div key={s.name} className="flex items-center gap-2.5">
            <span
              className="flex-shrink-0 h-2 w-2 rounded-full"
              style={{ background: SPEAKER_COLORS[i % SPEAKER_COLORS.length] }}
            />
            <span className="text-[12px] text-[#475569] w-28 truncate font-medium">{s.name}</span>
            <div className="flex-1 h-1.5 rounded-full overflow-hidden" style={{ background: 'rgba(226,232,240,0.8)' }}>
              <div
                className="h-full rounded-full"
                style={{
                  width: `${s.pct}%`,
                  background: SPEAKER_COLORS[i % SPEAKER_COLORS.length],
                  transition: 'width 0.6s cubic-bezier(0.22,1,0.36,1)',
                }}
              />
            </div>
            <span className="text-[11px] font-semibold w-8 text-right" style={{ color: SPEAKER_COLORS[i % SPEAKER_COLORS.length] }}>{s.pct}%</span>
            <span className="text-[10px] text-[#94A3B8] w-16 text-right hidden sm:block">{s.words.toLocaleString()} words</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function parseTimestamp(ts) {
  if (!ts || typeof ts !== 'string') return NaN;
  const parts = ts.split(':').map(Number);
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return NaN;
}

function TranscriptViewer({ transcript, alerts = [], highlightTime, transcriptRef }) {
  const alertsByTime = useMemo(() => {
    const map = new Map();
    if (!alerts.length) return map;

    const segments = transcript?.transcript_json?.segments || [];

    alerts.forEach(a => {
      if (!a.start_time) return;

      // 1. Exact timestamp match
      if (segments.some(s => s.start_time === a.start_time)) {
        const list = map.get(a.start_time) || [];
        list.push(a);
        map.set(a.start_time, list);
        return;
      }

      // 2. Text content match
      if (a.flagged_text) {
        const lowerFlagged = a.flagged_text.toLowerCase();
        const textMatch = segments.find(s => s.text && s.text.toLowerCase().includes(lowerFlagged));
        if (textMatch) {
          const list = map.get(textMatch.start_time) || [];
          list.push(a);
          map.set(textMatch.start_time, list);
          return;
        }
      }

      // 3. Fuzzy timestamp — nearest within 2 minutes
      const alertSec = parseTimestamp(a.start_time);
      if (!isNaN(alertSec)) {
        let bestTs = null, bestDiff = Infinity;
        for (const s of segments) {
          const sec = parseTimestamp(s.start_time);
          if (isNaN(sec)) continue;
          const diff = Math.abs(sec - alertSec);
          if (diff < bestDiff && diff <= 120) { bestDiff = diff; bestTs = s.start_time; }
        }
        if (bestTs) {
          const list = map.get(bestTs) || [];
          list.push(a);
          map.set(bestTs, list);
        }
      }
    });
    return map;
  }, [alerts, transcript]);

  useEffect(() => {
    if (highlightTime && transcriptRef?.current) {
      const timer = setTimeout(() => {
        const target = transcriptRef.current.querySelector(`[data-time="${highlightTime}"]`);
        if (target) target.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }, 300);
      return () => clearTimeout(timer);
    }
  }, [highlightTime, transcriptRef, transcript]);

  if (!transcript) {
    return (
      <div
        className="rounded-[20px] p-5"
        style={{
          background: 'rgba(255,255,255,0.92)',
          border: '1px solid rgba(226,232,240,0.7)',
          boxShadow: '0 4px 24px rgba(15,23,42,0.07)',
        }}
      >
        <EmptyState icon={FileText} title="No transcript" description="Transcript is not yet available" />
      </div>
    );
  }

  const transcriptJson = transcript.transcript_json;
  const hasMalformedData = transcriptJson && !Array.isArray(transcriptJson.segments);
  const segments = transcriptJson?.segments || [];
  const metadataSource = transcriptJson?.metadata?.source || transcript.source || 'local';
  const isTeams = transcript.source === 'teams' || metadataSource === 'teams';
  const isAssemblyAI = metadataSource === 'assemblyai';
  const sourceBadge = isTeams ? 'Teams' : isAssemblyAI ? 'AssemblyAI' : 'Local';

  const sourceBadgeStyle = isTeams
    ? { background: '#EEF2FF', color: '#4F46E5', border: '1px solid #C7D2FE' }
    : isAssemblyAI
      ? { background: '#ECFDF5', color: '#059669', border: '1px solid #A7F3D0' }
      : { background: '#F4F2EF', color: '#64748B', border: '1px solid rgba(226,232,240,0.8)' };

  return (
    <div
      className="rounded-[20px] overflow-hidden"
      style={{
        background: 'rgba(255,255,255,0.92)',
        border: '1px solid rgba(226,232,240,0.7)',
        boxShadow: '0 4px 24px rgba(15,23,42,0.07)',
      }}
    >
      {/* Header */}
      <div
        className="flex items-center justify-between px-5 py-4"
        style={{ borderBottom: '1px solid rgba(226,232,240,0.7)' }}
      >
        <div>
          <p className="text-[10px] uppercase tracking-[0.28em] font-semibold text-[#94A3B8] mb-0.5">Recording</p>
          <h3
            className="text-[16px] font-semibold text-[#020617] flex items-center gap-2"
            style={{ fontFamily: 'Geist, ui-sans-serif, system-ui, sans-serif' }}
          >
            <FileText className="h-4 w-4 text-[#64748B]" />
            Transcript
          </h3>
        </div>
        <div className="flex items-center gap-2">
          <span
            className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-semibold"
            style={sourceBadgeStyle}
          >
            {isTeams ? <Cloud className="h-3 w-3" /> : <Cpu className="h-3 w-3" />}
            {sourceBadge}
          </span>
          {transcript.word_count && (
            <span className="text-[11px] text-[#94A3B8] font-medium">{transcript.word_count.toLocaleString()} words</span>
          )}
        </div>
      </div>

      <SpeakerBreakdown segments={segments} />

      {/* Segments */}
      <div ref={transcriptRef} className="p-5 max-h-[600px] overflow-y-auto space-y-1">
        {hasMalformedData && (
          <div
            className="rounded-[12px] px-4 py-3 text-[12px] mb-3"
            style={{ background: '#FFFBEB', border: '1px solid #FDE68A', color: '#92400E' }}
          >
            Transcript data is malformed — local recording may have failed. Raw data is stored but cannot be displayed.
          </div>
        )}
        {segments.map((segment, idx) => {
          const segmentAlerts = alertsByTime.get(segment.start_time) || [];
          const isHighlighted = highlightTime && segment.start_time === highlightTime;
          const hasAlert = segmentAlerts.length > 0;

          return (
            <div
              key={idx}
              data-time={segment.start_time}
              className="flex gap-3 rounded-[12px] px-3 py-2 transition-all duration-300"
              style={
                isHighlighted
                  ? { background: '#FFF7ED', border: '1px solid #FED7AA' }
                  : hasAlert
                    ? { background: '#FFFBEB' }
                    : {}
              }
            >
              <div className="flex-shrink-0 w-16 text-[11px] text-[#94A3B8] pt-0.5 font-mono leading-relaxed">
                {segment.start_time}
              </div>
              <div className="flex-1 min-w-0">
                <span className="text-[11px] font-semibold" style={{ color: '#F97316' }}>
                  {segment.speaker}
                </span>
                <p className="text-[13px] text-[#374151] mt-0.5 leading-relaxed">
                  {renderHighlightedText(segment.text, segmentAlerts)}
                </p>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default TranscriptViewer;
