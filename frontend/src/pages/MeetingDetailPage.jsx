// file: frontend/src/pages/MeetingDetailPage.jsx
import React from 'react';
import { useParams } from 'react-router-dom';
import MeetingDetail from '../components/admin/MeetingDetail';
import ErrorBoundary from '../components/shared/ErrorBoundary';

function MeetingDetailPage() {
  const { id } = useParams();

  return (
    <ErrorBoundary>
      <MeetingDetail meetingId={id} />
    </ErrorBoundary>
  );
}

export default MeetingDetailPage;
