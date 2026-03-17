// file: frontend/src/components/admin/ToneAlertDetail.jsx
import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useGroupedAlerts, useMeetingsLog } from '../../hooks/useAlerts';
import { formatDateShort } from '../../utils/formatDate';
import { formatDuration } from '../../utils/formatDuration';
import {
  AlertTriangle, CheckCircle, ExternalLink, Filter,
  ChevronDown, ChevronUp, Video, ShieldCheck, Clock, Monitor, Tag, User
} from 'lucide-react';
import LoadingSpinner from '../shared/LoadingSpinner';

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

const categoryColors = {
  client_conversation: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400',
  consultant_meeting: 'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400',
  internal_meeting: 'bg-indigo-100 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-400',
  interview: 'bg-teal-100 text-teal-700 dark:bg-teal-900/30 dark:text-teal-400',
  target_company: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400',
  sales_service: 'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400',
  general: 'bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300',
};

function isUserSpeaker(speaker, userName) {
  if (!userName || !speaker) return false;
  const u = userName.toLowerCase().trim();
  const s = speaker.toLowerCase().trim();
  return s === u || s.includes(u) || u.includes(s);
}

function ToneAlertDetail() {
  const navigate = useNavigate();
  const [logOpen, setLogOpen] = useState(false);
  const [filters, setFilters] = useState({});
  const [expandedMeetings, setExpandedMeetings] = useState(new Set());
  const [reviewError, setReviewError] = useState('');
  const { groups, loading: groupsLoading, markReviewed, markUnreviewed } = useGroupedAlerts(filters);
  const { meetings: meetingsLog, loading: logLoading } = useMeetingsLog();

  function toggleMeeting(meetingId) {
    setExpandedMeetings(prev => {
      const next = new Set(prev);
      if (next.has(meetingId)) next.delete(meetingId);
      else next.add(meetingId);
      return next;
    });
  }

  async function handleMarkReviewed(alertId) {
    setReviewError('');
    const { error } = await markReviewed(alertId);
    if (error) setReviewError('Failed to mark as reviewed: ' + error.message);
  }

  async function handleMarkUnreviewed(alertId) {
    setReviewError('');
    const { error } = await markUnreviewed(alertId);
    if (error) setReviewError('Failed to mark as unreviewed: ' + error.message);
  }

  const totalAlerts = groups.reduce((sum, g) => sum + g.alerts.length, 0);

  if (groupsLoading && logLoading) return <LoadingSpinner size="lg" className="py-12" />;

  const flaggedCount = meetingsLog.filter(m => m.alert_count > 0).length;
  const cleanCount = meetingsLog.filter(m => m.alert_count === 0 && m.status === 'processed').length;

  return (
    <div className="space-y-6">
      <h2 className="text-2xl font-bold text-gray-900 dark:text-white">Tone Alerts</h2>

      {/* ── Meetings Log Dropdown ── */}
      <div className="bg-white dark:bg-gray-800 rounded-xl border dark:border-gray-700 overflow-hidden">
        <button
          onClick={() => setLogOpen(!logOpen)}
          className="w-full flex items-center justify-between p-4 hover:bg-gray-50 dark:hover:bg-gray-700/30 transition-colors"
        >
          <div className="flex items-center gap-3">
            <Video className="h-5 w-5 text-brand-600" />
            <span className="text-base font-semibold text-gray-900 dark:text-white">Meetings Log</span>
            <span className="text-xs text-gray-500 dark:text-gray-400">
              {meetingsLog.length} meetings &middot; {flaggedCount} flagged &middot; {cleanCount} clean
            </span>
          </div>
          {logOpen
            ? <ChevronUp className="h-5 w-5 text-gray-400" />
            : <ChevronDown className="h-5 w-5 text-gray-400" />
          }
        </button>

        {logOpen && (
          <div className="border-t dark:border-gray-700">
            {logLoading ? (
              <div className="p-4"><LoadingSpinner size="sm" /></div>
            ) : meetingsLog.length === 0 ? (
              <div className="p-6 text-center text-sm text-gray-500">No meetings recorded yet</div>
            ) : (
              <div className="overflow-x-auto max-h-80 overflow-y-auto">
                <table className="w-full text-sm">
                  <thead className="sticky top-0 bg-gray-50 dark:bg-gray-800/80 backdrop-blur">
                    <tr className="border-b dark:border-gray-700">
                      <th className="text-left px-4 py-2 font-medium text-gray-500 dark:text-gray-400">User</th>
                      <th className="text-left px-4 py-2 font-medium text-gray-500 dark:text-gray-400">Date</th>
                      <th className="text-left px-4 py-2 font-medium text-gray-500 dark:text-gray-400">Duration</th>
                      <th className="text-left px-4 py-2 font-medium text-gray-500 dark:text-gray-400">App</th>
                      <th className="text-left px-4 py-2 font-medium text-gray-500 dark:text-gray-400">Category</th>
                      <th className="text-left px-4 py-2 font-medium text-gray-500 dark:text-gray-400">Tone Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y dark:divide-gray-700">
                    {meetingsLog.map(m => (
                      <tr
                        key={m.id}
                        onClick={() => navigate(`/meetings/${m.id}`)}
                        className="hover:bg-gray-50 dark:hover:bg-gray-700/30 cursor-pointer"
                      >
                        <td className="px-4 py-2.5 font-medium text-gray-900 dark:text-white">
                          {m.profiles?.full_name}
                        </td>
                        <td className="px-4 py-2.5 text-gray-600 dark:text-gray-300">
                          {formatDateShort(m.start_time)}
                        </td>
                        <td className="px-4 py-2.5 text-gray-600 dark:text-gray-300">
                          {formatDuration(m.duration_seconds)}
                        </td>
                        <td className="px-4 py-2.5 text-gray-600 dark:text-gray-300">
                          {m.detected_app}
                        </td>
                        <td className="px-4 py-2.5">
                          {m.detected_category && (
                            <span className={`inline-flex px-2 py-0.5 rounded-full text-xs font-medium ${categoryColors[m.detected_category] || categoryColors.general}`}>
                              {m.detected_category.replace(/_/g, ' ')}
                            </span>
                          )}
                        </td>
                        <td className="px-4 py-2.5">
                          {m.status !== 'processed' ? (
                            <span className="inline-flex items-center gap-1 text-xs text-gray-400">
                              <span className="w-1.5 h-1.5 rounded-full bg-gray-300 animate-pulse" />
                              {m.status}
                            </span>
                          ) : m.alert_count > 0 ? (
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400">
                              <AlertTriangle className="h-3 w-3" />
                              {m.alert_count} alert{m.alert_count > 1 ? 's' : ''}
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400">
                              <ShieldCheck className="h-3 w-3" />
                              No issues
                            </span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </div>

      {/* ── Flagged Alerts grouped by meeting ── */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-lg font-semibold text-gray-900 dark:text-white flex items-center gap-2">
            <AlertTriangle className="h-5 w-5 text-amber-500" />
            Flagged Alerts
            {totalAlerts > 0 && (
              <span className="inline-flex items-center justify-center min-w-[1.25rem] h-5 px-1.5 rounded-full text-xs font-bold bg-red-500 text-white">
                {totalAlerts}
              </span>
            )}
          </h3>
          <div className="flex flex-wrap gap-3 items-center">
            <Filter className="h-4 w-4 text-gray-400" />
            <select
              value={filters.severity || ''}
              onChange={(e) => setFilters({ ...filters, severity: e.target.value || undefined })}
              className="px-3 py-1.5 border rounded-lg text-sm dark:bg-gray-700 dark:border-gray-600 dark:text-white"
            >
              <option value="">All Severities</option>
              <option value="high">High</option>
              <option value="medium">Medium</option>
              <option value="low">Low</option>
            </select>
            <select
              value={filters.isReviewed === undefined ? '' : String(filters.isReviewed)}
              onChange={(e) => setFilters({
                ...filters,
                isReviewed: e.target.value === '' ? undefined : e.target.value === 'true',
              })}
              className="px-3 py-1.5 border rounded-lg text-sm dark:bg-gray-700 dark:border-gray-600 dark:text-white"
            >
              <option value="">All Status</option>
              <option value="false">Unreviewed</option>
              <option value="true">Reviewed</option>
            </select>
          </div>
        </div>

        {reviewError && (
          <div className="mb-3 p-2 text-xs text-red-600 bg-red-50 dark:bg-red-900/20 dark:text-red-400 rounded-lg">
            {reviewError}
          </div>
        )}

        {groupsLoading ? (
          <LoadingSpinner size="sm" className="py-8" />
        ) : groups.length === 0 ? (
          <div className="bg-white dark:bg-gray-800 rounded-xl border dark:border-gray-700 p-8 text-center">
            <ShieldCheck className="h-10 w-10 text-green-500 mx-auto mb-3" />
            <p className="text-sm font-medium text-gray-700 dark:text-gray-300">No tone alerts detected</p>
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
              All analyzed meetings have clean tone. Alerts will appear here when flagged.
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {groups.map(group => {
              const isOpen = expandedMeetings.has(group.meetingId);
              const m = group.meeting;
              const unreviewedCount = group.alerts.filter(a => !a.is_reviewed).length;
              const highCount = group.alerts.filter(a => a.severity === 'high').length;

              return (
                <div key={group.meetingId} className="bg-white dark:bg-gray-800 rounded-xl border dark:border-gray-700 overflow-hidden">
                  {/* Meeting header — collapsible toggle */}
                  <button
                    onClick={() => toggleMeeting(group.meetingId)}
                    className="w-full flex items-center justify-between p-4 hover:bg-gray-50 dark:hover:bg-gray-700/30 transition-colors"
                  >
                    <div className="flex items-center gap-3 min-w-0 flex-1">
                      <AlertTriangle className="h-4 w-4 text-amber-500 flex-shrink-0" />
                      <div className="flex items-center gap-2 flex-wrap min-w-0">
                        <span className="text-sm font-semibold text-gray-900 dark:text-white truncate">
                          {m.profiles?.full_name}
                        </span>
                        <span className="text-xs text-gray-500 dark:text-gray-400 flex items-center gap-1">
                          <Clock className="h-3 w-3" />
                          {formatDateShort(m.start_time)}
                        </span>
                        {m.duration_seconds && (
                          <span className="text-xs text-gray-400">
                            {formatDuration(m.duration_seconds)}
                          </span>
                        )}
                        <span className="text-xs text-gray-500 dark:text-gray-400 flex items-center gap-1">
                          <Monitor className="h-3 w-3" />
                          {m.detected_app}
                        </span>
                        {m.detected_category && (
                          <span className={`inline-flex px-2 py-0.5 rounded-full text-xs font-medium ${categoryColors[m.detected_category] || categoryColors.general}`}>
                            {m.detected_category.replace(/_/g, ' ')}
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-2 flex-shrink-0 ml-3">
                      {highCount > 0 && (
                        <span className="inline-flex items-center justify-center min-w-[1.25rem] h-5 px-1.5 rounded-full text-xs font-bold bg-red-500 text-white" title={`${highCount} high severity`}>
                          {highCount}
                        </span>
                      )}
                      <span className="inline-flex items-center justify-center min-w-[1.25rem] h-5 px-1.5 rounded-full text-xs font-bold bg-amber-500 text-white" title={`${group.alerts.length} total flags`}>
                        {group.alerts.length}
                      </span>
                      {unreviewedCount > 0 && (
                        <span className="text-xs text-gray-400">{unreviewedCount} new</span>
                      )}
                      {isOpen
                        ? <ChevronUp className="h-4 w-4 text-gray-400" />
                        : <ChevronDown className="h-4 w-4 text-gray-400" />
                      }
                    </div>
                  </button>

                  {/* Expanded alert cards */}
                  {isOpen && (
                    <div className="border-t dark:border-gray-700 p-4 space-y-3 bg-gray-50/50 dark:bg-gray-900/20">
                      {group.alerts.map(alert => (
                        <div
                          key={alert.id}
                          className={`rounded-lg border p-3 ${severityColors[alert.severity] || ''}`}
                        >
                          <div className="flex items-start justify-between gap-2">
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-2 mb-1 flex-wrap">
                                <span className={`inline-flex px-1.5 py-0.5 rounded text-xs font-medium ${severityBadge[alert.severity]}`}>
                                  {alert.severity}
                                </span>
                                <span className="text-xs text-gray-500 font-mono">{alert.start_time}</span>
                                <span className="text-xs font-medium text-gray-600 dark:text-gray-400">{alert.speaker}</span>
                                {isUserSpeaker(alert.speaker, m.profiles?.full_name) ? (
                                  <span className="inline-flex px-1.5 py-0.5 rounded text-[10px] font-semibold bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-400">
                                    User
                                  </span>
                                ) : (
                                  <span className="inline-flex px-1.5 py-0.5 rounded text-[10px] font-semibold bg-sky-100 text-sky-700 dark:bg-sky-900/30 dark:text-sky-400">
                                    Participant
                                  </span>
                                )}
                              </div>
                              <p className="text-sm text-gray-800 dark:text-gray-200 italic">&ldquo;{alert.flagged_text}&rdquo;</p>
                              {alert.reason && (
                                <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">{alert.reason}</p>
                              )}
                            </div>
                            <div className="flex items-center gap-1.5 flex-shrink-0">
                              <button
                                onClick={(e) => { e.stopPropagation(); navigate(`/meetings/${alert.meeting_id}?alert=${encodeURIComponent(alert.start_time)}`); }}
                                className="p-1.5 rounded-md hover:bg-white/50 dark:hover:bg-gray-700/50 text-gray-400 hover:text-brand-600"
                                title="View in transcript"
                              >
                                <ExternalLink className="h-4 w-4" />
                              </button>
                              {!alert.is_reviewed ? (
                                <button
                                  onClick={(e) => { e.stopPropagation(); handleMarkReviewed(alert.id); }}
                                  className="p-1.5 rounded-md hover:bg-white/50 dark:hover:bg-gray-700/50 text-gray-400 hover:text-green-600"
                                  title="Mark as reviewed"
                                >
                                  <CheckCircle className="h-4 w-4" />
                                </button>
                              ) : (
                                <button
                                  onClick={(e) => { e.stopPropagation(); handleMarkUnreviewed(alert.id); }}
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
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

export default ToneAlertDetail;
