// file: frontend/src/components/admin/DangerZone.jsx
import React, { useState } from 'react';
import { supabase } from '../../lib/supabase';
import { useAuth } from '../../hooks/useAuth';
import {
  ShieldAlert, Lock, UserPlus, Loader2, Eye, EyeOff, X, Shield,
  ChevronRight, KeyRound, LogOut, Trash2, Check, Link, Copy, Clock,
} from 'lucide-react';

function DangerZone() {
  const { user, profile } = useAuth();
  const [isExpanded, setIsExpanded] = useState(false);
  const [isUnlocked, setIsUnlocked] = useState(false);
  const [authPassword, setAuthPassword] = useState('');
  const [authError, setAuthError] = useState('');
  const [authLoading, setAuthLoading] = useState(false);
  const [showAuthPw, setShowAuthPw] = useState(false);

  // Admin list
  const [admins, setAdmins] = useState([]);
  const [adminsLoading, setAdminsLoading] = useState(false);

  // Add admin form
  const [newEmail, setNewEmail] = useState('');
  const [newName, setNewName] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [showNewPw, setShowNewPw] = useState(false);
  const [addError, setAddError] = useState('');
  const [addSuccess, setAddSuccess] = useState('');
  const [addLoading, setAddLoading] = useState(false);

  // Change own password
  const [changePw, setChangePw] = useState('');
  const [changePwConfirm, setChangePwConfirm] = useState('');
  const [showChangePw, setShowChangePw] = useState(false);
  const [changePwError, setChangePwError] = useState('');
  const [changePwSuccess, setChangePwSuccess] = useState('');
  const [changePwLoading, setChangePwLoading] = useState(false);

  // Admin actions (delete / force logout)
  const [confirmAction, setConfirmAction] = useState(null); // { type: 'delete'|'logout', adminId, adminName }
  const [actionLoading, setActionLoading] = useState(false);
  const [actionMsg, setActionMsg] = useState(null); // { type: 'success'|'error', text }

  // Invite code
  const [invite, setInvite] = useState(null); // { code, expires_at }
  const [inviteLoading, setInviteLoading] = useState(false);
  const [inviteCopied, setInviteCopied] = useState(false);

  // ── Re-authentication ──
  async function handleReAuth(e) {
    e.preventDefault();
    setAuthError('');
    setAuthLoading(true);

    const { error } = await supabase.auth.signInWithPassword({
      email: user.email,
      password: authPassword,
    });

    setAuthLoading(false);
    if (error) {
      setAuthError('Invalid credentials. Please try again.');
    } else {
      setIsUnlocked(true);
      setAuthPassword('');
      fetchAdmins();
    }
  }

  async function fetchAdmins() {
    setAdminsLoading(true);
    const { data, error } = await supabase
      .from('profiles')
      .select('id, email, full_name, created_at')
      .eq('org_id', profile.org_id)
      .eq('role', 'admin')
      .order('created_at', { ascending: true });

    if (!error && data) setAdmins(data);
    setAdminsLoading(false);
  }

  // ── Add admin ──
  async function handleAddAdmin(e) {
    e.preventDefault();
    setAddError('');
    setAddSuccess('');
    setAddLoading(true);

    const { data, error } = await supabase.rpc('create_admin_user', {
      p_email: newEmail.trim(),
      p_password: newPassword,
      p_full_name: newName.trim(),
    });

    setAddLoading(false);
    if (error) {
      setAddError(error.message);
    } else {
      setAddSuccess(`Admin "${newName.trim()}" (${newEmail.trim()}) created successfully.`);
      setNewEmail('');
      setNewName('');
      setNewPassword('');
      fetchAdmins();
      setTimeout(() => setAddSuccess(''), 5000);
    }
  }

  // ── Change own password ──
  async function handleChangePassword(e) {
    e.preventDefault();
    setChangePwError('');
    setChangePwSuccess('');

    if (changePw !== changePwConfirm) {
      setChangePwError('Passwords do not match.');
      return;
    }
    if (changePw.length < 8) {
      setChangePwError('Password must be at least 8 characters.');
      return;
    }

    setChangePwLoading(true);
    const { error } = await supabase.auth.updateUser({ password: changePw });
    setChangePwLoading(false);

    if (error) {
      setChangePwError(error.message);
    } else {
      setChangePwSuccess('Password updated successfully.');
      setChangePw('');
      setChangePwConfirm('');
      setTimeout(() => setChangePwSuccess(''), 5000);
    }
  }

  // ── Delete another admin ──
  async function handleDeleteAdmin(adminId) {
    setActionLoading(true);
    setActionMsg(null);

    const { data, error } = await supabase.rpc('delete_admin_user', {
      p_profile_id: adminId,
    });

    setActionLoading(false);
    setConfirmAction(null);

    if (error) {
      setActionMsg({ type: 'error', text: error.message });
    } else {
      setActionMsg({ type: 'success', text: `Admin "${data.deleted_name}" has been removed.` });
      fetchAdmins();
      setTimeout(() => setActionMsg(null), 5000);
    }
  }

  // ── Generate invite code ──
  async function handleGenerateInvite() {
    setInviteLoading(true);
    const { data, error } = await supabase.rpc('generate_admin_invite');
    setInviteLoading(false);
    if (!error && data) {
      setInvite({ code: data.code, expires_at: data.expires_at });
      setInviteCopied(false);
    }
  }

  function handleCopyInvite() {
    navigator.clipboard.writeText(invite.code);
    setInviteCopied(true);
    setTimeout(() => setInviteCopied(false), 2000);
  }

  // ── Force logout another admin ──
  // Uses Edge Function so the service role key stays server-side.
  // admin.signOut(userId, 'global') revokes the JWT secret immediately —
  // the target's existing access tokens become invalid at once.
  async function handleForceLogout(adminId) {
    setActionLoading(true);
    setActionMsg(null);

    const { data, error } = await supabase.functions.invoke('force-logout-admin', {
      body: { profileId: adminId },
    });

    setActionLoading(false);
    setConfirmAction(null);

    if (error) {
      // FunctionsHttpError has a `context` Response — extract the real body
      let errorText = error.message;
      try {
        const body = await error.context?.json?.();
        if (body?.error) errorText = body.error;
      } catch { /* ignore parse errors */ }
      setActionMsg({ type: 'error', text: errorText });
    } else if (data?.error) {
      setActionMsg({ type: 'error', text: data.error });
    } else {
      setActionMsg({ type: 'success', text: `"${data.name}" has been signed out from all devices immediately.` });
      setTimeout(() => setActionMsg(null), 5000);
    }
  }

  function handleLock() {
    setIsUnlocked(false);
    setIsExpanded(false);
    setAuthPassword('');
    setAuthError('');
    setNewEmail('');
    setNewName('');
    setNewPassword('');
    setAddError('');
    setAddSuccess('');
    setChangePw('');
    setChangePwConfirm('');
    setChangePwError('');
    setChangePwSuccess('');
    setConfirmAction(null);
    setActionMsg(null);
    setInvite(null);
    setInviteCopied(false);
  }

  const SUPER_ADMIN_EMAIL = import.meta.env.VITE_SUPER_ADMIN_EMAIL || '';
  const isSelf = (adminId) => adminId === profile.id;
  const isSuperAdmin = (email) => email?.toLowerCase() === SUPER_ADMIN_EMAIL;
  const isCurrentUserSuperAdmin = isSuperAdmin(user?.email);

  return (
    <div className="rounded-xl border-2 border-red-300 dark:border-red-800 overflow-hidden">
      {/* Header — clickable to expand/collapse */}
      <button
        type="button"
        onClick={() => !isUnlocked && setIsExpanded(!isExpanded)}
        className={`w-full flex items-center justify-between px-6 py-4 bg-red-50 dark:bg-red-900/20 ${isExpanded || isUnlocked ? 'border-b border-red-200 dark:border-red-800' : ''} ${!isUnlocked ? 'cursor-pointer hover:bg-red-100/60 dark:hover:bg-red-900/30 transition-colors' : 'cursor-default'}`}
      >
        <div className="flex items-center gap-2">
          <ShieldAlert className="h-5 w-5 text-red-600 dark:text-red-400" />
          <div className="text-left">
            <h3 className="text-lg font-semibold text-red-900 dark:text-red-300">Danger Zone</h3>
            {!isExpanded && !isUnlocked && (
              <p className="text-xs text-red-600/70 dark:text-red-400/70 mt-0.5">Manage administrators and other sensitive settings</p>
            )}
          </div>
        </div>
        {isUnlocked ? (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); handleLock(); }}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-red-700 dark:text-red-400 bg-red-100 dark:bg-red-900/30 hover:bg-red-200 dark:hover:bg-red-900/50 transition-colors"
          >
            <Lock className="h-3.5 w-3.5" />
            Lock
          </button>
        ) : (
          <ChevronRight className={`h-5 w-5 text-red-400 transition-transform duration-200 ${isExpanded ? 'rotate-90' : ''}`} />
        )}
      </button>

      {(isExpanded || isUnlocked) && <div className="p-6">
        {!isUnlocked ? (
          /* ── Re-authentication gate ── */
          <div>
            <p className="text-sm text-gray-600 dark:text-gray-400 mb-4">
              This section contains sensitive operations. Please verify your identity to continue.
            </p>
            <form onSubmit={handleReAuth} className="space-y-3">
              <div>
                <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">
                  Email
                </label>
                <div className="w-full px-3 py-2 border rounded-lg bg-gray-50 dark:bg-gray-700 dark:border-gray-600 text-gray-500 dark:text-gray-400 text-sm select-text">
                  {user.email}
                </div>
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">
                  Password
                </label>
                <div className="relative">
                  <input
                    type={showAuthPw ? 'text' : 'password'}
                    value={authPassword}
                    onChange={(e) => setAuthPassword(e.target.value)}
                    placeholder="Enter your password"
                    required
                    className="w-full px-3 py-2 pr-10 border rounded-lg focus:ring-2 focus:ring-red-500 dark:bg-gray-700 dark:border-gray-600 dark:text-white text-sm"
                  />
                  <button
                    type="button"
                    onClick={() => setShowAuthPw(!showAuthPw)}
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
                  >
                    {showAuthPw ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
              </div>

              {authError && (
                <p className="text-xs text-red-600 dark:text-red-400">{authError}</p>
              )}

              <button
                type="submit"
                disabled={authLoading || !authPassword}
                className="flex items-center gap-2 px-4 py-2 rounded-lg bg-red-600 text-white text-sm font-medium hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {authLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Lock className="h-4 w-4" />}
                Verify Identity
              </button>
            </form>
          </div>
        ) : (
          /* ── Unlocked — Full admin management ── */
          <div className="space-y-6">

            {/* ── Global action feedback ── */}
            {actionMsg && (
              <div className={`p-2.5 rounded-lg text-xs ${
                actionMsg.type === 'error'
                  ? 'bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400'
                  : 'bg-green-50 dark:bg-green-900/20 text-green-600 dark:text-green-400'
              }`}>
                {actionMsg.text}
              </div>
            )}

            {/* ── Current Administrators ── */}
            <div>
              <h4 className="text-sm font-semibold text-gray-900 dark:text-white mb-3 flex items-center gap-2">
                <Shield className="h-4 w-4 text-gray-500" />
                Current Administrators
              </h4>
              {adminsLoading ? (
                <div className="flex items-center gap-2 text-sm text-gray-500">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Loading...
                </div>
              ) : (
                <div className="border dark:border-gray-700 rounded-lg divide-y dark:divide-gray-700">
                  {admins.map((admin) => (
                    <div key={admin.id}>
                      <div className="flex items-center justify-between px-4 py-3">
                        <div>
                          <p className="text-sm font-medium text-gray-900 dark:text-white flex items-center flex-wrap gap-1.5">
                            {admin.full_name}
                            {isSuperAdmin(admin.email) && (
                              <span className="inline-flex px-1.5 py-0.5 rounded text-[10px] font-semibold bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400">
                                Super Admin
                              </span>
                            )}
                            {isSelf(admin.id) && (
                              <span className="inline-flex px-1.5 py-0.5 rounded text-[10px] font-semibold bg-brand-100 text-brand-700 dark:bg-brand-900/30 dark:text-brand-400">
                                You
                              </span>
                            )}
                          </p>
                          <p className="text-xs text-gray-500 dark:text-gray-400">{admin.email}</p>
                        </div>
                        <div className="flex items-center gap-1">
                          {/* Action buttons: only super admin can logout/delete others */}
                          {isCurrentUserSuperAdmin && !isSelf(admin.id) && !isSuperAdmin(admin.email) && (
                            <>
                              <button
                                onClick={() => setConfirmAction({ type: 'logout', adminId: admin.id, adminName: admin.full_name })}
                                className="p-1.5 rounded-md hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-400 hover:text-amber-600 dark:hover:text-amber-400"
                                title="Force sign out from all devices"
                              >
                                <LogOut className="h-4 w-4" />
                              </button>
                              <button
                                onClick={() => setConfirmAction({ type: 'delete', adminId: admin.id, adminName: admin.full_name })}
                                className="p-1.5 rounded-md hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-400 hover:text-red-600 dark:hover:text-red-400"
                                title="Remove administrator"
                              >
                                <Trash2 className="h-4 w-4" />
                              </button>
                            </>
                          )}
                          {(isSelf(admin.id) || isSuperAdmin(admin.email)) && (
                            <span className="text-xs text-gray-400">
                              {new Date(admin.created_at).toLocaleDateString()}
                            </span>
                          )}
                        </div>
                      </div>

                      {/* Inline confirmation */}
                      {confirmAction && confirmAction.adminId === admin.id && (
                        <div className="px-4 pb-3">
                          <div className={`flex items-center justify-between p-3 rounded-lg text-xs ${
                            confirmAction.type === 'delete'
                              ? 'bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800'
                              : 'bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800'
                          }`}>
                            <p className={confirmAction.type === 'delete' ? 'text-red-700 dark:text-red-400' : 'text-amber-700 dark:text-amber-400'}>
                              {confirmAction.type === 'delete'
                                ? `Permanently remove "${admin.full_name}"? This cannot be undone.`
                                : `Sign out "${admin.full_name}" from all devices?`}
                            </p>
                            <div className="flex items-center gap-2 ml-3 flex-shrink-0">
                              <button
                                onClick={() => setConfirmAction(null)}
                                disabled={actionLoading}
                                className="px-2.5 py-1 rounded text-gray-600 dark:text-gray-400 hover:bg-white dark:hover:bg-gray-700 font-medium"
                              >
                                Cancel
                              </button>
                              <button
                                onClick={() => confirmAction.type === 'delete'
                                  ? handleDeleteAdmin(admin.id)
                                  : handleForceLogout(admin.id)}
                                disabled={actionLoading}
                                className={`flex items-center gap-1 px-2.5 py-1 rounded text-white font-medium disabled:opacity-50 ${
                                  confirmAction.type === 'delete' ? 'bg-red-600 hover:bg-red-700' : 'bg-amber-600 hover:bg-amber-700'
                                }`}
                              >
                                {actionLoading && <Loader2 className="h-3 w-3 animate-spin" />}
                                Confirm
                              </button>
                            </div>
                          </div>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* ── Change Your Password ── */}
            <div className="border-t dark:border-gray-700 pt-6">
              <h4 className="text-sm font-semibold text-gray-900 dark:text-white mb-1 flex items-center gap-2">
                <KeyRound className="h-4 w-4 text-gray-500" />
                Change Your Password
              </h4>
              <p className="text-xs text-gray-500 dark:text-gray-400 mb-4">
                Update the password for your own admin account.
              </p>

              <form onSubmit={handleChangePassword} className="space-y-3">
                <div>
                  <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">
                    New Password
                  </label>
                  <div className="relative">
                    <input
                      type={showChangePw ? 'text' : 'password'}
                      value={changePw}
                      onChange={(e) => setChangePw(e.target.value)}
                      placeholder="Minimum 8 characters"
                      required
                      minLength={8}
                      className="w-full px-3 py-2 pr-10 border rounded-lg focus:ring-2 focus:ring-brand-500 dark:bg-gray-700 dark:border-gray-600 dark:text-white text-sm"
                    />
                    <button
                      type="button"
                      onClick={() => setShowChangePw(!showChangePw)}
                      className="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
                    >
                      {showChangePw ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </button>
                  </div>
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">
                    Confirm New Password
                  </label>
                  <input
                    type="password"
                    value={changePwConfirm}
                    onChange={(e) => setChangePwConfirm(e.target.value)}
                    placeholder="Re-enter new password"
                    required
                    minLength={8}
                    className={`w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-brand-500 dark:bg-gray-700 dark:border-gray-600 dark:text-white text-sm ${
                      changePwConfirm && changePw !== changePwConfirm ? 'border-red-400 dark:border-red-600' : ''
                    }`}
                  />
                  {changePwConfirm && changePw !== changePwConfirm && (
                    <p className="text-xs text-red-500 mt-1">Passwords do not match</p>
                  )}
                </div>

                {changePwError && (
                  <div className="flex items-start gap-2 p-2.5 rounded-lg bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 text-xs">
                    <X className="h-3.5 w-3.5 mt-0.5 flex-shrink-0" />
                    {changePwError}
                  </div>
                )}
                {changePwSuccess && (
                  <div className="flex items-center gap-2 p-2.5 rounded-lg bg-green-50 dark:bg-green-900/20 text-green-600 dark:text-green-400 text-xs">
                    <Check className="h-3.5 w-3.5 flex-shrink-0" />
                    {changePwSuccess}
                  </div>
                )}

                <button
                  type="submit"
                  disabled={changePwLoading || changePw.length < 8 || changePw !== changePwConfirm}
                  className="flex items-center gap-2 px-4 py-2 rounded-lg bg-brand-600 text-white text-sm font-medium hover:bg-brand-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                >
                  {changePwLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <KeyRound className="h-4 w-4" />}
                  Update Password
                </button>
              </form>
            </div>

            {/* ── Invite New Administrator ── */}
            <div className="border-t dark:border-gray-700 pt-6">
              <h4 className="text-sm font-semibold text-gray-900 dark:text-white mb-1 flex items-center gap-2">
                <Link className="h-4 w-4 text-gray-500" />
                Invite New Administrator
              </h4>
              <p className="text-xs text-gray-500 dark:text-gray-400 mb-4">
                Generate a one-time invite code. Share it with the new admin — they use it on the login page to sign up with their own credentials. Codes expire after 24 hours.
              </p>

              {invite ? (
                <div className="space-y-3">
                  <div className="flex items-center gap-2 p-3 rounded-lg bg-gray-50 dark:bg-gray-700/50 border dark:border-gray-600">
                    <span className="flex-1 font-mono text-lg font-bold tracking-widest text-gray-900 dark:text-white select-all">
                      {invite.code}
                    </span>
                    <button
                      onClick={handleCopyInvite}
                      className="p-1.5 rounded-md hover:bg-gray-200 dark:hover:bg-gray-600 text-gray-500"
                      title="Copy code"
                    >
                      {inviteCopied ? <Check className="h-4 w-4 text-green-500" /> : <Copy className="h-4 w-4" />}
                    </button>
                  </div>
                  <div className="flex items-center gap-1.5 text-xs text-amber-600 dark:text-amber-400">
                    <Clock className="h-3.5 w-3.5" />
                    Expires {new Date(invite.expires_at).toLocaleString()} — one use only
                  </div>
                  <button
                    onClick={handleGenerateInvite}
                    disabled={inviteLoading}
                    className="text-xs text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 underline"
                  >
                    Generate a new code (invalidates this one)
                  </button>
                </div>
              ) : (
                <button
                  onClick={handleGenerateInvite}
                  disabled={inviteLoading}
                  className="flex items-center gap-2 px-4 py-2 rounded-lg border border-gray-300 dark:border-gray-600 text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                >
                  {inviteLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Link className="h-4 w-4" />}
                  Generate Invite Code
                </button>
              )}
            </div>

            {/* ── Add New Administrator ── */}
            <div className="border-t dark:border-gray-700 pt-6">
              <h4 className="text-sm font-semibold text-gray-900 dark:text-white mb-1 flex items-center gap-2">
                <UserPlus className="h-4 w-4 text-gray-500" />
                Add New Administrator
              </h4>
              <p className="text-xs text-gray-500 dark:text-gray-400 mb-4">
                The new admin will be able to log in to this dashboard and manage all settings.
              </p>

              <form onSubmit={handleAddAdmin} className="space-y-3">
                <div>
                  <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">
                    Full Name
                  </label>
                  <input
                    type="text"
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                    placeholder="John Doe"
                    required
                    className="w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-brand-500 dark:bg-gray-700 dark:border-gray-600 dark:text-white text-sm"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">
                    Email Address
                  </label>
                  <input
                    type="email"
                    value={newEmail}
                    onChange={(e) => setNewEmail(e.target.value)}
                    placeholder="admin@yourcompany.com"
                    required
                    className="w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-brand-500 dark:bg-gray-700 dark:border-gray-600 dark:text-white text-sm"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">
                    Password
                  </label>
                  <div className="relative">
                    <input
                      type={showNewPw ? 'text' : 'password'}
                      value={newPassword}
                      onChange={(e) => setNewPassword(e.target.value)}
                      placeholder="Minimum 8 characters"
                      required
                      minLength={8}
                      className="w-full px-3 py-2 pr-10 border rounded-lg focus:ring-2 focus:ring-brand-500 dark:bg-gray-700 dark:border-gray-600 dark:text-white text-sm"
                    />
                    <button
                      type="button"
                      onClick={() => setShowNewPw(!showNewPw)}
                      className="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
                    >
                      {showNewPw ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </button>
                  </div>
                </div>

                {addError && (
                  <div className="flex items-start gap-2 p-2.5 rounded-lg bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 text-xs">
                    <X className="h-3.5 w-3.5 mt-0.5 flex-shrink-0" />
                    {addError}
                  </div>
                )}
                {addSuccess && (
                  <div className="p-2.5 rounded-lg bg-green-50 dark:bg-green-900/20 text-green-600 dark:text-green-400 text-xs">
                    {addSuccess}
                  </div>
                )}

                <button
                  type="submit"
                  disabled={addLoading || !newEmail || !newName || newPassword.length < 8}
                  className="flex items-center gap-2 px-4 py-2 rounded-lg bg-red-600 text-white text-sm font-medium hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                >
                  {addLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <UserPlus className="h-4 w-4" />}
                  Create Administrator
                </button>
              </form>
            </div>

          </div>
        )}
      </div>}
    </div>
  );
}

export default DangerZone;
