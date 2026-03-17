// file: frontend/src/pages/DashboardPage.jsx
import React from 'react';
import Overview from '../components/admin/Overview';
import ErrorBoundary from '../components/shared/ErrorBoundary';

function DashboardPage() {
  return (
    <ErrorBoundary>
      <Overview />
    </ErrorBoundary>
  );
}

export default DashboardPage;
