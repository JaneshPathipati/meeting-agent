// file: frontend/src/components/shared/TopNav.jsx
import React, { useState, useRef, useEffect } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import {
  LayoutDashboard, Radio, UsersRound, Presentation, TrendingUp, SlidersHorizontal,
  User, Bell, LogOut,
} from 'lucide-react';
import { useAuth } from '../../hooks/useAuth';
import { supabase } from '../../lib/supabase';

const NAV_ITEMS = [
  { to: '/',          icon: LayoutDashboard,   label: 'Dashboard',   exact: true },
  { to: '/live',      icon: Radio,             label: 'Live Monitor'              },
  { to: '/users',     icon: UsersRound,        label: 'Members'                   },
  { to: '/meetings',  icon: Presentation,      label: 'Sessions'                  },
  { to: '/analytics', icon: TrendingUp,        label: 'Insights'                  },
  { to: '/settings',  icon: SlidersHorizontal, label: 'Preferences'               },
];

/* ── Profile dropdown ────────────────────────────────────────────── */
function ProfileDropdown({ profile, logout }) {
  const [open, setOpen]           = useState(false);
  const [hasAlerts, setHasAlerts] = useState(false);
  const navigate = useNavigate();
  const ref = useRef(null);

  useEffect(() => {
    supabase
      .from('tone_alerts')
      .select('id', { count: 'exact', head: true })
      .eq('is_reviewed', false)
      .then(({ count }) => setHasAlerts((count || 0) > 0));
  }, []);

  useEffect(() => {
    if (!open) return;
    function handleClickOutside(e) {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [open]);

  const initial = profile?.full_name?.charAt(0)?.toUpperCase() || 'A';

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen(o => !o)}
        className="flex items-center gap-2 rounded-xl p-1 hover:bg-black/5 transition-colors"
      >
        <div
          className="h-8 w-8 rounded-full flex items-center justify-center text-[13px] font-bold text-white"
          style={{ background: 'linear-gradient(135deg, #F97316 0%, #DC4F04 100%)' }}
        >
          {initial}
        </div>
      </button>

      {open && (
        <div
          className="absolute right-0 top-full mt-2 w-52 bg-white z-50 overflow-hidden"
          style={{
            borderRadius: '14px',
            boxShadow: '0 4px 24px rgba(15,23,42,0.12), 0 0 0 1px rgba(226,232,240,0.7)',
          }}
        >
          {profile?.full_name && (
            <div className="px-4 py-3 border-b border-[#F1F5F9]">
              <p className="text-[13px] font-semibold text-[#020617]">{profile.full_name}</p>
              <p className="text-[11px] text-[#94A3B8]">Administrator</p>
            </div>
          )}

          <div className="p-1.5 space-y-0.5">
            <button
              onClick={() => setOpen(false)}
              className="flex items-center gap-3 w-full px-3 py-2 rounded-lg text-[13px] text-[#475569] hover:bg-[#F8FAFC] transition-colors"
            >
              <User className="h-4 w-4" />
              Profile
            </button>

            <button
              onClick={() => { setOpen(false); navigate('/alerts'); }}
              className="flex items-center gap-3 w-full px-3 py-2 rounded-lg text-[13px] text-[#475569] hover:bg-[#F8FAFC] transition-colors"
            >
              <Bell className="h-4 w-4" />
              Notifications
              {hasAlerts && (
                <span className="ml-auto h-2 w-2 rounded-full bg-[#F97316]" />
              )}
            </button>

            <button
              onClick={() => { setOpen(false); logout(); }}
              className="flex items-center gap-3 w-full px-3 py-2 rounded-lg text-[13px] text-red-500 hover:bg-red-50 transition-colors"
            >
              <LogOut className="h-4 w-4" />
              Logout
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/* ── Top navigation bar ──────────────────────────────────────────── */
function TopNav() {
  const { profile, logout } = useAuth();

  return (
    <header
      className="relative flex-shrink-0 flex items-center px-6 h-16 bg-white"
      style={{
        borderRadius: '0 0 16px 16px',
        boxShadow: '0 2px 12px rgba(15,23,42,0.07)',
      }}
    >
      {/* Logo */}
      <div className="flex items-center gap-3 flex-shrink-0">
        <div className="h-9 w-9 rounded-xl bg-white shadow-md overflow-hidden flex items-center justify-center">
          <img src="/utilitarianlabs_logo.jpg" alt="logo" className="h-7 w-7 object-contain" />
        </div>
        <span className="text-[15px] font-bold text-gradient-orange tracking-tight whitespace-nowrap">
          Admin Panel
        </span>
      </div>

      {/* Nav links — centred */}
      <nav className="absolute left-1/2 -translate-x-1/2 flex items-center gap-1">
        {NAV_ITEMS.map(({ to, icon: Icon, label, exact }) => (
          <NavLink
            key={to}
            to={to}
            end={exact}
            className={({ isActive }) =>
              `flex items-center gap-2 px-3 py-2 rounded-[10px] text-[13px] font-medium transition-all duration-150 whitespace-nowrap ${
                isActive
                  ? 'bg-[#F97316] text-white'
                  : 'text-[#475569] hover:bg-black/5 hover:text-[#020617]'
              }`
            }
          >
            <Icon className="h-4 w-4 flex-shrink-0" />
            {label}
          </NavLink>
        ))}
      </nav>

      {/* Profile dropdown — pinned right */}
      <div className="ml-auto">
        <ProfileDropdown profile={profile} logout={logout} />
      </div>
    </header>
  );
}

export default TopNav;
