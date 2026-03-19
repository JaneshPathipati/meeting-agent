// file: frontend/src/components/admin/AddUserModal.jsx
import React, { useState, useEffect } from 'react';
import ReactDOM from 'react-dom';
import { supabase } from '../../lib/supabase';
import { useAuth } from '../../hooks/useAuth';
import { isValidEmail, validateStringLength } from '../../utils/validation';
import { X, Loader2, Copy, Check, Key, RefreshCw, UserPlus, CheckCircle2, Mail, User, ArrowRight } from 'lucide-react';

function generateKey() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const randomBytes = crypto.getRandomValues(new Uint8Array(16));
  let key = '';
  for (let i = 0; i < 16; i++) {
    if (i > 0 && i % 4 === 0) key += '-';
    key += chars[randomBytes[i] % chars.length];
  }
  return key;
}

const inputClass = "w-full px-4 py-3 rounded-[14px] text-[13px] text-[#020617] placeholder-[#C4CADA] outline-none transition-all duration-200";
const inputStyle = { background: '#F9F8F6', border: '1.5px solid rgba(226,232,240,0.8)' };

function AddUserModal({ onClose, onAdded }) {
  const { profile } = useAuth();
  const [form, setForm] = useState({ full_name: '', microsoft_email: '' });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [authKey, setAuthKey] = useState('');
  const [authKeyLoading, setAuthKeyLoading] = useState(true);
  const [copied, setCopied] = useState(false);
  const [showSuccess, setShowSuccess] = useState(false);
  const [createdUser, setCreatedUser] = useState(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    fetchAuthKey();
    // trigger entrance animation
    requestAnimationFrame(() => setVisible(true));
  }, []);

  function handleClose() {
    setVisible(false);
    setTimeout(onClose, 280);
  }

  async function fetchAuthKey() {
    setAuthKeyLoading(true);
    const { data } = await supabase.from('organizations').select('authorization_key').eq('id', profile.org_id).single();
    setAuthKey(data?.authorization_key || '');
    setAuthKeyLoading(false);
  }

  async function handleSetKey(newKey) {
    const { data, error } = await supabase.from('organizations').update({ authorization_key: newKey }).eq('id', profile.org_id).select('authorization_key');
    if (error || !data?.length) { setError('Failed to save key: ' + (error?.message || 'unknown')); return; }
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
    if (!validateStringLength(form.full_name, 2, 100)) { setError('Name must be 2–100 characters'); return; }
    if (!isValidEmail(form.microsoft_email)) { setError('A valid Microsoft email is required for enrollment'); return; }
    if (!authKey) { setError('A Registration Key must be configured. Click Generate below.'); return; }

    setLoading(true);
    const { data: existing } = await supabase.from('profiles').select('id, full_name').eq('microsoft_email', form.microsoft_email).eq('org_id', profile.org_id).limit(1);
    if (existing?.length > 0) { setError(`${form.microsoft_email} already exists (${existing[0].full_name}).`); setLoading(false); return; }

    const { data: inserted, error: insertError } = await supabase.from('profiles').insert({
      org_id: profile.org_id, full_name: form.full_name, email: form.microsoft_email,
      microsoft_email: form.microsoft_email, role: 'user',
    }).select('id, full_name, microsoft_email').single();
    setLoading(false);
    if (insertError) { setError(insertError.message); return; }
    setCreatedUser(inserted);
    setShowSuccess(true);
  }

  /* ── Drawer shell ─────────────────────────────────────────────── */
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
        className="relative flex flex-col w-full max-w-[440px] h-full bg-white shadow-2xl transition-transform duration-280 ease-out overflow-y-auto"
        style={{
          transform: visible ? 'translateX(0)' : 'translateX(100%)',
          boxShadow: '-8px 0 40px rgba(2,6,23,0.14)',
        }}
      >
        {showSuccess && createdUser ? (
          /* ── Success state ─────────────────────────────────────── */
          <>
            {/* Green top strip */}
            <div className="px-7 pt-10 pb-8 text-center flex-shrink-0"
              style={{ background: 'linear-gradient(160deg, #F0FDF4 0%, #DCFCE7 100%)', borderBottom: '1px solid rgba(187,247,208,0.7)' }}>
              <div className="mx-auto mb-5 h-16 w-16 rounded-full flex items-center justify-center"
                style={{ background: 'linear-gradient(135deg, #10B981 0%, #059669 100%)', boxShadow: '0 8px 24px rgba(16,185,129,0.40)' }}>
                <CheckCircle2 className="h-8 w-8 text-white" />
              </div>
              <h3 className="text-[20px] font-bold text-[#020617]">Member Added!</h3>
              <p className="text-[13px] text-[#64748B] mt-1.5">
                <span className="font-semibold text-[#020617]">{createdUser.full_name}</span> has been created.
              </p>
            </div>

            <div className="flex-1 px-7 py-7 space-y-4">
              <p className="text-[11px] uppercase tracking-[0.2em] font-semibold text-[#94A3B8]">Share with the new member</p>

              <div className="rounded-[16px] p-4 space-y-1" style={{ background: '#F9F8F6', border: '1.5px solid rgba(226,232,240,0.8)' }}>
                <p className="text-[10px] uppercase tracking-[0.18em] font-semibold text-[#94A3B8] mb-2">Registration Key</p>
                <div className="flex items-center gap-2">
                  <code className="flex-1 text-[15px] font-mono font-bold tracking-wider text-[#020617]">{authKey}</code>
                  <button onClick={handleCopy}
                    className="flex-shrink-0 p-2 rounded-[10px] transition-all hover:scale-105"
                    style={{ background: copied ? '#D1FAE5' : '#FFEDD5', border: '1px solid ' + (copied ? '#A7F3D0' : '#FED7AA') }}>
                    {copied ? <Check className="h-4 w-4 text-[#059669]" /> : <Copy className="h-4 w-4 text-[#F97316]" />}
                  </button>
                </div>
              </div>

              <div className="rounded-[16px] p-4" style={{ background: '#F9F8F6', border: '1.5px solid rgba(226,232,240,0.8)' }}>
                <p className="text-[10px] uppercase tracking-[0.18em] font-semibold text-[#94A3B8] mb-1.5">Microsoft Login Email</p>
                <p className="text-[13px] font-semibold text-[#020617]">{createdUser.microsoft_email}</p>
              </div>

              <div className="rounded-[14px] p-3.5 text-[12px] leading-relaxed"
                style={{ background: '#EFF6FF', border: '1px solid #BFDBFE', color: '#1D4ED8' }}>
                Open Scriptor agent → enter the key → sign in with Microsoft → complete profile setup.
              </div>
            </div>

            <div className="flex-shrink-0 px-7 pb-8">
              <button onClick={() => onAdded()}
                className="w-full flex items-center justify-center gap-2 py-3.5 rounded-[14px] text-[14px] font-semibold text-white transition-all hover:opacity-90"
                style={{ background: 'linear-gradient(135deg, #F97316 0%, #DC4F04 100%)', boxShadow: '0 4px 16px rgba(249,115,22,0.35)' }}>
                Done <ArrowRight className="h-4 w-4" />
              </button>
            </div>
          </>
        ) : (
          /* ── Form state ────────────────────────────────────────── */
          <>
            {/* Orange header */}
            <div className="relative flex-shrink-0 px-7 pt-8 pb-7"
              style={{ background: 'linear-gradient(160deg, #FFF7ED 0%, #FFEDD5 100%)', borderBottom: '1.5px solid rgba(254,215,170,0.5)' }}>
              <button onClick={handleClose}
                className="absolute right-5 top-5 p-1.5 rounded-full hover:bg-[#FED7AA] transition-colors">
                <X className="h-4 w-4 text-[#9A3412]" />
              </button>
              <div className="flex items-center gap-4">
                <div className="h-12 w-12 rounded-[16px] flex items-center justify-center flex-shrink-0"
                  style={{ background: 'linear-gradient(135deg, #F97316 0%, #DC4F04 100%)', boxShadow: '0 6px 20px rgba(249,115,22,0.40)' }}>
                  <UserPlus className="h-6 w-6 text-white" />
                </div>
                <div>
                  <h3 className="text-[20px] font-bold text-[#020617]">Add Member</h3>
                  <p className="text-[12px] text-[#92400E] mt-0.5">Create a new monitored employee</p>
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

                {/* Auth Key */}
                <div className="rounded-[18px] p-5" style={{ background: '#F9F8F6', border: '1.5px solid rgba(226,232,240,0.8)' }}>
                  <div className="flex items-center gap-2 mb-4">
                    <span className="flex h-7 w-7 items-center justify-center rounded-lg" style={{ background: '#FFEDD5' }}>
                      <Key className="h-3.5 w-3.5 text-[#F97316]" />
                    </span>
                    <span className="text-[13px] font-semibold text-[#020617]">Registration Key</span>
                  </div>
                  {authKeyLoading ? (
                    <div className="flex items-center gap-2">
                      <Loader2 className="h-4 w-4 animate-spin text-[#CBD5E1]" />
                      <span className="text-[12px] text-[#94A3B8]">Loading…</span>
                    </div>
                  ) : authKey ? (
                    <div className="flex items-center gap-2">
                      <code className="flex-1 text-[14px] font-mono font-bold tracking-wider text-[#020617] bg-white px-4 py-2.5 rounded-[12px]"
                        style={{ border: '1.5px solid rgba(226,232,240,0.7)' }}>
                        {authKey}
                      </code>
                      <button type="button" onClick={handleCopy}
                        className="flex-shrink-0 p-2.5 rounded-[12px] transition-all hover:scale-105"
                        style={{ background: copied ? '#D1FAE5' : '#FFEDD5', border: '1px solid ' + (copied ? '#A7F3D0' : '#FED7AA') }}>
                        {copied ? <Check className="h-4 w-4 text-[#059669]" /> : <Copy className="h-4 w-4 text-[#F97316]" />}
                      </button>
                    </div>
                  ) : (
                    <div className="space-y-2">
                      <p className="text-[12px] text-[#D97706]">No key set. Generate one to allow enrollment.</p>
                      <button type="button" onClick={() => handleSetKey(generateKey())}
                        className="flex items-center gap-1.5 px-3.5 py-2 rounded-[10px] text-[12px] font-semibold text-white"
                        style={{ background: 'linear-gradient(135deg, #F97316 0%, #DC4F04 100%)' }}>
                        <RefreshCw className="h-3.5 w-3.5" />Generate Key
                      </button>
                    </div>
                  )}
                </div>

                {/* Microsoft Email */}
                <div>
                  <label className="flex items-center gap-1.5 text-[12px] font-semibold text-[#64748B] mb-2">
                    <Mail className="h-3.5 w-3.5" />Microsoft Email
                    <span className="text-[#F97316] ml-0.5">*</span>
                  </label>
                  <input
                    type="email"
                    value={form.microsoft_email}
                    onChange={e => setForm({ ...form, microsoft_email: e.target.value })}
                    className={inputClass}
                    style={inputStyle}
                    placeholder="user@company.com"
                    required
                    onFocus={e => e.currentTarget.style.borderColor = 'rgba(249,115,22,0.55)'}
                    onBlur={e => e.currentTarget.style.borderColor = 'rgba(226,232,240,0.8)'}
                  />
                  <p className="text-[11px] text-[#94A3B8] mt-1.5">Must match their Microsoft account exactly.</p>
                </div>

                {/* Display Name */}
                <div>
                  <label className="flex items-center gap-1.5 text-[12px] font-semibold text-[#64748B] mb-2">
                    <User className="h-3.5 w-3.5" />Display Name
                    <span className="text-[#F97316] ml-0.5">*</span>
                  </label>
                  <input
                    type="text"
                    value={form.full_name}
                    onChange={e => setForm({ ...form, full_name: e.target.value })}
                    className={inputClass}
                    style={inputStyle}
                    placeholder="Placeholder name (updated during enrollment)"
                    required
                    onFocus={e => e.currentTarget.style.borderColor = 'rgba(249,115,22,0.55)'}
                    onBlur={e => e.currentTarget.style.borderColor = 'rgba(226,232,240,0.8)'}
                  />
                </div>
              </div>

              {/* Sticky footer */}
              <div className="flex-shrink-0 px-7 pb-8 pt-4 space-y-3"
                style={{ borderTop: '1px solid rgba(226,232,240,0.6)' }}>
                <button type="submit" disabled={loading}
                  className="w-full flex items-center justify-center gap-2 py-3.5 rounded-[14px] text-[14px] font-semibold text-white transition-all hover:opacity-90 disabled:opacity-60"
                  style={{ background: 'linear-gradient(135deg, #F97316 0%, #DC4F04 100%)', boxShadow: '0 4px 16px rgba(249,115,22,0.35)' }}>
                  {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <UserPlus className="h-4 w-4" />}
                  {loading ? 'Adding…' : 'Add Member'}
                </button>
                <button type="button" onClick={handleClose}
                  className="w-full py-3 rounded-[14px] text-[13px] font-medium text-[#64748B] transition-colors hover:bg-[#F4F2EF]"
                  style={{ border: '1.5px solid rgba(226,232,240,0.8)' }}>
                  Cancel
                </button>
              </div>
            </form>
          </>
        )}
      </div>
    </div>
  );

  return ReactDOM.createPortal(drawer, document.body);
}

export default AddUserModal;
