// file: frontend/src/components/admin/AddUserModal.jsx
import React, { useState, useEffect } from 'react';
import { supabase } from '../../lib/supabase';
import { useAuth } from '../../hooks/useAuth';
import { isValidEmail, validateStringLength } from '../../utils/validation';
import { X, Loader2, Copy, Check, Key, RefreshCw } from 'lucide-react';

function generateKey() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let key = '';
  for (let i = 0; i < 16; i++) {
    if (i > 0 && i % 4 === 0) key += '-';
    key += chars[Math.floor(Math.random() * chars.length)];
  }
  return key;
}

function AddUserModal({ onClose, onAdded }) {
  const { profile } = useAuth();
  const [form, setForm] = useState({
    full_name: '',
    microsoft_email: '',
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [authKey, setAuthKey] = useState('');
  const [authKeyLoading, setAuthKeyLoading] = useState(true);
  const [copied, setCopied] = useState(false);
  const [showSuccess, setShowSuccess] = useState(false);
  const [createdUser, setCreatedUser] = useState(null);

  useEffect(() => {
    fetchAuthKey();
  }, []);

  async function fetchAuthKey() {
    setAuthKeyLoading(true);
    const { data } = await supabase
      .from('organizations')
      .select('authorization_key')
      .eq('id', profile.org_id)
      .single();
    setAuthKey(data?.authorization_key || '');
    setAuthKeyLoading(false);
  }

  async function handleSetKey(newKey) {
    const { data, error } = await supabase
      .from('organizations')
      .update({ authorization_key: newKey })
      .eq('id', profile.org_id)
      .select('authorization_key');

    if (error || !data || data.length === 0) {
      setError('Failed to save key: ' + (error?.message || 'no rows updated'));
      return;
    }
    setAuthKey(data[0].authorization_key);
  }

  function handleCopy() {
    navigator.clipboard.writeText(authKey);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');

    if (!validateStringLength(form.full_name, 2, 100)) {
      setError('Name must be 2-100 characters');
      return;
    }
    if (!isValidEmail(form.microsoft_email)) {
      setError('A valid Microsoft email is required for user enrollment');
      return;
    }
    if (!authKey) {
      setError('An Authorization Key must be configured before adding users. Click Generate below.');
      return;
    }

    setLoading(true);

    // Check for duplicate microsoft_email
    const { data: existing } = await supabase
      .from('profiles')
      .select('id, full_name')
      .eq('microsoft_email', form.microsoft_email)
      .eq('org_id', profile.org_id)
      .limit(1);

    if (existing && existing.length > 0) {
      setError(`A user with Microsoft email ${form.microsoft_email} already exists (${existing[0].full_name}).`);
      setLoading(false);
      return;
    }

    const { data: inserted, error: insertError } = await supabase
      .from('profiles')
      .insert({
        org_id: profile.org_id,
        full_name: form.full_name,
        email: form.microsoft_email,
        microsoft_email: form.microsoft_email,
        role: 'user',
      })
      .select('id, full_name, microsoft_email')
      .single();

    setLoading(false);

    if (insertError) {
      setError(insertError.message);
      return;
    }

    setCreatedUser(inserted);
    setShowSuccess(true);
  }

  if (showSuccess && createdUser) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
        <div className="bg-white dark:bg-gray-800 rounded-xl shadow-xl w-full max-w-md mx-4">
          <div className="flex items-center justify-between p-4 border-b dark:border-gray-700">
            <h3 className="text-lg font-semibold text-green-600 dark:text-green-400">User Created</h3>
            <button onClick={() => { onAdded(); }} className="p-1 rounded-md hover:bg-gray-100 dark:hover:bg-gray-700">
              <X className="h-5 w-5" />
            </button>
          </div>
          <div className="p-5 space-y-4">
            <p className="text-sm text-gray-700 dark:text-gray-300">
              <strong>{createdUser.full_name}</strong> has been added. Share the following with the user to complete their setup:
            </p>

            <div className="bg-gray-50 dark:bg-gray-700/50 rounded-lg p-4 space-y-3">
              <div>
                <span className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">Authorization Key</span>
                <div className="flex items-center gap-2 mt-1">
                  <code className="flex-1 text-sm font-mono bg-white dark:bg-gray-800 px-3 py-1.5 rounded border dark:border-gray-600">{authKey}</code>
                  <button onClick={handleCopy} className="p-1.5 rounded hover:bg-gray-200 dark:hover:bg-gray-600">
                    {copied ? <Check className="h-4 w-4 text-green-500" /> : <Copy className="h-4 w-4 text-gray-400" />}
                  </button>
                </div>
              </div>
              <div>
                <span className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">Microsoft Login Email</span>
                <p className="text-sm font-medium mt-1">{createdUser.microsoft_email}</p>
              </div>
            </div>

            <div className="p-3 rounded-lg bg-blue-50 dark:bg-blue-900/20 text-blue-700 dark:text-blue-400 text-xs">
              The user should: 1) Open MeetChamp agent, 2) Enter the Authorization Key, 3) Sign in with their Microsoft account ({createdUser.microsoft_email}), 4) Complete their profile.
            </div>

            <button
              onClick={() => { onAdded(); }}
              className="w-full px-4 py-2 bg-brand-600 text-white rounded-lg hover:bg-brand-700 text-sm font-medium"
            >
              Done
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-white dark:bg-gray-800 rounded-xl shadow-xl w-full max-w-md mx-4">
        <div className="flex items-center justify-between p-4 border-b dark:border-gray-700">
          <h3 className="text-lg font-semibold text-gray-900 dark:text-white">Add User</h3>
          <button onClick={onClose} className="p-1 rounded-md hover:bg-gray-100 dark:hover:bg-gray-700">
            <X className="h-5 w-5" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-4 space-y-4">
          {error && (
            <div className="p-3 rounded-lg bg-red-50 text-red-700 text-sm dark:bg-red-900/30 dark:text-red-400">
              {error}
            </div>
          )}

          {/* Authorization Key section */}
          <div className="p-3 rounded-lg bg-gray-50 dark:bg-gray-700/50 space-y-2">
            <div className="flex items-center gap-2">
              <Key className="h-4 w-4 text-brand-600" />
              <span className="text-sm font-medium text-gray-700 dark:text-gray-300">Authorization Key</span>
            </div>
            {authKeyLoading ? (
              <Loader2 className="h-4 w-4 animate-spin text-gray-400" />
            ) : authKey ? (
              <div className="flex items-center gap-2">
                <code className="flex-1 text-xs font-mono bg-white dark:bg-gray-800 px-2 py-1 rounded border dark:border-gray-600">{authKey}</code>
                <button type="button" onClick={handleCopy} className="p-1 rounded hover:bg-gray-200 dark:hover:bg-gray-600">
                  {copied ? <Check className="h-3.5 w-3.5 text-green-500" /> : <Copy className="h-3.5 w-3.5 text-gray-400" />}
                </button>
              </div>
            ) : (
              <div className="space-y-1">
                <p className="text-xs text-amber-600 dark:text-amber-400">No key configured. Generate one to allow user enrollment.</p>
                <button
                  type="button"
                  onClick={() => handleSetKey(generateKey())}
                  className="flex items-center gap-1 text-xs px-2 py-1 bg-brand-600 text-white rounded hover:bg-brand-700"
                >
                  <RefreshCw className="h-3 w-3" /> Generate Key
                </button>
              </div>
            )}
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Microsoft Email *</label>
            <input
              type="email"
              value={form.microsoft_email}
              onChange={(e) => setForm({ ...form, microsoft_email: e.target.value })}
              className="w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-brand-500 dark:bg-gray-700 dark:border-gray-600 dark:text-white"
              placeholder="user@company.com (must match their Microsoft account)"
              required
            />
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">The user must sign in with this exact Microsoft email during enrollment.</p>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Display Name *</label>
            <input
              type="text"
              value={form.full_name}
              onChange={(e) => setForm({ ...form, full_name: e.target.value })}
              className="w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-brand-500 dark:bg-gray-700 dark:border-gray-600 dark:text-white"
              placeholder="Placeholder name (user updates during enrollment)"
              required
            />
          </div>

          <div className="flex justify-end gap-3 pt-2">
            <button type="button" onClick={onClose} className="px-4 py-2 text-sm text-gray-600 hover:bg-gray-100 rounded-lg dark:text-gray-300 dark:hover:bg-gray-700">
              Cancel
            </button>
            <button
              type="submit"
              disabled={loading}
              className="flex items-center gap-2 px-4 py-2 bg-brand-600 text-white rounded-lg hover:bg-brand-700 disabled:opacity-50 text-sm font-medium"
            >
              {loading && <Loader2 className="h-4 w-4 animate-spin" />}
              Add User
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

export default AddUserModal;
