// file: frontend/src/components/admin/MeetingsList.jsx
import React, { useState, useRef, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMeetings } from '../../hooks/useMeetings';
import { useRealtime } from '../../hooks/useRealtime';
import { supabase } from '../../lib/supabase';
import { formatDateShort } from '../../utils/formatDate';
import { formatDuration } from '../../utils/formatDuration';
import { Video, Filter, Mail, MailX, Search, X, Send, AlertCircle, Download } from 'lucide-react';
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
  1: 'Fetching Teams Transcript (5 min)',
  2: 'Fetching Teams Transcript (10 min)',
  3: 'Fetching Teams Transcript (15 min)',
  4: 'Fetching Teams Transcript (20 min)',
  5: 'Teams Transcript Unavailable — Processing Local',
};

function getStatusLabel(meeting) {
  if (meeting.status === 'awaiting_teams_transcript') {
    const attempt = meeting.teams_transcript_attempt || 0;
    return TEAMS_ATTEMPT_LABELS[attempt] || TEAMS_ATTEMPT_LABELS[0];
  }
  const labels = {
    uploaded: 'Uploaded',
    processing: 'Processing',
    processed: 'Processed',
    failed: 'Failed',
  };
  return labels[meeting.status] || meeting.status;
}

const categoryColors = {
  client_conversation: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400',
  consultant_meeting: 'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400',
  target_company: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400',
  sales_service: 'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400',
  general: 'bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300',
};

const statusColors = {
  uploaded: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400',
  processing: 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400',
  processed: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400',
  failed: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400',
  awaiting_teams_transcript: 'bg-indigo-100 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-400',
};

