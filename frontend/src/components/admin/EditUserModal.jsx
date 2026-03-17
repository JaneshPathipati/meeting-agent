// file: frontend/src/components/admin/EditUserModal.jsx
import React, { useState } from 'react';
import { supabase } from '../../lib/supabase';
import { isValidEmail, validateStringLength } from '../../utils/validation';
import { X, Loader2, AlertTriangle } from 'lucide-react';

function EditUserModal({ user, onClose, onUpdated }) {
  const [form, setForm] = useState({
    full_name: user.full_name,
    microsoft_email: user.microsoft_email || '',
    department: user.department || '',
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');

    if (!validateStringLength(form.full_name, 2, 100)) {
      setError('Name must be 2-100 characters');
      return;
    }
    if (!isValidEmail(form.microsoft_email)) {
      setError('Invalid Microsoft email address');
      return;
    }

    setLoading(true);
    const { error: updateError } = await supabase
      .from('profiles')
      .update({
        full_name: form.full_name,
        email: form.microsoft_email,
        microsoft_email: form.microsoft_email,
        department: form.department || null,
      })
      .eq('id', user.id);

    setLoading(false);

    if (updateError) {
      setError(updateError.message);
      return;
    }

    onUpdated();
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-white dark:bg-gray-800 rounded-xl shadow-xl w-full max-w-md mx-4">
        <div className="flex items-center justify-between p-4 border-b dark:border-gray-700">
          <h3 className="text-lg font-semibold text-gray-900 dark:text-white">Edit User</h3>
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

          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Full Name *</label>
            <input
              type="text"
              value={form.full_name}
              onChange={(e) => setForm({ ...form, full_name: e.target.value })}
              className="w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-brand-500 dark:bg-gray-700 dark:border-gray-600 dark:text-white"
              required
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Microsoft Email *</label>
            <input
              type="email"
              value={form.microsoft_email}
              onChange={(e) => setForm({ ...form, microsoft_email: e.target.value })}
              className="w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-brand-500 dark:bg-gray-700 dark:border-gray-600 dark:text-white"
              required
            />
            {form.microsoft_email !== (user.microsoft_email || '') && (
              <div className="flex items-start gap-1.5 mt-1.5 p-2 rounded bg-amber-50 dark:bg-amber-900/20">
                <AlertTriangle className="h-3.5 w-3.5 text-amber-500 mt-0.5 flex-shrink-0" />
                <span className="text-xs text-amber-700 dark:text-amber-400">
                  Changing the Microsoft email will require the user to re-enroll with the new email. Lock out the user first if they are currently active.
                </span>
              </div>
            )}
          </div>

          {user.enrolled_at && (
            <div className="p-2 rounded-lg bg-green-50 dark:bg-green-900/20 text-xs text-green-700 dark:text-green-400">
              Enrolled: {new Date(user.enrolled_at).toLocaleDateString()} &middot; Role: {user.job_role === 'Other' ? user.job_role_custom || 'Other' : user.job_role || 'Not set'}
            </div>
          )}

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
              Save Changes
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

export default EditUserModal;
