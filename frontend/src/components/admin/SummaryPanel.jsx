// file: frontend/src/components/admin/SummaryPanel.jsx
import React, { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Sparkles, AlertTriangle, Clock, Key, Ban, Server, Info, Loader2, Send, RotateCcw } from 'lucide-react';
import { supabase } from '../../lib/supabase';

const categoryLabels = {
  client_conversation: 'Client Conversation',
  consultant_meeting:  'Consultant Meeting',
  internal_meeting:    'Internal Meeting',
  interview:           'Interview',
  target_company:      'Target Company',
  sales_service:       'Sales/Service',
  general:             'General',
};

const categoryColors = {
  client_conversation: { bg: '#EFF6FF', color: '#2563EB', border: '#BFDBFE' },
  consultant_meeting:  { bg: '#F5F3FF', color: '#7C3AED', border: '#DDD6FE' },
  internal_meeting:    { bg: '#EEF2FF', color: '#4F46E5', border: '#C7D2FE' },
  interview:           { bg: '#F0FDFA', color: '#0D9488', border: '#99F6E4' },
  target_company:      { bg: '#ECFDF5', color: '#059669', border: '#A7F3D0' },
  sales_service:       { bg: '#FFF7ED', color: '#EA580C', border: '#FED7AA' },
  general:             { bg: '#F4F2EF', color: '#64748B', border: 'rgba(226,232,240,0.8)' },
};

function classifyError(errorMessage) {
  if (!errorMessage) return { type: 'unknown', icon: AlertTriangle, color: 'red', title: 'Processing Failed', description: 'An unexpected error occurred while generating the summary.' };

  const msg = errorMessage.toLowerCase();

  if (msg.includes('command failed') || msg.includes('ffmpeg') || msg.includes('ffprobe') || msg.includes('maxbuffer') || msg.includes('enoent')) {
    return { type: 'local', icon: Server, color: 'amber', title: 'Audio Processing Failed', description: 'The audio file could not be processed. This may be due to a corrupted recording or insufficient resources.' };
  }
  if (msg.includes('timed out') || msg.includes('timeout')) {
    return { type: 'timeout', icon: Clock, color: 'amber', title: 'Request Timed Out', description: 'The AI service took too long to respond. This usually resolves on retry.' };
  }
  if (msg.includes('rate limit') || msg.includes('too many requests') || /\b429\b/.test(msg)) {
    return { type: 'rate_limit', icon: Ban, color: 'amber', title: 'Rate Limit Exceeded', description: 'Too many requests were sent to the AI service. Processing will resume automatically.' };
  }
  if (msg.includes('api key') || msg.includes('unauthorized') || /\b401\b/.test(msg)) {
    return { type: 'auth', icon: Key, color: 'red', title: 'Invalid API Key', description: 'The OpenAI API key is missing or invalid. Please check your configuration.' };
  }
  if (msg.includes('insufficient_quota') || msg.includes('billing') || msg.includes('exceeded your current quota')) {
    return { type: 'quota', icon: Ban, color: 'red', title: 'API Quota Exceeded', description: 'The OpenAI account has run out of credits. Please check your billing.' };
  }
  if (msg.includes('model') && (msg.includes('not found') || msg.includes('does not exist'))) {
    return { type: 'model', icon: Server, color: 'red', title: 'Model Configuration Error', description: 'The configured AI model is unavailable. Please verify the model name in your settings.' };
  }
  if (msg.includes('context_length_exceeded') || msg.includes('maximum context length') || msg.includes('too many tokens') || msg.includes('max_tokens')) {
    return { type: 'tokens', icon: AlertTriangle, color: 'amber', title: 'Transcript Too Long', description: 'The meeting transcript exceeded the AI model\'s token limit. A shorter segment may be needed.' };
  }
  if (msg.includes('server error') || msg.includes('service unavailable') || /\b50[0-3]\b/.test(msg)) {
    return { type: 'server', icon: Server, color: 'amber', title: 'AI Service Unavailable', description: 'The AI service is temporarily down. Processing will resume when it\'s back online.' };
  }
  if (msg.includes('pg_net') || msg.includes('response expired')) {
    return { type: 'infra', icon: Server, color: 'amber', title: 'Processing Queue Delay', description: 'The request was queued but the response expired. It will be retried automatically.' };
  }

  return { type: 'unknown', icon: AlertTriangle, color: 'red', title: 'Processing Failed', description: 'An error occurred during summary generation.' };
}

