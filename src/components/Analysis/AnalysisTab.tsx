/**
 * AnalysisTab — landing page for analytical reports.
 *
 * Mirrors the MeshManager AnalysisPage card grid: each report is selectable
 * from the grid and rendered full-screen when active.
 *
 * Coverage deep link (#5277 P4a WP4, spec §2a.7): `/reports?report=coverage&
 * sender=…&range=…` opens straight to the Coverage Report, pre-filtered.
 * `parseCoverageDeepLink` (WP1) is the only thing that reads the params — it
 * returns `null` unless `report=coverage`, so every other report's URL
 * (today none use query params) is untouched. The initial `selected` is
 * seeded from the link ONCE via a lazy `useState` initializer; the router's
 * `useSearchParams` value is otherwise only consulted to build the prop
 * `CoverageReport` reads at ITS OWN mount, never re-applied to `selected` on
 * a later params change — same query-stability rule CoverageReport's
 * `timeWindow` already documents.
 */
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router-dom';
import SolarMonitoringReport from './SolarMonitoringReport';
import NodeInfoEnrichmentReport from './NodeInfoEnrichmentReport';
import MqttViolationsReport from './MqttViolationsReport';
import MeshIssuesReport from './MeshIssuesReport';
import CoverageReport from './CoverageReport';
import { parseCoverageDeepLink } from '../../utils/coverageDeepLink';
import { UiIcon, type UiIconName } from '../icons';

type AnalysisType =
  | 'solar-monitoring'
  | 'nodeinfo-enrichment'
  | 'mqtt-oktomqtt-violations'
  | 'mesh-issues'
  | 'coverage'
  | null;

interface AnalysisCard {
  id: Exclude<AnalysisType, null>;
  title: string;
  description: string;
  icon: UiIconName;
}

const AnalysisTab: React.FC = () => {
  const { t } = useTranslation();
  const [searchParams, setSearchParams] = useSearchParams();
  // Recomputed only when the URL's search params actually change (react-router
  // hands back a new URLSearchParams instance on navigation) — not on every
  // render, and NOT stored back into a query key anywhere, so this has none
  // of the render-loop shape the #5277 query-stability fix guards against.
  const coverageLink = useMemo(() => parseCoverageDeepLink(searchParams), [searchParams]);
  const [selected, setSelected] = useState<AnalysisType>(() => (coverageLink ? 'coverage' : null));

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
    {
      id: 'coverage',
      title: t('analysis.coverage.title', 'Coverage Report'),
      description: t(
        'analysis.coverage.description',
        'Map RF receptions of position packets — how far your mesh actually reaches, and how well each receiver hears it. Built from a survey node driving your coverage area, not sent by MeshMonitor.',
      ),
      icon: 'radioSignal',
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

  if (selected === 'coverage') {
    return (
      <div className="reports-section">
        <button
          type="button"
          className="reports-section__back"
          onClick={() => {
            // Clears report=/sender=/range= so Back does not reopen the
            // report on the next render (spec §2a.7) — without this, the
            // deep link that opened the report would still be in the URL
            // and `coverageLink` would still be truthy.
            setSearchParams({}, { replace: true });
            setSelected(null);
          }}
        >
          <UiIcon name="back" size={16} /> {t('analysis.back_to_reports', 'Back to reports')}
        </button>
        <CoverageReport initialLink={coverageLink ?? undefined} />
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
