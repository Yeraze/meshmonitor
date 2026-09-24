/**
 * @vitest-environment jsdom
 *
 * CoverageReport (#5277, Phase 1 WP4). `useCoverageData` hooks and
 * `CoverageMap` (Leaflet-heavy, tested separately in CoverageMap.test.tsx)
 * are mocked so this file focuses on CoverageReport's own filter wiring:
 * default params, sender/hops changes refetching with the right args, the
 * truncation banner, the empty state, the guidance toggle, and the metric
 * toggle reaching CoverageMap.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, fallback?: string | Record<string, unknown>, opts?: Record<string, unknown>) => {
      if (typeof fallback === 'string') {
        const vars = (opts ?? {}) as Record<string, unknown>;
        return fallback.replace(/\{\{(\w+)\}\}/g, (_, k) => String(vars[k] ?? ''));
      }
      return _key;
    },
  }),
}));

const useCoverageReceivers = vi.fn();
const useCoverageSenders = vi.fn();
const useCoverageReceptions = vi.fn();

vi.mock('../../hooks/useCoverageData', () => ({
  useCoverageReceivers: (...args: unknown[]) => useCoverageReceivers(...args),
  useCoverageSenders: (...args: unknown[]) => useCoverageSenders(...args),
  useCoverageReceptions: (...args: unknown[]) => useCoverageReceptions(...args),
}));

vi.mock('./CoverageMap', () => ({
  CoverageMap: ({ fixes, receivers, metric }: any) => (
    <div data-testid="coverage-map-stub">
      fixes:{fixes.length} receivers:{receivers.length} metric:{metric}
    </div>
  ),
}));

import CoverageReport from './CoverageReport';

const RECEIVERS = [
  {
    sourceId: 'src-a', sourceName: 'Source A', protocol: 'meshtastic', receiverKind: 'local',
    receiverId: '!aaaaaaaa', receiverNodeNum: 1, longName: 'Receiver One', shortName: 'R1',
    latitude: 26.1, longitude: -80.2, lastReceivedAt: 1,
  },
  {
    sourceId: 'src-a', sourceName: 'Source A', protocol: 'meshtastic', receiverKind: 'local',
    receiverId: '!cccccccc', receiverNodeNum: 3, longName: 'Receiver Two', shortName: 'R2',
    latitude: 26.3, longitude: -80.4, lastReceivedAt: 1,
  },
];

const SENDERS = [
  { senderId: '!bbbbbbbb', senderNodeNum: 2, longName: 'Sender One', shortName: 'S1', fixCount: 4, lastReceivedAt: 1 },
];

function makeReception(id: number) {
  return {
    id, sourceId: 'src-a', protocol: 'meshtastic', receiverKind: 'local',
    receiverId: '!aaaaaaaa', receiverNodeNum: 1, receiverLatitude: 26.1, receiverLongitude: -80.2,
    senderId: '!bbbbbbbb', senderNodeNum: 2, packetKey: String(id), packetId: id, pathKey: 'r0:h0',
    latitude: 26.15, longitude: -80.25, altitude: null, precisionBits: null, snr: 5, rssi: -80,
    hopStart: 0, hopLimit: 0, hopsAway: 0, relayNode: 0, transportMechanism: null, channel: 0,
    rxTime: 1_700_000_000, receivedAt: 1_700_000_000_000 + id,
  };
}

const NOW = 1_700_000_000_000;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);

  useCoverageReceivers.mockReturnValue({
    data: { receivers: RECEIVERS, retentionDays: 7 },
    isLoading: false,
    refetch: vi.fn(),
  });
  useCoverageSenders.mockReturnValue({
    data: { senders: SENDERS, truncated: false },
    isLoading: false,
    refetch: vi.fn(),
  });
  useCoverageReceptions.mockReturnValue({
    data: { items: [makeReception(1), makeReception(2)], truncated: false },
    isLoading: false,
    refetch: vi.fn(),
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

function lastReceptionsFilters() {
  const calls = useCoverageReceptions.mock.calls;
  return calls[calls.length - 1][0];
}

describe('CoverageReport', () => {
  it('defaults to a 24h window, all receivers, no sender, no hops filter', () => {
    render(<CoverageReport />);

    const filters = lastReceptionsFilters();
    expect(filters.sinceMs).toBe(NOW - 24 * 3_600_000);
    expect(filters.untilMs).toBe(NOW);
    expect(filters.receiverIds).toBeUndefined();
    expect(filters.senderId).toBeUndefined();
    expect(filters.hops).toBeUndefined();
    expect(filters.hopsMode).toBe('exact');
  });

  it('refetches with the chosen sender id when the sender select changes', () => {
    render(<CoverageReport />);

    fireEvent.change(screen.getByLabelText('Sender'), { target: { value: '!bbbbbbbb' } });

    expect(lastReceptionsFilters().senderId).toBe('!bbbbbbbb');
  });

  it('refetches with an exact hops filter, then switches to "up to" mode', () => {
    render(<CoverageReport />);

    fireEvent.change(screen.getByLabelText('Hops'), { target: { value: '2' } });
    expect(lastReceptionsFilters().hops).toBe(2);
    expect(lastReceptionsFilters().hopsMode).toBe('exact');

    fireEvent.click(screen.getByRole('checkbox', { name: 'Up to this many hops' }));
    expect(lastReceptionsFilters().hopsMode).toBe('max');
  });

  it('deselecting a receiver narrows receiverIds; deselecting all shows the selection-required banner', () => {
    render(<CoverageReport />);

    fireEvent.click(screen.getByRole('checkbox', { name: 'Receiver Two' }));
    expect(lastReceptionsFilters().receiverIds).toEqual(['!aaaaaaaa']);

    fireEvent.click(screen.getByRole('checkbox', { name: 'Receiver One' }));
    expect(screen.getByText('Select at least one receiver.')).toBeInTheDocument();
  });

  it('shows the truncation banner when the receptions query reports truncated', () => {
    useCoverageReceptions.mockReturnValue({
      data: { items: [makeReception(1)], truncated: true },
      isLoading: false,
      refetch: vi.fn(),
    });

    render(<CoverageReport />);

    expect(
      screen.getByText(/Showing the first 1 receptions in this window/),
    ).toBeInTheDocument();
  });

  it('shows the empty state when there are no receptions and nothing is loading', () => {
    useCoverageReceptions.mockReturnValue({
      data: { items: [], truncated: false },
      isLoading: false,
      refetch: vi.fn(),
    });

    render(<CoverageReport />);

    expect(screen.getByText('No RF receptions in this window.')).toBeInTheDocument();
    expect(screen.queryByTestId('coverage-map-stub')).not.toBeInTheDocument();
  });

  it('toggles the setup guidance panel', () => {
    render(<CoverageReport />);

    expect(screen.queryByText(/Recommended survey-node settings/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('Setup guidance'));
    expect(screen.getByText(/Recommended survey-node settings/)).toBeInTheDocument();
    expect(screen.getByText(/receiver firmware caveat/i)).toBeInTheDocument();
    fireEvent.click(screen.getByText('Setup guidance'));
    expect(screen.queryByText(/Recommended survey-node settings/)).not.toBeInTheDocument();
  });

  it('passes the selected colour metric through to CoverageMap', () => {
    render(<CoverageReport />);

    expect(screen.getByTestId('coverage-map-stub')).toHaveTextContent('metric:snr');
    fireEvent.change(screen.getByLabelText('Colour by'), { target: { value: 'rssi' } });
    expect(screen.getByTestId('coverage-map-stub')).toHaveTextContent('metric:rssi');
  });

  it('shows the retention note from the receivers query', () => {
    render(<CoverageReport />);
    expect(screen.getByText('Data kept 7 days.')).toBeInTheDocument();
  });
});
