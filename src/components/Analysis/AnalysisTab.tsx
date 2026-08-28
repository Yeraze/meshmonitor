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
import MqttViolationsReport from './MqttViolationsReport';
import MeshIssuesReport from './MeshIssuesReport';
import { UiIcon, type UiIconName } from '../icons';

type AnalysisType =
  | 'solar-monitoring'
  | 'nodeinfo-enrichment'
  | 'mqtt-oktomqtt-violations'
  | 'mesh-issues'
  | null;

interface AnalysisCard {
  id: Exclude<AnalysisType, null>;
  title: string;
  description: string;
  icon: UiIconName;
}

const AnalysisTab: React.FC = () => {
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
    {
      id: 'mqtt-oktomqtt-violations',
      title: t('analysis.mqtt_violations.title', 'ok_to_mqtt Violations'),
      description: t(
        'analysis.mqtt_violations.description',
        "Find MQTT gateways that uplinked other nodes' packets even though the sender did not opt in to MQTT (ok_to_mqtt = 0).",
      ),
      icon: 'securityAlert',
    },
    {
      id: 'mesh-issues',
      title: t('analysis.mesh_issues.title', 'Mesh Issues'),
      description: t(
        'analysis.mesh_issues.description',
        'Flag wrongly-roled or poorly placed routers, airtime abusers, and infrastructure nodes on failing power — from passively collected data only.',
      ),
      icon: 'alert',
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
        <SolarMonitoringReport />
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

  if (selected === 'mqtt-oktomqtt-violations') {
    return (
      <div className="reports-section">
        <button
          type="button"
          className="reports-section__back"
          onClick={() => setSelected(null)}
        >
          <UiIcon name="back" size={16} /> {t('analysis.back_to_reports', 'Back to reports')}
        </button>
        <MqttViolationsReport />
      </div>
    );
  }

  if (selected === 'mesh-issues') {
    return (
      <div className="reports-section">
        <button
          type="button"
          className="reports-section__back"
          onClick={() => setSelected(null)}
        >
          <UiIcon name="back" size={16} /> {t('analysis.back_to_reports', 'Back to reports')}
        </button>
        <MeshIssuesReport />
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
