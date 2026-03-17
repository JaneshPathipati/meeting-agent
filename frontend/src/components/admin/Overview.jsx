// file: frontend/src/components/admin/Overview.jsx
import React, { useState, useEffect } from 'react';
import { supabase } from '../../lib/supabase';
import { Video, Users, AlertTriangle, Clock, Mail } from 'lucide-react';
import { formatRelative } from '../../utils/formatDate';
import LoadingSpinner from '../shared/LoadingSpinner';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer
} from 'recharts';

function StatCard({ icon: Icon, label, value, color }) {
  return (
    <div className="bg-white dark:bg-gray-800 rounded-xl border dark:border-gray-700 p-5">
      <div className="flex items-center gap-3">
        <div className={`p-2.5 rounded-lg ${color}`}>
          <Icon className="h-5 w-5 text-white" />
        </div>
        <div>
          <p className="text-sm text-gray-500 dark:text-gray-400">{label}</p>
          <p className="text-2xl font-bold text-gray-900 dark:text-white">{value}</p>
        </div>
      </div>
    </div>
  );
}

function Overview() {
  const [stats, setStats] = useState(null);
  const [chartData, setChartData] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchStats();
  }, []);

  async function fetchStats() {
    try {
      const now = new Date();
      const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
      const weekStart = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
      const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();

      const [todayRes, weekRes, monthRes, agentsRes, alertsRes, inFlightRes, emailsTodayRes] = await Promise.all([
        supabase.from('meetings').select('id', { count: 'exact', head: true }).gte('created_at', todayStart),
        supabase.from('meetings').select('id', { count: 'exact', head: true }).gte('created_at', weekStart),
        supabase.from('meetings').select('id', { count: 'exact', head: true }).gte('created_at', monthStart),
        supabase.from('profiles').select('id', { count: 'exact', head: true })
          .eq('role', 'user').eq('is_active', true)
          .gte('last_agent_heartbeat', new Date(now.getTime() - 15 * 60 * 1000).toISOString()),
        supabase.from('tone_alerts').select('id', { count: 'exact', head: true }).eq('is_reviewed', false),
        supabase.from('meetings').select('id', { count: 'exact', head: true })
          .in('status', ['uploaded', 'processing', 'awaiting_teams_transcript']),
        supabase.from('meetings').select('id', { count: 'exact', head: true })
          .not('email_sent_at', 'is', null).gte('email_sent_at', todayStart),
      ]);

      setStats({
        meetingsToday: todayRes.count || 0,
        meetingsWeek: weekRes.count || 0,
        meetingsMonth: monthRes.count || 0,
        activeAgents: agentsRes.count || 0,
        pendingAlerts: alertsRes.count || 0,
        processingQueue: inFlightRes.count || 0,
        emailsSentToday: emailsTodayRes.count || 0,
      });

      // Fetch last 7 days chart data
      const days = [];
      for (let i = 6; i >= 0; i--) {
        const dayStart = new Date(now.getTime() - i * 24 * 60 * 60 * 1000);
        dayStart.setHours(0, 0, 0, 0);
        const dayEnd = new Date(dayStart);
        dayEnd.setHours(23, 59, 59, 999);

        const { count } = await supabase
          .from('meetings')
          .select('id', { count: 'exact', head: true })
          .gte('created_at', dayStart.toISOString())
          .lte('created_at', dayEnd.toISOString());

        days.push({
          day: dayStart.toLocaleDateString('en-US', { weekday: 'short' }),
          meetings: count || 0,
        });
      }
      setChartData(days);
    } catch (err) {
      console.error('Failed to fetch stats:', err);
    } finally {
      setLoading(false);
    }
  }

  if (loading) return <LoadingSpinner size="lg" className="py-12" />;

  return (
    <div className="space-y-6">
      <h2 className="text-2xl font-bold text-gray-900 dark:text-white">Dashboard</h2>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4">
        <StatCard icon={Video} label="Meetings Today" value={stats.meetingsToday} color="bg-brand-600" />
        <StatCard icon={Users} label="Active Agents" value={stats.activeAgents} color="bg-green-600" />
        <StatCard icon={AlertTriangle} label="Pending Alerts" value={stats.pendingAlerts} color="bg-amber-500" />
        <StatCard icon={Clock} label="Processing Queue" value={stats.processingQueue} color="bg-blue-500" />
        <StatCard icon={Mail} label="Emails Sent Today" value={stats.emailsSentToday} color="bg-indigo-500" />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="bg-white dark:bg-gray-800 rounded-xl border dark:border-gray-700 p-5">
          <h3 className="text-sm font-medium text-gray-500 dark:text-gray-400 mb-4">Meetings This Week</h3>
          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={chartData}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                <XAxis dataKey="day" tick={{ fontSize: 12 }} />
                <YAxis allowDecimals={false} tick={{ fontSize: 12 }} />
                <Tooltip />
                <Bar dataKey="meetings" fill="#6366f1" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="bg-white dark:bg-gray-800 rounded-xl border dark:border-gray-700 p-5">
          <h3 className="text-sm font-medium text-gray-500 dark:text-gray-400 mb-4">Summary</h3>
          <div className="space-y-4">
            <div className="flex justify-between items-center py-2 border-b dark:border-gray-700">
              <span className="text-sm text-gray-600 dark:text-gray-300">This Week</span>
              <span className="text-lg font-semibold text-gray-900 dark:text-white">{stats.meetingsWeek} meetings</span>
            </div>
            <div className="flex justify-between items-center py-2 border-b dark:border-gray-700">
              <span className="text-sm text-gray-600 dark:text-gray-300">This Month</span>
              <span className="text-lg font-semibold text-gray-900 dark:text-white">{stats.meetingsMonth} meetings</span>
            </div>
            <div className="flex justify-between items-center py-2 border-b dark:border-gray-700">
              <span className="text-sm text-gray-600 dark:text-gray-300">Active Agents</span>
              <span className="text-lg font-semibold text-green-600">{stats.activeAgents}</span>
            </div>
            <div className="flex justify-between items-center py-2">
              <span className="text-sm text-gray-600 dark:text-gray-300">Unreviewed Alerts</span>
              <span className={`text-lg font-semibold ${stats.pendingAlerts > 0 ? 'text-amber-500' : 'text-gray-900 dark:text-white'}`}>
                {stats.pendingAlerts}
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default Overview;
