import React from 'react';
import { useTranslation } from 'react-i18next';

interface DashboardHeaderProps {
  favoritesCount: number;
  daysToView: number;
  onAddWidgetClick: () => void;
}

const DashboardHeader: React.FC<DashboardHeaderProps> = ({
  favoritesCount,
  daysToView,
  onAddWidgetClick,
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
      <button
        className="dashboard-add-widget-btn"
        onClick={onAddWidgetClick}
        title={t('dashboard.add_widget_title')}
      >
        {t('dashboard.add_widget_button')}
      </button>
    </div>
  );
};

export default DashboardHeader;
