// file: frontend/src/components/admin/UsersList.jsx
import React, { useState, useEffect, useMemo, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../../lib/supabase';
import { UserPlus, Edit2, UserX, Wifi, WifiOff, Lock, Unlock, Trash2, Mail, MailX, FileText, FileX, Search, X } from 'lucide-react';
import { formatRelative } from '../../utils/formatDate';
import LoadingSpinner from '../shared/LoadingSpinner';
import EmptyState from '../shared/EmptyState';
import AddUserModal from './AddUserModal';
import EditUserModal from './EditUserModal';

function ConfirmDialog({ title, message, confirmLabel, confirmColor, onConfirm, onCancel }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-white dark:bg-gray-800 rounded-xl shadow-xl w-full max-w-sm mx-4 p-5">
        <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-2">{title}</h3>
        <p className="text-sm text-gray-600 dark:text-gray-400 mb-5">{message}</p>
        <div className="flex justify-end gap-3">
          <button
            onClick={onCancel}
            className="px-4 py-2 text-sm text-gray-600 hover:bg-gray-100 rounded-lg dark:text-gray-300 dark:hover:bg-gray-700"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            className={`px-4 py-2 text-sm font-medium text-white rounded-lg ${confirmColor || 'bg-brand-600 hover:bg-brand-700'}`}
          >
            {confirmLabel || 'Confirm'}
          </button>
        </div>
      </div>
    </div>
  );
}

