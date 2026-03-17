// file: frontend/src/components/shared/LoginForm.jsx
import React, { useState } from 'react';
import { useAuth } from '../../hooks/useAuth';
import { isValidEmail } from '../../utils/validation';
import { Loader2 } from 'lucide-react';

function LoginForm() {
  const { login, error: authError } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [rememberMe, setRememberMe] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');

    if (!isValidEmail(email)) {
      setError('Please enter a valid email address');
      return;
    }
    if (password.length < 6) {
      setError('Password must be at least 6 characters');
      return;
    }

    setLoading(true);
    const result = await login(email, password);
    setLoading(false);

    if (!result.success) {
      setError(result.error || 'Login failed');
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      {(error || authError) && (
        <div className="p-3 bg-red-50 border border-red-200 text-red-700 text-sm">
          {error || authError}
        </div>
      )}

      <div>
        <label htmlFor="email" className="block text-sm font-medium text-[#020617] mb-1">
          Email Address
        </label>
        <input
          id="email"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="w-full px-3 py-2.5 bg-white border border-[#E2E8F0] text-[#020617] text-sm focus:outline-none focus:border-[#F97316] focus:ring-1 focus:ring-[#F97316]"
          placeholder="Enter your email"
          required
        />
      </div>

      <div>
        <div className="flex items-center justify-between mb-1">
          <label htmlFor="password" className="block text-sm font-medium text-[#020617]">
            Password
          </label>
          <button
            type="button"
            onClick={() => setError('Password reset is not configured yet. Please contact your administrator.')}
            className="text-xs text-[#64748B] hover:text-[#F97316] transition-colors"
          >
            Forgot?
          </button>
        </div>
        <input
          id="password"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="w-full px-3 py-2.5 bg-white border border-[#E2E8F0] text-[#020617] text-sm focus:outline-none focus:border-[#F97316] focus:ring-1 focus:ring-[#F97316]"
          placeholder="Enter your password"
          required
        />
      </div>

      <div className="flex items-center justify-between gap-4">
        <label className="inline-flex items-center gap-2 text-xs text-[#64748B] select-none">
          <input
            type="checkbox"
            checked={rememberMe}
            onChange={(e) => setRememberMe(e.target.checked)}
            className="h-3.5 w-3.5 bg-white border border-[#CBD5E1] text-[#F97316] focus:ring-[#F97316]"
          />
          Remember me
        </label>
      </div>

      <button
        type="submit"
        disabled={loading}
        className="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-[#F97316] text-white text-sm font-semibold hover:bg-[#EA580C] disabled:opacity-50 transition-colors"
      >
        {loading && <Loader2 className="h-4 w-4 animate-spin" />}
        {loading ? 'Signing in...' : 'Login'}
      </button>
    </form>
  );
}

export default LoginForm;
