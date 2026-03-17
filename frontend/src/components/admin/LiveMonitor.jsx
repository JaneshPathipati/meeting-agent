// file: frontend/src/components/admin/LiveMonitor.jsx
import React, { useState, useEffect, useRef } from 'react';
import { supabase } from '../../lib/supabase';
import { useNavigate } from 'react-router-dom';
import { Wifi, WifiOff, Loader2, RefreshCw, Monitor, Clock, ShieldOff, User } from 'lucide-react';
import { formatRelative } from '../../utils/formatDate';
import { formatDuration } from '../../utils/formatDuration';
import LoadingSpinner from '../shared/LoadingSpinner';

const PIPELINE_STATUS = {
  uploaded:                  { label: 'Queued',         color: '#3B82F6', bg: '#EFF6FF' },
  processing:                { label: 'Processing AI',  color: '#F59E0B', bg: '#FFFBEB' },
  awaiting_teams_transcript: { label: 'Fetching Teams', color: '#6366F1', bg: '#EEF2FF' },
};

function timeAgo(iso) {
  if (!iso) return 'Never';
  const diff = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (diff < 60)    return `${diff}s ago`;
  if (diff < 3600)  return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function isOnline(heartbeat) {
  if (!heartbeat) return false;
  return Date.now() - new Date(heartbeat).getTime() < 5 * 60 * 1000;
}

/* ── Agent row ──────────────────────────────────────────────────── */
function AgentRow({ user, animate }) {
  const online = isOnline(user.last_agent_heartbeat);
  return (
    <tr
      className={`border-b border-[#F1F5F9] last:border-0 transition-colors ${
        animate ? 'bg-green-50/40 animate-slide-up' : 'hover:bg-[#F8FAFC]'
      }`}
    >
      <td className="px-4 py-3">
        <div className="flex items-center gap-2.5">
          <div
            className="h-7 w-7 flex items-center justify-center text-[11px] font-bold text-white flex-shrink-0"
            style={{ background: online ? '#10B981' : '#CBD5E1' }}
          >
            {(user.full_name || '?').charAt(0).toUpperCase()}
          </div>
          <div>
            <p className="text-[13px] font-medium text-[#020617]">{user.full_name}</p>
            <p className="text-[11px] text-[#94A3B8]">{user.microsoft_email || user.email || '—'}</p>
          </div>
        </div>
      </td>
      <td className="px-4 py-3 text-[12px] text-[#64748B]">
        {user.job_role === 'Other' ? user.job_role_custom || 'Other' : user.job_role || '—'}
      </td>
      <td className="px-4 py-3">
        <div className="flex items-center gap-1.5">
          {online ? (
            <>
              <Wifi className="h-3.5 w-3.5 text-[#10B981]" />
              <span className="text-[12px] font-medium text-[#10B981]">Online</span>
            </>
          ) : (
            <>
              <WifiOff className="h-3.5 w-3.5 text-[#94A3B8]" />
              <span className="text-[12px] text-[#94A3B8]">
                {user.last_agent_heartbeat ? timeAgo(user.last_agent_heartbeat) : 'Never'}
              </span>
            </>
          )}
        </div>
      </td>
      <td className="px-4 py-3">
        <div className="flex flex-wrap gap-1">
          <span className={`inline-flex px-1.5 py-0.5 text-[11px] font-medium ${
            user.is_active
              ? 'bg-green-100 text-green-700'
              : 'bg-gray-100 text-gray-500'
          }`}>
            {user.is_active ? 'Active' : 'Inactive'}
          </span>
          {user.is_locked_out && (
            <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 text-[11px] font-medium bg-red-100 text-red-600">
              <ShieldOff className="h-2.5 w-2.5" />
              Locked
            </span>
          )}
        </div>
      </td>
      <td className="px-4 py-3 text-[12px] text-[#64748B]">
        {user.last_agent_heartbeat
          ? new Date(user.last_agent_heartbeat).toLocaleString()
          : '—'}
      </td>
    </tr>
  );
}

/* ── Main component ──────────────────────────────────────────────── */
function LiveMonitor() {
  const navigate = useNavigate();
  const [agents, setAgents] = useState([]);
  const [pipeline, setPipeline] = useState([]);
  const [loading, setLoading] = useState(true);
  const [lastRefresh, setLastRefresh] = useState(null);
  const [newAgentIds, setNewAgentIds] = useState(new Set());
  const channelRef = useRef(null);

  async function fetchAll() {
    const [agentsRes, pipelineRes] = await Promise.all([
      supabase
        .from('profiles')
        .select('id, full_name, email, microsoft_email, job_role, job_role_custom, last_agent_heartbeat, is_active, is_locked_out')
        .eq('role', 'user')
        .order('last_agent_heartbeat', { ascending: false, nullsFirst: false }),
      supabase
        .from('meetings')
        .select('id, status, created_at, detected_app, duration_seconds, profiles(full_name)')
        .in('status', ['uploaded', 'processing', 'awaiting_teams_transcript'])
        .order('created_at', { ascending: false })
        .limit(15),
    ]);
    setAgents(agentsRes.data || []);
    setPipeline(pipelineRes.data || []);
    setLastRefresh(new Date());
    setLoading(false);
  }

  useEffect(() => {
    fetchAll();
    const interval = setInterval(fetchAll, 15000);

    channelRef.current = supabase
      .channel('live-monitor-realtime')
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'profiles' }, (payload) => {
        setAgents(prev =>
          prev.map(a => a.id === payload.new.id ? { ...a, ...payload.new } : a)
        );
        setLastRefresh(new Date());
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'meetings' }, fetchAll)
      .subscribe();

    return () => {
      clearInterval(interval);
      if (channelRef.current) supabase.removeChannel(channelRef.current);
    };
  }, []);

  const onlineAgents  = agents.filter(a => isOnline(a.last_agent_heartbeat));
  const offlineAgents = agents.filter(a => !isOnline(a.last_agent_heartbeat));

  if (loading) return <LoadingSpinner size="lg" className="py-16" />;

  return (
    <div className="space-y-8 animate-page-reveal">

      {/* Header */}
      <div className="flex items-end justify-between animate-fade-in">
        <div>
          <p className="text-[11px] uppercase tracking-[0.34em] text-[#64748B]">Real-Time</p>
          <h2 className="mt-1 text-[28px] font-semibold tracking-tight text-[#020617] leading-tight">
            Live Monitor
          </h2>
        </div>
        <div className="flex items-center gap-3">
          {lastRefresh && (
            <span className="text-[12px] text-[#94A3B8]">
              Updated {timeAgo(lastRefresh)}
            </span>
          )}
          <button
            onClick={fetchAll}
            className="flex items-center gap-1.5 px-3 py-1.5 border border-[#E2E8F0] text-[12px] text-[#475569] hover:border-[#F97316] hover:text-[#F97316] transition-all duration-150"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            Refresh
          </button>
        </div>
      </div>

      {/* ── Summary strip ───────────────────────────────────────── */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 animate-slide-up">
        {[
          { label: 'Online Now',        value: onlineAgents.length,  color: '#10B981', bg: '#ECFDF5' },
          { label: 'Total Agents',      value: agents.length,        color: '#F97316', bg: '#FFF7ED' },
          { label: 'In Pipeline',       value: pipeline.length,      color: '#3B82F6', bg: '#EFF6FF' },
          { label: 'Offline',           value: offlineAgents.length, color: '#94A3B8', bg: '#F8FAFC' },
        ].map(({ label, value, color, bg }) => (
          <div
            key={label}
            className="glass-card p-4"
          >
            <p
              className="text-[26px] font-semibold leading-none"
              style={{ color }}
            >{value}</p>
            <p className="mt-1 text-[11px] uppercase tracking-[0.18em] text-[#64748B]">{label}</p>
            <div className="mt-3 h-[2px] w-6" style={{ background: color }} />
          </div>
        ))}
      </div>

      {/* ── Online Agents ────────────────────────────────────────── */}
      <div
        className="glass-panel animate-slide-up"
        style={{ animationDelay: '120ms' }}
      >
        <div className="flex items-center gap-2.5 px-6 pt-5 pb-4 border-b border-[#F1F5F9]">
          <div className="relative flex h-2.5 w-2.5">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-[#10B981] opacity-60" />
            <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-[#10B981]" />
          </div>
          <p className="text-[11px] uppercase tracking-[0.28em] text-[#64748B]">Live</p>
          <h3 className="text-[16px] font-semibold text-[#020617]">Online Agents</h3>
          <span className="ml-auto text-[11px] px-2 py-0.5 border border-[#E2E8F0] text-[#64748B]">
            {onlineAgents.length} / {agents.length}
          </span>
        </div>

        {onlineAgents.length === 0 ? (
          <div className="px-6 py-10 text-center">
            <WifiOff className="h-8 w-8 text-[#E2E8F0] mx-auto mb-2" />
            <p className="text-[13px] text-[#94A3B8]">No agents online right now</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[#F1F5F9] bg-[#FAFBFC]">
                  <th className="text-left px-4 py-2.5 text-[11px] font-medium uppercase tracking-wide text-[#94A3B8]">Agent</th>
                  <th className="text-left px-4 py-2.5 text-[11px] font-medium uppercase tracking-wide text-[#94A3B8]">Role</th>
                  <th className="text-left px-4 py-2.5 text-[11px] font-medium uppercase tracking-wide text-[#94A3B8]">Status</th>
                  <th className="text-left px-4 py-2.5 text-[11px] font-medium uppercase tracking-wide text-[#94A3B8]">Account</th>
                  <th className="text-left px-4 py-2.5 text-[11px] font-medium uppercase tracking-wide text-[#94A3B8]">Last Heartbeat</th>
                </tr>
              </thead>
              <tbody>
                {onlineAgents.map(user => (
                  <AgentRow key={user.id} user={user} animate={newAgentIds.has(user.id)} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ── Processing Pipeline ──────────────────────────────────── */}
      <div
        className="glass-panel animate-slide-up"
        style={{ animationDelay: '200ms' }}
      >
        <div className="flex items-center gap-2.5 px-6 pt-5 pb-4 border-b border-[#F1F5F9]">
          <Loader2 className="h-4 w-4 text-[#F97316] animate-spin" />
          <p className="text-[11px] uppercase tracking-[0.28em] text-[#64748B]">Active</p>
          <h3 className="text-[16px] font-semibold text-[#020617]">Processing Pipeline</h3>
          {pipeline.length > 0 && (
            <span className="ml-auto text-[11px] px-2 py-0.5 border border-[#E2E8F0] text-[#64748B]">
              {pipeline.length} in flight
            </span>
          )}
        </div>

        {pipeline.length === 0 ? (
          <div className="px-6 py-10 text-center">
            <div className="h-8 w-8 mx-auto mb-2 text-[#E2E8F0] flex items-center justify-center">
              <Monitor className="h-8 w-8" />
            </div>
            <p className="text-[13px] text-[#94A3B8]">Pipeline is clear — no meetings processing</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[#F1F5F9] bg-[#FAFBFC]">
                  <th className="text-left px-4 py-2.5 text-[11px] font-medium uppercase tracking-wide text-[#94A3B8]">User</th>
                  <th className="text-left px-4 py-2.5 text-[11px] font-medium uppercase tracking-wide text-[#94A3B8]">App</th>
                  <th className="text-left px-4 py-2.5 text-[11px] font-medium uppercase tracking-wide text-[#94A3B8]">Stage</th>
                  <th className="text-left px-4 py-2.5 text-[11px] font-medium uppercase tracking-wide text-[#94A3B8]">Duration</th>
                  <th className="text-left px-4 py-2.5 text-[11px] font-medium uppercase tracking-wide text-[#94A3B8]">Waiting</th>
                </tr>
              </thead>
              <tbody>
                {pipeline.map(item => {
                  const meta = PIPELINE_STATUS[item.status] || PIPELINE_STATUS.uploaded;
                  return (
                    <tr
                      key={item.id}
                      onClick={() => navigate(`/meetings/${item.id}`)}
                      className="border-b border-[#F1F5F9] last:border-0 hover:bg-[#F8FAFC] cursor-pointer transition-colors"
                    >
                      <td className="px-4 py-3 text-[13px] font-medium text-[#020617]">
                        {item.profiles?.full_name || '—'}
                      </td>
                      <td className="px-4 py-3 text-[12px] text-[#64748B]">
                        {item.detected_app || '—'}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-1.5">
                          <Loader2 className="h-3 w-3 animate-spin flex-shrink-0" style={{ color: meta.color }} />
                          <span
                            className="text-[11px] font-medium px-1.5 py-0.5"
                            style={{ color: meta.color, background: meta.bg }}
                          >
                            {meta.label}
                          </span>
                        </div>
                      </td>
                      <td className="px-4 py-3 text-[12px] text-[#64748B]">
                        {item.duration_seconds ? formatDuration(item.duration_seconds) : '—'}
                      </td>
                      <td className="px-4 py-3 text-[12px] text-[#94A3B8]">
                        {timeAgo(item.created_at)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ── Offline Agents (collapsed by default) ───────────────── */}
      {offlineAgents.length > 0 && (
        <div
          className="glass-panel animate-slide-up"
          style={{ animationDelay: '280ms' }}
        >
          <div className="px-6 pt-5 pb-4 border-b border-[#F1F5F9]">
            <div className="flex items-center gap-2.5">
              <WifiOff className="h-4 w-4 text-[#94A3B8]" />
              <p className="text-[11px] uppercase tracking-[0.28em] text-[#94A3B8]">Offline</p>
              <h3 className="text-[16px] font-semibold text-[#64748B]">Inactive Agents</h3>
              <span className="ml-auto text-[11px] px-2 py-0.5 border border-[#E2E8F0] text-[#94A3B8]">
                {offlineAgents.length}
              </span>
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[#F1F5F9] bg-[#FAFBFC]">
                  <th className="text-left px-4 py-2.5 text-[11px] font-medium uppercase tracking-wide text-[#94A3B8]">Agent</th>
                  <th className="text-left px-4 py-2.5 text-[11px] font-medium uppercase tracking-wide text-[#94A3B8]">Role</th>
                  <th className="text-left px-4 py-2.5 text-[11px] font-medium uppercase tracking-wide text-[#94A3B8]">Status</th>
                  <th className="text-left px-4 py-2.5 text-[11px] font-medium uppercase tracking-wide text-[#94A3B8]">Account</th>
                  <th className="text-left px-4 py-2.5 text-[11px] font-medium uppercase tracking-wide text-[#94A3B8]">Last Heartbeat</th>
                </tr>
              </thead>
              <tbody>
                {offlineAgents.map(user => (
                  <AgentRow key={user.id} user={user} animate={false} />
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

export default LiveMonitor;
