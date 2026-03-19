// file: frontend/src/components/admin/UsersList.jsx
import React, { useState, useEffect, useMemo, useRef } from 'react';
import ReactDOM from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../../lib/supabase';
import {
  UserPlus, Edit2, UserX, Wifi, WifiOff, Lock, Unlock,
  Trash2, Mail, MailX, FileText, FileX, Search, X,
  Users, CheckCircle2, Activity,
} from 'lucide-react';
import { formatRelative } from '../../utils/formatDate';
import LoadingSpinner from '../shared/LoadingSpinner';
import AddUserModal from './AddUserModal';
import EditUserModal from './EditUserModal';

/* ── Confirm dialog ──────────────────────────────────────────────── */
function ConfirmDialog({ title, message, confirmLabel, confirmColor, onConfirm, onCancel }) {
  return ReactDOM.createPortal(
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/50"
      style={{ fontFamily: 'Onest, ui-sans-serif, system-ui, sans-serif' }}>
      <div className="bg-white w-full max-w-sm mx-4 overflow-hidden"
        style={{ borderRadius: '22px', boxShadow: '0 24px 60px rgba(15,23,42,0.22)' }}>
        <div className="px-6 pt-6 pb-5">
          <h3 className="text-[16px] font-bold text-[#020617] mb-2">{title}</h3>
          <p className="text-[13px] text-[#64748B] leading-relaxed">{message}</p>
        </div>
        <div className="flex gap-3 px-6 pb-6">
          <button onClick={onCancel}
            className="flex-1 py-2.5 rounded-[12px] text-[13px] font-medium text-[#475569] transition-colors hover:bg-[#F4F2EF]"
            style={{ border: '1px solid rgba(226,232,240,0.9)' }}>
            Cancel
          </button>
          <button onClick={onConfirm}
            className={`flex-1 py-2.5 rounded-[12px] text-[13px] font-semibold text-white transition-all ${confirmColor || 'bg-[#F97316] hover:bg-[#EA580C]'}`}>
            {confirmLabel || 'Confirm'}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}

/* ── Avatar ──────────────────────────────────────────────────────── */
const AVATAR_COLORS = [
  ['#F97316', '#FFEDD5'], ['#3B82F6', '#DBEAFE'], ['#8B5CF6', '#EDE9FE'],
  ['#10B981', '#D1FAE5'], ['#F59E0B', '#FEF3C7'], ['#EC4899', '#FCE7F3'],
];
function Avatar({ name, size = 40 }) {
  const idx = (name?.charCodeAt(0) || 0) % AVATAR_COLORS.length;
  const [fg, bg] = AVATAR_COLORS[idx];
  const initials = (name || '?').split(' ').map(w => w[0]).slice(0, 2).join('').toUpperCase();
  return (
    <div className="flex-shrink-0 flex items-center justify-center font-bold select-none"
      style={{ width: size, height: size, borderRadius: size / 3, background: bg, color: fg, fontSize: size * 0.36 }}>
      {initials}
    </div>
  );
}

/* ── Toggle pill ─────────────────────────────────────────────────── */
function TogglePill({ on, onColor, onBg, offColor = '#94A3B8', offBg = '#F1F5F9', onIcon: OnIcon, offIcon: OffIcon, label, onClick }) {
  return (
    <button onClick={onClick}
      className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-semibold transition-all hover:opacity-80"
      style={{ background: on ? onBg : offBg, color: on ? onColor : offColor }}>
      {on ? <OnIcon className="h-3 w-3" /> : <OffIcon className="h-3 w-3" />}
      {on ? 'On' : 'Off'}
    </button>
  );
}

/* ── Action icon button ──────────────────────────────────────────── */
function Btn({ onClick, title, children, danger }) {
  return (
    <button onClick={onClick} title={title}
      className={`p-1.5 rounded-lg transition-all duration-100 ${danger ? 'hover:bg-red-50' : 'hover:bg-[#F4F2EF]'}`}>
      {children}
    </button>
  );
}

function UsersList() {
  const navigate = useNavigate();
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showAddModal, setShowAddModal] = useState(false);
  const [editingUser, setEditingUser] = useState(null);
  const [confirm, setConfirm] = useState(null);
  const [searchInput, setSearchInput] = useState('');
  const [searchTerm, setSearchTerm] = useState('');
  const searchRef = useRef(null);
  const debounceRef = useRef(null);

  const filteredUsers = useMemo(() => {
    if (!searchTerm) return users;
    return users.filter(u => {
      const name  = (u.full_name || '').toLowerCase();
      const email = (u.microsoft_email || u.email || '').toLowerCase();
      return name.includes(searchTerm) || email.includes(searchTerm);
    });
  }, [users, searchTerm]);

  const stats = useMemo(() => ({
    total:    users.length,
    active:   users.filter(u => u.is_active).length,
    online:   users.filter(u => u.last_agent_heartbeat && new Date(u.last_agent_heartbeat).getTime() > Date.now() - 15 * 60 * 1000).length,
  }), [users]);

  useEffect(() => { fetchUsers(); }, []);
  useEffect(() => () => { if (debounceRef.current) clearTimeout(debounceRef.current); }, []);

  async function fetchUsers() {
    setLoading(true);
    const { data, error } = await supabase.from('profiles').select('*').eq('role', 'user').order('full_name');
    if (!error) setUsers(data || []);
    setLoading(false);
  }

  function handleSearch(val) {
    setSearchInput(val);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => setSearchTerm(val.trim().toLowerCase()), 200);
  }

  function isOnline(hb) { return !!hb && new Date(hb).getTime() > Date.now() - 15 * 60 * 1000; }

  /* ── Confirm helpers ── */
  function confirmAction(title, message, label, color, onConfirm) {
    setConfirm({ title, message, confirmLabel: label, confirmColor: color, onConfirm: () => { onConfirm(); } });
  }

  function doToggleActive(user) {
    const action = user.is_active ? 'Deactivate' : 'Activate';
    confirmAction(`${action} Member?`,
      user.is_active ? `Deactivating ${user.full_name}. Their agent will stop on next heartbeat.`
                     : `Reactivating ${user.full_name}. They can re-enroll.`,
      action, user.is_active ? 'bg-red-500 hover:bg-red-600' : 'bg-[#10B981] hover:bg-emerald-600',
      async () => {
        await supabase.from('profiles').update({ is_active: !user.is_active }).eq('id', user.id);
        setConfirm(null);
        setUsers(p => p.map(u => u.id === user.id ? { ...u, is_active: !u.is_active } : u));
      });
  }

  function doToggleLock(user) {
    const locking = !user.is_locked_out;
    confirmAction(`${locking ? 'Lock Out' : 'Unlock'} Member?`,
      locking ? `${user.full_name} will be locked out and must re-enroll.`
              : `${user.full_name} can re-enroll via the setup wizard.`,
      locking ? 'Lock Out' : 'Unlock',
      locking ? 'bg-amber-500 hover:bg-amber-600' : 'bg-[#10B981] hover:bg-emerald-600',
      async () => {
        await supabase.from('profiles').update({ is_locked_out: locking }).eq('id', user.id);
        setConfirm(null);
        setUsers(p => p.map(u => u.id === user.id ? { ...u, is_locked_out: locking } : u));
      });
  }

  function doToggleSummary(user) {
    const enabling = user.summary_enabled === false;
    confirmAction(`${enabling ? 'Enable' : 'Disable'} Summaries?`,
      enabling ? `AI summaries will be generated for ${user.full_name} after each meeting.`
               : `Summaries disabled for ${user.full_name}. Meetings still recorded.`,
      enabling ? 'Enable' : 'Disable',
      enabling ? 'bg-[#10B981] hover:bg-emerald-600' : 'bg-amber-500 hover:bg-amber-600',
      async () => {
        const upd = { summary_enabled: enabling };
        if (!enabling) upd.email_enabled = false;
        await supabase.from('profiles').update(upd).eq('id', user.id);
        setConfirm(null);
        setUsers(p => p.map(u => u.id === user.id ? { ...u, ...upd } : u));
      });
  }

  function doToggleEmail(user) {
    const enabling = !user.email_enabled;
    confirmAction(`${enabling ? 'Enable' : 'Disable'} Email Notifications?`,
      enabling ? `${user.full_name} will receive summary emails after meetings.`
               : `${user.full_name} will no longer receive summary emails.`,
      enabling ? 'Enable' : 'Disable',
      enabling ? 'bg-[#10B981] hover:bg-emerald-600' : 'bg-amber-500 hover:bg-amber-600',
      async () => {
        await supabase.from('profiles').update({ email_enabled: enabling }).eq('id', user.id);
        setConfirm(null);
        setUsers(p => p.map(u => u.id === user.id ? { ...u, email_enabled: enabling } : u));
      });
  }

  function doDelete(user) {
    confirmAction('Delete Member?',
      `Permanently delete ${user.full_name}? All meetings, transcripts, and summaries will be removed. Cannot be undone.`,
      'Delete', 'bg-red-500 hover:bg-red-600',
      async () => {
        await supabase.from('profiles').delete().eq('id', user.id);
        setConfirm(null);
        setUsers(p => p.filter(u => u.id !== user.id));
      });
  }

  if (loading) return <LoadingSpinner size="lg" className="py-16" />;

  return (
    <div className="space-y-6 animate-page-reveal">

      {/* ── Page header ─────────────────────────────────────────── */}
      <div className="flex items-end justify-between animate-fade-in">
        <div>
          <p className="text-[11px] uppercase tracking-[0.34em] text-[#64748B]">Management</p>
          <h2 className="mt-1 text-[28px] font-semibold tracking-tight text-[#020617] leading-tight">Members</h2>
        </div>
        <button
          onClick={() => setShowAddModal(true)}
          className="flex items-center gap-2 px-5 py-2.5 text-[13px] font-semibold text-white rounded-[14px] transition-all duration-150 hover:-translate-y-0.5 active:translate-y-0"
          style={{ background: 'linear-gradient(135deg, #F97316 0%, #DC4F04 100%)', boxShadow: '0 4px 16px rgba(249,115,22,0.40)' }}>
          <UserPlus className="h-4 w-4" />
          Add Member
        </button>
      </div>

      {/* ── Stat chips ──────────────────────────────────────────── */}
      <div className="flex flex-wrap gap-3 animate-slide-up" style={{ animationDelay: '40ms' }}>
        {[
          { icon: Users,        label: 'Total',  value: stats.total,  color: '#F97316', bg: '#FFEDD5' },
          { icon: CheckCircle2, label: 'Active', value: stats.active, color: '#059669', bg: '#D1FAE5' },
          { icon: Activity,     label: 'Online', value: stats.online, color: '#3B82F6', bg: '#DBEAFE' },
        ].map(({ icon: Icon, label, value, color, bg }) => (
          <div key={label} className="flex items-center gap-2 px-4 py-2 rounded-[12px]"
            style={{ background: 'rgba(255,255,255,0.85)', border: '1px solid rgba(226,232,240,0.7)', boxShadow: '0 2px 6px rgba(15,23,42,0.05)' }}>
            <span className="flex h-6 w-6 items-center justify-center rounded-lg" style={{ background: bg }}>
              <Icon className="h-3.5 w-3.5" style={{ color }} />
            </span>
            <span className="text-[13px] font-semibold text-[#020617]">{value}</span>
            <span className="text-[11px] text-[#94A3B8] font-medium">{label}</span>
          </div>
        ))}
      </div>

      {/* ── Search ──────────────────────────────────────────────── */}
      <div className="relative animate-slide-up" style={{ animationDelay: '80ms' }}>
        <Search className="absolute left-4 top-1/2 -translate-y-1/2 h-4 w-4 text-[#CBD5E1] pointer-events-none" />
        <input
          ref={searchRef}
          type="text"
          value={searchInput}
          onChange={e => handleSearch(e.target.value)}
          placeholder="Search by name or email…"
          className="w-full pl-11 pr-10 py-3 rounded-[16px] text-[13px] text-[#020617] placeholder-[#CBD5E1] outline-none transition-all duration-200"
          style={{ background: 'rgba(255,255,255,0.9)', border: '1px solid rgba(226,232,240,0.7)', boxShadow: '0 2px 10px rgba(15,23,42,0.05)' }}
          onFocus={e => e.currentTarget.style.borderColor = 'rgba(249,115,22,0.45)'}
          onBlur={e => e.currentTarget.style.borderColor = 'rgba(226,232,240,0.7)'}
        />
        {searchInput && (
          <button onClick={() => { setSearchInput(''); setSearchTerm(''); searchRef.current?.focus(); }}
            className="absolute right-4 top-1/2 -translate-y-1/2 text-[#CBD5E1] hover:text-[#94A3B8] transition-colors">
            <X className="h-4 w-4" />
          </button>
        )}
      </div>

      {/* ── Member cards ────────────────────────────────────────── */}
      {filteredUsers.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 animate-fade-in">
          <div className="h-16 w-16 rounded-[20px] flex items-center justify-center mb-4"
            style={{ background: '#F4F2EF', border: '1px solid rgba(226,232,240,0.7)' }}>
            <Users className="h-7 w-7 text-[#CBD5E1]" />
          </div>
          <p className="text-[15px] font-semibold text-[#020617] mb-1">
            {searchTerm ? 'No results found' : 'No members yet'}
          </p>
          <p className="text-[13px] text-[#94A3B8]">
            {searchTerm ? `No members match "${searchInput}"` : 'Click "Add Member" to get started'}
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {filteredUsers.map((user, i) => {
            const online = isOnline(user.last_agent_heartbeat);
            return (
              <div
                key={user.id}
                className="group animate-slide-up"
                style={{
                  animationDelay: `${100 + i * 40}ms`,
                  background: 'rgba(255,255,255,0.88)',
                  border: '1px solid rgba(226,232,240,0.65)',
                  borderRadius: '18px',
                  boxShadow: '0 2px 8px rgba(15,23,42,0.04)',
                  transition: 'box-shadow 0.15s ease, border-color 0.15s ease',
                }}
                onMouseEnter={e => { e.currentTarget.style.boxShadow = '0 6px 24px rgba(15,23,42,0.09)'; e.currentTarget.style.borderColor = 'rgba(249,115,22,0.20)'; }}
                onMouseLeave={e => { e.currentTarget.style.boxShadow = '0 2px 8px rgba(15,23,42,0.04)'; e.currentTarget.style.borderColor = 'rgba(226,232,240,0.65)'; }}
              >
                <div className="flex items-center gap-4 px-5 py-4">

                  {/* Avatar */}
                  <Avatar name={user.full_name} size={44} />

                  {/* Name + email */}
                  <div className="min-w-0 flex-1">
                    <button
                      onClick={() => navigate('/users/' + user.id)}
                      className="text-[14px] font-semibold text-[#F97316] hover:text-[#EA580C] transition-colors truncate block text-left"
                    >
                      {user.full_name}
                    </button>
                    <p className="text-[12px] text-[#94A3B8] truncate mt-0.5">{user.microsoft_email || user.email}</p>
                  </div>

                  {/* Role */}
                  <div className="hidden sm:block min-w-[90px]">
                    <span className="text-[12px] text-[#64748B]">
                      {user.job_role === 'Other' ? user.job_role_custom || 'Other' : user.job_role || '—'}
                    </span>
                  </div>

                  {/* Agent status */}
                  <div className="hidden md:flex items-center gap-1.5 min-w-[90px]">
                    {online ? (
                      <>
                        <span className="relative flex h-2 w-2">
                          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-[#10B981] opacity-60" />
                          <span className="relative inline-flex rounded-full h-2 w-2 bg-[#10B981]" />
                        </span>
                        <span className="text-[12px] font-medium text-[#10B981]">Online</span>
                      </>
                    ) : (
                      <>
                        <WifiOff className="h-3.5 w-3.5 text-[#CBD5E1]" />
                        <span className="text-[12px] text-[#CBD5E1]">
                          {user.last_agent_heartbeat ? formatRelative(user.last_agent_heartbeat) : 'Never'}
                        </span>
                      </>
                    )}
                  </div>

                  {/* Toggle pills */}
                  <div className="hidden lg:flex items-center gap-2">
                    <TogglePill
                      on={user.summary_enabled !== false}
                      onColor="#7C3AED" onBg="#EDE9FE"
                      onIcon={FileText} offIcon={FileX}
                      onClick={() => doToggleSummary(user)}
                    />
                    <TogglePill
                      on={user.email_enabled !== false}
                      onColor="#2563EB" onBg="#DBEAFE"
                      onIcon={Mail} offIcon={MailX}
                      onClick={() => doToggleEmail(user)}
                    />
                  </div>

                  {/* Status badge */}
                  <div className="flex flex-col gap-1 items-end min-w-[72px]">
                    <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-[11px] font-semibold"
                      style={user.is_active ? { background: '#D1FAE5', color: '#059669' } : { background: '#F1F5F9', color: '#94A3B8' }}>
                      {user.is_active ? 'Active' : 'Inactive'}
                    </span>
                    {user.is_locked_out && (
                      <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-[11px] font-semibold"
                        style={{ background: '#FEE2E2', color: '#DC2626' }}>
                        Locked
                      </span>
                    )}
                  </div>

                  {/* Divider */}
                  <div className="hidden sm:block h-8 w-px flex-shrink-0" style={{ background: 'rgba(226,232,240,0.6)' }} />

                  {/* Actions */}
                  <div className="flex items-center gap-0.5">
                    <Btn onClick={() => setEditingUser(user)} title="Edit member">
                      <Edit2 className="h-3.5 w-3.5 text-[#64748B]" />
                    </Btn>
                    <Btn onClick={() => doToggleSummary(user)} title={user.summary_enabled !== false ? 'Disable summary' : 'Enable summary'}>
                      {user.summary_enabled !== false
                        ? <FileText className="h-3.5 w-3.5 text-[#8B5CF6]" />
                        : <FileX className="h-3.5 w-3.5 text-[#CBD5E1]" />}
                    </Btn>
                    <Btn onClick={() => doToggleEmail(user)} title={user.email_enabled !== false ? 'Disable email' : 'Enable email'}>
                      {user.email_enabled !== false
                        ? <Mail className="h-3.5 w-3.5 text-[#3B82F6]" />
                        : <MailX className="h-3.5 w-3.5 text-[#CBD5E1]" />}
                    </Btn>
                    <Btn onClick={() => doToggleLock(user)} title={user.is_locked_out ? 'Unlock' : 'Lock out'}>
                      {user.is_locked_out
                        ? <Unlock className="h-3.5 w-3.5 text-[#10B981]" />
                        : <Lock className="h-3.5 w-3.5 text-[#F59E0B]" />}
                    </Btn>
                    <Btn onClick={() => doToggleActive(user)} title={user.is_active ? 'Deactivate' : 'Activate'}>
                      <UserX className={`h-3.5 w-3.5 ${user.is_active ? 'text-[#EF4444]' : 'text-[#10B981]'}`} />
                    </Btn>
                    <Btn onClick={() => doDelete(user)} title="Delete member" danger>
                      <Trash2 className="h-3.5 w-3.5 text-[#EF4444]" />
                    </Btn>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {showAddModal && (
        <AddUserModal onClose={() => setShowAddModal(false)} onAdded={() => { setShowAddModal(false); fetchUsers(); }} />
      )}
      {editingUser && (
        <EditUserModal user={editingUser} onClose={() => setEditingUser(null)} onUpdated={() => { setEditingUser(null); fetchUsers(); }} />
      )}
      {confirm && (
        <ConfirmDialog
          title={confirm.title}
          message={confirm.message}
          confirmLabel={confirm.confirmLabel}
          confirmColor={confirm.confirmColor}
          onConfirm={confirm.onConfirm}
          onCancel={() => setConfirm(null)}
        />
      )}
    </div>
  );
}

export default UsersList;
