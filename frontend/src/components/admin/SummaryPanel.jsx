// file: frontend/src/components/admin/SummaryPanel.jsx
import React, { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Sparkles, AlertTriangle, Clock, Key, Ban, Server, Info, Loader2, Send, RotateCcw } from 'lucide-react';
import { supabase } from '../../lib/supabase';

const categoryLabels = {
  client_conversation: 'Client Conversation',
  consultant_meeting: 'Consultant Meeting',
  internal_meeting: 'Internal Meeting',
  interview: 'Interview',
  target_company: 'Target Company',
  sales_service: 'Sales/Service',
  general: 'General',
};

function classifyError(errorMessage) {
  if (!errorMessage) return { type: 'unknown', icon: AlertTriangle, color: 'red', title: 'Processing Failed', description: 'An unexpected error occurred while generating the summary.' };

  const msg = errorMessage.toLowerCase();

  // Check for local processing failures FIRST (ffmpeg, commands) — their verbose output
  // contains numbers like "401", "500" etc. in version strings that would false-match API errors
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

const colorMap = {
  red: { bg: 'bg-red-50 dark:bg-red-900/20', border: 'border-red-200 dark:border-red-800', icon: 'text-red-500 dark:text-red-400', title: 'text-red-800 dark:text-red-300', desc: 'text-red-600 dark:text-red-400', infoBg: 'bg-red-100 dark:bg-red-900/40', infoText: 'text-red-700 dark:text-red-300' },
  amber: { bg: 'bg-amber-50 dark:bg-amber-900/20', border: 'border-amber-200 dark:border-amber-800', icon: 'text-amber-500 dark:text-amber-400', title: 'text-amber-800 dark:text-amber-300', desc: 'text-amber-600 dark:text-amber-400', infoBg: 'bg-amber-100 dark:bg-amber-900/40', infoText: 'text-amber-700 dark:text-amber-300' },
};

function ErrorCard({ errorMessage }) {
  const [showDetail, setShowDetail] = useState(false);
  const classified = classifyError(errorMessage);
  const Icon = classified.icon;
  const colors = colorMap[classified.color] || colorMap.red;

  // Truncate very long error messages (e.g. 54KB ffmpeg dumps) for display
  const truncatedError = errorMessage && errorMessage.length > 500
    ? errorMessage.substring(0, 500) + '\n\n... (' + (errorMessage.length - 500).toLocaleString() + ' characters truncated)'
    : errorMessage;

  return (
    <div className={`rounded-lg border ${colors.border} ${colors.bg} p-4`}>
      <div className="flex items-start gap-3">
        <Icon className={`h-5 w-5 mt-0.5 flex-shrink-0 ${colors.icon}`} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <h4 className={`text-sm font-semibold ${colors.title}`}>{classified.title}</h4>
            {errorMessage && (
              <button
                onClick={() => setShowDetail(!showDetail)}
                className={`p-0.5 rounded-full hover:bg-black/5 dark:hover:bg-white/10 transition-colors`}
                title={showDetail ? 'Hide technical details' : 'View technical details'}
              >
                <Info className={`h-3.5 w-3.5 ${colors.icon} opacity-60 hover:opacity-100`} />
              </button>
            )}
          </div>
          <p className={`text-xs mt-1 ${colors.desc}`}>{classified.description}</p>
          {showDetail && truncatedError && (
            <div className={`mt-2 px-2.5 py-1.5 rounded text-xs font-mono ${colors.infoBg} ${colors.infoText} break-all max-h-40 overflow-y-auto`}>
              {truncatedError}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function StructuredSummary({ structured }) {
  if (!structured) return null;
  // Support both camelCase (from GPT) and snake_case (from backend) field names
  const executive_summary = structured.executive_summary || structured.executiveSummary || null;
  const participants = structured.participants || [];
  const key_discussion_points = structured.key_discussion_points || structured.keyTopics || structured.keyDiscussionPoints || [];
  const decisions_made = structured.decisions_made || structured.decisions || structured.decisionsMade || [];
  const action_items = structured.action_items || structured.actionItems || [];
  const open_questions = structured.open_questions || structured.openQuestions || [];

  return (
    <div className="space-y-4 text-sm text-gray-700 dark:text-gray-300">
      {executive_summary && (
        <div>
          <h4 className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400 mb-1">Executive Summary</h4>
          <p className="text-sm leading-relaxed">{executive_summary}</p>
        </div>
      )}

      {participants && participants.length > 0 && (
        <div>
          <h4 className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400 mb-2">Participants</h4>
          <div className="flex flex-wrap gap-1.5">
            {participants.map((p, i) => (
              <span key={i} className="inline-flex px-2 py-0.5 rounded-full text-xs bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300">{p}</span>
            ))}
          </div>
        </div>
      )}

      {key_discussion_points && key_discussion_points.length > 0 && (
        <div>
          <h4 className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400 mb-1">Key Discussion Points</h4>
          <ul className="list-disc list-inside space-y-1 text-sm">
            {key_discussion_points.map((pt, i) => <li key={i}>{pt}</li>)}
          </ul>
        </div>
      )}

      {decisions_made && decisions_made.length > 0 && (
        <div>
          <h4 className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400 mb-1">Decisions Made</h4>
          {typeof decisions_made[0] === 'string' ? (
            <ul className="list-disc list-inside space-y-1 text-sm">
              {decisions_made.map((d, i) => <li key={i}>{d}</li>)}
            </ul>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs border-collapse">
                <thead>
                  <tr className="bg-gray-50 dark:bg-gray-700">
                    <th className="text-left p-2 border border-gray-200 dark:border-gray-600 font-medium">Decision</th>
                    <th className="text-left p-2 border border-gray-200 dark:border-gray-600 font-medium">Context</th>
                  </tr>
                </thead>
                <tbody>
                  {decisions_made.map((d, i) => (
                    <tr key={i} className="even:bg-gray-50 dark:even:bg-gray-700/50">
                      <td className="p-2 border border-gray-200 dark:border-gray-600">{d.decision || d}</td>
                      <td className="p-2 border border-gray-200 dark:border-gray-600 text-gray-500 dark:text-gray-400">{d.context || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {action_items && action_items.length > 0 && (
        <div>
          <h4 className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400 mb-1">Action Items</h4>
          {typeof action_items[0] === 'string' ? (
            <ul className="list-disc list-inside space-y-1 text-sm">
              {action_items.map((item, i) => <li key={i}>{item}</li>)}
            </ul>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs border-collapse">
                <thead>
                  <tr className="bg-gray-50 dark:bg-gray-700">
                    <th className="text-left p-2 border border-gray-200 dark:border-gray-600 font-medium">Owner</th>
                    <th className="text-left p-2 border border-gray-200 dark:border-gray-600 font-medium">Task</th>
                    <th className="text-left p-2 border border-gray-200 dark:border-gray-600 font-medium">Deadline</th>
                  </tr>
                </thead>
                <tbody>
                  {action_items.map((item, i) => (
                    <tr key={i} className="even:bg-gray-50 dark:even:bg-gray-700/50">
                      <td className="p-2 border border-gray-200 dark:border-gray-600 font-medium">{item.owner || '—'}</td>
                      <td className="p-2 border border-gray-200 dark:border-gray-600">{item.task || item}</td>
                      <td className="p-2 border border-gray-200 dark:border-gray-600 text-gray-500 dark:text-gray-400">{item.deadline || 'TBD'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {open_questions && open_questions.length > 0 && (
        <div>
          <h4 className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400 mb-1">Open Questions</h4>
          <ul className="list-disc list-inside space-y-1 text-sm">
            {open_questions.map((q, i) => <li key={i}>{q}</li>)}
          </ul>
        </div>
      )}
    </div>
  );
}

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
  if (!summary) {
    if (meetingStatus === 'failed') {
      return (
        <div className="bg-white dark:bg-gray-800 rounded-xl border dark:border-gray-700">
          <div className="flex items-center gap-2 p-4 border-b dark:border-gray-700">
            <Sparkles className="h-4 w-4 text-gray-400" />
            <h3 className="text-sm font-semibold text-gray-900 dark:text-white">AI Summary</h3>
          </div>
          <div className="p-4">
            <ErrorCard errorMessage={errorMessage} />
          </div>
        </div>
      );
    }

    let statusIcon = Sparkles;
    let description = 'Summary is being generated...';
    let showSpinner = false;

    if (meetingStatus === 'processing') {
      description = 'AI is analyzing the transcript...';
      showSpinner = true;
    } else if (meetingStatus === 'uploaded') {
      description = 'Transcript uploaded, waiting for processing...';
      showSpinner = true;
    } else if (meetingStatus === 'awaiting_teams_transcript') {
      description = 'Waiting for Teams transcript...';
      showSpinner = true;
    }

    return (
      <div className="bg-white dark:bg-gray-800 rounded-xl border dark:border-gray-700 p-5">
        <div className="flex flex-col items-center justify-center py-8 text-center">
          {showSpinner ? (
            <Loader2 className="h-10 w-10 text-brand-500 dark:text-brand-400 mb-4 animate-spin" />
          ) : (
            <Sparkles className="h-10 w-10 text-gray-300 dark:text-gray-600 mb-4" />
          )}
          <h3 className="text-sm font-medium text-gray-900 dark:text-white mb-1">No summary yet</h3>
          <p className="text-xs text-gray-500 dark:text-gray-400 max-w-[200px]">{description}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="bg-white dark:bg-gray-800 rounded-xl border dark:border-gray-700">
      <div className="flex items-center justify-between p-4 border-b dark:border-gray-700">
        <h3 className="text-sm font-semibold text-gray-900 dark:text-white flex items-center gap-2">
          <Sparkles className="h-4 w-4" />
          AI Summary
        </h3>
        {category && (
          <span className="inline-flex px-2 py-0.5 rounded-full text-xs font-medium bg-brand-100 text-brand-700 dark:bg-brand-900/30 dark:text-brand-400">
            {categoryLabels[category] || category}
          </span>
        )}
      </div>

      <div className="p-4">
        {meeting && meetingStatus === 'processed' && (
          <div className="flex items-center justify-between mb-3 pb-3 border-b border-gray-100 dark:border-gray-700">
            <span className="text-xs text-gray-500 dark:text-gray-400">
              {meeting.email_sent_at
                ? `Sent ${new Date(meeting.email_sent_at).toLocaleString()}`
                : 'Email not sent yet'}
            </span>
            <button
              onClick={handleSendEmail}
              disabled={sending}
              className={`inline-flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-lg border transition-colors disabled:opacity-50 ${
                meeting.email_sent_at
                  ? 'border-brand-300 dark:border-brand-600 text-brand-600 dark:text-brand-400 bg-brand-50 dark:bg-brand-900/30 hover:bg-brand-100 dark:hover:bg-brand-900/50'
                  : 'border-orange-300 dark:border-orange-600 text-orange-600 dark:text-orange-400 bg-orange-50 dark:bg-orange-900/30 hover:bg-orange-100 dark:hover:bg-orange-900/50'
              }`}
            >
              {sending ? (
                <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Sending...</>
              ) : meeting.email_sent_at ? (
                <><RotateCcw className="h-3.5 w-3.5" /> Resend</>
              ) : (
                <><Send className="h-3.5 w-3.5" /> Send Email</>
              )}
            </button>
          </div>
        )}

        {/* Summary text (always show if available) */}
        {summary.content && (
          <div className="prose prose-sm dark:prose-invert max-w-none text-gray-700 dark:text-gray-300 leading-relaxed
            prose-headings:text-gray-900 dark:prose-headings:text-white prose-headings:font-semibold prose-headings:mt-4 prose-headings:mb-2
            prose-h2:text-base prose-h2:border-b prose-h2:border-gray-200 dark:prose-h2:border-gray-700 prose-h2:pb-1
            prose-strong:text-gray-900 dark:prose-strong:text-white
            prose-li:my-0.5
            prose-table:text-xs prose-th:bg-gray-50 dark:prose-th:bg-gray-700 prose-th:px-3 prose-th:py-1.5 prose-td:px-3 prose-td:py-1.5
            prose-table:border prose-table:border-gray-200 dark:prose-table:border-gray-700
            prose-th:border prose-th:border-gray-200 dark:prose-th:border-gray-700
            prose-td:border prose-td:border-gray-200 dark:prose-td:border-gray-700">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>
              {summary.content}
            </ReactMarkdown>
          </div>
        )}

        {/* Structured summary sections (if available) */}
        {summary.structured_json && (
          <div className={summary.content ? 'mt-4 pt-4 border-t border-gray-100 dark:border-gray-700' : ''}>
            <StructuredSummary structured={summary.structured_json} />
          </div>
        )}
      </div>
    </div>
  );
}

export default SummaryPanel;
