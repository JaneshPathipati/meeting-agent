// file: frontend/src/components/shared/Sidebar.jsx
import React, { useState, useEffect, useRef } from 'react';
import { NavLink } from 'react-router-dom';
import {
  LayoutDashboard, Users, Video, AlertTriangle, BarChart3,
  Settings, ScrollText, X, Radio, Search, Wifi,
} from 'lucide-react';
import { supabase } from '../../lib/supabase';

/* ── Live badge counts (fetched once + realtime updates) ─────────── */
function useSidebarCounts() {
  const [alertsCount, setAlertsCount]     = useState(0);
  const [processingCount, setProcessingCount] = useState(0);
  const [onlineCount, setOnlineCount]     = useState(0);
  const channelRef = useRef(null);

  async function fetchCounts() {
    const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const [alertsRes, processingRes, onlineRes] = await Promise.all([
      supabase.from('tone_alerts').select('id', { count: 'exact', head: true }).eq('is_reviewed', false),
      supabase.from('meetings').select('id', { count: 'exact', head: true })
        .in('status', ['uploaded', 'processing', 'awaiting_teams_transcript']),
      supabase.from('profiles').select('id', { count: 'exact', head: true })
        .eq('role', 'user').eq('is_active', true).gte('last_agent_heartbeat', fiveMinAgo),
    ]);
    setAlertsCount(alertsRes.count || 0);
    setProcessingCount(processingRes.count || 0);
    setOnlineCount(onlineRes.count || 0);
  }

  useEffect(() => {
    fetchCounts();
    const interval = setInterval(fetchCounts, 30000);

    channelRef.current = supabase
      .channel('sidebar-counts')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'tone_alerts' }, fetchCounts)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'meetings' }, fetchCounts)
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'profiles' }, fetchCounts)
      .subscribe();

    return () => {
      clearInterval(interval);
      if (channelRef.current) supabase.removeChannel(channelRef.current);
    };
  }, []);

  return { alertsCount, processingCount, onlineCount };
}

/* ── Badge component ─────────────────────────────────────────────── */
function Badge({ count, color = '#EF4444' }) {
  if (!count) return null;
  return (
    <span
      className="ml-auto flex h-4.5 min-w-[1.1rem] items-center justify-center px-1 text-[10px] font-bold text-white leading-none"
      style={{ background: color, borderRadius: '4px' }}
    >
      {count > 99 ? '99+' : count}
    </span>
  );
}

/* ── Nav section label ───────────────────────────────────────────── */
function SectionLabel({ label }) {
  return (
    <p className="px-3 pt-4 pb-1 text-[9px] uppercase tracking-[0.28em] text-[#CBD5E1] font-semibold select-none">
      {label}
    </p>
  );
}

