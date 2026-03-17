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

const statusColors = {
  uploaded: 'bg-blue-100 text-blue-700',
  processing: 'bg-yellow-100 text-yellow-700',
  processed: 'bg-green-100 text-green-700',
  failed: 'bg-red-100 text-red-700',
  awaiting_teams_transcript: 'bg-indigo-100 text-indigo-700',
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
  const labels = {
    uploaded: 'Uploaded',
    processing: 'Processing',
    processed: 'Processed',
    failed: 'Failed',
  };
  return labels[meeting.status] || meeting.status;
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

    // 2. Text content match — find the segment containing the flagged quote
    if (!target && flaggedText) {
      const lowerFlagged = flaggedText.toLowerCase();
      const allSegs = transcriptRef.current.querySelectorAll('[data-time]');
      for (const el of allSegs) {
        const text = el.textContent || '';
        if (text.toLowerCase().includes(lowerFlagged)) {
          target = el;
          break;
        }
      }
    }

    // 3. Fuzzy timestamp — nearest within 2 minutes
    if (!target && startTime) {
      const parts = startTime.split(':').map(Number);
      const alertSec = parts.length === 3 ? parts[0] * 3600 + parts[1] * 60 + parts[2]
        : parts.length === 2 ? parts[0] * 60 + parts[1] : NaN;

      if (!isNaN(alertSec)) {
        let bestEl = null;
        let bestDiff = Infinity;
        transcriptRef.current.querySelectorAll('[data-time]').forEach(el => {
          const ts = el.getAttribute('data-time');
          const p = ts.split(':').map(Number);
          const sec = p.length === 3 ? p[0] * 3600 + p[1] * 60 + p[2]
            : p.length === 2 ? p[0] * 60 + p[1] : NaN;
          const diff = Math.abs(sec - alertSec);
          if (diff < bestDiff && diff <= 120) {
            bestDiff = diff;
            bestEl = el;
          }
        });
        target = bestEl;
      }
    }

    if (target) {
      target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, []);

  if (loading) return <LoadingSpinner size="lg" className="py-12" />;
  if (error) return <div className="text-red-500 py-8 text-center">{error}</div>;
  if (!meeting) return <div className="text-gray-500 py-8 text-center">Meeting not found</div>;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start gap-4">
        <button
          onClick={() => navigate('/meetings')}
          className="p-2 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700 mt-0.5"
        >
          <ArrowLeft className="h-5 w-5" />
        </button>
        <div className="flex-1">
          <div className="flex items-center gap-3 flex-wrap">
            <h2 className="text-2xl font-bold text-gray-900 dark:text-white">
              {meeting.profiles?.full_name}'s Meeting
            </h2>
            <span className={`inline-flex px-2.5 py-0.5 rounded-full text-xs font-medium ${statusColors[meeting.status] || ''}`}>
              {getStatusLabel(meeting)}
            </span>
          </div>
          <div className="flex items-center gap-4 mt-2 text-sm text-gray-500 dark:text-gray-400 flex-wrap">
            <span className="flex items-center gap-1">
              <Clock className="h-4 w-4" />
              {formatDateTime(meeting.start_time)} - {formatDurationLong(meeting.duration_seconds)}
            </span>
            <span className="flex items-center gap-1">
              <Monitor className="h-4 w-4" />
              {meeting.detected_app}
            </span>
            {meeting.detected_category && (
              <span className="flex items-center gap-1">
                <Tag className="h-4 w-4" />
                {meeting.detected_category.replace(/_/g, ' ')}
              </span>
            )}
            {meeting.email_sent_at ? (
              <span className="flex items-center gap-1 text-green-600 dark:text-green-400" title={`Email sent ${new Date(meeting.email_sent_at).toLocaleString()}`}>
                <Mail className="h-4 w-4" />
                Email sent
              </span>
            ) : (
              <span className="flex items-center gap-1 text-gray-400" title="Email not sent yet">
                <MailX className="h-4 w-4" />
                No email
              </span>
            )}
          </div>

          {/* Attendees */}
          {meeting.attendees && meeting.attendees.length > 0 && (
            <div className="flex items-start gap-2 mt-3">
              <Users className="h-4 w-4 text-gray-400 mt-0.5 flex-shrink-0" />
              <div className="flex flex-wrap gap-1.5">
                {meeting.attendees.map((a, i) => (
                  <span
                    key={i}
                    title={a.email}
                    className="inline-flex px-2 py-0.5 rounded-full text-xs bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300"
                  >
                    {a.name || a.email}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Three-panel layout */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 space-y-6">
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
          <SummaryPanel summary={summary} category={meeting.detected_category} meetingStatus={meeting.status} errorMessage={meeting.error_message} meeting={meeting} onEmailSent={refetch} />
        </div>
      </div>
    </div>
  );
}

export default MeetingDetail;
