// file: frontend/src/components/shared/Navbar.jsx
import React, { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../hooks/useAuth';
import { LogOut, Menu, Bell, AlertTriangle, X } from 'lucide-react';
import { supabase } from '../../lib/supabase';

/* ── Alert severity colours ──────────────────────────────────────── */
const SEV_COLORS = {
  high:   { text: 'text-red-600',    bg: 'bg-red-50',    dot: '#EF4444' },
  medium: { text: 'text-orange-600', bg: 'bg-orange-50', dot: '#F97316' },
  low:    { text: 'text-yellow-600', bg: 'bg-yellow-50', dot: '#F59E0B' },
};

function timeAgo(iso) {
  const diff = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

/* ── Notification Bell component ─────────────────────────────────── */
function NotificationBell() {
  const navigate = useNavigate();
  const [count, setCount] = useState(0);
  const [recent, setRecent] = useState([]);
  const [open, setOpen] = useState(false);
  const [pulse, setPulse] = useState(false);
  const dropdownRef = useRef(null);
  const channelRef = useRef(null);

  async function fetchAlerts() {
    const { data, count: cnt } = await supabase
      .from('tone_alerts')
      .select('id, flagged_text, severity, created_at, speaker', { count: 'exact' })
      .eq('is_reviewed', false)
      .order('created_at', { ascending: false })
      .limit(5);
    setCount(cnt || 0);
    setRecent(data || []);
  }

  useEffect(() => {
    fetchAlerts();

    channelRef.current = supabase
      .channel('navbar-tone-alerts')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'tone_alerts' }, (payload) => {
        setCount(c => c + 1);
        setRecent(prev => [payload.new, ...prev].slice(0, 5));
        // Pulse the bell
        setPulse(true);
        setTimeout(() => setPulse(false), 2000);
      })
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'tone_alerts' }, () => {
        fetchAlerts();
      })
      .subscribe();

    return () => {
      if (channelRef.current) supabase.removeChannel(channelRef.current);
    };
  }, []);

  // Close dropdown when clicking outside
  useEffect(() => {
    if (!open) return;
    function handleClickOutside(e) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [open]);

  return (
    <div className="relative" ref={dropdownRef}>
      <button
        onClick={() => setOpen(o => !o)}
        className={`relative p-2 rounded-xl border border-transparent hover:border-orange-200/60 hover:bg-[#FFF3E8]/80 transition-all duration-150 ${pulse ? 'animate-glow-ring' : ''}`}
        title="Tone alerts"
      >
        <Bell className="h-4 w-4 text-[#475569]" />
        {count > 0 && (
          <span
            className="absolute -top-1 -right-1 flex h-4 w-4 items-center justify-center rounded-full text-[9px] font-bold text-white"
            style={{ background: '#EF4444', minWidth: '1rem' }}
          >
            {count > 99 ? '99+' : count}
          </span>
        )}
      </button>

      {open && (
        <div
          className="absolute right-0 top-full mt-2 w-80 float-panel rounded-2xl z-50 overflow-hidden"
        >
          {/* Header */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-[#F1F5F9]">
            <div className="flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-[#F59E0B]" />
              <span className="text-[13px] font-semibold text-[#020617]">Tone Alerts</span>
              {count > 0 && (
                <span className="text-[11px] px-1.5 py-0.5 bg-red-100 text-red-600 font-semibold rounded">
                  {count} unreviewed
                </span>
              )}
            </div>
            <button onClick={() => setOpen(false)} className="p-0.5 hover:bg-[#F1F5F9] transition-colors">
              <X className="h-3.5 w-3.5 text-[#94A3B8]" />
            </button>
          </div>

          {/* Alert list */}
          <div className="max-h-72 overflow-y-auto">
            {recent.length === 0 ? (
              <div className="px-4 py-6 text-center">
                <Bell className="h-8 w-8 text-[#E2E8F0] mx-auto mb-2" />
                <p className="text-[12px] text-[#94A3B8]">No unreviewed alerts</p>
              </div>
            ) : (
              recent.map(alert => {
                const sev = SEV_COLORS[alert.severity] || SEV_COLORS.medium;
                return (
                  <div
                    key={alert.id}
                    className="px-4 py-3 border-b border-[#F8FAFC] last:border-0 hover:bg-[#F8FAFC] rounded-xl transition-colors cursor-pointer"
                    onClick={() => { setOpen(false); navigate('/alerts'); }}
                  >
                    <div className="flex items-center gap-2 mb-1">
                      <span className="h-1.5 w-1.5 rounded-full flex-shrink-0" style={{ background: sev.dot }} />
                      <span className={`text-[11px] font-semibold uppercase tracking-wide ${sev.text}`}>{alert.severity}</span>
                      {alert.speaker && (
                        <span className="text-[11px] text-[#64748B]">{alert.speaker}</span>
                      )}
                      <span className="ml-auto text-[10px] text-[#94A3B8]">{timeAgo(alert.created_at)}</span>
                    </div>
                    <p className="text-[12px] text-[#475569] line-clamp-2 italic">
                      "{alert.flagged_text}"
                    </p>
                  </div>
                );
              })
            )}
          </div>

          {/* Footer */}
          <div className="px-4 py-2.5 border-t border-[#F1F5F9]">
            <button
              onClick={() => { setOpen(false); navigate('/alerts'); }}
              className="text-[12px] font-medium text-[#F97316] hover:text-[#EA580C] transition-colors"
            >
              View all alerts →
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/* ── Main Navbar ─────────────────────────────────────────────────── */
function Navbar({ onToggleSidebar }) {
  const { profile, logout } = useAuth();

  return (
    <header className="rounded-2xl float-panel flex-shrink-0 h-14 flex items-center gap-4 px-5">
      {/* Mobile hamburger */}
      <button
        onClick={onToggleSidebar}
        className="lg:hidden p-2 rounded-xl hover:bg-[#FFF3E8] transition-colors"
      >
        <Menu className="h-5 w-5 text-[#475569]" />
      </button>

      {/* Spacer */}
      <div className="flex-1" />

      {/* Right actions */}
      <div className="flex items-center gap-3">
        {/* Notification Bell */}
        <NotificationBell />

        {/* User pill */}
        {profile?.full_name && (
          <div className="hidden sm:flex items-center gap-2 border border-[#E2E8F0] rounded-xl px-3 py-1.5">
            <div
              className="h-7 w-7 rounded-full flex items-center justify-center text-[10px] font-bold text-white"
              style={{ background: 'linear-gradient(135deg, #F97316 0%, #DC4F04 100%)' }}
            >
              {profile.full_name.charAt(0).toUpperCase()}
            </div>
            <span className="text-[12px] font-medium text-[#475569]">
              {profile.full_name}
            </span>
          </div>
        )}

        {/* Logout */}
        <button
          onClick={logout}
          className="rounded-xl p-2 border border-transparent hover:bg-red-50/60 hover:text-red-500 text-[#475569] transition-all duration-150"
          title="Sign out"
        >
          <LogOut className="h-4 w-4" />
        </button>
      </div>
    </header>
  );
}

export default Navbar;