function UsersList() {
  const navigate = useNavigate();
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showAddModal, setShowAddModal] = useState(false);
  const [editingUser, setEditingUser] = useState(null);
  const [confirm, setConfirm] = useState(null);
  const [actionError, setActionError] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [searchTerm, setSearchTerm] = useState('');
  const searchRef = useRef(null);
  const debounceRef = useRef(null);

  const handleSearchChange = (value) => {
    setSearchInput(value);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      setSearchTerm(value.trim().toLowerCase());
    }, 200);
  };

  useEffect(() => {
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, []);

  const clearSearch = () => {
    setSearchInput('');
    setSearchTerm('');
    searchRef.current?.focus();
  };

  const filteredUsers = useMemo(() => {
    if (!searchTerm) return users;
    return users.filter(u => {
      const name = (u.full_name || '').toLowerCase();
      const email = (u.microsoft_email || u.email || '').toLowerCase();
      return name.includes(searchTerm) || email.includes(searchTerm);
    });
  }, [users, searchTerm]);

  useEffect(() => {
    fetchUsers();
  }, []);

  async function fetchUsers() {
    setLoading(true);
    const { data, error } = await supabase
      .from('profiles')
      .select('*')
      .eq('role', 'user')
      .order('full_name', { ascending: true });

    if (!error) setUsers(data || []);
    setLoading(false);
  }

  function requestToggleActive(user) {
    const action = user.is_active ? 'Deactivate' : 'Activate';
    const desc = user.is_active
      ? `This will deactivate ${user.full_name}. Their agent will stop on the next heartbeat and they won't be able to re-enroll until reactivated.`
      : `This will reactivate ${user.full_name}. They will be able to enroll again.`;
    setConfirm({
      title: `${action} User?`,
      message: desc,
      confirmLabel: action,
      confirmColor: user.is_active ? 'bg-red-600 hover:bg-red-700' : 'bg-green-600 hover:bg-green-700',
      onConfirm: async () => {
        const { error } = await supabase
          .from('profiles')
          .update({ is_active: !user.is_active })
          .eq('id', user.id);
        setConfirm(null);
        if (error) { setActionError('Failed to update status: ' + error.message); return; }
        setActionError('');
        setUsers(prev => prev.map(u => u.id === user.id ? { ...u, is_active: !u.is_active } : u));
      },
    });
  }

  function requestToggleLockOut(user) {
    const action = user.is_locked_out ? 'Unlock' : 'Lock Out';
    const desc = user.is_locked_out
      ? `This will unlock ${user.full_name}. They will be able to re-enroll using the setup wizard.`
      : `This will lock out ${user.full_name}. Their agent will stop on the next heartbeat and local credentials will be cleared. They must re-enroll to use MeetChamp again.`;
    setConfirm({
      title: `${action} User?`,
      message: desc,
      confirmLabel: action,
      confirmColor: user.is_locked_out ? 'bg-green-600 hover:bg-green-700' : 'bg-amber-600 hover:bg-amber-700',
      onConfirm: async () => {
        const newLocked = !user.is_locked_out;
        const { error } = await supabase
          .from('profiles')
          .update({ is_locked_out: newLocked })
          .eq('id', user.id);
        setConfirm(null);
        if (error) { setActionError('Failed to update lock status: ' + error.message); return; }
        setActionError('');
        setUsers(prev => prev.map(u => u.id === user.id ? { ...u, is_locked_out: newLocked } : u));
      },
    });
  }

  function requestToggleSummary(user) {
    const enabling = user.summary_enabled === false;
    const action = enabling ? 'Enable' : 'Disable';
    const desc = enabling
      ? `This will enable AI summary generation for ${user.full_name}. Summaries and tone analysis will be generated after each meeting.`
      : `This will disable AI summary generation for ${user.full_name}. Meetings will still be recorded and transcribed, but no summary will be generated. Email notifications will also stop.`;
    setConfirm({
      title: `${action} Summary Generation?`,
      message: desc,
      confirmLabel: action,
      confirmColor: enabling ? 'bg-green-600 hover:bg-green-700' : 'bg-amber-600 hover:bg-amber-700',
      onConfirm: async () => {
        const updates = { summary_enabled: enabling };
        if (!enabling) updates.email_enabled = false;
        const { error } = await supabase
          .from('profiles')
          .update(updates)
          .eq('id', user.id);
        setConfirm(null);
        if (error) { setActionError('Failed to update summary setting: ' + error.message); return; }
        setActionError('');
        setUsers(prev => prev.map(u => u.id === user.id ? { ...u, ...updates } : u));
      },
    });
  }

  function requestToggleEmail(user) {
    const enabling = !user.email_enabled;
    const action = enabling ? 'Enable' : 'Disable';
    const desc = enabling
      ? `This will enable email summary notifications for ${user.full_name}. They will receive an email after each meeting is processed.`
      : `This will disable email summary notifications for ${user.full_name}. They will no longer receive summary emails after meetings.`;
    setConfirm({
      title: `${action} Email Notifications?`,
      message: desc,
      confirmLabel: action,
      confirmColor: enabling ? 'bg-green-600 hover:bg-green-700' : 'bg-amber-600 hover:bg-amber-700',
      onConfirm: async () => {
        const { error } = await supabase
          .from('profiles')
          .update({ email_enabled: enabling })
          .eq('id', user.id);
        setConfirm(null);
        if (error) { setActionError('Failed to update email setting: ' + error.message); return; }
        setActionError('');
        setUsers(prev => prev.map(u => u.id === user.id ? { ...u, email_enabled: enabling } : u));
      },
    });
  }

  function requestDeleteUser(user) {
    setConfirm({
      title: 'Delete User?',
      message: `Are you sure you want to permanently delete ${user.full_name} (${user.microsoft_email || user.email})? This will also delete all their meetings, transcripts, and summaries. This action cannot be undone.`,
      confirmLabel: 'Delete',
      confirmColor: 'bg-red-600 hover:bg-red-700',
      onConfirm: async () => {
        const { error } = await supabase
          .from('profiles')
          .delete()
          .eq('id', user.id);
        setConfirm(null);
        if (error) { setActionError('Failed to delete user: ' + error.message); return; }
        setActionError('');
        setUsers(prev => prev.filter(u => u.id !== user.id));
      },
    });
  }

  function isAgentOnline(heartbeat) {
    if (!heartbeat) return false;
    return new Date(heartbeat).getTime() > Date.now() - 15 * 60 * 1000;
  }

  if (loading) return <LoadingSpinner size="lg" className="py-12" />;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-bold text-gray-900 dark:text-white">Users</h2>
        <button
          onClick={() => setShowAddModal(true)}
          className="flex items-center gap-2 px-4 py-2 bg-brand-600 text-white rounded-lg hover:bg-brand-700 text-sm font-medium"
        >
          <UserPlus className="h-4 w-4" />
          Add User
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

      {actionError && (
        <div className="p-3 rounded-lg bg-red-50 text-red-700 text-sm dark:bg-red-900/30 dark:text-red-400">
          {actionError}
        </div>
      )}

      {filteredUsers.length === 0 ? (
        searchTerm ? (
          <EmptyState
            icon={Search}
            title="No results found"
            description={`No users match "${searchInput}"`}
          />
        ) : (
          <EmptyState title="No users yet" description="Add monitored employees to get started" />
        )
      ) : (
        <div className="bg-white dark:bg-gray-800 rounded-xl border dark:border-gray-700 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50">
                  <th className="text-left px-4 py-3 font-medium text-gray-500 dark:text-gray-400">Name</th>
                  <th className="text-left px-4 py-3 font-medium text-gray-500 dark:text-gray-400">Email</th>
                  <th className="text-left px-4 py-3 font-medium text-gray-500 dark:text-gray-400">Role</th>
                  <th className="text-left px-4 py-3 font-medium text-gray-500 dark:text-gray-400">Agent</th>
                  <th className="text-left px-4 py-3 font-medium text-gray-500 dark:text-gray-400">Summary</th>
                  <th className="text-left px-4 py-3 font-medium text-gray-500 dark:text-gray-400">Email</th>
                  <th className="text-left px-4 py-3 font-medium text-gray-500 dark:text-gray-400">Status</th>
                  <th className="text-right px-4 py-3 font-medium text-gray-500 dark:text-gray-400">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y dark:divide-gray-700">
                {filteredUsers.map(user => (
                  <tr key={user.id} className="hover:bg-gray-50 dark:hover:bg-gray-700/30">
                    <td
                      className="px-4 py-3 font-medium text-brand-600 dark:text-brand-400 hover:text-brand-700 dark:hover:text-brand-300 cursor-pointer hover:underline"
                      onClick={() => navigate('/users/' + user.id)}
                    >
                      {user.full_name}
                    </td>
                    <td className="px-4 py-3 text-gray-600 dark:text-gray-300">{user.microsoft_email || user.email}</td>
                    <td className="px-4 py-3 text-gray-600 dark:text-gray-300">{user.job_role === 'Other' ? user.job_role_custom || 'Other' : user.job_role || '-'}</td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1.5">
                        {isAgentOnline(user.last_agent_heartbeat) ? (
                          <>
                            <Wifi className="h-4 w-4 text-green-500" />
                            <span className="text-green-600 text-xs">Online</span>
                          </>
                        ) : (
                          <>
                            <WifiOff className="h-4 w-4 text-gray-400" />
                            <span className="text-gray-400 text-xs">
                              {user.last_agent_heartbeat ? formatRelative(user.last_agent_heartbeat) : 'Never'}
                            </span>
                          </>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${
                        user.summary_enabled !== false
                          ? 'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400'
                          : 'bg-gray-100 text-gray-500 dark:bg-gray-700 dark:text-gray-400'
                      }`}>
                        {user.summary_enabled !== false ? <FileText className="h-3 w-3" /> : <FileX className="h-3 w-3" />}
                        {user.summary_enabled !== false ? 'On' : 'Off'}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${
                        user.email_enabled !== false
                          ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400'
                          : 'bg-gray-100 text-gray-500 dark:bg-gray-700 dark:text-gray-400'
                      }`}>
                        {user.email_enabled !== false ? <Mail className="h-3 w-3" /> : <MailX className="h-3 w-3" />}
                        {user.email_enabled !== false ? 'On' : 'Off'}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex flex-col items-start gap-0.5">
                        <span className={`inline-block w-fit px-2 py-0.5 rounded-full text-xs font-medium ${
                          user.is_active
                            ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400'
                            : 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-400'
                        }`}>
                          {user.is_active ? 'Active' : 'Inactive'}
                        </span>
                        {user.is_locked_out && (
                          <span className="inline-block w-fit px-2 py-0.5 rounded-full text-xs font-medium bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400">
                            Locked
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <div className="flex items-center justify-end gap-1">
                        <button
                          onClick={() => setEditingUser(user)}
                          className="p-1.5 rounded-md hover:bg-gray-100 dark:hover:bg-gray-700"
                          title="Edit"
                        >
                          <Edit2 className="h-4 w-4 text-gray-500" />
                        </button>
                        <button
                          onClick={() => requestToggleSummary(user)}
                          className="p-1.5 rounded-md hover:bg-gray-100 dark:hover:bg-gray-700"
                          title={user.summary_enabled !== false ? 'Disable summary generation' : 'Enable summary generation'}
                        >
                          {user.summary_enabled !== false
                            ? <FileText className="h-4 w-4 text-purple-500" />
                            : <FileX className="h-4 w-4 text-gray-400" />
                          }
                        </button>
                        <button
                          onClick={() => requestToggleEmail(user)}
                          className="p-1.5 rounded-md hover:bg-gray-100 dark:hover:bg-gray-700"
                          title={user.email_enabled !== false ? 'Disable email notifications' : 'Enable email notifications'}
                        >
                          {user.email_enabled !== false
                            ? <Mail className="h-4 w-4 text-blue-500" />
                            : <MailX className="h-4 w-4 text-gray-400" />
                          }
                        </button>
                        <button
                          onClick={() => requestToggleLockOut(user)}
                          className="p-1.5 rounded-md hover:bg-gray-100 dark:hover:bg-gray-700"
                          title={user.is_locked_out ? 'Unlock (allow re-enrollment)' : 'Lock Out (force logout)'}
                        >
                          {user.is_locked_out
                            ? <Unlock className="h-4 w-4 text-green-500" />
                            : <Lock className="h-4 w-4 text-amber-500" />
                          }
                        </button>
                        <button
                          onClick={() => requestToggleActive(user)}
                          className="p-1.5 rounded-md hover:bg-gray-100 dark:hover:bg-gray-700"
                          title={user.is_active ? 'Deactivate' : 'Activate'}
                        >
                          <UserX className={`h-4 w-4 ${user.is_active ? 'text-red-500' : 'text-green-500'}`} />
                        </button>
                        <button
                          onClick={() => requestDeleteUser(user)}
                          className="p-1.5 rounded-md hover:bg-gray-100 dark:hover:bg-gray-700"
                          title="Delete user permanently"
                        >
                          <Trash2 className="h-4 w-4 text-red-400" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {showAddModal && (
        <AddUserModal
          onClose={() => setShowAddModal(false)}
          onAdded={() => { setShowAddModal(false); fetchUsers(); }}
        />
      )}

      {editingUser && (
        <EditUserModal
          user={editingUser}
          onClose={() => setEditingUser(null)}
          onUpdated={() => { setEditingUser(null); fetchUsers(); }}
        />
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
