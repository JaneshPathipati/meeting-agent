// file: frontend/src/pages/MeetingsPage.jsx
import React from 'react';
import MeetingsList from '../components/admin/MeetingsList';
import ErrorBoundary from '../components/shared/ErrorBoundary';

function MeetingsPage() {
  return (
    <ErrorBoundary>
      <MeetingsList />
    </ErrorBoundary>
  );
}

export default MeetingsPage;
