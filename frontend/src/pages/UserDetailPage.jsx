// file: frontend/src/pages/UserDetailPage.jsx
import React from 'react';
import { useParams } from 'react-router-dom';
import UserDetail from '../components/admin/UserDetail';
import ErrorBoundary from '../components/shared/ErrorBoundary';

function UserDetailPage() {
  const { id } = useParams();

  return (
    <ErrorBoundary>
      <UserDetail userId={id} />
    </ErrorBoundary>
  );
}

export default UserDetailPage;
