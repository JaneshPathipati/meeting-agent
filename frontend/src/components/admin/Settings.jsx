// file: frontend/src/components/admin/Settings.jsx
import React, { useState, useEffect, useRef, useMemo } from 'react';
import { supabase } from '../../lib/supabase';
import { useAuth } from '../../hooks/useAuth';
import { Key, Copy, RefreshCw, Check, Loader2, Building2, Mail, FileText, ToggleLeft, ToggleRight, Shield, X } from 'lucide-react';
import DangerZone from './DangerZone';

function ToggleSwitch({ enabled, onChange, disabled, label, description }) {
  return (
    <div className={`flex items-center justify-between py-2 ${disabled ? 'opacity-50' : ''}`}>
      <div>
        <p className="text-sm font-medium text-gray-700 dark:text-gray-300">{label}</p>
        {description && <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">{description}</p>}
      </div>
      <button
        onClick={() => !disabled && onChange(!enabled)}
        disabled={disabled}
        className="relative"
      >
        {enabled ? (
          <ToggleRight className="h-8 w-8 text-brand-600" />
        ) : (
          <ToggleLeft className="h-8 w-8 text-gray-400" />
        )}
      </button>
    </div>
  );
}

function generateKey() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let key = '';
  for (let i = 0; i < 16; i++) {
    if (i > 0 && i % 4 === 0) key += '-';
    key += chars[Math.floor(Math.random() * chars.length)];
  }
  return key;
}

