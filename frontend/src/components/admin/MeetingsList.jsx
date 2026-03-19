// file: frontend/src/components/admin/MeetingsList.jsx
import React, { useState, useRef, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMeetings } from '../../hooks/useMeetings';
import { useRealtime } from '../../hooks/useRealtime';
import { supabase } from '../../lib/supabase';
import { formatDateShort } from '../../utils/formatDate';
import { formatDuration } from '../../utils/formatDuration';
import { Presentation, SlidersHorizontal, Mail, MailX, Search, X, Send, AlertCircle, Download } from 'lucide-react';
import LoadingSpinner from '../shared/LoadingSpinner';
import EmptyState from '../shared/EmptyState';
import Pagination from '../shared/Pagination';

const CATEGORIES = [
  { value: '', label: 'All Categories' },
  { value: 'client_conversation', label: 'Client Conversation' },
  { value: 'consultant_meeting', label: 'Consultant Meeting' },
  { value: 'internal_meeting', label: 'Internal Meeting' },
  { value: 'interview', label: 'Interview' },
  { value: 'target_company', label: 'Target Company' },
  { value: 'sales_service', label: 'Sales/Service' },
  { value: 'general', label: 'General' },
];

const STATUSES = [
  { value: '', label: 'All Statuses' },
  { value: 'uploaded', label: 'Uploaded' },
  { value: 'processing', label: 'Processing' },
  { value: 'processed', label: 'Processed' },
  { value: 'failed', label: 'Failed' },
];

const TEAMS_ATTEMPT_LABELS = {
  0: 'Awaiting Teams Transcript',
  1: 'Fetching Teams (5 min)',
  2: 'Fetching Teams (10 min)',
  3: 'Fetching Teams (15 min)',
  4: 'Fetching Teams (20 min)',
  5: 'Processing Local',
};

function getStatusLabel(meeting) {
  if (meeting.status === 'awaiting_teams_transcript') {
    return TEAMS_ATTEMPT_LABELS[meeting.teams_transcript_attempt || 0] || TEAMS_ATTEMPT_LABELS[0];
  }
  return { uploaded: 'Uploaded', processing: 'Processing', processed: 'Processed', failed: 'Failed' }[meeting.status] || meeting.status;
}

const categoryPills = {
  client_conversation: { color: '#2563EB', bg: '#DBEAFE' },
  consultant_meeting:  { color: '#7C3AED', bg: '#EDE9FE' },
  internal_meeting:    { color: '#4F46E5', bg: '#EEF2FF' },
  interview:           { color: '#0D9488', bg: '#CCFBF1' },
  target_company:      { color: '#059669', bg: '#D1FAE5' },
  sales_service:       { color: '#EA580C', bg: '#FFEDD5' },
  general:             { color: '#64748B', bg: '#F1F5F9' },
};

const statusPills = {
  uploaded:                  { color: '#2563EB', bg: '#DBEAFE' },
  processing:                { color: '#D97706', bg: '#FEF3C7' },
  processed:                 { color: '#059669', bg: '#D1FAE5' },
  failed:                    { color: '#DC2626', bg: '#FEE2E2' },
  awaiting_teams_transcript: { color: '#4F46E5', bg: '#EEF2FF' },
};

function Pill({ color, bg, children }) {
  return (
    <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-[11px] font-semibold whitespace-nowrap"
      style={{ color, background: bg }}>
      {children}
    </span>
  );
}

