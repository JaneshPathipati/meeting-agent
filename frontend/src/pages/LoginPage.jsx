// file: frontend/src/pages/LoginPage.jsx
import React, { useState } from 'react';
import { Navigate } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';
import LoginForm from '../components/shared/LoginForm';
import AdminSignupForm from '../components/shared/AdminSignupForm';

function LoginPage() {
  const { user, profile, loading } = useAuth();
  const [view, setView] = useState('login'); // 'login' | 'signup'

  if (!loading && user && profile?.role === 'admin') {
    return <Navigate to="/" replace />;
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-gray-900 px-4">
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">MeetChamp</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">Admin Dashboard</p>
        </div>

        <div className="bg-white dark:bg-gray-800 rounded-xl shadow-sm border dark:border-gray-700 p-6">
          {view === 'login' ? (
            <>
              <LoginForm />
              <div className="mt-5 text-center">
                <button
                  type="button"
                  onClick={() => setView('signup')}
                  className="text-sm text-gray-400 dark:text-gray-500 hover:text-brand-600 dark:hover:text-brand-400 transition-colors"
                >
                  Sign up as new admin
                </button>
              </div>
            </>
          ) : (
            <AdminSignupForm
              onSuccess={() => setView('login')}
              onBack={() => setView('login')}
            />
          )}
        </div>
      </div>
    </div>
  );
}

export default LoginPage;
