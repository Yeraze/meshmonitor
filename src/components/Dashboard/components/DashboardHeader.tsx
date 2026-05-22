import React from 'react';
import { useTranslation } from 'react-i18next';

interface DashboardHeaderProps {
  favoritesCount: number;
  daysToView: number;
  onAddWidgetClick: () => void;
  /** When false, the "Add Widget" button is suppressed — used for source
   *  types (e.g. MeshCore) that don't yet have any custom-widget kinds. */
  showAddWidget?: boolean;
}

const DashboardHeader: React.FC<DashboardHeaderProps> = ({
  favoritesCount,
  daysToView,
  onAddWidgetClick,
  showAddWidget = true,
}) => {
  const { t } = useTranslation();

  return (
    <div className="dashboard-header-section">
      <div>
        <h2 className="dashboard-title">{t('dashboard.title')}</h2>
        <p className="dashboard-subtitle">
          {favoritesCount > 0
            ? t('dashboard.subtitle_with_data', { days: daysToView })
            : t('dashboard.subtitle_empty')}
        </p>
      </div>
      {showAddWidget && (
        <button
          className="dashboard-add-widget-btn"
          onClick={onAddWidgetClick}
          title={t('dashboard.add_widget_title')}
        >
          {t('dashboard.add_widget_button')}
        </button>
      )}
    </div>
  );
};

export default DashboardHeader;
