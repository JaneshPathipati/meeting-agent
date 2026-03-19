// file: frontend/src/components/shared/Sidebar.jsx
import React, { useState, useEffect, useRef } from 'react';
import { NavLink } from 'react-router-dom';
import {
  LayoutDashboard, Users, Video, BarChart3,
  Settings, X, Radio, Wifi,
  ChevronLeft, ChevronRight,
} from 'lucide-react';
import { supabase } from '../../lib/supabase';

/* ── Live badge counts (fetched once + realtime updates) ─────────── */
function useSidebarCounts() {
  const [alertsCount, setAlertsCount]     = useState(0);
  const [processingCount, setProcessingCount] = useState(0);
  const [onlineCount, setOnlineCount]     = useState(0);
  const channelRef = useRef(null);
  const debounceRef = useRef(null);

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

    function debouncedFetchCounts() {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(fetchCounts, 2000);
    }

    channelRef.current = supabase
      .channel('sidebar-counts')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'tone_alerts' }, debouncedFetchCounts)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'meetings' }, debouncedFetchCounts)
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'profiles' }, debouncedFetchCounts)
      .subscribe();

    return () => {
      clearInterval(interval);
      if (debounceRef.current) clearTimeout(debounceRef.current);
      if (channelRef.current) supabase.removeChannel(channelRef.current);
    };
  }, []);

  return { alertsCount, processingCount, onlineCount };
}

/* ── Badge component ─────────────────────────────────────────────── */
function Badge({ count, color = '#EF4444', collapsed = false }) {
  if (!count) return null;
  const display = count > 99 ? '99+' : count;
  if (collapsed) {
    return (
      <span
        className="absolute -top-1 -right-1 flex h-4 min-w-[1rem] items-center justify-center px-1 text-[9px] font-bold text-white leading-none rounded-full"
        style={{ background: color }}
      >
        {display}
      </span>
    );
  }
  return (
    <span
      className="ml-auto flex h-4.5 min-w-[1.1rem] items-center justify-center px-1 text-[10px] font-bold text-white leading-none"
      style={{ background: color, borderRadius: '4px' }}
    >
      {display}
    </span>
  );
}

/* ── Nav section label ───────────────────────────────────────────── */
function SectionLabel({ label, collapsed }) {
  return (
    <div
      className="overflow-hidden transition-all duration-220"
      style={{ opacity: collapsed ? 0 : 1, height: collapsed ? 0 : undefined, pointerEvents: collapsed ? 'none' : undefined }}
    >
      <p className="px-3 pt-4 pb-1 text-[9px] uppercase tracking-[0.28em] text-[#CBD5E1] font-semibold select-none">
        {label}
      </p>
    </div>
  );
}

