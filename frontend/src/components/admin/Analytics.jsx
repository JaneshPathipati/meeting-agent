// file: frontend/src/components/admin/Analytics.jsx
import React, { useState, useEffect } from 'react';
import { supabase } from '../../lib/supabase';
import LoadingSpinner from '../shared/LoadingSpinner';
import { Video, Clock, Layers, BarChart2, PieChart as PieIcon, TrendingUp, Monitor } from 'lucide-react';
import {
  BarChart, Bar, PieChart, Pie, Cell, LineChart, Line, Area, AreaChart,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from 'recharts';

const CATEGORY_COLORS = {
  client_conversation: '#3B82F6',
  consultant_meeting:  '#8B5CF6',
  internal_meeting:    '#6366F1',
  interview:           '#14B8A6',
  target_company:      '#10B981',
  sales_service:       '#F97316',
  general:             '#6B7280',
  uncategorized:       '#CBD5E1',
};

const PLATFORM_COLORS = {
  'Microsoft Teams': '#6366F1',
  'Google Meet':     '#10B981',
  'Others':          '#F97316',
};

function categorizePlatform(detectedApp) {
  if (!detectedApp) return 'Others';
  const lower = detectedApp.toLowerCase();
  if (lower.includes('teams')) return 'Microsoft Teams';
  if (lower.includes('meet') || lower.includes('google')) return 'Google Meet';
  return 'Others';
}

/* ── Custom tooltip ───────────────────────────────────────────────── */
function ChartTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null;
  return (
    <div
      className="rounded-[14px] px-4 py-3"
      style={{
        background: 'rgba(255,255,255,0.98)',
        boxShadow: '0 8px 30px rgba(15,23,42,0.14)',
        border: '1px solid rgba(226,232,240,0.7)',
        fontFamily: 'Onest, ui-sans-serif, system-ui, sans-serif',
      }}
    >
      {label && <p className="text-[10px] uppercase tracking-[0.2em] font-semibold text-[#94A3B8] mb-1">{label}</p>}
      <p
        className="text-[20px] font-semibold text-[#020617] leading-none"
        style={{ fontFamily: 'Geist, ui-sans-serif, system-ui, sans-serif' }}
      >
        {payload[0].value}
      </p>
      {payload[0].name && payload[0].name !== payload[0].value && (
        <p className="text-[11px] text-[#64748B] mt-0.5">{payload[0].name}</p>
      )}
    </div>
  );
}

/* ── Custom Legend pills ──────────────────────────────────────────── */
function LegendPills({ items }) {
  return (
    <div className="flex flex-wrap gap-2 mt-4 justify-center">
      {items.map((item, i) => (
        <span
          key={i}
          className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-medium"
          style={{
            background: item.fill + '18',
            color: item.fill,
            border: `1px solid ${item.fill}30`,
          }}
        >
          <span className="h-1.5 w-1.5 rounded-full flex-shrink-0" style={{ background: item.fill }} />
          {item.name}
        </span>
      ))}
    </div>
  );
}

/* ── Stat card ────────────────────────────────────────────────────── */
function StatCard({ icon: Icon, label, value, accent, delay }) {
  return (
    <div
      className="glass-card animate-slide-up p-6"
      style={{ animationDelay: `${delay}ms`, borderRadius: '20px' }}
    >
      <div className="flex items-start justify-between mb-4">
        <div
          className="h-10 w-10 rounded-[14px] flex items-center justify-center flex-shrink-0"
          style={{
            background: `linear-gradient(135deg, ${accent} 0%, ${accent}CC 100%)`,
            boxShadow: `0 4px 14px ${accent}40`,
          }}
        >
          <Icon className="h-4.5 w-4.5 text-white" style={{ height: '18px', width: '18px' }} />
        </div>
        <span
          className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold"
          style={{ background: accent + '15', color: accent }}
        >
          Live
        </span>
      </div>
      <p
        className="text-[36px] font-semibold tracking-tight text-[#020617] leading-none mb-1.5"
        style={{ fontFamily: 'Geist, ui-sans-serif, system-ui, sans-serif' }}
      >
        {value}
      </p>
      <p className="text-[12px] font-medium text-[#64748B]">{label}</p>
    </div>
  );
}