function MeetingsList() {
  const navigate = useNavigate();
  const [filters, setFilters] = useState({ page: 0, pageSize: 20 });
  const [searchInput, setSearchInput] = useState('');
  const [emailConfirm, setEmailConfirm] = useState(null);
  const [sending, setSending] = useState(false);
  const [emailError, setEmailError] = useState('');
  const [exporting, setExporting] = useState(false);
  const searchRef = useRef(null);
  const debounceRef = useRef(null);
  const realtimeDebounceRef = useRef(null);
  const { meetings, loading, error, totalCount, refetch } = useMeetings(filters);

  const debouncedRefetch = useCallback(() => {
    if (realtimeDebounceRef.current) clearTimeout(realtimeDebounceRef.current);
    realtimeDebounceRef.current = setTimeout(() => refetch(), 800);
  }, [refetch]);

  useEffect(() => () => { if (realtimeDebounceRef.current) clearTimeout(realtimeDebounceRef.current); }, []);
  useRealtime('meetings', debouncedRefetch);

  const handleManualEmail = async () => {
    if (!emailConfirm) return;
    setSending(true); setEmailError('');
    try {
      const { data, error } = await supabase.rpc('send_manual_email', { p_meeting_id: emailConfirm.id });
      if (error) throw error;
      if (data === false) setEmailError('Email could not be sent. Check that the user has an email address and a summary exists.');
      else { setEmailConfirm(null); refetch(); }
    } catch (err) {
      setEmailError('Failed to send email: ' + err.message);
    } finally { setSending(false); }
  };

  const handleSearchChange = useCallback((value) => {
    setSearchInput(value);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      setFilters(prev => ({ ...prev, search: value.trim() || undefined, page: 0 }));
    }, 300);
  }, []);

  useEffect(() => () => { if (debounceRef.current) clearTimeout(debounceRef.current); }, []);

  const handleExportCSV = async () => {
    setExporting(true);
    try {
      let query = supabase
        .from('meetings')
        .select('start_time, duration_seconds, detected_app, detected_category, status, email_sent_at, profiles(full_name, microsoft_email, email)')
        .order('created_at', { ascending: false })
        .limit(5000);
      if (filters.category) query = query.eq('detected_category', filters.category);
      if (filters.status)   query = query.eq('status', filters.status);
      if (filters.dateFrom) query = query.gte('created_at', filters.dateFrom);
      if (filters.dateTo)   query = query.lte('created_at', filters.dateTo + 'T23:59:59');
      if (filters.search)   query = query.or(`profiles.full_name.ilike.%${filters.search}%,profiles.microsoft_email.ilike.%${filters.search}%`);
      const { data } = await query;
      if (!data?.length) return;
      const headers = ['User', 'Email', 'Date', 'Duration (min)', 'App', 'Category', 'Status', 'Email Sent'];
      const rows = data.map(m => [
        m.profiles?.full_name || '',
        m.profiles?.microsoft_email || m.profiles?.email || '',
        m.start_time ? new Date(m.start_time).toLocaleString() : '',
        m.duration_seconds ? Math.round(m.duration_seconds / 60) : '',
        m.detected_app || '',
        m.detected_category?.replace(/_/g, ' ') || '',
        m.status || '',
        m.email_sent_at ? new Date(m.email_sent_at).toLocaleString() : 'No',
      ]);
      const csv = [headers, ...rows].map(row => row.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n');
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = `sessions-${new Date().toISOString().split('T')[0]}.csv`;
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err) { console.error('Export failed:', err); }
    finally { setExporting(false); }
  };

  const selectClass = "px-3 py-2 rounded-[12px] text-[12px] text-[#475569] outline-none transition-all duration-150 cursor-pointer";
  const selectStyle = {
    background: 'rgba(255,255,255,0.85)',
    border: '1px solid rgba(226,232,240,0.8)',
    boxShadow: '0 1px 4px rgba(15,23,42,0.04)',
  };

  return (
    <div className="space-y-6 animate-page-reveal">

      {/* ── Page header ─────────────────────────────────────────── */}
      <div className="flex items-end justify-between animate-fade-in">
        <div>
          <p className="text-[11px] uppercase tracking-[0.34em] text-[#64748B]">Management</p>
          <h2 className="mt-1 text-[28px] font-semibold tracking-tight text-[#020617] leading-tight">
            Sessions
          </h2>
        </div>
        <button
          onClick={handleExportCSV}
          disabled={exporting || loading}
          className="flex items-center gap-2 px-4 py-2.5 text-[13px] font-semibold rounded-[12px] transition-all duration-150 hover:-translate-y-0.5 disabled:opacity-50 disabled:cursor-not-allowed"
          style={{ background: 'rgba(255,255,255,0.9)', border: '1px solid rgba(226,232,240,0.9)', boxShadow: '0 2px 8px rgba(15,23,42,0.06)' }}
        >
          <Download className={`h-4 w-4 text-[#F97316] ${exporting ? 'animate-bounce' : ''}`} />
          <span className="text-[#475569]">{exporting ? 'Exporting…' : 'Export CSV'}</span>
        </button>
      </div>

      {/* ── Search ──────────────────────────────────────────────── */}
      <div className="relative animate-slide-up" style={{ animationDelay: '60ms' }}>
        <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 h-4 w-4 text-[#94A3B8] pointer-events-none" />
        <input
          ref={searchRef}
          type="text"
          value={searchInput}
          onChange={(e) => handleSearchChange(e.target.value)}
          placeholder="Search sessions by name or email…"
          className="w-full pl-10 pr-10 py-2.5 rounded-[14px] text-[13px] text-[#020617] placeholder-[#94A3B8] outline-none transition-all duration-200"
          style={{ background: 'rgba(255,255,255,0.85)', border: '1px solid rgba(226,232,240,0.8)', boxShadow: '0 2px 8px rgba(15,23,42,0.05)' }}
          onFocus={e => e.currentTarget.style.borderColor = 'rgba(249,115,22,0.5)'}
          onBlur={e => e.currentTarget.style.borderColor = 'rgba(226,232,240,0.8)'}
        />
        {searchInput && (
          <button onClick={() => { setSearchInput(''); setFilters(prev => ({ ...prev, search: undefined, page: 0 })); searchRef.current?.focus(); }}
            className="absolute right-3.5 top-1/2 -translate-y-1/2 text-[#94A3B8] hover:text-[#475569]">
            <X className="h-4 w-4" />
          </button>
        )}
      </div>

      {/* ── Filters ─────────────────────────────────────────────── */}
      <div className="flex flex-wrap gap-2 items-center animate-slide-up" style={{ animationDelay: '100ms' }}>
        <div className="flex items-center gap-1.5 mr-1">
          <SlidersHorizontal className="h-3.5 w-3.5 text-[#94A3B8]" />
          <span className="text-[11px] uppercase tracking-[0.18em] text-[#94A3B8] font-semibold">Filter</span>
        </div>
        <select className={selectClass} style={selectStyle}
          value={filters.category || ''}
          onChange={(e) => setFilters({ ...filters, category: e.target.value || undefined, page: 0 })}>
          {CATEGORIES.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
        </select>
        <select className={selectClass} style={selectStyle}
          value={filters.status || ''}
          onChange={(e) => setFilters({ ...filters, status: e.target.value || undefined, page: 0 })}>
          {STATUSES.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
        </select>
        <input type="date" className={selectClass} style={selectStyle}
          value={filters.dateFrom || ''}
          onChange={(e) => setFilters({ ...filters, dateFrom: e.target.value || undefined, page: 0 })} />
        <input type="date" className={selectClass} style={selectStyle}
          value={filters.dateTo || ''}
          onChange={(e) => setFilters({ ...filters, dateTo: e.target.value || undefined, page: 0 })} />
      </div>

      {loading && meetings.length === 0 && <LoadingSpinner size="sm" className="py-2" />}

      {/* ── Table ───────────────────────────────────────────────── */}
      {!loading && error && meetings.length === 0 ? (
        <EmptyState icon={AlertCircle} title="Failed to load sessions" description={error} />
      ) : !loading && meetings.length === 0 ? (
        <EmptyState
          icon={filters.search ? Search : Presentation}
          title={filters.search ? 'No results found' : 'No sessions yet'}
          description={filters.search ? `No sessions match "${filters.search}"` : 'Sessions appear here once agents start recording'}
        />
      ) : meetings.length > 0 ? (
        <div className="glass-panel overflow-hidden animate-slide-up" style={{ animationDelay: '140ms' }}>
          <div className="overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead>
                <tr style={{ background: '#F4F2EF', borderBottom: '1px solid rgba(226,232,240,0.6)' }}>
                  {['Member', 'Date', 'Duration', 'App', 'Category', 'Status', 'Mail'].map(h => (
                    <th key={h} className="px-4 py-3 text-left text-[11px] uppercase tracking-[0.18em] font-semibold text-[#94A3B8]">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {meetings.map((meeting, idx) => {
                  const catPill = categoryPills[meeting.detected_category] || categoryPills.general;
                  const stPill  = statusPills[meeting.status] || statusPills.uploaded;
                  return (
                    <tr
                      key={meeting.id}
                      onClick={() => navigate(`/meetings/${meeting.id}`)}
                      className="cursor-pointer transition-colors hover:bg-[#FFF8F4]"
                      style={{ borderBottom: idx < meetings.length - 1 ? '1px solid rgba(241,245,249,0.8)' : 'none' }}
                    >
                      <td className="px-4 py-3 font-semibold text-[#020617]">{meeting.profiles?.full_name}</td>
                      <td className="px-4 py-3 text-[#475569]">{formatDateShort(meeting.start_time)}</td>
                      <td className="px-4 py-3 text-[#475569]">{formatDuration(meeting.duration_seconds)}</td>
                      <td className="px-4 py-3 text-[#475569]">{meeting.detected_app}</td>
                      <td className="px-4 py-3">
                        {meeting.detected_category && (
                          <Pill color={catPill.color} bg={catPill.bg}>
                            {meeting.detected_category.replace(/_/g, ' ')}
                          </Pill>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <Pill color={stPill.color} bg={stPill.bg}>{getStatusLabel(meeting)}</Pill>
                      </td>
                      <td className="px-4 py-3">
                        {meeting.email_sent_at ? (
                          <span className="flex items-center gap-1 text-[12px] font-medium" style={{ color: '#059669' }}
                            title={`Sent ${new Date(meeting.email_sent_at).toLocaleString()}`}>
                            <Mail className="h-3.5 w-3.5" />Sent
                          </span>
                        ) : meeting.status === 'processed' ? (
                          <button
                            onClick={(e) => { e.stopPropagation(); setEmailConfirm({ id: meeting.id, userName: meeting.profiles?.full_name || 'Unknown', email: meeting.profiles?.microsoft_email || meeting.profiles?.email || 'N/A' }); }}
                            className="flex items-center gap-1 text-[12px] font-medium text-[#F97316] hover:text-[#EA580C] transition-colors"
                          >
                            <Mail className="h-3.5 w-3.5" />Send
                          </button>
                        ) : (
                          <span className="flex items-center gap-1 text-[12px] text-[#CBD5E1]">
                            <MailX className="h-3.5 w-3.5" />—
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <Pagination
            page={filters.page}
            pageSize={filters.pageSize}
            totalCount={totalCount}
            onPageChange={(p) => setFilters({ ...filters, page: p })}
          />
        </div>
      ) : null}

      {/* ── Manual email dialog ──────────────────────────────────── */}
      {emailConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="bg-white rounded-[20px] shadow-2xl p-6 max-w-md w-full mx-4" style={{ boxShadow: '0 8px 40px rgba(15,23,42,0.18)' }}>
            <div className="flex items-center gap-3 mb-4">
              <div className="p-2 rounded-full" style={{ background: '#FFEDD5' }}>
                <Send className="h-5 w-5 text-[#F97316]" />
              </div>
              <h3 className="text-[16px] font-semibold text-[#020617]">Send Email Manually</h3>
            </div>
            <p className="text-[13px] text-[#475569] mb-4">This will send the meeting summary email to:</p>
            <div className="rounded-[14px] p-3 mb-4 text-[13px]" style={{ background: '#F4F2EF' }}>
              <p className="font-semibold text-[#020617]">{emailConfirm.userName}</p>
              <p className="text-[#64748B]">{emailConfirm.email}</p>
            </div>
            <p className="text-[12px] text-[#F97316] mb-5">
              This bypasses the org email toggle and sends regardless of settings.
            </p>
            {emailError && <p className="text-[12px] text-red-600 mb-4">{emailError}</p>}
            <div className="flex justify-end gap-3">
              <button
                onClick={() => { setEmailConfirm(null); setEmailError(''); }}
                disabled={sending}
                className="px-4 py-2 text-[13px] text-[#475569] hover:bg-[#F4F2EF] rounded-xl transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleManualEmail}
                disabled={sending}
                className="px-4 py-2 text-[13px] font-semibold text-white rounded-xl transition-colors disabled:opacity-50"
                style={{ background: 'linear-gradient(135deg, #F97316 0%, #DC4F04 100%)' }}
              >
                {sending ? 'Sending…' : 'Send Email'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default MeetingsList;
