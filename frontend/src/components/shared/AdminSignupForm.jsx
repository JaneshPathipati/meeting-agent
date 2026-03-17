// file: frontend/src/components/shared/AdminSignupForm.jsx
import React, { useState } from 'react';
import { supabase } from '../../lib/supabase';
import { Loader2, Eye, EyeOff, ArrowLeft, CheckCircle } from 'lucide-react';

function formatCode(raw) {
  const clean = raw.replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 12);
  if (clean.length <= 4) return clean;
  if (clean.length <= 8) return clean.slice(0, 4) + '-' + clean.slice(4);
  return clean.slice(0, 4) + '-' + clean.slice(4, 8) + '-' + clean.slice(8);
}

function AdminSignupForm({ onSuccess, onBack }) {
  const [step, setStep] = useState('code'); // 'code' | 'creds'
  const [code, setCode] = useState('');
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  // Step 1: verify code without consuming it
  async function handleVerifyCode(e) {
    e.preventDefault();
    setError('');
    if (code.replace(/-/g, '').length < 12) {
      setError('Please enter a complete 12-character invite code.');
      return;
    }
    setLoading(true);
    const { error: rpcError } = await supabase.rpc('check_admin_invite_code', {
      p_code: code.replace(/-/g, ''),
    });
    setLoading(false);
    if (rpcError) {
      setError(rpcError.message);
      return;
    }
    setStep('creds');
  }

  // Step 2: create account
  async function handleCreateAccount(e) {
    e.preventDefault();
    setError('');
    if (fullName.trim().length < 2) {
      setError('Please enter your full name.');
      return;
    }
    if (password.length < 8) {
      setError('Password must be at least 8 characters.');
      return;
    }
    if (password !== confirmPassword) {
      setError('Passwords do not match.');
      return;
    }
    setLoading(true);
    const { error: rpcError } = await supabase.rpc('redeem_admin_invite', {
      p_code: code.replace(/-/g, ''),
      p_email: email.trim(),
      p_password: password,
      p_full_name: fullName.trim(),
    });
    if (rpcError) {
      setLoading(false);
      setError(rpcError.message);
      return;
    }

    // Auto sign-in with the credentials they just set
    const { error: signInError } = await supabase.auth.signInWithPassword({
      email: email.trim(),
      password,
    });
    setLoading(false);
    if (signInError) {
      setError('Account created but sign-in failed. Please log in manually.');
    } else {
      onSuccess?.();
    }
  }

  function handleBack() {
    setError('');
    if (step === 'creds') {
      setStep('code');
    } else {
      onBack?.();
    }
  }

  return (
    <div>
      {/* Header with back button */}
      <div className="flex items-center gap-2 mb-5">
        <button
          type="button"
          onClick={handleBack}
          className="p-1 rounded-md text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
        >
          <ArrowLeft className="h-4 w-4" />
        </button>
        <div>
          <h2 className="text-sm font-semibold text-gray-900 dark:text-white">
            Sign up as new admin
          </h2>
          <p className="text-xs text-gray-400">
            {step === 'code' ? 'Enter your invite code to get started' : 'Set up your login credentials'}
          </p>
        </div>
        {/* Step indicator */}
        <div className="ml-auto flex items-center gap-1.5">
          <span className={`h-1.5 w-5 rounded-full transition-colors ${step === 'code' ? 'bg-brand-500' : 'bg-brand-500'}`} />
          <span className={`h-1.5 w-5 rounded-full transition-colors ${step === 'creds' ? 'bg-brand-500' : 'bg-gray-200 dark:bg-gray-600'}`} />
        </div>
      </div>

      {error && (
        <div className="mb-4 p-3 rounded-lg bg-red-50 text-red-700 text-sm dark:bg-red-900/30 dark:text-red-400">
          {error}
        </div>
      )}

      {/* Step 1: Code verification */}
      {step === 'code' && (
        <form onSubmit={handleVerifyCode} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              Invite Code
            </label>
            <input
              type="text"
              value={code}
              onChange={(e) => setCode(formatCode(e.target.value))}
              placeholder="XXXX-XXXX-XXXX"
              maxLength={14}
              autoFocus
              required
              className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg font-mono tracking-widest text-center text-lg focus:ring-2 focus:ring-brand-500 focus:border-brand-500 dark:bg-gray-700 dark:text-white"
            />
            <p className="text-xs text-gray-400 mt-1">
              Enter the code provided by your administrator.
            </p>
          </div>
          <button
            type="submit"
            disabled={loading || code.replace(/-/g, '').length < 12}
            className="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-brand-600 text-white rounded-lg hover:bg-brand-700 disabled:opacity-50 disabled:cursor-not-allowed font-medium transition-colors"
          >
            {loading && <Loader2 className="h-4 w-4 animate-spin" />}
            {loading ? 'Verifying...' : 'Verify Code'}
          </button>
        </form>
      )}

      {/* Step 2: Credentials */}
      {step === 'creds' && (
        <form onSubmit={handleCreateAccount} className="space-y-4">
          {/* Verified code badge */}
          <div className="flex items-center gap-2 px-3 py-2 bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 rounded-lg">
            <CheckCircle className="h-4 w-4 text-green-600 dark:text-green-400 flex-shrink-0" />
            <span className="text-xs text-green-700 dark:text-green-400 font-mono">{code}</span>
            <span className="text-xs text-green-600 dark:text-green-400 ml-auto">Code verified</span>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              Full Name
            </label>
            <input
              type="text"
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              placeholder="John Doe"
              autoFocus
              required
              className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg focus:ring-2 focus:ring-brand-500 focus:border-brand-500 dark:bg-gray-700 dark:text-white"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              Email Address
            </label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@company.com"
              required
              className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg focus:ring-2 focus:ring-brand-500 focus:border-brand-500 dark:bg-gray-700 dark:text-white"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              Password
            </label>
            <div className="relative">
              <input
                type={showPw ? 'text' : 'password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Minimum 8 characters"
                required
                minLength={8}
                className="w-full px-3 py-2 pr-10 border border-gray-300 dark:border-gray-600 rounded-lg focus:ring-2 focus:ring-brand-500 focus:border-brand-500 dark:bg-gray-700 dark:text-white"
              />
              <button
                type="button"
                onClick={() => setShowPw(!showPw)}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
              >
                {showPw ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              Confirm Password
            </label>
            <input
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              placeholder="Re-enter password"
              required
              className={`w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-brand-500 focus:border-brand-500 dark:bg-gray-700 dark:text-white ${
                confirmPassword && password !== confirmPassword
                  ? 'border-red-400 dark:border-red-600'
                  : 'border-gray-300 dark:border-gray-600'
              }`}
            />
            {confirmPassword && password !== confirmPassword && (
              <p className="text-xs text-red-500 mt-1">Passwords do not match</p>
            )}
          </div>

          <button
            type="submit"
            disabled={loading || password !== confirmPassword || password.length < 8}
            className="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-brand-600 text-white rounded-lg hover:bg-brand-700 disabled:opacity-50 disabled:cursor-not-allowed font-medium transition-colors"
          >
            {loading && <Loader2 className="h-4 w-4 animate-spin" />}
            {loading ? 'Creating account...' : 'Create Admin Account'}
          </button>
        </form>
      )}
    </div>
  );
}

export default AdminSignupForm;
