// file: frontend/src/pages/LiveMonitorPage.jsx
import React from 'react';
import LiveMonitor from '../components/admin/LiveMonitor';
import ErrorBoundary from '../components/shared/ErrorBoundary';

export default function LiveMonitorPage() {
  return (
    <ErrorBoundary>
      <LiveMonitor />
    </ErrorBoundary>
  );
}
