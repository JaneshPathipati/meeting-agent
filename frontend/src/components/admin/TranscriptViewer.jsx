// file: frontend/src/components/admin/TranscriptViewer.jsx
import React, { useMemo, useEffect, useState } from 'react';
import { FileText, Cpu, Cloud, ChevronDown, ChevronUp } from 'lucide-react';
import EmptyState from '../shared/EmptyState';

const highlightStyles = {
  high: 'bg-red-200/60 dark:bg-red-900/40 border-b-2 border-red-400 rounded-sm px-0.5',
  medium: 'bg-orange-200/60 dark:bg-orange-900/40 border-b-2 border-orange-400 rounded-sm px-0.5',
  low: 'bg-yellow-200/60 dark:bg-yellow-900/40 border-b-2 border-yellow-400 rounded-sm px-0.5',
};

function renderHighlightedText(text, segmentAlerts) {
  if (!segmentAlerts || segmentAlerts.length === 0) return text;

  // Find all match positions
  const matches = [];
  segmentAlerts.forEach(alert => {
    if (!alert.flagged_text) return;
    const lowerText = text.toLowerCase();
    const lowerFlagged = alert.flagged_text.toLowerCase();
    const idx = lowerText.indexOf(lowerFlagged);
    if (idx !== -1) {
      matches.push({
        start: idx,
        end: idx + alert.flagged_text.length,
        severity: alert.severity,
      });
    }
  });

  // If no exact matches found, highlight the entire segment subtly
  if (matches.length === 0) {
    const highestSeverity = segmentAlerts.reduce((h, a) => {
      const order = { high: 3, medium: 2, low: 1 };
      return (order[a.severity] || 0) > (order[h] || 0) ? a.severity : h;
    }, 'low');
    return <mark className={highlightStyles[highestSeverity]}>{text}</mark>;
  }

  // Sort by start position and remove overlaps (keep higher severity)
  matches.sort((a, b) => a.start - b.start);
  const merged = [];
  for (const m of matches) {
    if (merged.length === 0 || m.start >= merged[merged.length - 1].end) {
      merged.push({ ...m });
    }
  }

  // Build the result fragments
  const parts = [];
  let lastIdx = 0;
  merged.forEach((m, i) => {
    if (m.start > lastIdx) {
      parts.push(<span key={`t-${i}`}>{text.slice(lastIdx, m.start)}</span>);
    }
    parts.push(
      <mark key={`h-${i}`} className={highlightStyles[m.severity] || highlightStyles.low}>
        {text.slice(m.start, m.end)}
      </mark>
    );
    lastIdx = m.end;
  });
  if (lastIdx < text.length) {
    parts.push(<span key="tail">{text.slice(lastIdx)}</span>);
  }
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
    <div className="px-4 py-3 border-b dark:border-gray-700 bg-gray-50/50 dark:bg-gray-900/20">
      <div className="flex items-center justify-between mb-2">
        <p className="text-[10px] uppercase tracking-widest text-gray-400 font-medium">Speaker Breakdown</p>
        {rest.length > 0 && (
          <button
            onClick={() => setExpanded(e => !e)}
            className="flex items-center gap-0.5 text-[10px] text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
          >
            {expanded ? 'Less' : `+${rest.length} more`}
            {expanded ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
          </button>
        )}
      </div>
      <div className="space-y-1.5">
        {(expanded ? stats : topTwo).map((s, i) => (
          <div key={s.name} className="flex items-center gap-2">
            <span
              className="flex-shrink-0 h-2 w-2 rounded-full"
              style={{ background: SPEAKER_COLORS[i % SPEAKER_COLORS.length] }}
            />
            <span className="text-xs text-gray-700 dark:text-gray-300 w-28 truncate font-medium">{s.name}</span>
            <div className="flex-1 h-1.5 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
              <div
                className="h-full rounded-full"
                style={{ width: `${s.pct}%`, background: SPEAKER_COLORS[i % SPEAKER_COLORS.length], transition: 'width 0.6s cubic-bezier(0.22,1,0.36,1)' }}
              />
            </div>
            <span className="text-[11px] font-semibold w-8 text-right" style={{ color: SPEAKER_COLORS[i % SPEAKER_COLORS.length] }}>{s.pct}%</span>
            <span className="text-[10px] text-gray-400 w-16 text-right hidden sm:block">{s.words.toLocaleString()} words</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// Parse HH:MM:SS or MM:SS timestamp string to total seconds
function parseTimestamp(ts) {
  if (!ts || typeof ts !== 'string') return NaN;
  const parts = ts.split(':').map(Number);
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return NaN;
}

function TranscriptViewer({ transcript, alerts = [], highlightTime, transcriptRef }) {
  // Build alert lookup — maps segment start_time → alerts that belong to that segment.
  // OpenAI tone analysis returns approximate timestamps that may not exactly match
  // the transcript segment boundaries (e.g., alert says 00:05:56, segment is 00:04:56).
  // Strategy: exact timestamp → text content match → fuzzy timestamp (nearest within 2 min).
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

      // 2. Text content match — find the segment containing the flagged quote.
      //    Most reliable because the AI's flagged_text is verbatim from the transcript.
      if (a.flagged_text) {
        const lowerFlagged = a.flagged_text.toLowerCase();
        const textMatch = segments.find(s =>
          s.text && s.text.toLowerCase().includes(lowerFlagged)
        );
        if (textMatch) {
          const list = map.get(textMatch.start_time) || [];
          list.push(a);
          map.set(textMatch.start_time, list);
          return;
        }
      }

      // 3. Fuzzy timestamp — nearest segment within 2 minutes
      const alertSec = parseTimestamp(a.start_time);
      if (!isNaN(alertSec)) {
        let bestTs = null;
        let bestDiff = Infinity;
        for (const s of segments) {
          const sec = parseTimestamp(s.start_time);
          if (isNaN(sec)) continue;
          const diff = Math.abs(sec - alertSec);
          if (diff < bestDiff && diff <= 120) {
            bestDiff = diff;
            bestTs = s.start_time;
          }
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

  // Auto-scroll to highlighted segment on mount/change
  useEffect(() => {
    if (highlightTime && transcriptRef?.current) {
      // Small delay to let DOM render
      const timer = setTimeout(() => {
        const target = transcriptRef.current.querySelector(`[data-time="${highlightTime}"]`);
        if (target) {
          target.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
      }, 300);
      return () => clearTimeout(timer);
    }
  }, [highlightTime, transcriptRef, transcript]);

  if (!transcript) {
    return (
      <div className="bg-white dark:bg-gray-800 rounded-xl border dark:border-gray-700 p-5">
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
    ? 'bg-indigo-100 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-400'
    : isAssemblyAI
      ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400'
      : 'bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300';

  return (
    <div className="bg-white dark:bg-gray-800 rounded-xl border dark:border-gray-700">
      <div className="flex items-center justify-between p-4 border-b dark:border-gray-700">
        <h3 className="text-sm font-semibold text-gray-900 dark:text-white flex items-center gap-2">
          <FileText className="h-4 w-4" />
          Transcript
        </h3>
        <div className="flex items-center gap-2">
          <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${sourceBadgeStyle}`}>
            {isTeams ? <Cloud className="h-3 w-3" /> : <Cpu className="h-3 w-3" />}
            {sourceBadge}
          </span>
          {transcript.word_count && (
            <span className="text-xs text-gray-400">{transcript.word_count} words</span>
          )}
        </div>
      </div>

      <SpeakerBreakdown segments={segments} />

      <div ref={transcriptRef} className="p-4 max-h-[600px] overflow-y-auto space-y-3">
        {hasMalformedData && (
          <div className="rounded-lg border border-amber-200 bg-amber-50 dark:border-amber-700/50 dark:bg-amber-900/20 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
            Transcript data is malformed — local recording may have failed. Raw data is stored but cannot be displayed.
          </div>
        )}
        {segments.map((segment, idx) => {
          const segmentAlerts = alertsByTime.get(segment.start_time) || [];
          const isHighlighted = highlightTime && segment.start_time === highlightTime;

          return (
            <div
              key={idx}
              data-time={segment.start_time}
              className={`flex gap-3 rounded-lg px-2 py-1.5 transition-all duration-500 ${
                isHighlighted
                  ? 'ring-2 ring-brand-500 bg-brand-50/50 dark:bg-brand-900/20'
                  : segmentAlerts.length > 0
                    ? 'bg-gray-50/50 dark:bg-gray-700/20'
                    : ''
              }`}
            >
              <div className="flex-shrink-0 w-20 text-xs text-gray-400 dark:text-gray-500 pt-0.5 font-mono">
                {segment.start_time}
              </div>
              <div className="flex-1">
                <span className="text-xs font-medium text-brand-600 dark:text-brand-400">
                  {segment.speaker}
                </span>
                <p className="text-sm text-gray-700 dark:text-gray-300 mt-0.5 leading-relaxed">
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
