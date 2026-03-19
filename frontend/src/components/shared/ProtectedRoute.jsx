// file: frontend/src/components/shared/ProtectedRoute.jsx
import React from 'react';
import { Navigate, Outlet } from 'react-router-dom';
import { useAuth } from '../../hooks/useAuth';
import TopNav from './TopNav';

function ProtectedRoute() {
  const { user, profile, loading } = useAuth();

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-gradient-to-br from-[#FFF3E8] to-white">
        <div className="flex flex-col items-center gap-3">
          <div className="h-10 w-10 border-2 border-[#E2E8F0] border-t-[#F97316] rounded-full animate-spin" />
          <p className="text-[12px] uppercase tracking-[0.2em] text-[#94A3B8]">Loading…</p>
        </div>
      </div>
    );
  }

  if (!user || !profile) return <Navigate to="/login" replace />;
  if (profile.role !== 'admin') return <Navigate to="/login" replace />;

  return (
    <div className="flex flex-col h-screen overflow-hidden" style={{ background: '#F4F2EF' }}>
      <TopNav />
      <main className="flex-1 overflow-y-auto">
        <div className="max-w-6xl mx-auto p-5 lg:p-8 space-y-6">
          <Outlet />
        </div>
      </main>
    </div>
  );
}

export default ProtectedRoute;
