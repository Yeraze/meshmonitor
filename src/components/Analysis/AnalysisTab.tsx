/**
 * AnalysisTab — landing page for analytical reports.
 *
 * Mirrors the MeshManager AnalysisPage card grid: each report is selectable
 * from the grid and rendered full-screen when active.
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import SolarMonitoringReport from './SolarMonitoringReport';

type AnalysisType = 'solar-monitoring' | null;

interface AnalysisCard {
  id: Exclude<AnalysisType, null>;
  title: string;
  description: string;
  icon: string;
}

interface AnalysisTabProps {
  baseUrl: string;
}

const AnalysisTab: React.FC<AnalysisTabProps> = ({ baseUrl }) => {
  const { t } = useTranslation();
  const [selected, setSelected] = useState<AnalysisType>(null);

  const reports: AnalysisCard[] = [
    {
      id: 'solar-monitoring',
      title: t('analysis.solar_monitoring.title', 'Solar Monitoring Analysis'),
      description: t(
        'analysis.solar_monitoring.description',
        'Identify solar-powered nodes by analyzing battery and voltage patterns that show daytime charging and nighttime discharge.',
      ),
      icon: '☀️',
    },
  ];

  if (selected === 'solar-monitoring') {
    return (
      <div className="reports-section">
        <button
          type="button"
          className="reports-section__back"
          onClick={() => setSelected(null)}
        >
          {t('analysis.back_to_reports', '← Back to reports')}
        </button>
        <SolarMonitoringReport baseUrl={baseUrl} />
      </div>
    );
  }

  return (
    <>
      <p className="reports-grid__intro">
        {t(
          'analysis.subtitle',
          'Cross-network analytical reports built from collected telemetry and routing data. Choose a report to run.',
        )}
      </p>
      <div className="reports-grid">
        {reports.map((r) => (
          <button
            key={r.id}
            type="button"
            className="reports-card"
            onClick={() => setSelected(r.id)}
          >
            <div className="reports-card__icon">{r.icon}</div>
            <h3 className="reports-card__title">{r.title}</h3>
            <p className="reports-card__desc">{r.description}</p>
          </button>
        ))}
      </div>
    </>
  );
};

export default AnalysisTab;
