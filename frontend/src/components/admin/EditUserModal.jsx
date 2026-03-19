// file: frontend/src/components/admin/EditUserModal.jsx
import React, { useState, useEffect } from 'react';
import ReactDOM from 'react-dom';
import { supabase } from '../../lib/supabase';
import { isValidEmail, validateStringLength } from '../../utils/validation';
import { X, Loader2, AlertTriangle, Pencil, Mail, User, Briefcase, Save } from 'lucide-react';

const inputClass = "w-full px-4 py-3 rounded-[14px] text-[13px] text-[#020617] placeholder-[#C4CADA] outline-none transition-all duration-200";
const inputStyle = { background: '#F9F8F6', border: '1.5px solid rgba(226,232,240,0.8)' };

function EditUserModal({ user, onClose, onUpdated }) {
  const [form, setForm] = useState({
    full_name:       user.full_name,
    microsoft_email: user.microsoft_email || '',
    department:      user.department || '',
  });
  const [loading, setLoading]   = useState(false);
  const [error, setError]       = useState('');
  const [visible, setVisible]   = useState(false);

  useEffect(() => {
    requestAnimationFrame(() => setVisible(true));
  }, []);

  function handleClose() {
    setVisible(false);
    setTimeout(onClose, 280);
  }

  const emailChanged = form.microsoft_email !== (user.microsoft_email || '');

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    if (!validateStringLength(form.full_name, 2, 100)) { setError('Name must be 2–100 characters'); return; }
    if (!isValidEmail(form.microsoft_email)) { setError('Invalid Microsoft email address'); return; }

    setLoading(true);
    const { error: updateError } = await supabase.from('profiles').update({
      full_name: form.full_name, email: form.microsoft_email,
      microsoft_email: form.microsoft_email, department: form.department || null,
    }).eq('id', user.id);
    setLoading(false);
    if (updateError) { setError(updateError.message); return; }
    onUpdated();
  }

  const drawer = (
    <div
      className="fixed inset-0 z-[9999] flex justify-end"
      style={{ fontFamily: 'Onest, ui-sans-serif, system-ui, sans-serif' }}
    >
      {/* Backdrop */}
      <div
        className="absolute inset-0 transition-opacity duration-280"
        style={{ background: 'rgba(2,6,23,0.45)', opacity: visible ? 1 : 0 }}
        onClick={handleClose}
      />

      {/* Panel */}
      <div
        className="relative flex flex-col w-full max-w-[440px] h-full bg-white overflow-y-auto"
        style={{
          transform: visible ? 'translateX(0)' : 'translateX(100%)',
          transition: 'transform 280ms cubic-bezier(0.32,0,0.15,1)',
          boxShadow: '-8px 0 40px rgba(2,6,23,0.14)',
        }}
      >
        {/* Blue header */}
        <div className="relative flex-shrink-0 px-7 pt-8 pb-7"
          style={{ background: 'linear-gradient(160deg, #F8FAFC 0%, #EFF6FF 100%)', borderBottom: '1.5px solid rgba(219,234,254,0.6)' }}>
          <button onClick={handleClose}
            className="absolute right-5 top-5 p-1.5 rounded-full hover:bg-[#DBEAFE] transition-colors">
            <X className="h-4 w-4 text-[#1E40AF]" />
          </button>
          <div className="flex items-center gap-4">
            <div className="h-12 w-12 rounded-[16px] flex items-center justify-center flex-shrink-0"
              style={{ background: 'linear-gradient(135deg, #3B82F6 0%, #1D4ED8 100%)', boxShadow: '0 6px 20px rgba(59,130,246,0.40)' }}>
              <Pencil className="h-5 w-5 text-white" />
            </div>
            <div>
              <h3 className="text-[20px] font-bold text-[#020617]">Edit Member</h3>
              <p className="text-[12px] font-medium mt-0.5" style={{ color: '#2563EB' }}>{user.full_name}</p>
            </div>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="flex flex-col flex-1">
          <div className="flex-1 px-7 py-7 space-y-6">

            {error && (
              <div className="p-3.5 rounded-[12px] text-[12px] leading-relaxed"
                style={{ background: '#FEF2F2', border: '1px solid #FECACA', color: '#DC2626' }}>
                {error}
              </div>
            )}

            {/* Full Name */}
            <div>
              <label className="flex items-center gap-1.5 text-[12px] font-semibold text-[#64748B] mb-2">
                <User className="h-3.5 w-3.5" />Full Name
                <span className="text-[#3B82F6] ml-0.5">*</span>
              </label>
              <input
                type="text"
                value={form.full_name}
                onChange={e => setForm({ ...form, full_name: e.target.value })}
                className={inputClass}
                style={inputStyle}
                required
                onFocus={e => e.currentTarget.style.borderColor = 'rgba(59,130,246,0.55)'}
                onBlur={e => e.currentTarget.style.borderColor = 'rgba(226,232,240,0.8)'}
              />
            </div>

            {/* Microsoft Email */}
            <div>
              <label className="flex items-center gap-1.5 text-[12px] font-semibold text-[#64748B] mb-2">
                <Mail className="h-3.5 w-3.5" />Microsoft Email
                <span className="text-[#3B82F6] ml-0.5">*</span>
              </label>
              <input
                type="email"
                value={form.microsoft_email}
                onChange={e => setForm({ ...form, microsoft_email: e.target.value })}
                className={inputClass}
                style={inputStyle}
                required
                onFocus={e => e.currentTarget.style.borderColor = 'rgba(59,130,246,0.55)'}
                onBlur={e => e.currentTarget.style.borderColor = 'rgba(226,232,240,0.8)'}
              />
              {emailChanged && (
                <div className="flex items-start gap-2 mt-2.5 p-3.5 rounded-[12px]"
                  style={{ background: '#FFFBEB', border: '1px solid #FDE68A' }}>
                  <AlertTriangle className="h-3.5 w-3.5 text-[#D97706] mt-0.5 flex-shrink-0" />
                  <span className="text-[11px] text-[#92400E] leading-relaxed">
                    Changing the Microsoft email requires the user to re-enroll. Lock them out first if currently active.
                  </span>
                </div>
              )}
            </div>

            {/* Enrolled info */}
            {user.enrolled_at && (
              <div className="flex items-center gap-2.5 p-3.5 rounded-[14px]"
                style={{ background: '#F0FDF4', border: '1px solid #BBF7D0' }}>
                <Briefcase className="h-4 w-4 text-[#059669] flex-shrink-0" />
                <span className="text-[12px] text-[#166534]">
                  Enrolled {new Date(user.enrolled_at).toLocaleDateString()} ·{' '}
                  {user.job_role === 'Other' ? user.job_role_custom || 'Other' : user.job_role || 'Role not set'}
                </span>
              </div>
            )}
          </div>

          {/* Sticky footer */}
          <div className="flex-shrink-0 px-7 pb-8 pt-4 space-y-3"
            style={{ borderTop: '1px solid rgba(226,232,240,0.6)' }}>
            <button type="submit" disabled={loading}
              className="w-full flex items-center justify-center gap-2 py-3.5 rounded-[14px] text-[14px] font-semibold text-white transition-all hover:opacity-90 disabled:opacity-60"
              style={{ background: 'linear-gradient(135deg, #3B82F6 0%, #1D4ED8 100%)', boxShadow: '0 4px 16px rgba(59,130,246,0.35)' }}>
              {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
              {loading ? 'Saving…' : 'Save Changes'}
            </button>
            <button type="button" onClick={handleClose}
              className="w-full py-3 rounded-[14px] text-[13px] font-medium text-[#64748B] transition-colors hover:bg-[#F4F2EF]"
              style={{ border: '1.5px solid rgba(226,232,240,0.8)' }}>
              Cancel
            </button>
          </div>
        </form>
      </div>
    </div>
  );

  return ReactDOM.createPortal(drawer, document.body);
}

export default EditUserModal;
