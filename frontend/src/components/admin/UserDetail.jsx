// file: frontend/src/components/admin/UserDetail.jsx
import React, { useState, useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../../lib/supabase';
import { formatDateShort } from '../../utils/formatDate';
import { formatDuration } from '../../utils/formatDuration';
import {
  ArrowLeft, Wifi, WifiOff, Mail, MailX, Lock,
  Video, AlertTriangle, Clock, BarChart3
} from 'lucide-react';
import LoadingSpinner from '../shared/LoadingSpinner';
import EmptyState from '../shared/EmptyState';
import {
  BarChart, Bar, PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend
} from 'recharts';

const CATEGORY_COLORS = {
  client_conversation: '#3b82f6',
  consultant_meeting: '#8b5cf6',
  target_company: '#10b981',
  sales_service: '#f97316',
  general: '#6b7280',
};

const PLATFORM_COLORS = {
  'Microsoft Teams': '#6366f1',
  'Google Meet': '#10b981',
  'Others': '#f97316',
};

const categoryBadgeColors = {
  client_conversation: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400',
  consultant_meeting: 'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400',
  target_company: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400',
  sales_service: 'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400',
  general: 'bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300',
};

const statusColors = {
  uploaded: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400',
  processing: 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400',
  processed: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400',
  failed: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400',
  awaiting_teams_transcript: 'bg-indigo-100 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-400',
};

function categorizePlatform(detectedApp) {
  if (!detectedApp) return 'Others';
  const lower = detectedApp.toLowerCase();
  if (lower.includes('teams')) return 'Microsoft Teams';
  if (lower.includes('meet') || lower.includes('google')) return 'Google Meet';
  return 'Others';
}

function isAgentOnline(heartbeat) {
  if (!heartbeat) return false;
  return new Date(heartbeat).getTime() > Date.now() - 15 * 60 * 1000;
}

function UserDetail({ userId }) {
  const navigate = useNavigate();
  const [profile, setProfile] = useState(null);
  const [meetings, setMeetings] = useState([]);
  const [alerts, setAlerts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!userId) return;
    fetchUserAnalytics();
  }, [userId]);

  async function fetchUserAnalytics() {
    setLoading(true);
    setError(null);
    try {
      const [profileRes, meetingsRes] = await Promise.all([
        supabase.from('profiles').select('*').eq('id', userId).single(),
        supabase.from('meetings')
          .select('id, start_time, end_time, duration_seconds, detected_app, detected_category, status, email_sent_at, created_at')
          .eq('user_id', userId)
          .order('created_at', { ascending: false }),
      ]);

      if (profileRes.error) throw profileRes.error;
      if (meetingsRes.error) throw meetingsRes.error;

      const meetingIds = (meetingsRes.data || []).map(m => m.id);

      let alertsData = [];
      if (meetingIds.length > 0) {
        const alertsRes = await supabase
          .from('tone_alerts')
          .select('id, meeting_id, severity, speaker, created_at')
          .in('meeting_id', meetingIds);
        if (!alertsRes.error) alertsData = alertsRes.data || [];
      }

      setProfile(profileRes.data);
      setMeetings(meetingsRes.data || []);
      setAlerts(alertsData);
    } catch (err) {
      setError(err.message || 'Failed to load user data');
    } finally {
      setLoading(false);
    }
  }

  // Speaker attribution helper
  function isUserSpeaker(speaker) {
    if (!profile || !speaker) return false;
    const userName = (profile.full_name || '').toLowerCase().trim();
    const speakerLower = speaker.toLowerCase().trim();
    if (!userName) return false;
    return speakerLower === userName || speakerLower.includes(userName) || userName.includes(speakerLower);
  }

  // Computed analytics
  const analytics = useMemo(() => {
    if (!meetings.length) return null;

    const totalMeetings = meetings.length;

    // Average duration
    const totalDuration = meetings.reduce((sum, m) => sum + (m.duration_seconds || 0), 0);
    const avgDuration = Math.round(totalDuration / totalMeetings / 60);

    // Flags — split by user vs participant
    const totalFlags = alerts.length;
    const userFlags = alerts.filter(a => isUserSpeaker(a.speaker)).length;
    const participantFlags = totalFlags - userFlags;
    const meetingsWithFlags = new Set(alerts.map(a => a.meeting_id)).size;
    const flagRate = totalMeetings > 0 ? Math.round(meetingsWithFlags / totalMeetings * 100) : 0;

    // Meetings over time (last 30 days, daily count)
    const dailyCounts = {};
    const now = new Date();
    for (let i = 29; i >= 0; i--) {
      const d = new Date(now.getTime() - i * 24 * 60 * 60 * 1000);
      dailyCounts[d.toISOString().split('T')[0]] = 0;
    }
    meetings.forEach(m => {
      const key = new Date(m.created_at).toISOString().split('T')[0];
      if (dailyCounts[key] !== undefined) dailyCounts[key]++;
    });
    const meetingsOverTime = Object.entries(dailyCounts).map(([date, count]) => ({
      date: date.slice(5),
      meetings: count,
    }));

    // Category breakdown
    const catCounts = {};
    meetings.forEach(m => {
      const cat = m.detected_category || 'uncategorized';
      catCounts[cat] = (catCounts[cat] || 0) + 1;
    });
    const categoryData = Object.entries(catCounts).map(([name, value]) => ({
      name: name.replace(/_/g, ' '),
      value,
      fill: CATEGORY_COLORS[name] || '#6b7280',
    }));

    // Platform breakdown
    const platformCounts = {};
    meetings.forEach(m => {
      const platform = categorizePlatform(m.detected_app);
      platformCounts[platform] = (platformCounts[platform] || 0) + 1;
    });
    const platformData = Object.entries(platformCounts).map(([name, value]) => ({
      name,
      value,
      fill: PLATFORM_COLORS[name] || '#6b7280',
    }));

    // Tone alerts by severity — split into user (dark) vs participant (light)
    const severityUser = { high: 0, medium: 0, low: 0 };
    const severityParticipant = { high: 0, medium: 0, low: 0 };
    alerts.forEach(a => {
      if (a.severity in severityUser) {
        if (isUserSpeaker(a.speaker)) {
          severityUser[a.severity]++;
        } else {
          severityParticipant[a.severity]++;
        }
      }
    });
    const severityData = [
      { name: 'High', user: severityUser.high, participant: severityParticipant.high, userFill: '#dc2626', participantFill: '#fca5a5' },
      { name: 'Medium', user: severityUser.medium, participant: severityParticipant.medium, userFill: '#ea580c', participantFill: '#fdba74' },
      { name: 'Low', user: severityUser.low, participant: severityParticipant.low, userFill: '#ca8a04', participantFill: '#fde68a' },
    ];

    return {
      totalMeetings,
      avgDuration,
      totalFlags,
      userFlags,
      participantFlags,
      flagRate,
      meetingsOverTime,
      categoryData,
      platformData,
      severityData,
    };
  }, [meetings, alerts, profile]);

  // Alert count per meeting for the table
  const alertCountByMeeting = useMemo(() => {
    const map = {};
    alerts.forEach(a => {
      map[a.meeting_id] = (map[a.meeting_id] || 0) + 1;
    });
    return map;
  }, [alerts]);

  if (loading) return <LoadingSpinner size="lg" className="py-12" />;
  if (error) return <div className="text-red-500 py-8 text-center">{error}</div>;
  if (!profile) return <div className="text-gray-500 py-8 text-center">User not found</div>;

  const recentMeetings = meetings.slice(0, 20);
  const online = isAgentOnline(profile.last_agent_heartbeat);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start gap-4">
        <button
          onClick={() => navigate('/users')}
          className="p-2 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700 mt-0.5"
        >
          <ArrowLeft className="h-5 w-5" />
        </button>
        <div className="flex-1">
          <div className="flex items-center gap-3 flex-wrap">
            <h2 className="text-2xl font-bold text-gray-900 dark:text-white">
              {profile.full_name}
            </h2>
            <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${
              online
                ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400'
                : 'bg-gray-100 text-gray-500 dark:bg-gray-700 dark:text-gray-400'
            }`}>
              {online ? <Wifi className="h-3 w-3" /> : <WifiOff className="h-3 w-3" />}
              {online ? 'Online' : 'Offline'}
            </span>
            {profile.is_active ? (
              <span className="inline-flex px-2 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400">
                Active
              </span>
            ) : (
              <span className="inline-flex px-2 py-0.5 rounded-full text-xs font-medium bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-400">
                Inactive
              </span>
            )}
            {profile.is_locked_out && (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400">
                <Lock className="h-3 w-3" />
                Locked
              </span>
            )}
          </div>
          <div className="flex items-center gap-4 mt-2 text-sm text-gray-500 dark:text-gray-400">
            <span>{profile.microsoft_email || profile.email}</span>
            {profile.job_role && (
              <span>{profile.job_role === 'Other' ? profile.job_role_custom || 'Other' : profile.job_role}</span>
            )}
          </div>
        </div>
      </div>

      {/* Stat Cards */}
      {analytics && (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-4">
            <div className="bg-white dark:bg-gray-800 rounded-xl border dark:border-gray-700 p-5 text-center">
              <p className="text-sm text-gray-500 dark:text-gray-400">Total Meetings</p>
              <p className="text-3xl font-bold text-gray-900 dark:text-white mt-1">{analytics.totalMeetings}</p>
            </div>
            <div className="bg-white dark:bg-gray-800 rounded-xl border dark:border-gray-700 p-5 text-center">
              <p className="text-sm text-gray-500 dark:text-gray-400">Avg Duration</p>
              <p className="text-3xl font-bold text-gray-900 dark:text-white mt-1">{analytics.avgDuration}m</p>
            </div>
            <div className="bg-white dark:bg-gray-800 rounded-xl border dark:border-gray-700 p-5 text-center border-rose-200 dark:border-rose-800">
              <p className="text-sm text-rose-600 dark:text-rose-400">User's Alerts</p>
              <p className="text-3xl font-bold text-rose-600 dark:text-rose-400 mt-1">{analytics.userFlags}</p>
              <p className="text-xs text-gray-400 mt-0.5">from {profile.full_name?.split(' ')[0]}</p>
            </div>
            <div className="bg-white dark:bg-gray-800 rounded-xl border dark:border-gray-700 p-5 text-center border-sky-200 dark:border-sky-800">
              <p className="text-sm text-sky-600 dark:text-sky-400">Participant Alerts</p>
              <p className="text-3xl font-bold text-sky-600 dark:text-sky-400 mt-1">{analytics.participantFlags}</p>
              <p className="text-xs text-gray-400 mt-0.5">from others</p>
            </div>
            <div className="bg-white dark:bg-gray-800 rounded-xl border dark:border-gray-700 p-5 text-center">
              <p className="text-sm text-gray-500 dark:text-gray-400">Total Alerts</p>
              <p className="text-3xl font-bold text-gray-900 dark:text-white mt-1">{analytics.totalFlags}</p>
            </div>
            <div className="bg-white dark:bg-gray-800 rounded-xl border dark:border-gray-700 p-5 text-center">
              <p className="text-sm text-gray-500 dark:text-gray-400">Flagged Meetings</p>
              <p className="text-3xl font-bold text-gray-900 dark:text-white mt-1">{analytics.flagRate}%</p>
            </div>
          </div>

          {/* Charts */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Meetings Over Time */}
            <div className="bg-white dark:bg-gray-800 rounded-xl border dark:border-gray-700 p-5">
              <h3 className="text-sm font-medium text-gray-500 dark:text-gray-400 mb-4">Meetings Over Time (30 Days)</h3>
              <div className="h-64">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={analytics.meetingsOverTime}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                    <XAxis dataKey="date" tick={{ fontSize: 10 }} interval={4} />
                    <YAxis allowDecimals={false} tick={{ fontSize: 12 }} />
                    <Tooltip />
                    <Bar dataKey="meetings" fill="#6366f1" radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>

            {/* Categories */}
            <div className="bg-white dark:bg-gray-800 rounded-xl border dark:border-gray-700 p-5">
              <h3 className="text-sm font-medium text-gray-500 dark:text-gray-400 mb-4">Meeting Categories</h3>
              <div className="h-64">
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie data={analytics.categoryData} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={80} label>
                      {analytics.categoryData.map((entry, idx) => (
                        <Cell key={idx} fill={entry.fill} />
                      ))}
                    </Pie>
                    <Tooltip />
                    <Legend />
                  </PieChart>
                </ResponsiveContainer>
              </div>
            </div>

            {/* Platform */}
            <div className="bg-white dark:bg-gray-800 rounded-xl border dark:border-gray-700 p-5">
              <h3 className="text-sm font-medium text-gray-500 dark:text-gray-400 mb-4">Meeting Platform</h3>
              <div className="h-64">
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie data={analytics.platformData} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={80} label>
                      {analytics.platformData.map((entry, idx) => (
                        <Cell key={idx} fill={entry.fill} />
                      ))}
                    </Pie>
                    <Tooltip />
                    <Legend />
                  </PieChart>
                </ResponsiveContainer>
              </div>
            </div>

            {/* Tone Alerts by Severity — User (dark) vs Participant (light) */}
            <div className="bg-white dark:bg-gray-800 rounded-xl border dark:border-gray-700 p-5">
              <h3 className="text-sm font-medium text-gray-500 dark:text-gray-400 mb-4">Tone Alerts by Severity</h3>
              <div className="h-64">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={analytics.severityData} layout="vertical">
                    <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                    <XAxis type="number" allowDecimals={false} tick={{ fontSize: 12 }} />
                    <YAxis type="category" dataKey="name" width={70} tick={{ fontSize: 12 }} />
                    <Tooltip
                      formatter={(value, name) => [value, name === 'user' ? 'User' : 'Participant']}
                    />
                    <Legend
                      formatter={(value) => value === 'user' ? 'User (dark)' : 'Participant (light)'}
                    />
                    <Bar dataKey="user" stackId="severity" radius={[0, 0, 0, 0]}>
                      {analytics.severityData.map((entry, idx) => (
                        <Cell key={idx} fill={entry.userFill} />
                      ))}
                    </Bar>
                    <Bar dataKey="participant" stackId="severity" radius={[0, 4, 4, 0]}>
                      {analytics.severityData.map((entry, idx) => (
                        <Cell key={idx} fill={entry.participantFill} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
          </div>
        </>
      )}

      {/* Recent Meetings Table */}
      <div>
        <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-3 flex items-center gap-2">
          <Video className="h-5 w-5 text-brand-600" />
          Recent Meetings
        </h3>
        {recentMeetings.length === 0 ? (
          <EmptyState icon={Video} title="No meetings yet" description="Meetings will appear here once the agent starts recording" />
        ) : (
          <div className="bg-white dark:bg-gray-800 rounded-xl border dark:border-gray-700 overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50">
                    <th className="text-left px-4 py-3 font-medium text-gray-500 dark:text-gray-400">Date</th>
                    <th className="text-left px-4 py-3 font-medium text-gray-500 dark:text-gray-400">Duration</th>
                    <th className="text-left px-4 py-3 font-medium text-gray-500 dark:text-gray-400">App</th>
                    <th className="text-left px-4 py-3 font-medium text-gray-500 dark:text-gray-400">Category</th>
                    <th className="text-left px-4 py-3 font-medium text-gray-500 dark:text-gray-400">Status</th>
                    <th className="text-left px-4 py-3 font-medium text-gray-500 dark:text-gray-400">Flags</th>
                    <th className="text-left px-4 py-3 font-medium text-gray-500 dark:text-gray-400">Mail</th>
                  </tr>
                </thead>
                <tbody className="divide-y dark:divide-gray-700">
                  {recentMeetings.map(meeting => (
                    <tr
                      key={meeting.id}
                      onClick={() => navigate(`/meetings/${meeting.id}`)}
                      className="hover:bg-gray-50 dark:hover:bg-gray-700/30 cursor-pointer"
                    >
                      <td className="px-4 py-3 text-gray-900 dark:text-white">
                        {formatDateShort(meeting.start_time)}
                      </td>
                      <td className="px-4 py-3 text-gray-600 dark:text-gray-300">
                        {formatDuration(meeting.duration_seconds)}
                      </td>
                      <td className="px-4 py-3 text-gray-600 dark:text-gray-300">
                        {meeting.detected_app}
                      </td>
                      <td className="px-4 py-3">
                        {meeting.detected_category && (
                          <span className={`inline-flex px-2 py-0.5 rounded-full text-xs font-medium ${categoryBadgeColors[meeting.detected_category] || categoryBadgeColors.general}`}>
                            {meeting.detected_category.replace(/_/g, ' ')}
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <span className={`inline-flex px-2 py-0.5 rounded-full text-xs font-medium ${statusColors[meeting.status] || ''}`}>
                          {meeting.status}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        {(alertCountByMeeting[meeting.id] || 0) > 0 ? (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400">
                            <AlertTriangle className="h-3 w-3" />
                            {alertCountByMeeting[meeting.id]}
                          </span>
                        ) : (
                          <span className="text-xs text-gray-400">-</span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        {meeting.email_sent_at ? (
                          <span className="inline-flex items-center gap-1 text-green-600 dark:text-green-400" title={`Sent ${new Date(meeting.email_sent_at).toLocaleString()}`}>
                            <Mail className="h-4 w-4" />
                            <span className="text-xs">Sent</span>
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 text-gray-400 dark:text-gray-500">
                            <MailX className="h-4 w-4" />
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default UserDetail;
