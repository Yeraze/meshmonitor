/**
 * @vitest-environment jsdom
 *
 * CoverageMap (#5277, Phase 1 WP4) — Leaflet cannot render in JSDOM, so
 * BaseMap and react-leaflet are stubbed (RouterClusterMap.test.tsx pattern).
 * Covers: one marker per fix, the popup listing every in-filter reception
 * with direct/relayed + distance, and the legend's relayed-hop note.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';

const { setViewMock, fitBoundsMock } = vi.hoisted(() => ({
  setViewMock: vi.fn(),
  fitBoundsMock: vi.fn(),
}));

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

vi.mock('../../contexts/SettingsContext', () => ({
  useSettings: () => ({
    mapTileset: 'osm',
    overlayColors: {
      snrColors: {
        excellent: '#22c55e',
        good: '#eab308',
        fair: '#f97316',
        poor: '#ef4444',
        noData: '#6c7086',
      },
    },
    customTilesets: [],
    distanceUnit: 'km',
    defaultMapCenterLat: null,
    defaultMapCenterLon: null,
    defaultMapCenterZoom: null,
  }),
}));

vi.mock('../map/BaseMap', () => ({
  BaseMap: ({ children }: { children?: React.ReactNode }) => <div data-testid="base-map">{children}</div>,
}));

vi.mock('react-leaflet', () => ({
  CircleMarker: ({ children, center, ...rest }: any) => (
    <div data-testid={rest['data-testid'] ?? 'circle-marker'} data-center={center.join(',')}>
      {children}
    </div>
  ),
  Tooltip: ({ children }: { children?: React.ReactNode }) => <span>{children}</span>,
  Popup: ({ children }: { children?: React.ReactNode }) => <div data-testid="popup">{children}</div>,
  useMap: () => ({ setView: setViewMock, fitBounds: fitBoundsMock }),
}));

import { CoverageMap } from './CoverageMap';
import type { CoverageFix } from '../../utils/coverage';
import type { CoverageReceptionDto, CoverageReceiverDto } from '../../types/coverage';

const receivers: CoverageReceiverDto[] = [
  {
    sourceId: 'src-a',
    sourceName: 'Source A',
    protocol: 'meshtastic',
    receiverKind: 'local',
    receiverId: '!aaaaaaaa',
    receiverNodeNum: 1,
    longName: 'Receiver One',
    shortName: 'R1',
    latitude: 26.1,
    longitude: -80.2,
    lastReceivedAt: 1,
  },
  {
    sourceId: 'src-a',
    sourceName: 'Source A',
    protocol: 'meshtastic',
    receiverKind: 'local',
    receiverId: '!cccccccc',
    receiverNodeNum: 3,
    longName: 'Receiver Two',
    shortName: 'R2',
    latitude: 26.3,
    longitude: -80.4,
    lastReceivedAt: 1,
  },
];

const SENDER_NAMES = new Map<string, string>([['!bbbbbbbb', 'Car-01']]);

function reception(overrides: Partial<CoverageReceptionDto>): CoverageReceptionDto {
  return {
    id: 1,
    sourceId: 'src-a',
    protocol: 'meshtastic',
    receiverKind: 'local',
    receiverId: '!aaaaaaaa',
    receiverNodeNum: 1,
    receiverLatitude: 26.1,
    receiverLongitude: -80.2,
    senderId: '!bbbbbbbb',
    senderNodeNum: 2,
    packetKey: '100',
    packetId: 100,
    pathKey: 'r0:h0',
    latitude: 26.15,
    longitude: -80.25,
    altitude: null,
    precisionBits: null,
    snr: 5.5,
    rssi: -85,
    hopStart: 0,
    hopLimit: 0,
    hopsAway: 0,
    relayNode: 0,
    transportMechanism: null,
    channel: 0,
    rxTime: 1_700_000_000,
    receivedAt: 1_700_000_000_000,
    ...overrides,
  };
}

describe('CoverageMap', () => {
  beforeEach(() => {
    setViewMock.mockClear();
    fitBoundsMock.mockClear();
  });

  it('renders one CircleMarker per fix plus one per visible receiver', () => {
    const fix: CoverageFix<CoverageReceptionDto> = {
      senderId: '!bbbbbbbb',
      packetKey: '100',
      latitude: 26.15,
      longitude: -80.25,
      receivedAt: 1_700_000_000_000,
      receptions: [reception({})],
      bestSnr: 5.5,
      bestRssi: -85,
    };

    render(<CoverageMap fixes={[fix]} receivers={receivers} metric="snr" senderNames={SENDER_NAMES} fitKey="k" />);

    // 2 receiver markers + 1 fix marker
    expect(screen.getAllByTestId('circle-marker')).toHaveLength(3);
  });

  it('lists a direct reception and its distance in the fix popup', () => {
    const fix: CoverageFix<CoverageReceptionDto> = {
      senderId: '!bbbbbbbb',
      packetKey: '100',
      latitude: 26.15,
      longitude: -80.25,
      receivedAt: 1_700_000_000_000,
      receptions: [reception({ id: 11, hopsAway: 0 })],
      bestSnr: 5.5,
      bestRssi: -85,
    };

    render(<CoverageMap fixes={[fix]} receivers={receivers} metric="snr" senderNames={SENDER_NAMES} fitKey="k" />);

    const popup = within(screen.getByTestId('coverage-fix-popup'));
    expect(popup.getByText('Receiver One')).toBeInTheDocument();
    expect(popup.getByText('Direct')).toBeInTheDocument();
    expect(popup.getByText(/SNR 5\.5 dB/)).toBeInTheDocument();
    expect(popup.getByText(/Distance: /)).toBeInTheDocument();
  });

  it('lists a relayed reception with hop count and relay hex', () => {
    const fix: CoverageFix<CoverageReceptionDto> = {
      senderId: '!bbbbbbbb',
      packetKey: '100',
      latitude: 26.15,
      longitude: -80.25,
      receivedAt: 1_700_000_000_000,
      receptions: [reception({ id: 12, hopsAway: 2, relayNode: 0xab })],
      bestSnr: 5.5,
      bestRssi: -85,
    };

    render(<CoverageMap fixes={[fix]} receivers={receivers} metric="snr" senderNames={SENDER_NAMES} fitKey="k" />);

    expect(screen.getByText(/Relayed \(2 hops, via 0xAB\)/)).toBeInTheDocument();
  });

  it('omits the relay byte when firmware reports no relay (0)', () => {
    const fix: CoverageFix<CoverageReceptionDto> = {
      senderId: '!bbbbbbbb',
      packetKey: '101',
      latitude: 26.15,
      longitude: -80.25,
      receivedAt: 1_700_000_000_000,
      receptions: [reception({ id: 13, hopsAway: 2, relayNode: 0 })],
      bestSnr: 5.5,
      bestRssi: -85,
    };

    render(<CoverageMap fixes={[fix]} receivers={receivers} metric="snr" senderNames={SENDER_NAMES} fitKey="k" />);

    expect(screen.getByText('Relayed (2 hops)')).toBeInTheDocument();
    expect(screen.queryByText(/via 0x00/)).toBeNull();
  });

  it('shows "—" for distance when the receiver snapshot position is null', () => {
    const fix: CoverageFix<CoverageReceptionDto> = {
      senderId: '!bbbbbbbb',
      packetKey: '100',
      latitude: 26.15,
      longitude: -80.25,
      receivedAt: 1_700_000_000_000,
      receptions: [reception({ id: 13, receiverLatitude: null, receiverLongitude: null })],
      bestSnr: 5.5,
      bestRssi: -85,
    };

    render(<CoverageMap fixes={[fix]} receivers={receivers} metric="snr" senderNames={SENDER_NAMES} fitKey="k" />);

    expect(screen.getByText('Distance: —')).toBeInTheDocument();
  });

  it('lists every reception within the filter, one per receiver heard', () => {
    const fix: CoverageFix<CoverageReceptionDto> = {
      senderId: '!bbbbbbbb',
      packetKey: '100',
      latitude: 26.15,
      longitude: -80.25,
      receivedAt: 1_700_000_000_000,
      receptions: [
        reception({ id: 21, receiverId: '!aaaaaaaa' }),
        reception({ id: 22, receiverId: '!cccccccc', receiverLatitude: 26.3, receiverLongitude: -80.4 }),
      ],
      bestSnr: 5.5,
      bestRssi: -85,
    };

    render(<CoverageMap fixes={[fix]} receivers={receivers} metric="snr" senderNames={SENDER_NAMES} fitKey="k" />);

    const popup = within(screen.getByTestId('coverage-fix-popup'));
    expect(popup.getByText('Receiver One')).toBeInTheDocument();
    expect(popup.getByText('Receiver Two')).toBeInTheDocument();
  });

  it('renders the relayed-hop legend note', () => {
    render(<CoverageMap fixes={[]} receivers={[]} metric="snr" senderNames={SENDER_NAMES} fitKey="k" />);
    expect(
      screen.getByText(
        "For receptions with 1 or more hops, colour shows the last relay's link, not the sender's position.",
      ),
    ).toBeInTheDocument();
  });

  it('shows the RSSI legend title when metric is rssi', () => {
    render(<CoverageMap fixes={[]} receivers={[]} metric="rssi" senderNames={SENDER_NAMES} fitKey="k" />);
    expect(screen.getByTestId('coverage-legend')).toHaveTextContent('RSSI');
  });

  it('names the sender in the popup header, with its !id and the fix time', () => {
    const fix: CoverageFix<CoverageReceptionDto> = {
      senderId: '!bbbbbbbb',
      packetKey: '100',
      latitude: 26.15,
      longitude: -80.25,
      receivedAt: 1_700_000_000_000,
      receptions: [reception({ id: 31 }), reception({ id: 32, receiverId: '!cccccccc' })],
      bestSnr: 5.5,
      bestRssi: -85,
    };

    render(<CoverageMap fixes={[fix]} receivers={receivers} metric="snr" senderNames={SENDER_NAMES} fitKey="k" />);

    const popup = within(screen.getByTestId('coverage-fix-popup'));
    expect(popup.getByText('Car-01 (!bbbbbbbb) — 2 reception(s)')).toBeInTheDocument();
    expect(popup.getByTestId('coverage-fix-popup-time')).toHaveTextContent(
      new Date(1_700_000_000_000).toLocaleString(),
    );
  });

  it('falls back to the bare !id in the popup header when no sender name is known', () => {
    const fix: CoverageFix<CoverageReceptionDto> = {
      senderId: '!bbbbbbbb',
      packetKey: '100',
      latitude: 26.15,
      longitude: -80.25,
      receivedAt: 1_700_000_000_000,
      receptions: [reception({ id: 41 })],
      bestSnr: 5.5,
      bestRssi: -85,
    };

    render(<CoverageMap fixes={[fix]} receivers={receivers} metric="snr" senderNames={new Map()} fitKey="k" />);

    const popup = within(screen.getByTestId('coverage-fix-popup'));
    expect(popup.getByText('!bbbbbbbb — 1 reception(s)')).toBeInTheDocument();
  });

  it('fits bounds once per fitKey, and a same-fitKey refresh does not refit', () => {
    const fix: CoverageFix<CoverageReceptionDto> = {
      senderId: '!bbbbbbbb',
      packetKey: '100',
      latitude: 26.15,
      longitude: -80.25,
      receivedAt: 1_700_000_000_000,
      receptions: [reception({})],
      bestSnr: 5.5,
      bestRssi: -85,
    };

    const { rerender } = render(
      <CoverageMap fixes={[fix]} receivers={receivers} metric="snr" senderNames={SENDER_NAMES} fitKey="k1" />,
    );
    expect(fitBoundsMock).toHaveBeenCalledTimes(1);

    // A manual Refresh re-fetches the same filter set: a NEW fixes array
    // reference, but the same fitKey. Must not yank the view again.
    const refreshedFix = { ...fix, receptions: [reception({ id: 99 })] };
    rerender(
      <CoverageMap fixes={[refreshedFix]} receivers={receivers} metric="snr" senderNames={SENDER_NAMES} fitKey="k1" />,
    );
    expect(fitBoundsMock).toHaveBeenCalledTimes(1);
  });

  it('refits when fitKey changes (a filter change)', () => {
    const fix: CoverageFix<CoverageReceptionDto> = {
      senderId: '!bbbbbbbb',
      packetKey: '100',
      latitude: 26.15,
      longitude: -80.25,
      receivedAt: 1_700_000_000_000,
      receptions: [reception({})],
      bestSnr: 5.5,
      bestRssi: -85,
    };

    const { rerender } = render(
      <CoverageMap fixes={[fix]} receivers={receivers} metric="snr" senderNames={SENDER_NAMES} fitKey="k1" />,
    );
    expect(fitBoundsMock).toHaveBeenCalledTimes(1);

    rerender(
      <CoverageMap fixes={[fix]} receivers={receivers} metric="snr" senderNames={SENDER_NAMES} fitKey="k2" />,
    );
    expect(fitBoundsMock).toHaveBeenCalledTimes(2);
  });
});
