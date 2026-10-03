/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CoverageCrossSourceSummary } from './CoverageCrossSourceSummary';
import type { CoverageCrossSourceRow } from '../../utils/coverageCrossSource';

vi.mock('react-i18next', async () => {
  const { createReactI18nextMock } = await import('../../test/mockI18n');
  return createReactI18nextMock();
});

const row = (o: Partial<CoverageCrossSourceRow> = {}): CoverageCrossSourceRow => ({
  key: 'a|b|!000000b0', senderSourceId: 'a', senderId: '!000000a0', sourceId: 'b', receiverId: '!000000b0',
  receiverKind: 'local', transport: 'rf', fixes: 12, receptions: 14, medianSnr: 4.25, bestSnr: 9, lastReceivedAt: 1,
  ...o,
});

const names = new Map([['a', 'Radio A'], ['b', 'Radio B'], ['m', 'Broker']]);

describe('CoverageCrossSourceSummary (#5560)', () => {
  it('renders nothing without rows', () => {
    const { container } = render(
      <CoverageCrossSourceSummary rows={[]} sourceNames={names} receiverNames={new Map()} sinceMs={0} untilMs={3_600_000} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('renders "N fixes from A heard by B over T" with transport and SNR', () => {
    render(
      <CoverageCrossSourceSummary rows={[row()]} sourceNames={names} receiverNames={new Map()} sinceMs={0} untilMs={3_600_000} />,
    );
    expect(screen.getByText(/12 fixes from Radio A heard by Radio B over/)).toBeInTheDocument();
    expect(screen.getByText('RF')).toBeInTheDocument();
    expect(screen.getByText('4.3 dB')).toBeInTheDocument();
    expect(screen.getByText('9.0 dB')).toBeInTheDocument();
  });

  it('names the gateway for an MQTT-gateway hearing', () => {
    render(
      <CoverageCrossSourceSummary
        rows={[row({ key: 'a|m|!000000c0', sourceId: 'm', receiverId: '!000000c0', receiverKind: 'mqtt_gateway', transport: 'mqtt_gateway', medianSnr: null, bestSnr: null })]}
        sourceNames={names}
        receiverNames={new Map([['m:!000000c0', 'Hilltop']])}
        sinceMs={0}
        untilMs={3_600_000}
      />,
    );
    expect(screen.getByText(/12 fixes from Radio A heard by gateway .* \(Broker\) over/)).toBeInTheDocument();
    expect(screen.getByText('MQTT gateway (RF)')).toBeInTheDocument();
  });
});
