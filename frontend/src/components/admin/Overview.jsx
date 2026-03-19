// file: frontend/src/components/admin/Overview.jsx
import React, { useState, useEffect, useRef } from 'react';
import { supabase } from '../../lib/supabase';
import { Video, Users, AlertTriangle, Clock, Mail, Loader2, Radio } from 'lucide-react';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell,
} from 'recharts';

/* ── Animated counter ────────────────────────────────────────────── */
function useCountUp(target, duration = 900) {
  const [value, setValue] = useState(0);
  const rafRef = useRef(null);
  useEffect(() => {
    if (target === 0) { setValue(0); return; }
    const start = performance.now();
    function tick(now) {
      const elapsed = now - start;
      const progress = Math.min(elapsed / duration, 1);
      const eased = 1 - Math.pow(1 - progress, 3);
      setValue(Math.round(eased * target));
      if (progress < 1) rafRef.current = requestAnimationFrame(tick);
    }
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [target, duration]);
  return value;
}

/* ── Stat card ───────────────────────────────────────────────────── */
const CARD_META = [
  { key: 'meetingsToday',  label: 'Meetings Today',    icon: Video,          accent: '#F97316' },
  { key: 'activeAgents',   label: 'Active Agents',     icon: Users,          accent: '#10B981' },
  { key: 'pendingAlerts',  label: 'Pending Alerts',    icon: AlertTriangle,  accent: '#F59E0B' },
  { key: 'processingQueue',label: 'Processing Queue',  icon: Clock,          accent: '#3B82F6' },
  { key: 'emailsSentToday',label: 'Emails Sent Today', icon: Mail,           accent: '#8B5CF6' },
];

function StatCard({ icon: Icon, label, value, accent, delay }) {
  const count = useCountUp(value);

  return (
    <div
      className="glass-card animate-slide-up"
      style={{ animationDelay: `${delay}ms`, borderRadius: '20px' }}
    >
      <div className="p-5">
        {/* Pill tag */}
        <span
          className="inline-flex items-center gap-1 px-2 py-0.5 text-[10px] font-semibold rounded-full mb-3"
          style={{ background: accent + '18', color: accent }}
        >
          <Icon className="h-3 w-3" />
          {label}
        </span>

        {/* Value */}
        <p
          className="text-[32px] font-semibold tracking-tight leading-none animate-count-up font-display"
          style={{ color: '#020617', animationDelay: `${delay + 100}ms` }}
        >
          {count}
        </p>

        {/* Icon strip */}
        <div
          className="mt-3 h-8 w-8 flex items-center justify-center rounded-xl"
          style={{ background: accent + '12', border: `1px solid ${accent}20` }}
        >
          <Icon className="h-4 w-4" style={{ color: accent }} />
        </div>
      </div>
    </div>
  );
}

/* ── Custom tooltip for chart ────────────────────────────────────── */
function CustomTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null;
  return (
    <div
      className="bg-white border border-[#E2E8F0] px-3 py-2"
      style={{ boxShadow: '0 8px 24px rgba(2,6,23,0.10)' }}
    >
      <p className="text-[11px] uppercase tracking-widest text-[#64748B] mb-1">{label}</p>
      <p className="text-[18px] font-semibold text-[#020617]">{payload[0].value}</p>
      <p className="text-[10px] text-[#94A3B8]">meetings</p>
    </div>
  );
}

/* ── Skeleton card ───────────────────────────────────────────────── */
function SkeletonCard() {
  return (
    <div className="glass-card p-5">
      <div className="skeleton h-8 w-8 mb-4" />
      <div className="skeleton h-8 w-16 mb-2" />
      <div className="skeleton h-3 w-24" />
    </div>
  );
}

/* ── Live Pipeline Monitor ───────────────────────────────────────── */
const PIPELINE_STATUS_LABELS = {
  uploaded:                  { label: 'Queued',            color: '#3B82F6', bg: '#EFF6FF' },
  processing:                { label: 'Processing AI',     color: '#F59E0B', bg: '#FFFBEB' },
  awaiting_teams_transcript: { label: 'Fetching Teams',    color: '#6366F1', bg: '#EEF2FF' },
};

function timeAgo(isoString) {
  const diff = Math.floor((Date.now() - new Date(isoString).getTime()) / 1000);
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  return `${Math.floor(diff / 3600)}h ago`;
}