function Settings() {
  const { profile } = useAuth();
  const [org, setOrg] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [copied, setCopied] = useState(false);
  const [orgName, setOrgName] = useState('');
  const [authKey, setAuthKey] = useState('');
  const [senderEmail, setSenderEmail] = useState('');
  const [summariesEnabled, setSummariesEnabled] = useState(true);
  const [emailsEnabled, setEmailsEnabled] = useState(true);
  const [minDuration, setMinDuration] = useState(120);
  const [exclusionKeywords, setExclusionKeywords] = useState([]);
  const [newKeyword, setNewKeyword] = useState('');
  const [saveMsg, setSaveMsg] = useState('');
  const savedValues = useRef({ orgName: '', authKey: '', senderEmail: '', summariesEnabled: true, emailsEnabled: true, minDuration: 120, exclusionKeywords: [] });

  const hasChanges = useMemo(() => {
    const s = savedValues.current;
    return orgName !== s.orgName
      || authKey !== s.authKey
      || senderEmail !== s.senderEmail
      || summariesEnabled !== s.summariesEnabled
      || emailsEnabled !== s.emailsEnabled
      || minDuration !== s.minDuration
      || JSON.stringify(exclusionKeywords) !== JSON.stringify(s.exclusionKeywords);
  }, [orgName, authKey, senderEmail, summariesEnabled, emailsEnabled, minDuration, exclusionKeywords]);

  useEffect(() => {
    fetchOrg();
  }, []);

  async function fetchOrg() {
    if (!profile?.org_id) return;
    setLoading(true);
    const { data, error } = await supabase
      .from('organizations')
      .select('*')
      .eq('id', profile.org_id)
      .single();

    if (!error && data) {
      setOrg(data);
      setOrgName(data.name);
      setAuthKey(data.authorization_key || '');
      setSenderEmail(data.sender_email || '');
      setSummariesEnabled(data.summaries_enabled !== false);
      setEmailsEnabled(data.emails_enabled !== false);
      setMinDuration(data.min_meeting_duration_seconds ?? 120);
      setExclusionKeywords(data.exclusion_keywords || []);
      savedValues.current = {
        orgName: data.name,
        authKey: data.authorization_key || '',
        senderEmail: data.sender_email || '',
        summariesEnabled: data.summaries_enabled !== false,
        emailsEnabled: data.emails_enabled !== false,
        minDuration: data.min_meeting_duration_seconds ?? 120,
        exclusionKeywords: data.exclusion_keywords || [],
      };
    }
    setLoading(false);
  }

  async function handleSave() {
    setSaving(true);
    setSaveMsg('');
    const { data, error } = await supabase
      .from('organizations')
      .update({
        name: orgName,
        authorization_key: authKey || null,
        sender_email: senderEmail || null,
        summaries_enabled: summariesEnabled,
        emails_enabled: summariesEnabled ? emailsEnabled : false,
        emails_enabled_before_off: emailsEnabled,
        min_meeting_duration_seconds: Math.max(30, Math.min(3600, Number(minDuration) || 120)),
        exclusion_keywords: exclusionKeywords,
      })
      .eq('id', profile.org_id)
      .select();

    setSaving(false);
    if (error) {
      setSaveMsg('Failed to save: ' + error.message);
    } else if (!data || data.length === 0) {
      setSaveMsg('Failed to save: no rows updated');
    } else {
      const d = data[0];
      setOrg(d);
      setOrgName(d.name);
      setAuthKey(d.authorization_key || '');
      setSenderEmail(d.sender_email || '');
      setSummariesEnabled(d.summaries_enabled !== false);
      setEmailsEnabled(d.emails_enabled !== false);
      setMinDuration(d.min_meeting_duration_seconds ?? 120);
      setExclusionKeywords(d.exclusion_keywords || []);
      savedValues.current = {
        orgName: d.name,
        authKey: d.authorization_key || '',
        senderEmail: d.sender_email || '',
        summariesEnabled: d.summaries_enabled !== false,
        emailsEnabled: d.emails_enabled !== false,
        minDuration: d.min_meeting_duration_seconds ?? 120,
        exclusionKeywords: d.exclusion_keywords || [],
      };
      setSaveMsg('Settings saved successfully');
      setTimeout(() => setSaveMsg(''), 3000);
    }
  }

  function handleGenerateKey() {
    setAuthKey(generateKey());
  }

  function formatAuthKey(raw) {
    // Strip non-alphanumeric, uppercase, insert hyphens every 4 chars
    const clean = raw.replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 16);
    return clean.replace(/(.{4})(?=.)/g, '$1-');
  }

  function handleAuthKeyChange(e) {
    setAuthKey(formatAuthKey(e.target.value));
  }

  function handleCopyKey() {
    // Copy the raw key value (with hyphens as displayed)
    navigator.clipboard.writeText(authKey);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-8 w-8 animate-spin text-brand-600" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <h2 className="text-2xl font-bold text-gray-900 dark:text-white">Settings</h2>

      {/* One card — all sections separated by dividers */}
      <div className="bg-white dark:bg-gray-800 rounded-xl border dark:border-gray-700 divide-y dark:divide-gray-700">

        {/* ── Organization ── */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 p-6">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <Building2 className="h-4 w-4 text-brand-500" />
              <h3 className="text-sm font-semibold text-gray-900 dark:text-white">Organization</h3>
            </div>
            <p className="text-xs text-gray-500 dark:text-gray-400">
              Your organization display name shown across the dashboard.
            </p>
          </div>
          <div className="md:col-span-2">
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              Organization Name
            </label>
            <input
              type="text"
              value={orgName}
              onChange={(e) => setOrgName(e.target.value)}
              className="w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-brand-500 dark:bg-gray-700 dark:border-gray-600 dark:text-white"
            />
          </div>
        </div>

        {/* ── Authorization Key ── */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 p-6">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <Key className="h-4 w-4 text-brand-500" />
              <h3 className="text-sm font-semibold text-gray-900 dark:text-white">Authorization Key</h3>
            </div>
            <p className="text-xs text-gray-500 dark:text-gray-400">
              Employees enter this key when enrolling the agent on their machine. Share it securely.
            </p>
          </div>
          <div className="md:col-span-2 space-y-3">
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={authKey}
                onChange={handleAuthKeyChange}
                placeholder="No key configured — click Generate"
                maxLength={19}
                className="flex-1 px-3 py-2 border rounded-lg font-mono text-sm tracking-wider focus:ring-2 focus:ring-brand-500 dark:bg-gray-700 dark:border-gray-600 dark:text-white"
              />
              <button
                onClick={handleCopyKey}
                disabled={!authKey}
                className="p-2 rounded-lg border hover:bg-gray-50 dark:hover:bg-gray-700 dark:border-gray-600 disabled:opacity-40"
                title="Copy to clipboard"
              >
                {copied ? <Check className="h-4 w-4 text-green-500" /> : <Copy className="h-4 w-4 text-gray-500" />}
              </button>
              <button
                onClick={handleGenerateKey}
                className="flex items-center gap-1.5 px-3 py-2 rounded-lg border hover:bg-gray-50 dark:hover:bg-gray-700 dark:border-gray-600 text-sm font-medium"
                title="Generate new key"
              >
                <RefreshCw className="h-4 w-4" />
                Generate
              </button>
            </div>
            <div className="p-3 rounded-lg bg-amber-50 dark:bg-amber-900/20 text-amber-700 dark:text-amber-400 text-xs">
              <strong>Note:</strong> Changing the key will not affect already-enrolled users. Only new enrollments require the current key.
            </div>
          </div>
        </div>

        {/* ── Processing ── */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 p-6">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <FileText className="h-4 w-4 text-brand-500" />
              <h3 className="text-sm font-semibold text-gray-900 dark:text-white">Processing</h3>
            </div>
            <p className="text-xs text-gray-500 dark:text-gray-400">
              Control AI summaries and email notifications org-wide. Can also be set per-user in the Users tab.
            </p>
          </div>
          <div className="md:col-span-2 space-y-3">
            <div className="border dark:border-gray-700 rounded-lg p-4 space-y-1">
              <ToggleSwitch
                enabled={summariesEnabled}
                onChange={(val) => {
                  setSummariesEnabled(val);
                  if (!val) {
                    setEmailsEnabled(false);
                  } else {
                    setEmailsEnabled(org?.emails_enabled_before_off !== false);
                  }
                }}
                label="Generate Summaries"
                description="When off, meetings are still recorded and transcribed but no AI summary or tone analysis is generated"
              />
              <div className={`ml-6 border-l-2 pl-4 ${summariesEnabled ? 'border-brand-200 dark:border-brand-800' : 'border-gray-200 dark:border-gray-700'}`}>
                <ToggleSwitch
                  enabled={emailsEnabled}
                  onChange={setEmailsEnabled}
                  disabled={!summariesEnabled}
                  label="Send Email Notifications"
                  description={!summariesEnabled ? 'Requires summaries to be enabled' : 'Send summary email to employees after each meeting is processed'}
                />
              </div>
            </div>
            {!summariesEnabled && (
              <div className="p-3 rounded-lg bg-amber-50 dark:bg-amber-900/20 text-amber-700 dark:text-amber-400 text-xs">
                <strong>Note:</strong> Summaries are disabled. Meetings will still be recorded and transcribed, but no AI analysis will be generated.
              </div>
            )}
          </div>
        </div>

        {/* ── Email Configuration ── */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 p-6">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <Mail className="h-4 w-4 text-brand-500" />
              <h3 className="text-sm font-semibold text-gray-900 dark:text-white">Email Configuration</h3>
            </div>
            <p className="text-xs text-gray-500 dark:text-gray-400">
              Sender address for summary emails via Microsoft Graph (requires Mail.Send permission in Azure AD).
            </p>
          </div>
          <div className="md:col-span-2 space-y-3">
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                Sender Email Address
              </label>
              <input
                type="email"
                value={senderEmail}
                onChange={(e) => setSenderEmail(e.target.value)}
                placeholder="admin@yourcompany.com"
                className="w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-brand-500 dark:bg-gray-700 dark:border-gray-600 dark:text-white"
              />
            </div>
            <div className="p-3 rounded-lg bg-blue-50 dark:bg-blue-900/20 text-blue-700 dark:text-blue-400 text-xs">
              <strong>Note:</strong> The sender must be a valid mailbox in your Microsoft 365 tenant. Leave blank to disable email notifications.
            </div>
          </div>
        </div>

        {/* ── Recording Rules ── */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 p-6">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <Shield className="h-4 w-4 text-brand-500" />
              <h3 className="text-sm font-semibold text-gray-900 dark:text-white">Recording Rules</h3>
            </div>
            <p className="text-xs text-gray-500 dark:text-gray-400">
              Configure minimum meeting duration and meeting title exclusions. Changes sync to enrolled agents on their next heartbeat.
            </p>
          </div>
          <div className="md:col-span-2 space-y-4">
            {/* Minimum duration */}
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                Minimum Meeting Duration (seconds)
              </label>
              <input
                type="number"
                min="30"
                max="3600"
                value={minDuration}
                onChange={(e) => setMinDuration(Number(e.target.value))}
                className="w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-brand-500 dark:bg-gray-700 dark:border-gray-600 dark:text-white"
              />
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                Meetings shorter than this will not be recorded. Default: 120s (2 min).
              </p>
            </div>

            {/* Exclusion keywords */}
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                Title Exclusion Keywords
              </label>
              <div className="flex gap-2 mb-2">
                <input
                  type="text"
                  value={newKeyword}
                  onChange={(e) => setNewKeyword(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && newKeyword.trim()) {
                      const kw = newKeyword.trim().toLowerCase();
                      if (!exclusionKeywords.includes(kw)) {
                        setExclusionKeywords([...exclusionKeywords, kw]);
                      }
                      setNewKeyword('');
                    }
                  }}
                  placeholder="e.g. 1:1, personal, hr"
                  className="flex-1 px-3 py-2 border rounded-lg focus:ring-2 focus:ring-brand-500 dark:bg-gray-700 dark:border-gray-600 dark:text-white text-sm"
                />
                <button
                  onClick={() => {
                    const kw = newKeyword.trim().toLowerCase();
                    if (kw && !exclusionKeywords.includes(kw)) {
                      setExclusionKeywords([...exclusionKeywords, kw]);
                    }
                    setNewKeyword('');
                  }}
                  className="px-3 py-2 rounded-lg border hover:bg-gray-50 dark:hover:bg-gray-700 dark:border-gray-600 text-sm font-medium"
                >
                  Add
                </button>
              </div>
              {exclusionKeywords.length > 0 ? (
                <div className="flex flex-wrap gap-1.5">
                  {exclusionKeywords.map((kw, i) => (
                    <span key={i} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-300">
                      {kw}
                      <button
                        onClick={() => setExclusionKeywords(exclusionKeywords.filter((_, j) => j !== i))}
                        className="hover:text-red-900 dark:hover:text-red-100"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </span>
                  ))}
                </div>
              ) : (
                <p className="text-xs text-gray-500 dark:text-gray-400">No exclusions set. All meetings will be recorded.</p>
              )}
            </div>
          </div>
        </div>

        {/* ── Save footer ── */}
        <div className="px-6 py-4 flex items-center gap-4">
          <button
            onClick={handleSave}
            disabled={saving || !hasChanges}
            className="flex items-center gap-2 px-5 py-2.5 bg-brand-600 text-white rounded-lg hover:bg-brand-700 disabled:opacity-50 disabled:cursor-not-allowed text-sm font-medium"
          >
            {saving && <Loader2 className="h-4 w-4 animate-spin" />}
            Save Settings
          </button>
          {saveMsg && (
            <span className={`text-sm ${saveMsg.includes('Failed') ? 'text-red-600' : 'text-green-600'}`}>
              {saveMsg}
            </span>
          )}
        </div>

      </div>

      {/* Danger Zone — full width, separate card */}
      <DangerZone />
    </div>
  );
}

export default Settings;