/* ── Single nav link ─────────────────────────────────────────────── */
function NavItem({ to, icon: Icon, label, badge, exact, onClose, delay = 0, liveIndicator = false }) {
  return (
    <NavLink
      to={to}
      end={exact}
      onClick={onClose}
      className={({ isActive }) =>
        `relative flex items-center gap-3 px-3 py-2.5 text-[13px] font-medium transition-all duration-150 animate-slide-in-left rounded-xl ${
          isActive
            ? 'nav-active-bar bg-gradient-to-r from-[#FFF3E8] to-[#FFF8F4] text-[#F97316] pl-4'
            : 'text-[#475569] hover:bg-white/60 hover:text-[#020617]'
        }`
      }
      style={({ isActive }) => ({ animationDelay: `${delay}ms`, ...(isActive ? { boxShadow: 'inset 0 0 0 1px rgba(249,115,22,0.15)' } : {}) })}
    >
      <Icon className="h-4 w-4 flex-shrink-0" />
      <span className="flex-1">{label}</span>
      {liveIndicator && (
        <span className="relative flex h-2 w-2">
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-[#10B981] opacity-60" />
          <span className="relative inline-flex rounded-full h-2 w-2 bg-[#10B981]" />
        </span>
      )}
      {badge}
    </NavLink>
  );
}

/* ── Main Sidebar ────────────────────────────────────────────────── */
function Sidebar({ isOpen, onClose }) {
  const { alertsCount, processingCount, onlineCount } = useSidebarCounts();

  return (
    <>
      {/* Mobile overlay */}
      {isOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/40 lg:hidden"
          onClick={onClose}
        />
      )}

      <aside
        className={`float-panel flex flex-col overflow-hidden flex-shrink-0 w-64 transform transition-transform duration-200 ease-in-out lg:translate-x-0 lg:static lg:z-auto lg:m-3 ${
          isOpen
            ? 'fixed top-3 left-3 bottom-3 z-50 translate-x-0'
            : 'fixed top-3 left-3 bottom-3 z-50 -translate-x-[110%] lg:translate-x-0'
        }`}
      >
        {/* ── Zone 1: Logo bar ────────────────────────────────── */}
        <div className="logo-bar flex items-center justify-between h-16 px-5 flex-shrink-0">
          <div className="flex items-center gap-3">
            <div className="h-9 w-9 rounded-xl bg-white shadow-md overflow-hidden flex items-center justify-center">
              <img src="/utilitarianlabs_logo.jpg" alt="logo" className="h-7 w-7 object-contain" />
            </div>
            <span className="text-[15px] font-bold text-gradient-orange tracking-tight">
              Admin Panel
            </span>
          </div>
          <button
            onClick={onClose}
            className="lg:hidden p-1.5 rounded-lg hover:bg-[#FFF3E8] transition-colors"
          >
            <X className="h-4 w-4 text-[#64748B]" />
          </button>
        </div>

        {/* ── Zone 2: Nav ──────────────────────────────────────── */}
        <nav className="flex-1 px-3 py-2 overflow-y-auto">

          {/* — Monitoring — */}
          <SectionLabel label="Monitoring" />
          <NavItem to="/"       icon={LayoutDashboard} label="Dashboard"     exact  onClose={onClose} delay={0} />
          <NavItem to="/live"   icon={Radio}           label="Live Monitor"  onClose={onClose} delay={40}
            liveIndicator={onlineCount > 0}
            badge={onlineCount > 0 ? <Badge count={onlineCount} color="#10B981" /> : null}
          />
          <NavItem to="/alerts" icon={AlertTriangle}   label="Tone Alerts"   onClose={onClose} delay={80}
            badge={<Badge count={alertsCount} color="#EF4444" />}
          />

          {/* — Management — */}
          <SectionLabel label="Management" />
          <NavItem to="/users"    icon={Users}   label="Users"    onClose={onClose} delay={120} />
          <NavItem to="/meetings" icon={Video}   label="Meetings" onClose={onClose} delay={160}
            badge={<Badge count={processingCount} color="#F59E0B" />}
          />
          <NavItem to="/search"   icon={Search}  label="Search"   onClose={onClose} delay={200} />
          <NavItem to="/analytics" icon={BarChart3} label="Analytics" onClose={onClose} delay={240} />

          {/* — System — */}
          <SectionLabel label="System" />
          <NavItem to="/logs"     icon={ScrollText} label="Device Logs" onClose={onClose} delay={280} />
          <NavItem to="/settings" icon={Settings}   label="Settings"   onClose={onClose} delay={320} />
        </nav>

        {/* ── Zone 3: Footer ───────────────────────────────────── */}
        <div className="px-4 py-3 border-t border-[rgba(15,23,42,0.06)] flex-shrink-0">
          <div className="flex items-center justify-between">
            <p className="text-[10px] uppercase tracking-[0.2em] text-[#94A3B8]">MeetChamp v1.0</p>
            {onlineCount > 0 && (
              <div className="flex items-center gap-1">
                <Wifi className="h-3 w-3 text-[#10B981]" />
                <span className="text-[10px] font-medium text-[#10B981]">{onlineCount} online</span>
              </div>
            )}
          </div>
        </div>
      </aside>
    </>
  );
}

export default Sidebar;