/* ── Chart panel wrapper ──────────────────────────────────────────── */
function ChartPanel({ eyebrow, title, icon: Icon, accent, children, delay }) {
  return (
    <div
      className="animate-slide-up"
      style={{
        animationDelay: `${delay}ms`,
        background: 'rgba(255,255,255,0.92)',
        border: '1px solid rgba(226,232,240,0.7)',
        borderRadius: '20px',
        boxShadow: '0 4px 24px rgba(15,23,42,0.07)',
      }}
    >
      <div
        className="flex items-center gap-3 px-6 py-5"
        style={{ borderBottom: '1px solid rgba(226,232,240,0.7)' }}
      >
        <div
          className="h-8 w-8 rounded-[10px] flex items-center justify-center flex-shrink-0"
          style={{ background: (accent || '#F97316') + '15' }}
        >
          <Icon className="h-4 w-4" style={{ color: accent || '#F97316' }} />
        </div>
        <div>
          <p className="text-[10px] uppercase tracking-[0.26em] font-semibold text-[#94A3B8] leading-none mb-0.5">
            {eyebrow}
          </p>
          <h3
            className="text-[15px] font-semibold text-[#020617] leading-tight"
            style={{ fontFamily: 'Geist, ui-sans-serif, system-ui, sans-serif' }}
          >
            {title}
          </h3>
        </div>
      </div>
      <div className="p-6">{children}</div>
    </div>
  );
}

/* ── Empty chart state ────────────────────────────────────────────── */
function EmptyChart({ message = 'No data yet' }) {
  return (
    <div className="h-56 flex flex-col items-center justify-center gap-2">
      <div className="h-10 w-10 rounded-full flex items-center justify-center" style={{ background: '#F4F2EF' }}>
        <BarChart2 className="h-5 w-5 text-[#CBD5E1]" />
      </div>
      <p className="text-[13px] font-medium text-[#94A3B8]">{message}</p>
    </div>
  );
}

