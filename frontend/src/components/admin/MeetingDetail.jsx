// file: frontend/src/components/admin/MeetingDetail.jsx
import React, { useRef, useCallback } from 'react';
import { useMeetingDetail } from '../../hooks/useMeetings';
import { formatDateTime } from '../../utils/formatDate';
import { formatDurationLong } from '../../utils/formatDuration';
import { ArrowLeft, Clock, Monitor, Tag, Mail, MailX, Users } from 'lucide-react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import LoadingSpinner from '../shared/LoadingSpinner';
import TranscriptViewer from './TranscriptViewer';
import SummaryPanel from './SummaryPanel';
import ToneAlerts from './ToneAlerts';

const statusConfig = {
  uploaded:                  { label: 'Uploaded',              bg: '#FFF7ED', color: '#EA580C', border: '#FED7AA' },
  processing:                { label: 'Processing',            bg: '#FFFBEB', color: '#D97706', border: '#FDE68A' },
  processed:                 { label: 'Processed',             bg: '#F0FDF4', color: '#16A34A', border: '#BBF7D0' },
  failed:                    { label: 'Failed',                bg: '#FEF2F2', color: '#DC2626', border: '#FECACA' },
  awaiting_teams_transcript: { label: 'Awaiting Transcript',   bg: '#EEF2FF', color: '#4F46E5', border: '#C7D2FE' },
};

const TEAMS_ATTEMPT_LABELS = {
  0: 'Awaiting Teams Transcript',
  1: 'Fetching Teams Transcript (5 min)',
  2: 'Fetching Teams Transcript (10 min)',
  3: 'Fetching Teams Transcript (15 min)',
  4: 'Fetching Teams Transcript (20 min)',
  5: 'Teams Transcript Unavailable — Processing Local',
};

function getStatusLabel(meeting) {
  if (meeting.status === 'awaiting_teams_transcript') {
    const attempt = meeting.teams_transcript_attempt || 0;
    return TEAMS_ATTEMPT_LABELS[attempt] || TEAMS_ATTEMPT_LABELS[0];
  }
  return statusConfig[meeting.status]?.label || meeting.status;
}

function MetaChip({ icon: Icon, children, color }) {
  return (
    <span
      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-[10px] text-[12px] font-medium"
      style={{ background: '#F4F2EF', border: '1px solid rgba(226,232,240,0.8)', color: color || '#475569' }}
    >
      <Icon className="h-3.5 w-3.5 flex-shrink-0" />
      {children}
    </span>
  );
}

