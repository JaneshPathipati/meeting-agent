// file: frontend/src/components/admin/Analytics.jsx
import React, { useState, useEffect } from 'react';
import { supabase } from '../../lib/supabase';
import LoadingSpinner from '../shared/LoadingSpinner';
import {
  BarChart, Bar, PieChart, Pie, Cell, LineChart, Line,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend
} from 'recharts';

const CATEGORY_COLORS = {
  client_conversation: '#3b82f6',
  consultant_meeting: '#8b5cf6',
  internal_meeting: '#6366f1',
  interview: '#14b8a6',
  target_company: '#10b981',
  sales_service: '#f97316',
  general: '#6b7280',
};

const PLATFORM_COLORS = {
  'Microsoft Teams': '#6366f1',
  'Google Meet': '#10b981',
  'Others': '#f97316',
};

function categorizePlatform(detectedApp) {
  if (!detectedApp) return 'Others';
  const lower = detectedApp.toLowerCase();
  if (lower.includes('teams')) return 'Microsoft Teams';
  if (lower.includes('meet') || lower.includes('google')) return 'Google Meet';
  return 'Others';
}

function Analytics() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    fetchAnalytics();
  }, []);

  async function fetchAnalytics() {
    try {
      const [meetingsRes, alertsRes, profilesRes] = await Promise.all([
        supabase.from('meetings').select('user_id, detected_app, detected_category, duration_seconds, created_at, profiles!inner(full_name)'),
        supabase.from('tone_alerts').select('severity, created_at'),
        supabase.from('profiles').select('id, full_name').eq('role', 'user').eq('is_active', true),
      ]);

      if (meetingsRes.error) throw meetingsRes.error;
      if (alertsRes.error) throw alertsRes.error;

      const meetings = meetingsRes.data || [];
      const alerts = alertsRes.data || [];

      // Meetings per user
      const userCounts = {};
      meetings.forEach(m => {
        const name = m.profiles?.full_name || 'Unknown';
        userCounts[name] = (userCounts[name] || 0) + 1;
      });
      const meetingsPerUser = Object.entries(userCounts)
        .map(([name, count]) => ({ name, meetings: count }))
        .sort((a, b) => b.meetings - a.meetings)
        .slice(0, 10);

      // Meetings per category
      const catCounts = {};
      meetings.forEach(m => {
        const cat = m.detected_category || 'uncategorized';
        catCounts[cat] = (catCounts[cat] || 0) + 1;
      });
      const meetingsPerCategory = Object.entries(catCounts)
        .map(([name, value]) => ({ name: name.replace(/_/g, ' '), value, fill: CATEGORY_COLORS[name] || '#6b7280' }));

      // Average duration
      const totalDuration = meetings.reduce((sum, m) => sum + (m.duration_seconds || 0), 0);
      const avgDuration = meetings.length > 0 ? Math.round(totalDuration / meetings.length / 60) : 0;

      // Tone alert trends (last 30 days)
      const alertTrend = {};
      const now = new Date();
      for (let i = 29; i >= 0; i--) {
        const d = new Date(now.getTime() - i * 24 * 60 * 60 * 1000);
        const key = d.toISOString().split('T')[0];
        alertTrend[key] = 0;
      }
      alerts.forEach(a => {
        const key = new Date(a.created_at).toISOString().split('T')[0];
        if (alertTrend[key] !== undefined) alertTrend[key]++;
      });
      const alertTrendData = Object.entries(alertTrend).map(([date, count]) => ({
        date: date.slice(5),
        alerts: count,
      }));

      // Meeting platform breakdown
      const platformCounts = {};
      meetings.forEach(m => {
        const platform = categorizePlatform(m.detected_app);
        platformCounts[platform] = (platformCounts[platform] || 0) + 1;
      });
      const platformData = Object.entries(platformCounts)
        .map(([name, value]) => ({ name, value, fill: PLATFORM_COLORS[name] || '#6b7280' }))
        .sort((a, b) => b.value - a.value);

      // Transcript source breakdown
      const { data: transcripts } = await supabase.from('transcripts').select('source');
      const sourceCounts = { local: 0, teams: 0 };
      (transcripts || []).forEach(t => {
        sourceCounts[t.source] = (sourceCounts[t.source] || 0) + 1;
      });
      const sourceData = [
        { name: 'Local (Parakeet)', value: sourceCounts.local },
        { name: 'Teams', value: sourceCounts.teams },
      ];

      setData({
        meetingsPerUser,
        meetingsPerCategory,
        avgDuration,
        totalMeetings: meetings.length,
        alertTrendData,
        sourceData,
        platformData,
      });
    } catch (err) {
      console.error('Analytics fetch error:', err);
      setError(err.message || 'Failed to load analytics');
    } finally {
      setLoading(false);
    }
  }

  if (loading) return <LoadingSpinner size="lg" className="py-12" />;
  if (error) return <div className="text-red-500 py-8 text-center">{error}</div>;
  if (!data) return null;

  return (
    <div className="space-y-6">
      <h2 className="text-2xl font-bold text-gray-900 dark:text-white">Analytics</h2>

      {/* Summary cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="bg-white dark:bg-gray-800 rounded-xl border dark:border-gray-700 p-5 text-center">
          <p className="text-sm text-gray-500 dark:text-gray-400">Total Meetings</p>
          <p className="text-3xl font-bold text-gray-900 dark:text-white mt-1">{data.totalMeetings}</p>
        </div>
        <div className="bg-white dark:bg-gray-800 rounded-xl border dark:border-gray-700 p-5 text-center">
          <p className="text-sm text-gray-500 dark:text-gray-400">Avg Duration</p>
          <p className="text-3xl font-bold text-gray-900 dark:text-white mt-1">{data.avgDuration}m</p>
        </div>
        <div className="bg-white dark:bg-gray-800 rounded-xl border dark:border-gray-700 p-5 text-center">
          <p className="text-sm text-gray-500 dark:text-gray-400">Transcript Sources</p>
          <p className="text-3xl font-bold text-gray-900 dark:text-white mt-1">
            {data.sourceData[1].value > 0 ? `${Math.round(data.sourceData[1].value / (data.sourceData[0].value + data.sourceData[1].value) * 100)}% Teams` : '100% Local'}
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Meetings per user */}
        <div className="bg-white dark:bg-gray-800 rounded-xl border dark:border-gray-700 p-5">
          <h3 className="text-sm font-medium text-gray-500 dark:text-gray-400 mb-4">Meetings per User</h3>
          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={data.meetingsPerUser} layout="vertical">
                <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                <XAxis type="number" allowDecimals={false} tick={{ fontSize: 12 }} />
                <YAxis type="category" dataKey="name" width={100} tick={{ fontSize: 11 }} />
                <Tooltip />
                <Bar dataKey="meetings" fill="#6366f1" radius={[0, 4, 4, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Meetings per category */}
        <div className="bg-white dark:bg-gray-800 rounded-xl border dark:border-gray-700 p-5">
          <h3 className="text-sm font-medium text-gray-500 dark:text-gray-400 mb-4">Meetings by Category</h3>
          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie data={data.meetingsPerCategory} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={80} label>
                  {data.meetingsPerCategory.map((entry, idx) => (
                    <Cell key={idx} fill={entry.fill} />
                  ))}
                </Pie>
                <Tooltip />
                <Legend />
              </PieChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Tone alert trends */}
        <div className="bg-white dark:bg-gray-800 rounded-xl border dark:border-gray-700 p-5">
          <h3 className="text-sm font-medium text-gray-500 dark:text-gray-400 mb-4">Tone Alerts (Last 30 Days)</h3>
          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={data.alertTrendData}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                <XAxis dataKey="date" tick={{ fontSize: 10 }} interval={4} />
                <YAxis allowDecimals={false} tick={{ fontSize: 12 }} />
                <Tooltip />
                <Line type="monotone" dataKey="alerts" stroke="#f59e0b" strokeWidth={2} dot={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Meeting platform breakdown */}
        <div className="bg-white dark:bg-gray-800 rounded-xl border dark:border-gray-700 p-5">
          <h3 className="text-sm font-medium text-gray-500 dark:text-gray-400 mb-4">Meeting Platform</h3>
          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie data={data.platformData} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={80} label>
                  {data.platformData.map((entry, idx) => (
                    <Cell key={idx} fill={entry.fill} />
                  ))}
                </Pie>
                <Tooltip />
                <Legend />
              </PieChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>
    </div>
  );
}

export default Analytics;