function LivePipelineMonitor() {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const channelRef = useRef(null);

  async function fetchLive() {
    const { data } = await supabase
      .from('meetings')
      .select('id, status, created_at, detected_app, profiles(full_name)')
      .in('status', ['uploaded', 'processing', 'awaiting_teams_transcript'])
      .order('created_at', { ascending: false })
      .limit(8);
    setItems(data || []);
    setLoading(false);
  }

  useEffect(() => {
    fetchLive();
    const interval = setInterval(fetchLive, 20000);
    channelRef.current = supabase
      .channel('overview-pipeline')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'meetings' }, fetchLive)
      .subscribe();
    return () => {
      clearInterval(interval);
      if (channelRef.current) supabase.removeChannel(channelRef.current);
    };
  }, []);

  if (!loading && items.length === 0) return null;

  return (
    <div
      className="glass-panel p-6 animate-slide-up"
      style={{ animationDelay: '480ms' }}
    >
      <div className="flex items-center gap-2 mb-5">
        <div className="relative flex h-2.5 w-2.5">
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-[#F97316] opacity-60" />
          <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-[#F97316]" />
        </div>
        <p className="text-[11px] uppercase tracking-[0.28em] text-[#64748B]">Live</p>
        <h3 className="text-[16px] font-semibold text-[#020617]">Processing Pipeline</h3>
        {items.length > 0 && (
          <span className="ml-auto text-[11px] px-2 py-0.5 border border-[#E2E8F0] text-[#64748B]">
            {items.length} active
          </span>
        )}
      </div>

      {loading ? (
        <div className="flex items-center gap-2 py-4">
          <Loader2 className="h-4 w-4 animate-spin text-[#F97316]" />
          <span className="text-[13px] text-[#64748B]">Loading pipeline...</span>
        </div>
      ) : (
        <div className="space-y-2">
          {items.map((item) => {
            const meta = PIPELINE_STATUS_LABELS[item.status] || PIPELINE_STATUS_LABELS.uploaded;
            return (
              <div
                key={item.id}
                className="flex items-center justify-between py-2 border-b border-[#F1F5F9] last:border-0"
              >
                <div className="flex items-center gap-3 min-w-0">
                  <Loader2 className="h-3.5 w-3.5 animate-spin flex-shrink-0" style={{ color: meta.color }} />
                  <span className="text-[13px] font-medium text-[#020617] truncate">
                    {item.profiles?.full_name || 'Unknown'}
                  </span>
                  {item.detected_app && (
                    <span className="text-[11px] text-[#94A3B8] hidden sm:block truncate">{item.detected_app}</span>
                  )}
                </div>
                <div className="flex items-center gap-2 flex-shrink-0 ml-3">
                  <span
                    className="text-[11px] font-medium px-2 py-0.5"
                    style={{ color: meta.color, background: meta.bg }}
                  >
                    {meta.label}
                  </span>
                  <span className="text-[11px] text-[#94A3B8]">{timeAgo(item.created_at)}</span>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* ── Main component ──────────────────────────────────────────────── */
function Overview() {
  const [stats, setStats] = useState(null);
  const [chartData, setChartData] = useState([]);
  const [loading, setLoading] = useState(true);
  const [hoverIdx, setHoverIdx] = useState(null);

  useEffect(() => { fetchStats(); }, []);

  async function fetchStats() {
    try {
      const now = new Date();
      const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
      const weekStart  = new Date(now.getTime() - 7  * 24 * 60 * 60 * 1000).toISOString();
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
        meetingsToday:  todayRes.count   || 0,
        meetingsWeek:   weekRes.count    || 0,
        meetingsMonth:  monthRes.count   || 0,
        activeAgents:   agentsRes.count  || 0,
        pendingAlerts:  alertsRes.count  || 0,
        processingQueue: inFlightRes.count || 0,
        emailsSentToday: emailsTodayRes.count || 0,
      });

      // 7-day chart
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
        days.push({ day: dayStart.toLocaleDateString('en-US', { weekday: 'short' }), meetings: count || 0 });
      }
      setChartData(days);
    } catch (err) {
      console.error('Failed to fetch stats:', err);
    } finally {
      setLoading(false);
    }
  }

  /* ── Render ─────────────────────────────────────────────────────── */
  return (
    <div className="space-y-8 animate-page-reveal">

      {/* Page header */}
      <div className="animate-fade-in">
        <p className="text-[11px] uppercase tracking-[0.34em] text-[#64748B]">Overview</p>
        <h2 className="mt-1 text-[28px] font-semibold tracking-tight text-[#020617] leading-tight">
          Dashboard
        </h2>
      </div>

      {/* ── Stat cards ────────────────────────────────────────────── */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4">
        {loading
          ? Array.from({ length: 5 }).map((_, i) => <SkeletonCard key={`skeleton-${i}`} />)
          : CARD_META.map((m, i) => (
              <StatCard
                key={m.key}
                icon={m.icon}
                label={m.label}
                value={stats[m.key]}
                accent={m.accent}
                delay={i * 60}
              />
            ))}
      </div>

      {/* ── Bottom row ────────────────────────────────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">

        {/* Chart — takes 2 cols */}
        <div
          className="lg:col-span-2 glass-panel p-6 animate-slide-up"
          style={{ animationDelay: '360ms' }}
        >
          <div className="flex items-end justify-between mb-6">
            <div>
              <p className="text-[11px] uppercase tracking-[0.28em] text-[#64748B]">Activity</p>
              <h3 className="mt-0.5 text-[16px] font-semibold text-[#020617]">Meetings This Week</h3>
            </div>
            <div
              className="text-[11px] px-2.5 py-1 border border-[#E2E8F0] text-[#64748B]"
            >
              Last 7 days
            </div>
          </div>

          <div className="h-52">
            {loading ? (
              <div className="h-full skeleton" />
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={chartData} barCategoryGap="35%">
                  <CartesianGrid strokeDasharray="3 3" stroke="#F1F5F9" vertical={false} />
                  <XAxis
                    dataKey="day"
                    tick={{ fontSize: 11, fill: '#94A3B8', fontFamily: 'inherit' }}
                    axisLine={false}
                    tickLine={false}
                  />
                  <YAxis
                    allowDecimals={false}
                    tick={{ fontSize: 11, fill: '#94A3B8', fontFamily: 'inherit' }}
                    axisLine={false}
                    tickLine={false}
                    width={28}
                  />
                  <Tooltip content={<CustomTooltip />} cursor={{ fill: '#FFF3E8' }} />
                  <Bar dataKey="meetings" radius={[0, 0, 0, 0]} isAnimationActive animationDuration={800}>
                    {chartData.map((entry, index) => (
                      <Cell
                        key={`cell-${index}`}
                        fill={index === hoverIdx ? '#EA580C' : '#F97316'}
                        onMouseEnter={() => setHoverIdx(index)}
                        onMouseLeave={() => setHoverIdx(null)}
                        style={{ transition: 'fill 0.15s ease', cursor: 'pointer' }}
                      />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            )}
          </div>
        </div>

        {/* Summary panel */}
        <div
          className="glass-panel p-6 flex flex-col animate-slide-up"
          style={{ animationDelay: '420ms' }}
        >
          <div className="mb-6">
            <p className="text-[11px] uppercase tracking-[0.28em] text-[#64748B]">At a glance</p>
            <h3 className="mt-0.5 text-[16px] font-semibold text-[#020617]">Summary</h3>
          </div>

          {loading ? (
            <div className="space-y-4">
              {Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className="skeleton h-10" />
              ))}
            </div>
          ) : (
            <div className="flex-1 flex flex-col justify-between">
              {[
                {
                  label: 'This Week',
                  value: `${stats.meetingsWeek} meetings`,
                  color: '#020617',
                  delay: 480,
                },
                {
                  label: 'This Month',
                  value: `${stats.meetingsMonth} meetings`,
                  color: '#020617',
                  delay: 530,
                },
                {
                  label: 'Active Agents',
                  value: stats.activeAgents,
                  color: '#10B981',
                  delay: 580,
                },
                {
                  label: 'Unreviewed Alerts',
                  value: stats.pendingAlerts,
                  color: stats.pendingAlerts > 0 ? '#F59E0B' : '#020617',
                  delay: 630,
                },
              ].map(({ label, value, color, delay }) => (
                <div
                  key={label}
                  className="flex justify-between items-center py-3 border-b border-[#F1F5F9] last:border-0 animate-slide-up"
                  style={{ animationDelay: `${delay}ms` }}
                >
                  <span className="text-[13px] text-[#64748B]">{label}</span>
                  <span
                    className="text-[15px] font-semibold"
                    style={{ color }}
                  >
                    {value}
                  </span>
                </div>
              ))}

              {/* Decorative orange gradient strip at bottom */}
              <div
                className="mt-5 h-[3px] w-full"
                style={{ background: 'linear-gradient(90deg, #F97316 0%, #FFD4AA 100%)' }}
              />
            </div>
          )}
        </div>
      </div>

      {/* ── Live Pipeline Monitor ──────────────────────────────── */}
      <LivePipelineMonitor />
    </div>
  );
}

export default Overview;
