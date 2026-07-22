/**
 * AnalysisTab — landing page for analytical reports.
 *
 * Mirrors the MeshManager AnalysisPage card grid: each report is selectable
 * from the grid and rendered full-screen when active.
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import SolarMonitoringReport from './SolarMonitoringReport';
import NodeInfoEnrichmentReport from './NodeInfoEnrichmentReport';
import { UiIcon, type UiIconName } from '../icons';

type AnalysisType = 'solar-monitoring' | 'nodeinfo-enrichment' | null;

interface AnalysisCard {
  id: Exclude<AnalysisType, null>;
  title: string;
  description: string;
  icon: UiIconName;
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
      icon: 'sun',
    },
    {
      id: 'nodeinfo-enrichment',
      title: t('analysis.enrichment.title', 'NodeInfo Enrichment'),
      description: t(
        'analysis.enrichment.description',
        'Fill blank NodeInfo fields (name, hardware, role, …) for nodes seen on multiple sources by copying from a source that already has the data.',
      ),
      icon: 'identity',
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
          <UiIcon name="back" size={16} /> {t('analysis.back_to_reports', 'Back to reports')}
        </button>
        <SolarMonitoringReport baseUrl={baseUrl} />
      </div>
    );
  }

  if (selected === 'nodeinfo-enrichment') {
    return (
      <div className="reports-section">
        <button
          type="button"
          className="reports-section__back"
          onClick={() => setSelected(null)}
        >
          <UiIcon name="back" size={16} /> {t('analysis.back_to_reports', 'Back to reports')}
        </button>
        <NodeInfoEnrichmentReport />
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
            <div className="reports-card__icon"><UiIcon name={r.icon} size={28} /></div>
            <h3 className="reports-card__title">{r.title}</h3>
            <p className="reports-card__desc">{r.description}</p>
          </button>
        ))}
      </div>
    </>
  );
};

export default AnalysisTab;