function MeetingsList() {
  const navigate = useNavigate();
  const [filters, setFilters] = useState({ page: 0, pageSize: 20 });
  const [searchInput, setSearchInput] = useState('');
  const [emailConfirm, setEmailConfirm] = useState(null); // { id, userName, email }
  const [sending, setSending] = useState(false);
  const [emailError, setEmailError] = useState('');
  const [exporting, setExporting] = useState(false);
  const searchRef = useRef(null);
  const debounceRef = useRef(null);
  const { meetings, loading, error, totalCount, refetch } = useMeetings(filters);

  const debouncedRefetch = useCallback(() => {
    const t = setTimeout(() => refetch(), 800);
    return () => clearTimeout(t);
  }, [refetch]);

  useRealtime('meetings', debouncedRefetch);

  const handleManualEmail = async () => {
    if (!emailConfirm) return;
    setSending(true);
    setEmailError('');
    try {
      const { data, error } = await supabase.rpc('send_manual_email', {
        p_meeting_id: emailConfirm.id,
      });
      if (error) throw error;
      if (data === false) {
        setEmailError('Email could not be sent. Check that the user has an email address and a summary exists.');
      } else {
        setEmailConfirm(null);
        refetch();
      }
    } catch (err) {
      setEmailError('Failed to send email: ' + err.message);
    } finally {
      setSending(false);
    }
  };

  const handleSearchChange = useCallback((value) => {
    setSearchInput(value);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      setFilters(prev => ({ ...prev, search: value.trim() || undefined, page: 0 }));
    }, 300);
  }, []);

  useEffect(() => {
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, []);

  const clearSearch = () => {
    setSearchInput('');
    setFilters(prev => ({ ...prev, search: undefined, page: 0 }));
    searchRef.current?.focus();
  };

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
      if (filters.search) {
        query = query.or(
          `profiles.full_name.ilike.%${filters.search}%,profiles.microsoft_email.ilike.%${filters.search}%`
        );
      }

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

      const csv = [headers, ...rows]
        .map(row => row.map(v => `"${String(v).replace(/"/g, '""')}"`).join(','))
        .join('\n');

      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `meetings-${new Date().toISOString().split('T')[0]}.csv`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error('Export failed:', err);
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-bold text-gray-900 dark:text-white">Meetings</h2>
        <button
          onClick={handleExportCSV}
          disabled={exporting || loading}
          className="flex items-center gap-1.5 px-3 py-1.5 text-sm border border-gray-200 rounded-lg text-gray-600 hover:border-orange-400 hover:text-orange-600 hover:bg-orange-50 transition-all duration-150 disabled:opacity-50"
          title="Export current view as CSV"
        >
          <Download className={`h-4 w-4 ${exporting ? 'animate-bounce' : ''}`} />
          <span>{exporting ? 'Exporting...' : 'Export CSV'}</span>
        </button>
      </div>

      {/* Search bar */}
      <div className="relative">
        <div className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none">
          <Search className="h-4.5 w-4.5 text-gray-400" />
        </div>
        <input
          ref={searchRef}
          type="text"
          value={searchInput}
          onChange={(e) => handleSearchChange(e.target.value)}
          placeholder="Search by name or email..."
          className="w-full pl-10 pr-10 py-2.5 border border-gray-200 rounded-xl text-sm bg-white shadow-sm transition-all duration-200 focus:outline-none focus:ring-2 focus:ring-brand-500/40 focus:border-brand-500 dark:bg-gray-800 dark:border-gray-700 dark:text-white dark:placeholder-gray-500 dark:focus:ring-brand-400/40 dark:focus:border-brand-400"
        />
        {searchInput && (
          <button
            onClick={clearSearch}
            className="absolute inset-y-0 right-0 pr-3.5 flex items-center text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 transition-colors"
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-3 items-center">
        <Filter className="h-4 w-4 text-gray-400" />
        <select
          value={filters.category || ''}
          onChange={(e) => setFilters({ ...filters, category: e.target.value || undefined, page: 0 })}
          className="px-3 py-1.5 border rounded-lg text-sm dark:bg-gray-700 dark:border-gray-600 dark:text-white"
        >
          {CATEGORIES.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
        </select>
        <select
          value={filters.status || ''}
          onChange={(e) => setFilters({ ...filters, status: e.target.value || undefined, page: 0 })}
          className="px-3 py-1.5 border rounded-lg text-sm dark:bg-gray-700 dark:border-gray-600 dark:text-white"
        >
          {STATUSES.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
        </select>
        <input
          type="date"
          value={filters.dateFrom || ''}
          onChange={(e) => setFilters({ ...filters, dateFrom: e.target.value || undefined, page: 0 })}
          className="px-3 py-1.5 border rounded-lg text-sm dark:bg-gray-700 dark:border-gray-600 dark:text-white"
          placeholder="From"
        />
        <input
          type="date"
          value={filters.dateTo || ''}
          onChange={(e) => setFilters({ ...filters, dateTo: e.target.value || undefined, page: 0 })}
          className="px-3 py-1.5 border rounded-lg text-sm dark:bg-gray-700 dark:border-gray-600 dark:text-white"
          placeholder="To"
        />
      </div>

      {loading && <LoadingSpinner size="sm" className="py-2" />}

      {!loading && error ? (
        <EmptyState
          icon={AlertCircle}
          title="Failed to load meetings"
          description={error.message || 'An unexpected error occurred. Please refresh the page.'}
        />
      ) : !loading && meetings.length === 0 ? (
        <EmptyState
          icon={filters.search ? Search : Video}
          title={filters.search ? 'No results found' : 'No meetings found'}
          description={filters.search ? `No meetings match "${filters.search}"` : 'Meetings will appear here once agents start recording'}
        />
      ) : meetings.length > 0 ? (
        <div className="bg-white dark:bg-gray-800 rounded-xl border dark:border-gray-700 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50">
                  <th className="text-left px-4 py-3 font-medium text-gray-500 dark:text-gray-400">User</th>
                  <th className="text-left px-4 py-3 font-medium text-gray-500 dark:text-gray-400">Date</th>
                  <th className="text-left px-4 py-3 font-medium text-gray-500 dark:text-gray-400">Duration</th>
                  <th className="text-left px-4 py-3 font-medium text-gray-500 dark:text-gray-400">App</th>
                  <th className="text-left px-4 py-3 font-medium text-gray-500 dark:text-gray-400">Category</th>
                  <th className="text-left px-4 py-3 font-medium text-gray-500 dark:text-gray-400">Status</th>
                  <th className="text-left px-4 py-3 font-medium text-gray-500 dark:text-gray-400">Mail</th>
                </tr>
              </thead>
              <tbody className="divide-y dark:divide-gray-700">
                {meetings.map(meeting => (
                  <tr
                    key={meeting.id}
                    onClick={() => navigate(`/meetings/${meeting.id}`)}
                    className="hover:bg-gray-50 dark:hover:bg-gray-700/30 cursor-pointer"
                  >
                    <td className="px-4 py-3 font-medium text-gray-900 dark:text-white">
                      {meeting.profiles?.full_name}
                    </td>
                    <td className="px-4 py-3 text-gray-600 dark:text-gray-300">
                      {formatDateShort(meeting.start_time)}
                    </td>
                    <td className="px-4 py-3 text-gray-600 dark:text-gray-300">
                      {formatDuration(meeting.duration_seconds)}
                    </td>
                    <td className="px-4 py-3 text-gray-600 dark:text-gray-300">
                      {meeting.detected_app}
                    </td>
                    <td className="px-4 py-3">
                      {meeting.detected_category && (
                        <span className={`inline-flex px-2 py-0.5 rounded-full text-xs font-medium ${categoryColors[meeting.detected_category] || categoryColors.general}`}>
                          {meeting.detected_category.replace(/_/g, ' ')}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex px-2 py-0.5 rounded-full text-xs font-medium ${statusColors[meeting.status] || ''}`}>
                        {getStatusLabel(meeting)}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      {meeting.email_sent_at ? (
                        <span className="inline-flex items-center gap-1 text-green-600 dark:text-green-400" title={`Sent ${new Date(meeting.email_sent_at).toLocaleString()}`}>
                          <Mail className="h-4 w-4" />
                          <span className="text-xs">Sent</span>
                        </span>
                      ) : meeting.status === 'processed' ? (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            setEmailConfirm({
                              id: meeting.id,
                              userName: meeting.profiles?.full_name || 'Unknown',
                              email: meeting.profiles?.microsoft_email || meeting.profiles?.email || 'N/A',
                            });
                          }}
                          className="inline-flex items-center gap-1 text-orange-500 hover:text-orange-600 dark:text-orange-400 dark:hover:text-orange-300 transition-colors"
                          title="Click to send email manually"
                        >
                          <Mail className="h-4 w-4" />
                          <span className="text-xs">Send</span>
                        </button>
                      ) : (
                        <span className="inline-flex items-center gap-1 text-gray-400 dark:text-gray-500" title="Email not sent">
                          <MailX className="h-4 w-4" />
                          <span className="text-xs">—</span>
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
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

      {/* Manual email confirmation dialog */}
      {emailConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="bg-white dark:bg-gray-800 rounded-xl shadow-xl border dark:border-gray-700 p-6 max-w-md w-full mx-4">
            <div className="flex items-center gap-3 mb-4">
              <div className="p-2 rounded-full bg-orange-100 dark:bg-orange-900/30">
                <Send className="h-5 w-5 text-orange-500" />
              </div>
              <h3 className="text-lg font-semibold text-gray-900 dark:text-white">Send Email Manually</h3>
            </div>
            <p className="text-sm text-gray-600 dark:text-gray-300 mb-4">
              This will send the meeting summary email to:
            </p>
            <div className="bg-gray-50 dark:bg-gray-700/50 rounded-lg p-3 mb-5 text-sm">
              <p className="font-medium text-gray-900 dark:text-white">{emailConfirm.userName}</p>
              <p className="text-gray-500 dark:text-gray-400">{emailConfirm.email}</p>
            </div>
            <p className="text-xs text-orange-600 dark:text-orange-400 mb-5">
              This action bypasses the organization email toggle and will send the email regardless of settings.
            </p>
            {emailError && (
              <p className="text-xs text-red-600 dark:text-red-400 mb-4">{emailError}</p>
            )}
            <div className="flex justify-end gap-3">
              <button
                onClick={() => { setEmailConfirm(null); setEmailError(''); }}
                disabled={sending}
                className="px-4 py-2 text-sm rounded-lg border border-gray-200 dark:border-gray-600 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleManualEmail}
                disabled={sending}
                className="px-4 py-2 text-sm rounded-lg bg-orange-500 hover:bg-orange-600 text-white font-medium transition-colors disabled:opacity-50"
              >
                {sending ? 'Sending...' : 'Send Email'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default MeetingsList;
