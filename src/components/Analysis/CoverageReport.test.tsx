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
import { MemoryRouter } from 'react-router-dom';

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
    latitude: 26.1, longitude: -80.2, lastReceivedAt: 1, receptionCount: 5,
  },
  {
    sourceId: 'src-a', sourceName: 'Source A', protocol: 'meshtastic', receiverKind: 'local',
    receiverId: '!cccccccc', receiverNodeNum: 3, longName: 'Receiver Two', shortName: 'R2',
    latitude: 26.3, longitude: -80.4, lastReceivedAt: 1, receptionCount: 5,
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
    data: { receivers: RECEIVERS, retentionDays: 7, mqttSources: [] },
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

function renderReport() {
  return render(
    <MemoryRouter>
      <CoverageReport />
    </MemoryRouter>,
  );
}

/** Opens the CoverageReceiverFilter panel (composite-keyed picker, #5277 P2 WP4). */
function openReceiverPanel() {
  fireEvent.click(screen.getByRole('button', { name: /Receivers:|All receivers/ }));
}

describe('CoverageReport', () => {
  it('defaults to a 24h window, all receivers, no sender, no hops filter', () => {
    renderReport();

    const filters = lastReceptionsFilters();
    expect(filters.sinceMs).toBe(NOW - 24 * 3_600_000);
    expect(filters.untilMs).toBe(NOW);
    expect(filters.receiverFilter).toBeUndefined();
    expect(filters.clientSideFilter).toBeUndefined();
    expect(filters.senderId).toBeUndefined();
    expect(filters.hops).toBeUndefined();
    expect(filters.hopsMode).toBe('exact');
  });

  it('refetches with the chosen sender id when the sender select changes', () => {
    renderReport();

    fireEvent.change(screen.getByLabelText('Sender'), { target: { value: '!bbbbbbbb' } });

    expect(lastReceptionsFilters().senderId).toBe('!bbbbbbbb');
  });

  it('refetches with an exact hops filter, then switches to "up to" mode', () => {
    renderReport();

    fireEvent.change(screen.getByLabelText('Hops'), { target: { value: '2' } });
    expect(lastReceptionsFilters().hops).toBe(2);
    expect(lastReceptionsFilters().hopsMode).toBe('exact');

    fireEvent.click(screen.getByRole('checkbox', { name: 'Up to this many hops' }));
    expect(lastReceptionsFilters().hopsMode).toBe('max');
  });

  it('deselecting a receiver narrows the receiverFilter (composite-keyed); deselecting all shows the selection-required banner', () => {
    renderReport();
    openReceiverPanel();

    fireEvent.click(screen.getByRole('checkbox', { name: 'Receiver Two' }));
    expect(lastReceptionsFilters().receiverFilter).toEqual([
      { sourceId: 'src-a', mode: 'include', receiverIds: ['!aaaaaaaa'] },
    ]);

    fireEvent.click(screen.getByRole('checkbox', { name: 'Receiver One' }));
    expect(screen.getByText('Select at least one receiver.')).toBeInTheDocument();
  });

  it('shows the truncation banner when the receptions query reports truncated', () => {
    useCoverageReceptions.mockReturnValue({
      data: { items: [makeReception(1)], truncated: true },
      isLoading: false,
      refetch: vi.fn(),
    });

    renderReport();

    expect(
      screen.getByText(/Showing the first 1 receptions in this window/),
    ).toBeInTheDocument();
    expect(screen.getByText(/pick a sender to see the rest/)).toBeInTheDocument();
  });

  it('shows the empty state when there are no receptions and nothing is loading', () => {
    useCoverageReceptions.mockReturnValue({
      data: { items: [], truncated: false },
      isLoading: false,
      refetch: vi.fn(),
    });

    renderReport();

    expect(screen.getByText('No RF receptions in this window.')).toBeInTheDocument();
    expect(screen.queryByTestId('coverage-map-stub')).not.toBeInTheDocument();
  });

  it('toggles the setup guidance panel', () => {
    renderReport();

    expect(screen.queryByText(/Recommended survey-node settings/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('Setup guidance'));
    expect(screen.getByText(/Recommended survey-node settings/)).toBeInTheDocument();
    expect(screen.getByText(/receiver firmware caveat/i)).toBeInTheDocument();
    fireEvent.click(screen.getByText('Setup guidance'));
    expect(screen.queryByText(/Recommended survey-node settings/)).not.toBeInTheDocument();
  });

  it('passes the selected colour metric through to CoverageMap', () => {
    renderReport();

    expect(screen.getByTestId('coverage-map-stub')).toHaveTextContent('metric:snr');
    fireEvent.change(screen.getByLabelText('Colour by'), { target: { value: 'rssi' } });
    expect(screen.getByTestId('coverage-map-stub')).toHaveTextContent('metric:rssi');
  });

  it('shows the retention note from the receivers query', () => {
    renderReport();
    expect(screen.getByText('Data kept 7 days.')).toBeInTheDocument();
  });

  it('shows the MQTT note when a gateway receiver is present', () => {
    useCoverageReceivers.mockReturnValue({
      data: {
        receivers: [
          { ...RECEIVERS[0], receiverKind: 'mqtt_gateway' },
        ],
        retentionDays: 7,
        mqttSources: [],
      },
      isLoading: false,
      refetch: vi.fn(),
    });

    renderReport();
    expect(screen.getByText(/Gateway receptions come from what each gateway itself reports/)).toBeInTheDocument();
  });

  it('shows the MQTT note when mqttSources is non-empty even with no gateway receivers yet', () => {
    useCoverageReceivers.mockReturnValue({
      data: {
        receivers: RECEIVERS,
        retentionDays: 7,
        mqttSources: [{ sourceId: 'src-mqtt', sourceName: 'MQTT Source', recordingEnabled: true }],
      },
      isLoading: false,
      refetch: vi.fn(),
    });

    renderReport();
    expect(screen.getByText(/Gateway receptions come from what each gateway itself reports/)).toBeInTheDocument();
  });

  it('does not show the MQTT note when there are no gateway receivers and no mqttSources', () => {
    renderReport();
    expect(screen.queryByText(/Gateway receptions come from what each gateway itself reports/)).not.toBeInTheDocument();
  });

  // #5277 Phase 3 WP3.
  describe('MeshCore', () => {
    it('the Hops select includes 8 (MeshCore advert flood limit)', () => {
      renderReport();
      const hopsSelect = screen.getByLabelText('Hops') as HTMLSelectElement;
      const values = Array.from(hopsSelect.options).map((o) => o.value);
      expect(values).toContain('8');

      fireEvent.change(hopsSelect, { target: { value: '8' } });
      expect(lastReceptionsFilters().hops).toBe(8);
    });

    it('abbreviates a MeshCore pubkey sender in the sender dropdown', () => {
      const PUBKEY = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2';
      useCoverageSenders.mockReturnValue({
        data: {
          senders: [
            { senderId: PUBKEY, senderNodeNum: null, longName: null, shortName: null, fixCount: 3, lastReceivedAt: 1 },
          ],
          truncated: false,
        },
        isLoading: false,
        refetch: vi.fn(),
      });

      renderReport();
      const option = screen.getByRole('option', { name: /a1b2c3d4…/ });
      expect(option).toBeInTheDocument();
      expect(screen.queryByRole('option', { name: new RegExp(PUBKEY) })).not.toBeInTheDocument();
    });

    it('the setup guidance panel carries the zero-hop, never-flood, MeshMonitor-button, and stored-position warnings plus the airtime figures', () => {
      renderReport();
      fireEvent.click(screen.getByText('Setup guidance'));

      expect(screen.getByText(/Send zero-hop adverts only, one every 60 seconds or slower/)).toBeInTheDocument();
      expect(screen.getByText(/Never flood adverts for a survey/)).toBeInTheDocument();
      expect(screen.getByText(/advert\.zerohop/)).toBeInTheDocument();
      expect(screen.getByText(/own Send advert button floods/)).toBeInTheDocument();
      expect(screen.getByText(/stored advert position, not a live GPS fix/)).toBeInTheDocument();
      expect(screen.getByText('US/Canada 910.525 MHz, SF7 BW62.5 CR5')).toBeInTheDocument();
      expect(screen.getByText('EU/UK narrow, SF8 BW62.5 CR8')).toBeInTheDocument();
      expect(screen.getByText('396 ms')).toBeInTheDocument();
      expect(screen.getByText(/0\.7% of the local channel/)).toBeInTheDocument();
      expect(screen.getByText(/Repeaters' own adverts are recorded automatically/)).toBeInTheDocument();
    });

    it('shows the MeshCore empty-state hint alongside the Meshtastic one', () => {
      useCoverageReceptions.mockReturnValue({
        data: { items: [], truncated: false },
        isLoading: false,
        refetch: vi.fn(),
      });

      renderReport();
      expect(
        screen.getByText('MeshCore companions record signed adverts that carry a position.'),
      ).toBeInTheDocument();
    });
  });
});
