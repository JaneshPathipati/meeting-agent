// file: frontend/src/pages/AlertsPage.jsx
import React from 'react';
import ToneAlertDetail from '../components/admin/ToneAlertDetail';
import ErrorBoundary from '../components/shared/ErrorBoundary';

function AlertsPage() {
  return (
    <ErrorBoundary>
      <ToneAlertDetail />
    </ErrorBoundary>
  );
}

export default AlertsPage;
