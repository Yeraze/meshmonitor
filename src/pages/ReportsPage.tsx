/**
 * ReportsPage — global cross-source analysis & reports workspace.
 *
 * Lists report cards (solar monitoring, etc.) and renders the selected report
 * full-screen. Public route; underlying API endpoints remain gated by per-source
 * permissions.
 */
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { SettingsProvider } from '../contexts/SettingsContext';
import { ToastProvider } from '../components/ToastContainer';
import AnalysisTab from '../components/Analysis/AnalysisTab';
import '../styles/analysis-reports.css';
import { UiIcon } from '../components/icons';

export default function ReportsPage() {
  const navigate = useNavigate();
  const { t } = useTranslation();

  return (
    <ToastProvider>
      <SettingsProvider>
        <div className="reports-page">
          <header className="reports-header">
            <button
              type="button"
              className="reports-header__back"
              onClick={() => navigate('/')}
            >
              <UiIcon name="back" size={16} /> {t('common.back', 'Dashboard')}
            </button>
            <h1>{t('analysis.title', 'Analysis & Reports')}</h1>
          </header>
          <main className="reports-body">
            <AnalysisTab />
          </main>
        </div>
      </SettingsProvider>
    </ToastProvider>
  );
}
