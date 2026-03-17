// file: frontend/src/pages/AnalyticsPage.jsx
import React from 'react';
import Analytics from '../components/admin/Analytics';
import ErrorBoundary from '../components/shared/ErrorBoundary';

function AnalyticsPage() {
  return (
    <ErrorBoundary>
      <Analytics />
    </ErrorBoundary>
  );
}

export default AnalyticsPage;