function MeetingDetail({ meetingId }) {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const highlightTime = searchParams.get('alert');
  const transcriptRef = useRef(null);
  const { meeting, transcript, summary, alerts, loading, error, refetch } = useMeetingDetail(meetingId);

  const handleScrollToAlert = useCallback((startTime, flaggedText) => {
    if (!transcriptRef.current) return;

    // 1. Exact timestamp match
    let target = transcriptRef.current.querySelector(`[data-time="${startTime}"]`);

    // 2. Text content match
    if (!target && flaggedText) {
      const lowerFlagged = flaggedText.toLowerCase();
      const allSegs = transcriptRef.current.querySelectorAll('[data-time]');
      for (const el of allSegs) {
        const text = el.textContent || '';
        if (text.toLowerCase().includes(lowerFlagged)) { target = el; break; }
      }
    }

    // 3. Fuzzy timestamp — nearest within 2 minutes
    if (!target && startTime) {
      const parts = startTime.split(':').map(Number);
      const alertSec = parts.length === 3 ? parts[0] * 3600 + parts[1] * 60 + parts[2]
        : parts.length === 2 ? parts[0] * 60 + parts[1] : NaN;

      if (!isNaN(alertSec)) {
        let bestEl = null, bestDiff = Infinity;
        transcriptRef.current.querySelectorAll('[data-time]').forEach(el => {
          const ts = el.getAttribute('data-time');
          const p = ts.split(':').map(Number);
          const sec = p.length === 3 ? p[0] * 3600 + p[1] * 60 + p[2] : p.length === 2 ? p[0] * 60 + p[1] : NaN;
          const diff = Math.abs(sec - alertSec);
          if (diff < bestDiff && diff <= 120) { bestDiff = diff; bestEl = el; }
        });
        target = bestEl;
      }
    }

    if (target) target.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, []);

  if (loading) return <LoadingSpinner size="lg" className="py-12" />;
  if (error) return <div className="text-red-500 py-8 text-center">{error}</div>;
  if (!meeting) return <div className="text-[#94A3B8] py-8 text-center text-[13px]">Session not found</div>;

  const sc = statusConfig[meeting.status] || statusConfig.uploaded;

  return (
    <div
      className="space-y-6 animate-page-reveal"
      style={{ fontFamily: 'Onest, ui-sans-serif, system-ui, sans-serif' }}
    >
      {/* ── Header ──────────────────────────────────────────────────── */}
      <div className="flex items-start gap-4 animate-fade-in">
        <button
          onClick={() => navigate('/sessions')}
          className="flex items-center gap-1.5 px-3 py-2 rounded-[12px] text-[13px] font-medium text-[#64748B] transition-all hover:bg-white hover:shadow-sm flex-shrink-0 mt-0.5"
          style={{ border: '1.5px solid rgba(226,232,240,0.8)' }}
        >
          <ArrowLeft className="h-4 w-4" />
          Back
        </button>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-3 flex-wrap">
            <h2
              className="text-[26px] font-semibold tracking-tight text-[#020617] leading-tight font-display"
              style={{ fontFamily: 'Geist, ui-sans-serif, system-ui, sans-serif' }}
            >
              {meeting.profiles?.full_name}'s Session
            </h2>
            <span
              className="inline-flex items-center px-2.5 py-1 rounded-full text-[11px] font-semibold"
              style={{ background: sc.bg, color: sc.color, border: `1px solid ${sc.border}` }}
            >
              {getStatusLabel(meeting)}
            </span>
          </div>

          {/* Meta chips row */}
          <div className="flex flex-wrap gap-2 mt-3">
            <MetaChip icon={Clock}>
              {formatDateTime(meeting.start_time)} · {formatDurationLong(meeting.duration_seconds)}
            </MetaChip>
            {meeting.detected_app && (
              <MetaChip icon={Monitor}>{meeting.detected_app}</MetaChip>
            )}
            {meeting.detected_category && (
              <MetaChip icon={Tag}>
                {meeting.detected_category.replace(/_/g, ' ')}
              </MetaChip>
            )}
            {meeting.email_sent_at ? (
              <MetaChip icon={Mail} color="#16A34A">
                Email sent {new Date(meeting.email_sent_at).toLocaleDateString()}
              </MetaChip>
            ) : (
              <MetaChip icon={MailX} color="#94A3B8">No email sent</MetaChip>
            )}
          </div>

          {/* Attendees */}
          {meeting.attendees && meeting.attendees.length > 0 && (
            <div className="flex items-start gap-2 mt-3">
              <Users className="h-3.5 w-3.5 text-[#94A3B8] mt-1 flex-shrink-0" />
              <div className="flex flex-wrap gap-1.5">
                {meeting.attendees.map((a, i) => (
                  <span
                    key={i}
                    title={a.email}
                    className="inline-flex px-2.5 py-0.5 rounded-full text-[11px] font-medium text-[#475569]"
                    style={{ background: '#F4F2EF', border: '1px solid rgba(226,232,240,0.8)' }}
                  >
                    {a.name || a.email}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* ── Live processing banner ──────────────────────────────────── */}
      {(meeting.status === 'uploaded' || meeting.status === 'processing') && (
        <div
          className="flex items-center gap-3 px-4 py-3 rounded-[14px] text-[13px] text-[#92400E] animate-fade-in"
          style={{ background: '#FFF7ED', border: '1px solid #FED7AA' }}
        >
          <span className="relative flex h-2 w-2 flex-shrink-0">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-[#F97316] opacity-75" />
            <span className="relative inline-flex rounded-full h-2 w-2 bg-[#F97316]" />
          </span>
          {meeting.status === 'processing'
            ? 'AI is analyzing this session — transcript, summary, and tone alerts will appear automatically.'
            : 'Session uploaded — AI processing will begin shortly.'}
        </div>
      )}

      {/* ── Three-panel layout ───────────────────────────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        <div className="lg:col-span-2 space-y-5">
          <TranscriptViewer
            transcript={transcript}
            alerts={alerts}
            highlightTime={highlightTime}
            transcriptRef={transcriptRef}
          />
          {alerts.length > 0 && (
            <ToneAlerts
              alerts={alerts}
              meetingId={meetingId}
              onScrollToAlert={handleScrollToAlert}
              userName={meeting.profiles?.full_name}
            />
          )}
        </div>
        <div>
          <SummaryPanel
            summary={summary}
            category={meeting.detected_category}
            meetingStatus={meeting.status}
            errorMessage={meeting.error_message}
            meeting={meeting}
            onEmailSent={refetch}
          />
        </div>
      </div>
    </div>
  );
}

export default MeetingDetail;
