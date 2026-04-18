/**
 * UsersPage — standalone page for user management and permissions.
 *
 * Renders UsersTab outside the source dashboard so admins can manage
 * users and per-source permissions from the main dashboard.
 */

import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ToastProvider } from '../components/ToastContainer';
import UsersTab from '../components/UsersTab';

function UsersPageInner() {
  const navigate = useNavigate();
  const { t } = useTranslation();

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
        {t('admin.back_to_dashboard')}
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
