// file: frontend/src/components/admin/Settings.jsx
import React, { useState, useEffect, useRef, useMemo } from 'react';
import { supabase } from '../../lib/supabase';
import { useAuth } from '../../hooks/useAuth';
import { Key, Copy, RefreshCw, Check, Loader2, Building2, Save } from 'lucide-react';

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

function formatAuthKey(raw) {
  const clean = raw.replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 16);
  return clean.replace(/(.{4})(?=.)/g, '$1-');
}

function Settings() {
  const { profile } = useAuth();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving]   = useState(false);
  const [copied, setCopied]   = useState(false);
  const [saveMsg, setSaveMsg] = useState('');
  const [orgName, setOrgName] = useState('');
  const [authKey, setAuthKey] = useState('');
  const savedValues = useRef({ orgName: '', authKey: '' });

  const hasChanges = useMemo(
    () => orgName !== savedValues.current.orgName || authKey !== savedValues.current.authKey,
    [orgName, authKey],
  );

  useEffect(() => { fetchOrg(); }, []);

  async function fetchOrg() {
    if (!profile?.org_id) return;
    setLoading(true);
    const { data, error } = await supabase.from('organizations').select('name, authorization_key').eq('id', profile.org_id).single();
    if (!error && data) {
      setOrgName(data.name || '');
      setAuthKey(data.authorization_key || '');
      savedValues.current = { orgName: data.name || '', authKey: data.authorization_key || '' };
    }
    setLoading(false);
  }

  async function handleSave() {
    setSaving(true); setSaveMsg('');
    const { data, error } = await supabase
      .from('organizations')
      .update({ name: orgName, authorization_key: authKey || null })
      .eq('id', profile.org_id)
      .select('name, authorization_key');
    setSaving(false);
    if (error || !data?.length) { setSaveMsg('Failed to save: ' + (error?.message || 'no rows updated')); return; }
    const d = data[0];
    setOrgName(d.name || ''); setAuthKey(d.authorization_key || '');
    savedValues.current = { orgName: d.name || '', authKey: d.authorization_key || '' };
    setSaveMsg('Saved successfully');
    setTimeout(() => setSaveMsg(''), 3000);
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="h-7 w-7 animate-spin text-[#F97316]" />
      </div>
    );
  }

  return (
    <div
      className="space-y-6 animate-page-reveal"
      style={{ fontFamily: 'Onest, ui-sans-serif, system-ui, sans-serif' }}
    >

      {/* ── Page header ─────────────────────────────────────────── */}
      <div className="animate-fade-in">
        <p className="text-[11px] uppercase tracking-[0.34em] text-[#64748B] font-medium">System</p>
        <h2
          className="mt-1 text-[28px] font-semibold tracking-tight text-[#020617] leading-tight"
          style={{ fontFamily: 'Geist, ui-sans-serif, system-ui, sans-serif' }}
        >
          Preferences
        </h2>
      </div>

      {/* ── Settings cards ──────────────────────────────────────── */}
      <div className="max-w-2xl space-y-4">

        {/* Organization */}
        <div
          className="rounded-[20px] overflow-hidden animate-slide-up"
          style={{
            background: 'rgba(255,255,255,0.92)',
            border: '1px solid rgba(226,232,240,0.7)',
            boxShadow: '0 4px 24px rgba(15,23,42,0.07)',
          }}
        >
          {/* Card header */}
          <div
            className="flex items-center gap-3 px-6 py-5"
            style={{ borderBottom: '1px solid rgba(226,232,240,0.7)' }}
          >
            <div
              className="h-9 w-9 rounded-[12px] flex items-center justify-center flex-shrink-0"
              style={{ background: '#FFF7ED', border: '1px solid #FED7AA' }}
            >
              <Building2 className="h-4 w-4 text-[#F97316]" />
            </div>
            <div>
              <h3
                className="text-[15px] font-semibold text-[#020617]"
                style={{ fontFamily: 'Geist, ui-sans-serif, system-ui, sans-serif' }}
              >
                Organization
              </h3>
              <p className="text-[11px] text-[#94A3B8] mt-0.5">Display name shown across the dashboard</p>
            </div>
          </div>

          {/* Card body */}
          <div className="px-6 py-5">
            <label className="block text-[11px] font-semibold uppercase tracking-[0.2em] text-[#94A3B8] mb-2">
              Organization Name
            </label>
            <input
              type="text"
              value={orgName}
              onChange={e => setOrgName(e.target.value)}
              className="w-full px-4 py-3 rounded-[14px] text-[13px] text-[#020617] outline-none transition-all duration-200"
              style={{ background: '#F9F8F6', border: '1.5px solid rgba(226,232,240,0.8)' }}
              onFocus={e => e.currentTarget.style.borderColor = 'rgba(249,115,22,0.5)'}
              onBlur={e => e.currentTarget.style.borderColor = 'rgba(226,232,240,0.8)'}
              placeholder="Your company name"
            />
          </div>
        </div>

        {/* Registration Key */}
        <div
          className="rounded-[20px] overflow-hidden animate-slide-up"
          style={{
            background: 'rgba(255,255,255,0.92)',
            border: '1px solid rgba(226,232,240,0.7)',
            boxShadow: '0 4px 24px rgba(15,23,42,0.07)',
            animationDelay: '60ms',
          }}
        >
          {/* Card header */}
          <div
            className="flex items-center gap-3 px-6 py-5"
            style={{ borderBottom: '1px solid rgba(226,232,240,0.7)' }}
          >
            <div
              className="h-9 w-9 rounded-[12px] flex items-center justify-center flex-shrink-0"
              style={{ background: '#F5F3FF', border: '1px solid #DDD6FE' }}
            >
              <Key className="h-4 w-4 text-[#8B5CF6]" />
            </div>
            <div>
              <h3
                className="text-[15px] font-semibold text-[#020617]"
                style={{ fontFamily: 'Geist, ui-sans-serif, system-ui, sans-serif' }}
              >
                Registration Key
              </h3>
              <p className="text-[11px] text-[#94A3B8] mt-0.5">Share with employees for agent enrollment</p>
            </div>
          </div>

          {/* Card body */}
          <div className="px-6 py-5 space-y-4">
            <div>
              <label className="block text-[11px] font-semibold uppercase tracking-[0.2em] text-[#94A3B8] mb-2">
                Key
              </label>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={authKey}
                  onChange={e => setAuthKey(formatAuthKey(e.target.value))}
                  placeholder="Click Generate to create a key"
                  maxLength={19}
                  className="flex-1 px-4 py-3 rounded-[14px] text-[13px] text-[#020617] outline-none transition-all duration-200 font-mono tracking-wider"
                  style={{ background: '#F9F8F6', border: '1.5px solid rgba(226,232,240,0.8)' }}
                  onFocus={e => e.currentTarget.style.borderColor = 'rgba(139,92,246,0.5)'}
                  onBlur={e => e.currentTarget.style.borderColor = 'rgba(226,232,240,0.8)'}
                />
                <button
                  onClick={() => { navigator.clipboard.writeText(authKey); setCopied(true); setTimeout(() => setCopied(false), 2000); }}
                  disabled={!authKey}
                  className="p-3 rounded-[14px] transition-all hover:scale-105 disabled:opacity-40 disabled:cursor-not-allowed flex-shrink-0"
                  style={{ background: copied ? '#D1FAE5' : '#F9F8F6', border: `1.5px solid ${copied ? '#A7F3D0' : 'rgba(226,232,240,0.8)'}` }}
                  title="Copy to clipboard"
                >
                  {copied
                    ? <Check className="h-4 w-4 text-[#059669]" />
                    : <Copy className="h-4 w-4 text-[#64748B]" />}
                </button>
                <button
                  onClick={() => setAuthKey(generateKey())}
                  className="flex items-center gap-1.5 px-4 py-3 rounded-[14px] text-[12px] font-semibold transition-all hover:scale-[1.02] flex-shrink-0"
                  style={{
                    background: 'linear-gradient(135deg, #8B5CF6 0%, #7C3AED 100%)',
                    color: '#fff',
                    boxShadow: '0 2px 10px rgba(139,92,246,0.35)',
                  }}
                >
                  <RefreshCw className="h-3.5 w-3.5" />
                  Generate
                </button>
              </div>
            </div>

            <div
              className="rounded-[12px] px-4 py-3 text-[11px] leading-relaxed"
              style={{ background: '#FFFBEB', border: '1px solid #FDE68A', color: '#92400E' }}
            >
              Changing the key does not affect already-enrolled users. Only new enrollments require the current key.
            </div>
          </div>
        </div>

      </div>

      {/* ── Save bar ────────────────────────────────────────────── */}
      <div className="flex items-center gap-4 max-w-2xl animate-fade-in" style={{ animationDelay: '120ms' }}>
        <button
          onClick={handleSave}
          disabled={saving || !hasChanges}
          className="flex items-center gap-2 px-6 py-3 text-[13px] font-semibold text-white rounded-[14px] transition-all hover:-translate-y-0.5 disabled:opacity-50 disabled:cursor-not-allowed disabled:transform-none"
          style={{
            background: 'linear-gradient(135deg, #F97316 0%, #DC4F04 100%)',
            boxShadow: hasChanges ? '0 4px 16px rgba(249,115,22,0.35)' : 'none',
          }}
        >
          {saving
            ? <Loader2 className="h-4 w-4 animate-spin" />
            : <Save className="h-4 w-4" />}
          Save Preferences
        </button>
        {saveMsg && (
          <span
            className="text-[13px] font-medium"
            style={{ color: saveMsg.includes('Failed') ? '#DC2626' : '#10B981' }}
          >
            {saveMsg}
          </span>
        )}
      </div>

    </div>
  );
}

export default Settings;
