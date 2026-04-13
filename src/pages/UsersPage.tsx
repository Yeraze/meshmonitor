/**
 * UsersPage — standalone page for user management and permissions.
 *
 * Renders UsersTab outside the source dashboard so admins can manage
 * users and per-source permissions from the main dashboard.
 */

import { useNavigate } from 'react-router-dom';
import { ToastProvider } from '../components/ToastContainer';
import UsersTab from '../components/UsersTab';

function UsersPageInner() {
  const navigate = useNavigate();

  return (
    <div style={{ maxWidth: 1200, margin: '0 auto', padding: '1rem' }}>
      <button
        onClick={() => navigate('/')}
        style={{
          background: 'none',
          border: 'none',
          color: 'var(--accent-color)',
          cursor: 'pointer',
          fontSize: '0.9rem',
          marginBottom: '0.5rem',
          padding: 0,
        }}
      >
        ← Back to Dashboard
      </button>
      <UsersTab />
    </div>
  );
}

export default function UsersPage() {
  return (
    <ToastProvider>
      <UsersPageInner />
    </ToastProvider>
  );
}
