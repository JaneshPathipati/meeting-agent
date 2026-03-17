// file: frontend/src/components/admin/LogsList.jsx
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { ScrollText, Search, X, RefreshCw, ChevronDown, ChevronRight, Filter } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { useLogs } from '../../hooks/useLogs';
import LoadingSpinner from '../shared/LoadingSpinner';
import EmptyState from '../shared/EmptyState';
import Pagination from '../shared/Pagination';
import { formatDateTime } from '../../utils/formatDate';

const LEVELS = [
  { value: '', label: 'All levels' },
  { value: 'error', label: 'Error' },
  { value: 'warn', label: 'Warn' },
  { value: 'info', label: 'Info' },
];

const LEVEL_BADGE = {
  error: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400',
  warn:  'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400',
  info:  'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300',
};

export default function LogsList() {
  const [filters, setFilters] = useState({ page: 0, pageSize: 50 });
  const [searchInput, setSearchInput] = useState('');
  const [expandedRows, setExpandedRows] = useState(new Set());
  const [profiles, setProfiles] = useState([]);
  const [autoRefresh, setAutoRefresh] = useState(false);
  const debounceRef = useRef(null);
  const autoRefreshRef = useRef(null);

  const { logs, loading, error, totalCount, refetch } = useLogs(filters);

  // Load profiles for the user dropdown filter
  useEffect(() => {
    async function loadProfiles() {
      const { data } = await supabase
        .from('profiles')
        .select('id, full_name')
        .eq('is_admin', false)
        .order('full_name');
      setProfiles(data || []);
    }
    loadProfiles();
  }, []);

  // Auto-refresh every 30s
  useEffect(() => {
    if (autoRefresh) {
      autoRefreshRef.current = setInterval(refetch, 30 * 1000);
    } else {
      clearInterval(autoRefreshRef.current);
    }
    return () => clearInterval(autoRefreshRef.current);
  }, [autoRefresh, refetch]);

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
  };

  const toggleRow = (id) => {
    setExpandedRows(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold text-gray-900 dark:text-white">Device Logs</h2>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">
            Live agent logs from employee devices · auto-deleted after 2 days
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setAutoRefresh(v => !v)}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium border transition-colors ${
              autoRefresh
                ? 'bg-brand-50 border-brand-200 text-brand-700 dark:bg-brand-900/30 dark:border-brand-700 dark:text-brand-400'
                : 'border-gray-200 text-gray-600 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-400 dark:hover:bg-gray-700/50'
            }`}
          >
            <RefreshCw className={`h-3.5 w-3.5 ${autoRefresh ? 'animate-spin' : ''}`} />
            {autoRefresh ? 'Auto-refresh on' : 'Auto-refresh'}
          </button>
          <button
            onClick={refetch}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium border border-gray-200 text-gray-600 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-400 dark:hover:bg-gray-700/50 transition-colors"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            Refresh
          </button>
        </div>
      </div>

      {/* Search bar */}
      <div className="relative">
        <Search className="h-4 w-4 absolute left-3.5 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none" />
        <input
          type="text"
          value={searchInput}
          onChange={(e) => handleSearchChange(e.target.value)}
          placeholder="Search log messages..."
          className="w-full pl-10 pr-10 py-2.5 border border-gray-200 dark:border-gray-700 rounded-xl text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-brand-500"
        />
        {searchInput && (
          <button
            onClick={clearSearch}
            className="absolute right-3.5 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200"
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3">
        <Filter className="h-4 w-4 text-gray-400 flex-shrink-0" />

        {/* User filter */}
        <select
          value={filters.profileId || ''}
          onChange={(e) => setFilters(prev => ({ ...prev, profileId: e.target.value || undefined, page: 0 }))}
          className="px-3 py-1.5 border border-gray-200 dark:border-gray-700 rounded-lg text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-brand-500"
        >
          <option value="">All users</option>
          {profiles.map(p => (
            <option key={p.id} value={p.id}>{p.full_name}</option>
          ))}
        </select>

        {/* Level filter */}
        <select
          value={filters.level || ''}
          onChange={(e) => setFilters(prev => ({ ...prev, level: e.target.value || undefined, page: 0 }))}
          className="px-3 py-1.5 border border-gray-200 dark:border-gray-700 rounded-lg text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-brand-500"
        >
          {LEVELS.map(l => (
            <option key={l.value} value={l.value}>{l.label}</option>
          ))}
        </select>

        {/* Date from */}
        <input
          type="date"
          value={filters.dateFrom || ''}
          onChange={(e) => setFilters(prev => ({ ...prev, dateFrom: e.target.value || undefined, page: 0 }))}
          className="px-3 py-1.5 border border-gray-200 dark:border-gray-700 rounded-lg text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-brand-500"
        />
        <span className="text-gray-400 text-sm">to</span>
        <input
          type="date"
          value={filters.dateTo || ''}
          onChange={(e) => setFilters(prev => ({ ...prev, dateTo: e.target.value || undefined, page: 0 }))}
          className="px-3 py-1.5 border border-gray-200 dark:border-gray-700 rounded-lg text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-brand-500"
        />

        {/* Clear filters */}
        {(filters.profileId || filters.level || filters.dateFrom || filters.dateTo || filters.search) && (
          <button
            onClick={() => {
              setFilters({ page: 0, pageSize: 50 });
              setSearchInput('');
            }}
            className="text-xs text-brand-600 dark:text-brand-400 hover:underline"
          >
            Clear all
          </button>
        )}
      </div>

      {/* Loading */}
      {loading && <LoadingSpinner size="sm" className="py-2" />}

      {/* Error */}
      {error && (
        <div className="text-sm text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/20 px-4 py-3 rounded-lg">
          {error}
        </div>
      )}

      {/* Empty state */}
      {!loading && !error && logs.length === 0 && (
        <EmptyState
          icon={ScrollText}
          title="No logs found"
          description={
            filters.search || filters.profileId || filters.level
              ? 'No logs match the current filters.'
              : 'Logs will appear here once agents are running and connected. Requires a new agent build.'
          }
        />
      )}

      {/* Table */}
      {!loading && logs.length > 0 && (
        <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50">
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider w-6"></th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider whitespace-nowrap">Time (device)</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider">User</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider">Module</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider">Level</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider">Message</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
                {logs.map(log => {
                  const hasMeta = log.meta && Object.keys(log.meta).length > 0;
                  const isExpanded = expandedRows.has(log.id);
                  return (
                    <React.Fragment key={log.id}>
                      <tr
                        onClick={() => hasMeta && toggleRow(log.id)}
                        className={`${hasMeta ? 'cursor-pointer' : ''} hover:bg-gray-50 dark:hover:bg-gray-700/30 transition-colors ${
                          log.level === 'error' ? 'bg-red-50/30 dark:bg-red-900/10' :
                          log.level === 'warn'  ? 'bg-amber-50/30 dark:bg-amber-900/10' : ''
                        }`}
                      >
                        {/* Expand icon */}
                        <td className="pl-4 pr-2 py-2.5 text-gray-400">
                          {hasMeta ? (
                            isExpanded
                              ? <ChevronDown className="h-3.5 w-3.5" />
                              : <ChevronRight className="h-3.5 w-3.5" />
                          ) : null}
                        </td>
                        {/* Time */}
                        <td className="px-4 py-2.5 text-gray-500 dark:text-gray-400 whitespace-nowrap font-mono text-xs">
                          {formatDateTime(log.logged_at)}
                        </td>
                        {/* User */}
                        <td className="px-4 py-2.5 text-gray-900 dark:text-white whitespace-nowrap">
                          {log.profiles?.full_name || '—'}
                        </td>
                        {/* Module */}
                        <td className="px-4 py-2.5">
                          {log.module ? (
                            <span className="font-mono text-xs text-gray-500 dark:text-gray-400 bg-gray-100 dark:bg-gray-700/50 px-1.5 py-0.5 rounded">
                              {log.module}
                            </span>
                          ) : (
                            <span className="text-gray-400">—</span>
                          )}
                        </td>
                        {/* Level badge */}
                        <td className="px-4 py-2.5">
                          <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${LEVEL_BADGE[log.level] || LEVEL_BADGE.info}`}>
                            {log.level}
                          </span>
                        </td>
                        {/* Message */}
                        <td className="px-4 py-2.5 text-gray-700 dark:text-gray-300 max-w-lg">
                          <span className="font-mono text-xs break-words">{log.message}</span>
                        </td>
                      </tr>
                      {/* Expanded meta row */}
                      {isExpanded && hasMeta && (
                        <tr className="bg-gray-50 dark:bg-gray-900/50">
                          <td colSpan={6} className="px-8 py-3">
                            <pre className="text-xs text-gray-600 dark:text-gray-300 font-mono whitespace-pre-wrap break-words overflow-auto max-h-48 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded p-3">
                              {JSON.stringify(log.meta, null, 2)}
                            </pre>
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
          <Pagination
            page={filters.page}
            pageSize={filters.pageSize}
            totalCount={totalCount}
            onPageChange={(p) => setFilters(prev => ({ ...prev, page: p }))}
          />
        </div>
      )}
    </div>
  );
}