function Analytics() {
  const [data, setData]     = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]   = useState(null);

  useEffect(() => { fetchAnalytics(); }, []);

  async function fetchAnalytics() {
    try {
      const [meetingsRes, alertsRes] = await Promise.all([
        supabase.from('meetings').select('user_id, detected_app, detected_category, duration_seconds, created_at, profiles!inner(full_name)'),
        supabase.from('tone_alerts').select('severity, created_at'),
      ]);

      if (meetingsRes.error) throw meetingsRes.error;
      if (alertsRes.error) throw alertsRes.error;

      const meetings = meetingsRes.data || [];
      const alerts   = alertsRes.data || [];

      // Sessions per member
      const userCounts = {};
      meetings.forEach(m => {
        const name = m.profiles?.full_name || 'Unknown';
        userCounts[name] = (userCounts[name] || 0) + 1;
      });
      const meetingsPerUser = Object.entries(userCounts)
        .map(([name, count]) => ({ name, meetings: count }))
        .sort((a, b) => b.meetings - a.meetings)
        .slice(0, 10);

      // Sessions per category
      const catCounts = {};
      meetings.forEach(m => {
        const cat = m.detected_category || 'uncategorized';
        catCounts[cat] = (catCounts[cat] || 0) + 1;
      });
      const meetingsPerCategory = Object.entries(catCounts)
        .map(([name, value]) => ({
          name: name.replace(/_/g, ' '),
          value,
          fill: CATEGORY_COLORS[name] || '#6B7280',
        }));

      // Avg duration
      const totalDuration = meetings.reduce((sum, m) => sum + (m.duration_seconds || 0), 0);
      const avgDuration = meetings.length > 0 ? Math.round(totalDuration / meetings.length / 60) : 0;

      // Tone alert trend (last 30 days)
      const alertTrend = {};
      const now = new Date();
      for (let i = 29; i >= 0; i--) {
        const d = new Date(now.getTime() - i * 24 * 60 * 60 * 1000);
        alertTrend[d.toISOString().split('T')[0]] = 0;
      }
      alerts.forEach(a => {
        const key = new Date(a.created_at).toISOString().split('T')[0];
        if (alertTrend[key] !== undefined) alertTrend[key]++;
      });
      const alertTrendData = Object.entries(alertTrend)
        .map(([date, count]) => ({ date: date.slice(5), alerts: count }));

      // Platform breakdown
      const platformCounts = {};
      meetings.forEach(m => {
        const p = categorizePlatform(m.detected_app);
        platformCounts[p] = (platformCounts[p] || 0) + 1;
      });
      const platformData = Object.entries(platformCounts)
        .map(([name, value]) => ({ name, value, fill: PLATFORM_COLORS[name] || '#6B7280' }))
        .sort((a, b) => b.value - a.value);

      // Transcript sources
      const { data: transcripts } = await supabase.from('transcripts').select('source');
      const sourceCounts = { local: 0, teams: 0 };
      (transcripts || []).forEach(t => { sourceCounts[t.source] = (sourceCounts[t.source] || 0) + 1; });
      const sourceData = [
        { name: 'Local (Parakeet)', value: sourceCounts.local },
        { name: 'Teams',            value: sourceCounts.teams },
      ];

      setData({ meetingsPerUser, meetingsPerCategory, avgDuration, totalMeetings: meetings.length, alertTrendData, sourceData, platformData });
    } catch (err) {
      console.error('Analytics fetch error:', err);
      setError(err.message || 'Failed to load analytics');
    } finally {
      setLoading(false);
    }
  }

  if (loading) return <LoadingSpinner size="lg" className="py-12" />;
  if (error)   return (
    <div className="py-8 text-center text-[13px]" style={{ color: '#DC2626' }}>{error}</div>
  );
  if (!data) return null;

  const teamsPercent = data.sourceData[0].value + data.sourceData[1].value > 0
    ? Math.round(data.sourceData[1].value / (data.sourceData[0].value + data.sourceData[1].value) * 100)
    : 0;

  const summaryCards = [
    { icon: Video,  label: 'Total Sessions', value: data.totalMeetings,                                       accent: '#F97316' },
    { icon: Clock,  label: 'Avg Duration',   value: `${data.avgDuration}m`,                                   accent: '#3B82F6' },
    { icon: Layers, label: 'Source Mix',     value: teamsPercent > 0 ? `${teamsPercent}% Teams` : '100% Local', accent: '#6366F1' },
  ];

  const maxBarValue = Math.max(...data.meetingsPerUser.map(d => d.meetings), 1);

  return (
    <div
      className="space-y-6 animate-page-reveal"
      style={{ fontFamily: 'Onest, ui-sans-serif, system-ui, sans-serif' }}
    >

      {/* ── Page header ─────────────────────────────────────────── */}
      <div className="animate-fade-in">
        <p className="text-[11px] uppercase tracking-[0.34em] text-[#64748B] font-medium">Reporting</p>
        <h2
          className="mt-1 text-[28px] font-semibold tracking-tight text-[#020617] leading-tight"
          style={{ fontFamily: 'Geist, ui-sans-serif, system-ui, sans-serif' }}
        >
          Insights
        </h2>
      </div>

      {/* ── Stat cards ──────────────────────────────────────────── */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        {summaryCards.map(({ icon, label, value, accent }, i) => (
          <StatCard key={label} icon={icon} label={label} value={value} accent={accent} delay={i * 60} />
        ))}
      </div>

      {/* ── Charts grid ─────────────────────────────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">

        {/* Sessions per member */}
        <ChartPanel eyebrow="Breakdown" title="Sessions per Member" icon={BarChart2} accent="#F97316" delay={180}>
          {data.meetingsPerUser.length === 0 ? (
            <EmptyChart message="No sessions yet" />
          ) : (
            <div className="space-y-2.5">
              {data.meetingsPerUser.map((row, i) => (
                <div key={row.name} className="flex items-center gap-3">
                  <span className="text-[12px] text-[#475569] font-medium w-32 truncate flex-shrink-0">{row.name}</span>
                  <div className="flex-1 h-7 rounded-[8px] overflow-hidden" style={{ background: '#F4F2EF' }}>
                    <div
                      className="h-full rounded-[8px] flex items-center px-2.5"
                      style={{
                        width: `${(row.meetings / maxBarValue) * 100}%`,
                        background: i === 0
                          ? 'linear-gradient(90deg, #F97316 0%, #FB923C 100%)'
                          : i === 1
                            ? 'linear-gradient(90deg, #3B82F6 0%, #60A5FA 100%)'
                            : 'linear-gradient(90deg, #8B5CF6 0%, #A78BFA 100%)',
                        minWidth: '40px',
                        transition: 'width 0.7s cubic-bezier(0.22,1,0.36,1)',
                      }}
                    >
                      <span className="text-[11px] font-bold text-white">{row.meetings}</span>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </ChartPanel>

        {/* Sessions by category */}
        <ChartPanel eyebrow="Distribution" title="Sessions by Category" icon={PieIcon} accent="#8B5CF6" delay={240}>
          {data.meetingsPerCategory.length === 0 ? (
            <EmptyChart message="No category data" />
          ) : (
            <>
              <div className="h-48">
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie
                      data={data.meetingsPerCategory}
                      dataKey="value"
                      nameKey="name"
                      cx="50%"
                      cy="50%"
                      outerRadius={80}
                      innerRadius={44}
                      paddingAngle={3}
                      strokeWidth={0}
                    >
                      {data.meetingsPerCategory.map((entry, idx) => (
                        <Cell key={idx} fill={entry.fill} />
                      ))}
                    </Pie>
                    <Tooltip
                      content={({ active, payload }) => {
                        if (!active || !payload?.length) return null;
                        const d = payload[0].payload;
                        return (
                          <div
                            className="rounded-[14px] px-4 py-3"
                            style={{
                              background: 'rgba(255,255,255,0.98)',
                              boxShadow: '0 8px 30px rgba(15,23,42,0.14)',
                              border: '1px solid rgba(226,232,240,0.7)',
                              fontFamily: 'Onest, ui-sans-serif, system-ui, sans-serif',
                            }}
                          >
                            <p className="text-[11px] font-semibold capitalize" style={{ color: d.fill }}>{d.name}</p>
                            <p className="text-[20px] font-semibold text-[#020617]" style={{ fontFamily: 'Geist, ui-sans-serif' }}>{d.value}</p>
                          </div>
                        );
                      }}
                    />
                  </PieChart>
                </ResponsiveContainer>
              </div>
              <LegendPills items={data.meetingsPerCategory} />
            </>
          )}
        </ChartPanel>

        {/* Tone alert trend */}
        <ChartPanel eyebrow="Trend" title="Tone Alerts — Last 30 Days" icon={TrendingUp} accent="#F59E0B" delay={300}>
          <div className="h-52">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={data.alertTrendData} margin={{ top: 4, right: 4, left: -16, bottom: 0 }}>
                <defs>
                  <linearGradient id="alertGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%"  stopColor="#F59E0B" stopOpacity={0.18} />
                    <stop offset="95%" stopColor="#F59E0B" stopOpacity={0}    />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#F1F5F9" vertical={false} />
                <XAxis
                  dataKey="date"
                  tick={{ fontSize: 10, fill: '#94A3B8', fontFamily: 'Onest, sans-serif' }}
                  axisLine={false}
                  tickLine={false}
                  interval={4}
                />
                <YAxis
                  allowDecimals={false}
                  tick={{ fontSize: 10, fill: '#94A3B8', fontFamily: 'Onest, sans-serif' }}
                  axisLine={false}
                  tickLine={false}
                  width={28}
                />
                <Tooltip content={<ChartTooltip />} cursor={{ stroke: 'rgba(245,158,11,0.2)', strokeWidth: 2 }} />
                <Area
                  type="monotone"
                  dataKey="alerts"
                  stroke="#F59E0B"
                  strokeWidth={2.5}
                  fill="url(#alertGrad)"
                  dot={false}
                  activeDot={{ r: 4, fill: '#F59E0B', strokeWidth: 0 }}
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </ChartPanel>

        {/* Platform breakdown */}
        <ChartPanel eyebrow="Platforms" title="Meeting Platform" icon={Monitor} accent="#6366F1" delay={360}>
          {data.platformData.length === 0 ? (
            <EmptyChart message="No platform data" />
          ) : (
            <>
              <div className="h-48">
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie
                      data={data.platformData}
                      dataKey="value"
                      nameKey="name"
                      cx="50%"
                      cy="50%"
                      outerRadius={80}
                      innerRadius={44}
                      paddingAngle={3}
                      strokeWidth={0}
                    >
                      {data.platformData.map((entry, idx) => (
                        <Cell key={idx} fill={entry.fill} />
                      ))}
                    </Pie>
                    <Tooltip
                      content={({ active, payload }) => {
                        if (!active || !payload?.length) return null;
                        const d = payload[0].payload;
                        return (
                          <div
                            className="rounded-[14px] px-4 py-3"
                            style={{
                              background: 'rgba(255,255,255,0.98)',
                              boxShadow: '0 8px 30px rgba(15,23,42,0.14)',
                              border: '1px solid rgba(226,232,240,0.7)',
                              fontFamily: 'Onest, ui-sans-serif, system-ui, sans-serif',
                            }}
                          >
                            <p className="text-[11px] font-semibold" style={{ color: d.fill }}>{d.name}</p>
                            <p className="text-[20px] font-semibold text-[#020617]" style={{ fontFamily: 'Geist, ui-sans-serif' }}>{d.value}</p>
                          </div>
                        );
                      }}
                    />
                  </PieChart>
                </ResponsiveContainer>
              </div>
              <LegendPills items={data.platformData} />
            </>
          )}
        </ChartPanel>

      </div>
    </div>
  );
}

export default Analytics;