/* ── Single nav link ─────────────────────────────────────────────── */
function NavItem({ to, icon: Icon, label, badge, badgeColor, exact, onClose, delay = 0, liveIndicator = false, collapsed }) {
  return (
    <NavLink
      to={to}
      end={exact}
      onClick={onClose}
      title={collapsed ? label : undefined}
      className={({ isActive }) =>
        `relative flex items-center gap-3 px-3 py-2.5 text-[13px] font-medium transition-all duration-150 animate-slide-in-left ${
          collapsed ? 'justify-center px-2' : ''
        } ${
          isActive
            ? 'bg-[#F97316] text-white rounded-[10px]'
            : 'text-[#475569] hover:bg-black/5 hover:text-[#020617] rounded-[10px]'
        }`
      }
      style={{ animationDelay: `${delay}ms` }}
    >
      {({ isActive }) => (
        <span className="relative flex items-center gap-3 w-full">
          <Icon className="h-4 w-4 flex-shrink-0" />
          {liveIndicator && collapsed && (
            <span className="absolute -top-1 -right-1 flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-[#10B981] opacity-60" />
              <span className="relative inline-flex rounded-full h-2 w-2 bg-[#10B981]" />
            </span>
          )}
          {badge && collapsed && (
            <Badge count={badge.count} color={badgeColor} collapsed />
          )}
          {!collapsed && (
            <>
              <span className="flex-1 whitespace-nowrap overflow-hidden">{label}</span>
              {liveIndicator && (
                <span className="relative flex h-2 w-2">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-[#10B981] opacity-60" />
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-[#10B981]" />
                </span>
              )}
              {badge}
            </>
          )}
        </span>
      )}
    </NavLink>
  );
}

/* ── Main Sidebar ────────────────────────────────────────────────── */
function Sidebar({ isOpen, onClose }) {
  const { processingCount, onlineCount } = useSidebarCounts();

  const [collapsed, setCollapsed] = useState(() => {
    try { return localStorage.getItem('sidebar_collapsed') === 'true'; }
    catch { return false; }
  });

  function toggleCollapsed() {
    setCollapsed(prev => {
      const next = !prev;
      try { localStorage.setItem('sidebar_collapsed', String(next)); } catch {}
      return next;
    });
  }

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
        className={`float-panel flex flex-col overflow-hidden flex-shrink-0 transform transition-all duration-220 ease-in-out lg:translate-x-0 lg:static lg:z-auto lg:m-3 ${
          collapsed ? 'w-16' : 'w-[248px]'
        } ${
          isOpen
            ? 'fixed top-3 left-3 bottom-3 z-50 translate-x-0'
            : 'fixed top-3 left-3 bottom-3 z-50 -translate-x-[110%] lg:translate-x-0'
        }`}
        style={{ transitionProperty: 'width, transform' }}
      >
        {/* ── Zone 1: Logo bar ────────────────────────────────── */}
        <div className="logo-bar flex items-center justify-between h-16 px-4 flex-shrink-0 overflow-hidden">
          <div className="flex items-center gap-3 min-w-0">
            <div className="h-9 w-9 rounded-xl bg-white shadow-md overflow-hidden flex items-center justify-center flex-shrink-0">
              <img src="/utilitarianlabs_logo.jpg" alt="logo" className="h-7 w-7 object-contain" />
            </div>
            {!collapsed && (
              <span className="text-[15px] font-bold text-gradient-orange tracking-tight whitespace-nowrap">
                Admin Panel
              </span>
            )}
          </div>
          <button
            onClick={onClose}
            className="lg:hidden p-1.5 rounded-lg hover:bg-[#FFF3E8] transition-colors flex-shrink-0"
          >
            <X className="h-4 w-4 text-[#64748B]" />
          </button>
        </div>

        {/* ── Zone 2: Nav ──────────────────────────────────────── */}
        <nav className="flex-1 px-2 py-2 overflow-y-auto overflow-x-hidden">
          <NavItem to="/" icon={LayoutDashboard} label="Dashboard" exact onClose={onClose} delay={0} collapsed={collapsed} />
          <NavItem to="/live" icon={Radio} label="Live Monitor" onClose={onClose} delay={40} collapsed={collapsed}
            liveIndicator={onlineCount > 0}
            badge={onlineCount > 0 ? <Badge count={onlineCount} color="#10B981" /> : null}
            badgeColor="#10B981"
          />
          <NavItem to="/users"    icon={Users}    label="Users"     onClose={onClose} delay={80}  collapsed={collapsed} />
          <NavItem to="/meetings" icon={Video}    label="Meetings"  onClose={onClose} delay={120} collapsed={collapsed}
            badge={<Badge count={processingCount} color="#F59E0B" />}
            badgeColor="#F59E0B"
          />
          <NavItem to="/analytics" icon={BarChart3} label="Analytics" onClose={onClose} delay={160} collapsed={collapsed} />
          <NavItem to="/settings"  icon={Settings}  label="Settings"  onClose={onClose} delay={200} collapsed={collapsed} />
        </nav>

        {/* ── Zone 3: Footer / Toggle ───────────────────────────── */}
        <div className="px-3 py-3 border-t border-[rgba(15,23,42,0.06)] flex-shrink-0">
          {!collapsed && onlineCount > 0 && (
            <div className="flex items-center gap-1 mb-2 px-1">
              <Wifi className="h-3 w-3 text-[#10B981]" />
              <span className="text-[10px] font-medium text-[#10B981]">{onlineCount} online</span>
            </div>
          )}
          <button
            onClick={toggleCollapsed}
            title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            className={`hidden lg:flex items-center gap-2 w-full rounded-[10px] p-2 text-[#94A3B8] hover:bg-black/5 hover:text-[#475569] transition-colors ${collapsed ? 'justify-center' : ''}`}
          >
            {collapsed ? (
              <ChevronRight className="h-4 w-4 flex-shrink-0" />
            ) : (
              <>
                <ChevronLeft className="h-4 w-4 flex-shrink-0" />
                <span className="text-[11px] font-medium whitespace-nowrap">Collapse</span>
              </>
            )}
          </button>
        </div>
      </aside>
    </>
  );
}

export default Sidebar;
