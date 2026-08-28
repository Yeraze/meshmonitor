/**
 * @vitest-environment jsdom
 *
 * AnalysisTab — landing page for analytical reports (#4964 Phase 1 WP5
 * addition: the Mesh Issues card). Covers that all report cards render in
 * the grid, that selecting a card swaps to its report, and that the back
 * button returns to the grid. Child report components are mocked — this
 * test is about the grid/routing behavior of AnalysisTab itself, not any
 * individual report's internals (those have their own test files).
 */
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, defaultValue?: string) =>
      typeof defaultValue === 'string' ? defaultValue : key,
    i18n: { changeLanguage: vi.fn(), language: 'en' },
  }),
  Trans: ({ children }: { children: React.ReactNode }) => children,
  initReactI18next: { type: '3rdParty', init: vi.fn() },
}));

vi.mock('./SolarMonitoringReport', () => ({
  default: () => <div data-testid="solar-monitoring-report">Solar report</div>,
}));
vi.mock('./NodeInfoEnrichmentReport', () => ({
  default: () => <div data-testid="nodeinfo-enrichment-report">Enrichment report</div>,
}));
vi.mock('./MqttViolationsReport', () => ({
  default: () => <div data-testid="mqtt-violations-report">MQTT violations report</div>,
}));
vi.mock('./MeshIssuesReport', () => ({
  default: () => <div data-testid="mesh-issues-report">Mesh issues report</div>,
}));

import AnalysisTab from './AnalysisTab';

describe('AnalysisTab', () => {
  it('renders every report card, including Mesh Issues, in the grid', () => {
    render(<AnalysisTab />);

    expect(screen.getByText('Solar Monitoring Analysis')).toBeInTheDocument();
    expect(screen.getByText('NodeInfo Enrichment')).toBeInTheDocument();
    expect(screen.getByText('ok_to_mqtt Violations')).toBeInTheDocument();
    expect(screen.getByText('Mesh Issues')).toBeInTheDocument();
  });

  it('clicking the Mesh Issues card swaps to the report, and the back button returns to the grid', async () => {
    const user = userEvent.setup();
    render(<AnalysisTab />);

    await user.click(screen.getByText('Mesh Issues'));

    expect(screen.getByTestId('mesh-issues-report')).toBeInTheDocument();
    expect(screen.queryByText('Solar Monitoring Analysis')).not.toBeInTheDocument();

    const backButton = screen.getByText('Back to reports');
    await user.click(backButton);

    expect(screen.queryByTestId('mesh-issues-report')).not.toBeInTheDocument();
    expect(screen.getByText('Mesh Issues')).toBeInTheDocument();
    expect(screen.getByText('Solar Monitoring Analysis')).toBeInTheDocument();
  });

  it('clicking another report card still works after the Mesh Issues addition', async () => {
    const user = userEvent.setup();
    render(<AnalysisTab />);

    await user.click(screen.getByText('ok_to_mqtt Violations'));

    expect(screen.getByTestId('mqtt-violations-report')).toBeInTheDocument();
  });
});