function ErrorCard({ errorMessage }) {
  const [showDetail, setShowDetail] = useState(false);
  const classified = classifyError(errorMessage);
  const Icon = classified.icon;
  const isRed = classified.color === 'red';

  const truncatedError = errorMessage && errorMessage.length > 500
    ? errorMessage.substring(0, 500) + '\n\n... (' + (errorMessage.length - 500).toLocaleString() + ' characters truncated)'
    : errorMessage;

  return (
    <div
      className="rounded-[14px] p-4"
      style={
        isRed
          ? { background: '#FEF2F2', border: '1px solid #FECACA' }
          : { background: '#FFFBEB', border: '1px solid #FDE68A' }
      }
    >
      <div className="flex items-start gap-3">
        <Icon className="h-4 w-4 mt-0.5 flex-shrink-0" style={{ color: isRed ? '#DC2626' : '#D97706' }} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <h4 className="text-[13px] font-semibold" style={{ color: isRed ? '#991B1B' : '#92400E' }}>{classified.title}</h4>
            {errorMessage && (
              <button
                onClick={() => setShowDetail(!showDetail)}
                className="p-0.5 rounded-full hover:bg-black/5 transition-colors"
                title={showDetail ? 'Hide technical details' : 'View technical details'}
              >
                <Info className="h-3.5 w-3.5 opacity-60 hover:opacity-100" style={{ color: isRed ? '#DC2626' : '#D97706' }} />
              </button>
            )}
          </div>
          <p className="text-[12px] mt-0.5 leading-relaxed" style={{ color: isRed ? '#B91C1C' : '#B45309' }}>{classified.description}</p>
          {showDetail && truncatedError && (
            <div
              className="mt-2 px-3 py-2 rounded-[10px] text-[11px] font-mono break-all max-h-40 overflow-y-auto"
              style={isRed ? { background: '#FEE2E2', color: '#991B1B' } : { background: '#FEF3C7', color: '#92400E' }}
            >
              {truncatedError}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function SectionLabel({ children }) {
  return (
    <p className="text-[10px] uppercase tracking-[0.28em] font-semibold text-[#94A3B8] mb-2">{children}</p>
  );
}

function StructuredSummary({ structured }) {
  if (!structured) return null;
  const executive_summary     = structured.executive_summary || structured.executiveSummary || null;
  const participants          = structured.participants || [];
  const key_discussion_points = structured.key_discussion_points || structured.keyTopics || structured.keyDiscussionPoints || [];
  const decisions_made        = structured.decisions_made || structured.decisions || structured.decisionsMade || [];
  const action_items          = structured.action_items || structured.actionItems || [];
  const open_questions        = structured.open_questions || structured.openQuestions || [];

  return (
    <div className="space-y-5 text-[13px] text-[#374151]">
      {executive_summary && (
        <div>
          <SectionLabel>Executive Summary</SectionLabel>
          <p className="text-[13px] leading-relaxed text-[#374151]">{executive_summary}</p>
        </div>
      )}

      {participants.length > 0 && (
        <div>
          <SectionLabel>Participants</SectionLabel>
          <div className="flex flex-wrap gap-1.5">
            {participants.map((p, i) => (
              <span
                key={i}
                className="inline-flex px-2.5 py-0.5 rounded-full text-[11px] font-medium text-[#475569]"
                style={{ background: '#F4F2EF', border: '1px solid rgba(226,232,240,0.8)' }}
              >
                {p}
              </span>
            ))}
          </div>
        </div>
      )}

      {key_discussion_points.length > 0 && (
        <div>
          <SectionLabel>Key Discussion Points</SectionLabel>
          <ul className="space-y-1.5">
            {key_discussion_points.map((pt, i) => (
              <li key={i} className="flex items-start gap-2 text-[13px]">
                <span className="mt-1.5 h-1.5 w-1.5 rounded-full bg-[#F97316] flex-shrink-0" />
                {pt}
              </li>
            ))}
          </ul>
        </div>
      )}

      {decisions_made.length > 0 && (
        <div>
          <SectionLabel>Decisions Made</SectionLabel>
          {typeof decisions_made[0] === 'string' ? (
            <ul className="space-y-1.5">
              {decisions_made.map((d, i) => (
                <li key={i} className="flex items-start gap-2 text-[13px]">
                  <span className="mt-1.5 h-1.5 w-1.5 rounded-full bg-[#3B82F6] flex-shrink-0" />
                  {d}
                </li>
              ))}
            </ul>
          ) : (
            <div className="overflow-x-auto rounded-[12px]" style={{ border: '1px solid rgba(226,232,240,0.8)' }}>
              <table className="w-full text-[12px] border-collapse">
                <thead>
                  <tr style={{ background: '#F4F2EF' }}>
                    <th className="text-left px-3 py-2 font-semibold text-[#64748B]">Decision</th>
                    <th className="text-left px-3 py-2 font-semibold text-[#64748B]">Context</th>
                  </tr>
                </thead>
                <tbody>
                  {decisions_made.map((d, i) => (
                    <tr key={i} style={i % 2 === 1 ? { background: '#FAFAF9' } : {}}>
                      <td className="px-3 py-2 border-t" style={{ borderColor: 'rgba(226,232,240,0.6)' }}>{d.decision || d}</td>
                      <td className="px-3 py-2 border-t text-[#94A3B8]" style={{ borderColor: 'rgba(226,232,240,0.6)' }}>{d.context || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {action_items.length > 0 && (
        <div>
          <SectionLabel>Action Items</SectionLabel>
          {typeof action_items[0] === 'string' ? (
            <ul className="space-y-1.5">
              {action_items.map((item, i) => (
                <li key={i} className="flex items-start gap-2 text-[13px]">
                  <span className="mt-1.5 h-1.5 w-1.5 rounded-full bg-[#10B981] flex-shrink-0" />
                  {item}
                </li>
              ))}
            </ul>
          ) : (
            <div className="overflow-x-auto rounded-[12px]" style={{ border: '1px solid rgba(226,232,240,0.8)' }}>
              <table className="w-full text-[12px] border-collapse">
                <thead>
                  <tr style={{ background: '#F4F2EF' }}>
                    <th className="text-left px-3 py-2 font-semibold text-[#64748B]">Owner</th>
                    <th className="text-left px-3 py-2 font-semibold text-[#64748B]">Task</th>
                    <th className="text-left px-3 py-2 font-semibold text-[#64748B]">Deadline</th>
                  </tr>
                </thead>
                <tbody>
                  {action_items.map((item, i) => (
                    <tr key={i} style={i % 2 === 1 ? { background: '#FAFAF9' } : {}}>
                      <td className="px-3 py-2 border-t font-medium" style={{ borderColor: 'rgba(226,232,240,0.6)' }}>{item.owner || '—'}</td>
                      <td className="px-3 py-2 border-t" style={{ borderColor: 'rgba(226,232,240,0.6)' }}>{item.task || item}</td>
                      <td className="px-3 py-2 border-t text-[#94A3B8]" style={{ borderColor: 'rgba(226,232,240,0.6)' }}>{item.deadline || 'TBD'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {open_questions.length > 0 && (
        <div>
          <SectionLabel>Open Questions</SectionLabel>
          <ul className="space-y-1.5">
            {open_questions.map((q, i) => (
              <li key={i} className="flex items-start gap-2 text-[13px]">
                <span className="mt-1.5 h-1.5 w-1.5 rounded-full bg-[#8B5CF6] flex-shrink-0" />
                {q}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

const panelStyle = {
  background: 'rgba(255,255,255,0.92)',
  border: '1px solid rgba(226,232,240,0.7)',
  borderRadius: '20px',
  boxShadow: '0 4px 24px rgba(15,23,42,0.07)',
};

function SummaryPanel({ summary, category, meetingStatus, errorMessage, meeting, onEmailSent }) {
  const [sending, setSending] = useState(false);

  const handleSendEmail = async () => {
    if (!meeting?.id || sending) return;
    setSending(true);
    try {
      const { data, error } = await supabase.rpc('send_manual_email', { p_meeting_id: meeting.id });
      if (error) throw error;
      if (data === false) {
        alert('Email could not be sent. Check that the user has an email address and a summary exists.');
      } else if (onEmailSent) {
        onEmailSent();
      }
    } catch (err) {
      alert('Failed to send email: ' + err.message);
    } finally {
      setSending(false);
    }
  };

  const catStyle = categoryColors[category] || categoryColors.general;

  /* ── No summary: failed ── */
  if (!summary && meetingStatus === 'failed') {
    return (
      <div style={panelStyle}>
        <div className="px-5 py-4" style={{ borderBottom: '1px solid rgba(226,232,240,0.7)' }}>
          <p className="text-[10px] uppercase tracking-[0.28em] font-semibold text-[#94A3B8] mb-0.5">Analysis</p>
          <h3 className="text-[16px] font-semibold text-[#020617] flex items-center gap-2"
            style={{ fontFamily: 'Geist, ui-sans-serif, system-ui, sans-serif' }}>
            <Sparkles className="h-4 w-4 text-[#64748B]" />
            AI Summary
          </h3>
        </div>
        <div className="p-5">
          <ErrorCard errorMessage={errorMessage} />
        </div>
      </div>
    );
  }

  /* ── No summary: pending ── */
  if (!summary) {
    let description = 'Summary is being generated…';
    let showSpinner = false;
    if (meetingStatus === 'processing') { description = 'AI is analyzing the transcript…'; showSpinner = true; }
    else if (meetingStatus === 'uploaded') { description = 'Transcript uploaded, waiting for processing…'; showSpinner = true; }
    else if (meetingStatus === 'awaiting_teams_transcript') { description = 'Waiting for Teams transcript…'; showSpinner = true; }

    return (
      <div style={panelStyle}>
        <div className="p-5 flex flex-col items-center justify-center py-12 text-center">
          {showSpinner
            ? <Loader2 className="h-10 w-10 text-[#F97316] mb-4 animate-spin" />
            : <Sparkles className="h-10 w-10 text-[#CBD5E1] mb-4" />
          }
          <h3 className="text-[14px] font-semibold text-[#020617] mb-1">No summary yet</h3>
          <p className="text-[12px] text-[#94A3B8] max-w-[200px] leading-relaxed">{description}</p>
        </div>
      </div>
    );
  }

  /* ── Summary available ── */
  return (
    <div style={panelStyle}>
      {/* Header */}
      <div className="px-5 py-4" style={{ borderBottom: '1px solid rgba(226,232,240,0.7)' }}>
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-[10px] uppercase tracking-[0.28em] font-semibold text-[#94A3B8] mb-0.5">Analysis</p>
            <h3
              className="text-[16px] font-semibold text-[#020617] flex items-center gap-2"
              style={{ fontFamily: 'Geist, ui-sans-serif, system-ui, sans-serif' }}
            >
              <Sparkles className="h-4 w-4 text-[#64748B]" />
              AI Summary
            </h3>
          </div>
          {category && (
            <span
              className="inline-flex items-center px-2.5 py-1 rounded-full text-[11px] font-semibold flex-shrink-0 mt-1"
              style={{ background: catStyle.bg, color: catStyle.color, border: `1px solid ${catStyle.border}` }}
            >
              {categoryLabels[category] || category}
            </span>
          )}
        </div>
      </div>

      <div className="p-5 space-y-5">
        {/* Email action row */}
        {meeting && meetingStatus === 'processed' && (
          <div
            className="flex items-center justify-between gap-3 p-3.5 rounded-[14px]"
            style={{ background: '#F9F8F6', border: '1px solid rgba(226,232,240,0.8)' }}
          >
            <span className="text-[12px] text-[#64748B]">
              {meeting.email_sent_at
                ? `Sent ${new Date(meeting.email_sent_at).toLocaleString()}`
                : 'Email not sent yet'}
            </span>
            <button
              onClick={handleSendEmail}
              disabled={sending}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-[10px] text-[12px] font-semibold text-white transition-all hover:opacity-90 disabled:opacity-50 flex-shrink-0"
              style={
                meeting.email_sent_at
                  ? { background: 'linear-gradient(135deg, #3B82F6 0%, #1D4ED8 100%)', boxShadow: '0 2px 8px rgba(59,130,246,0.35)' }
                  : { background: 'linear-gradient(135deg, #F97316 0%, #DC4F04 100%)', boxShadow: '0 2px 8px rgba(249,115,22,0.35)' }
              }
            >
              {sending
                ? <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Sending…</>
                : meeting.email_sent_at
                  ? <><RotateCcw className="h-3.5 w-3.5" /> Resend</>
                  : <><Send className="h-3.5 w-3.5" /> Send Email</>
              }
            </button>
          </div>
        )}

        {/* Markdown content */}
        {summary.content && (
          <div
            className="prose prose-sm max-w-none leading-relaxed text-[#374151]
              prose-headings:text-[#020617] prose-headings:font-semibold prose-headings:mt-4 prose-headings:mb-2
              prose-h2:text-[15px] prose-h2:border-b prose-h2:pb-1
              prose-strong:text-[#020617]
              prose-li:my-0.5
              prose-table:text-[12px]
              prose-th:bg-[#F4F2EF] prose-th:px-3 prose-th:py-1.5
              prose-td:px-3 prose-td:py-1.5"
            style={{ '--tw-prose-body': '#374151', '--tw-prose-headings': '#020617' }}
          >
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{summary.content}</ReactMarkdown>
          </div>
        )}

        {/* Structured sections */}
        {summary.structured_json && (
          <div className={summary.content ? 'pt-5 border-t' : ''} style={summary.content ? { borderColor: 'rgba(226,232,240,0.7)' } : {}}>
            <StructuredSummary structured={summary.structured_json} />
          </div>
        )}
      </div>
    </div>
  );
}

export default SummaryPanel;
