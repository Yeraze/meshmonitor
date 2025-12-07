import React from 'react';

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
  return (
    <div className="dashboard-header-section">
      <div>
        <h2 className="dashboard-title">Telemetry Dashboard</h2>
        <p className="dashboard-subtitle">
          {favoritesCount > 0
            ? `Showing last ${daysToView} days of favorited telemetry`
            : 'Add widgets or star telemetry in the Nodes tab'}
        </p>
      </div>
      <button
        className="dashboard-add-widget-btn"
        onClick={onAddWidgetClick}
        title="Add widget"
      >
        + Add Widget
      </button>
    </div>
  );
};

export default DashboardHeader;
