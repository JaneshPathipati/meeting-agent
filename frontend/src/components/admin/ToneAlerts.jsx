// file: frontend/src/components/admin/ToneAlerts.jsx
import React from 'react';
import { supabase } from '../../lib/supabase';
import { AlertTriangle, CheckCircle, XCircle, ExternalLink } from 'lucide-react';

const severityColors = {
  low: 'border-yellow-300 bg-yellow-50 dark:border-yellow-700 dark:bg-yellow-900/20',
  medium: 'border-orange-300 bg-orange-50 dark:border-orange-700 dark:bg-orange-900/20',
  high: 'border-red-300 bg-red-50 dark:border-red-700 dark:bg-red-900/20',
};

const severityBadge = {
  low: 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400',
  medium: 'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400',
  high: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400',
};

function isUserSpeaker(speaker, userName) {
  if (!userName || !speaker) return false;
  const u = userName.toLowerCase().trim();
  const s = speaker.toLowerCase().trim();
  return s === u || s.includes(u) || u.includes(s);
}

function ToneAlerts({ alerts, meetingId, onScrollToAlert, userName }) {
  const [localAlerts, setLocalAlerts] = React.useState(alerts);
  const [reviewError, setReviewError] = React.useState('');

  React.useEffect(() => { setLocalAlerts(alerts); }, [alerts]);

  async function markReviewed(alertId) {
    setReviewError('');
    const { error } = await supabase
      .from('tone_alerts')
      .update({ is_reviewed: true })
      .eq('id', alertId);

    if (error) {
      setReviewError('Failed to mark as reviewed: ' + error.message);
    } else {
      setLocalAlerts(prev => prev.map(a => a.id === alertId ? { ...a, is_reviewed: true } : a));
    }
  }

  async function markUnreviewed(alertId) {
    setReviewError('');
    const { error } = await supabase
      .from('tone_alerts')
      .update({ is_reviewed: false })
      .eq('id', alertId);

    if (error) {
      setReviewError('Failed to mark as unreviewed: ' + error.message);
    } else {
      setLocalAlerts(prev => prev.map(a => a.id === alertId ? { ...a, is_reviewed: false } : a));
    }
  }

  if (localAlerts.length === 0) return null;

  return (
    <div className="bg-white dark:bg-gray-800 rounded-xl border dark:border-gray-700">
      <div className="flex items-center gap-2 p-4 border-b dark:border-gray-700">
        <AlertTriangle className="h-4 w-4 text-amber-500" />
        <h3 className="text-sm font-semibold text-gray-900 dark:text-white">
          Tone Alerts ({localAlerts.length})
        </h3>
      </div>

      {reviewError && (
        <div className="mx-4 mt-2 p-2 text-xs text-red-600 bg-red-50 dark:bg-red-900/20 dark:text-red-400 rounded">
          {reviewError}
        </div>
      )}
      <div className="p-4 space-y-3">
        {localAlerts.map(alert => (
          <div
            key={alert.id}
            className={`rounded-lg border p-3 ${severityColors[alert.severity] || ''}`}
          >
            <div className="flex items-start justify-between gap-2">
              <div className="flex-1">
                <div className="flex items-center gap-2 mb-1">
                  <span className={`inline-flex px-1.5 py-0.5 rounded text-xs font-medium ${severityBadge[alert.severity] || severityBadge.medium}`}>
                    {alert.severity}
                  </span>
                  <span className="text-xs text-gray-500 font-mono">{alert.start_time}</span>
                  <span className="text-xs font-medium text-gray-600 dark:text-gray-400">{alert.speaker}</span>
                  {userName && (
                    isUserSpeaker(alert.speaker, userName) ? (
                      <span className="inline-flex px-1.5 py-0.5 rounded text-[10px] font-semibold bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-400">
                        User
                      </span>
                    ) : (
                      <span className="inline-flex px-1.5 py-0.5 rounded text-[10px] font-semibold bg-sky-100 text-sky-700 dark:bg-sky-900/30 dark:text-sky-400">
                        Participant
                      </span>
                    )
                  )}
                </div>
                <p className="text-sm text-gray-800 dark:text-gray-200 italic">"{alert.flagged_text}"</p>
                {alert.reason && (
                  <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">{alert.reason}</p>
                )}
              </div>
              <div className="flex items-center gap-1 flex-shrink-0">
                {onScrollToAlert && (
                  <button
                    onClick={() => onScrollToAlert(alert.start_time, alert.flagged_text)}
                    className="p-1.5 rounded-md hover:bg-white/50 dark:hover:bg-gray-700/50 text-gray-400 hover:text-brand-600"
                    title="Go to transcript"
                  >
                    <ExternalLink className="h-4 w-4" />
                  </button>
                )}
                {!alert.is_reviewed ? (
                  <button
                    onClick={() => markReviewed(alert.id)}
                    className="p-1.5 rounded-md hover:bg-white/50 dark:hover:bg-gray-700/50 text-gray-400 hover:text-green-600"
                    title="Mark as reviewed"
                  >
                    <CheckCircle className="h-4 w-4" />
                  </button>
                ) : (
                  <button
                    onClick={() => markUnreviewed(alert.id)}
                    className="p-1.5 rounded-md hover:bg-white/50 dark:hover:bg-gray-700/50 text-green-500 hover:text-amber-600"
                    title="Mark as unreviewed"
                  >
                    <CheckCircle className="h-4 w-4" />
                  </button>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export default ToneAlerts;
