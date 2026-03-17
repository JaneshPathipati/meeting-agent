// file: frontend/src/pages/LogsPage.jsx
import React from 'react';
import LogsList from '../components/admin/LogsList';
import ErrorBoundary from '../components/shared/ErrorBoundary';

export default function LogsPage() {
  return (
    <ErrorBoundary>
      <LogsList />
    </ErrorBoundary>
  );
}
