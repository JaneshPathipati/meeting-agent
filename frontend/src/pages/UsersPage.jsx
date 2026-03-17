// file: frontend/src/pages/UsersPage.jsx
import React from 'react';
import UsersList from '../components/admin/UsersList';
import ErrorBoundary from '../components/shared/ErrorBoundary';

function UsersPage() {
  return (
    <ErrorBoundary>
      <UsersList />
    </ErrorBoundary>
  );
}

export default UsersPage;
