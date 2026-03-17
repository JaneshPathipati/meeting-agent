// file: frontend/src/pages/SettingsPage.jsx
import React from 'react';
import Settings from '../components/admin/Settings';
import ErrorBoundary from '../components/shared/ErrorBoundary';

function SettingsPage() {
  return (
    <ErrorBoundary>
      <Settings />
    </ErrorBoundary>
  );
}

export default SettingsPage;
