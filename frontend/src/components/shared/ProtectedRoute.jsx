// file: frontend/src/components/shared/ProtectedRoute.jsx
import React, { useState } from 'react';
import { Navigate, Outlet } from 'react-router-dom';
import { useAuth } from '../../hooks/useAuth';
import Navbar from './Navbar';
import Sidebar from './Sidebar';
import LoadingSpinner from './LoadingSpinner';

function ProtectedRoute() {
  const { user, profile, loading } = useAuth();
  const [sidebarOpen, setSidebarOpen] = useState(false);

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-gradient-to-br from-[#FFF3E8] to-white">
        <div className="flex flex-col items-center gap-3">
          <div
            className="h-10 w-10 border-2 border-[#E2E8F0] border-t-[#F97316] rounded-full animate-spin"
          />
          <p className="text-[12px] uppercase tracking-[0.2em] text-[#94A3B8]">Loading…</p>
        </div>
      </div>
    );
  }

  if (!user || !profile) return <Navigate to="/login" replace />;
  if (profile.role !== 'admin') return <Navigate to="/login" replace />;

  return (
    <div
      className="flex h-screen overflow-hidden"
      style={{
        background:
          'radial-gradient(circle at top left, #FFF3E8 0%, #FFFFFF 45%, #E5F0FF 85%)',
      }}
    >
      <Sidebar isOpen={sidebarOpen} onClose={() => setSidebarOpen(false)} />
      <div className="flex-1 flex flex-col overflow-hidden min-w-0 p-3 pl-0 gap-3">
        <Navbar onToggleSidebar={() => setSidebarOpen(!sidebarOpen)} />
        <main className="flex-1 overflow-y-auto rounded-2xl float-panel">
          <div className="max-w-6xl mx-auto p-5 lg:p-8 space-y-6">
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  );
}

export default ProtectedRoute;
