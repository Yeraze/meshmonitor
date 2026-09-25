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
  BaseMap: ({ children, preferCanvas }: { children?: React.ReactNode; preferCanvas?: boolean }) => (
    <div data-testid="base-map" data-prefer-canvas={String(preferCanvas)}>
      {children}
    </div>
  ),
}));

vi.mock('react-leaflet', () => ({
  CircleMarker: ({ children, center, radius, pathOptions, ...rest }: any) => (
    <div
      data-testid={rest['data-testid'] ?? 'circle-marker'}
      data-center={center.join(',')}
      data-radius={radius}
      data-dash={pathOptions?.dashArray ?? ''}
    >
      {children}
    </div>
  ),
  Polyline: ({ children, positions, pathOptions }: any) => (
    <div
      data-testid="gap-polyline"
      data-positions={JSON.stringify(positions)}
      data-color={pathOptions?.color ?? ''}
      data-dash={pathOptions?.dashArray ?? ''}
      data-weight={pathOptions?.weight ?? ''}
    >
      {children}
    </div>
  ),
  Rectangle: ({ children, bounds, pathOptions }: any) => (
    <div
      data-testid="grid-cell"
      data-bounds={JSON.stringify(bounds)}
      data-fill={pathOptions?.fillColor ?? ''}
      data-fill-opacity={pathOptions?.fillOpacity ?? ''}
    >
      {children}
    </div>
  ),
  Tooltip: ({ children, permanent }: { children?: React.ReactNode; permanent?: boolean }) => (
    <span data-permanent={permanent ? 'true' : 'false'}>{children}</span>
  ),
  Popup: ({ children }: { children?: React.ReactNode }) => <div data-testid="popup">{children}</div>,
  useMap: () => ({ setView: setViewMock, fitBounds: fitBoundsMock }),
}));

import { CoverageMap } from './CoverageMap';
import type { CoverageFix } from '../../utils/coverage';
import type { CoverageReceptionDto, CoverageReceiverDto } from '../../types/coverage';
import type { CoverageGap, CoverageGridCell } from '../../types/coverageAnalysis';

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
    receptionCount: 5,
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
    receptionCount: 5,
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

  describe('cross-source gateway collapsing (#5277 Phase 2 WP4, Decision D7)', () => {
    const gatewayReceivers: CoverageReceiverDto[] = [
      {
        sourceId: 'src-a', sourceName: 'Source A', protocol: 'meshtastic', receiverKind: 'mqtt_gateway',
        receiverId: '!gw1', receiverNodeNum: 9, longName: 'Gateway One', shortName: 'GW1',
        latitude: 26.2, longitude: -80.3, lastReceivedAt: 100, receptionCount: 20,
      },
      {
        sourceId: 'src-b', sourceName: 'Source B', protocol: 'meshtastic', receiverKind: 'mqtt_gateway',
        receiverId: '!gw1', receiverNodeNum: 9, longName: 'Gateway One', shortName: 'GW1',
        latitude: 26.2, longitude: -80.3, lastReceivedAt: 200, receptionCount: 15,
      },
    ];

    it('renders one marker for the same physical gateway seen via two sources', () => {
      render(<CoverageMap fixes={[]} receivers={gatewayReceivers} metric="snr" senderNames={SENDER_NAMES} fitKey="k" />);
      expect(screen.getAllByTestId('circle-marker')).toHaveLength(1);
    });

    it('styles a gateway marker with a dashed stroke, a smaller radius, and a hover (non-permanent) tooltip', () => {
      render(<CoverageMap fixes={[]} receivers={gatewayReceivers} metric="snr" senderNames={SENDER_NAMES} fitKey="k" />);
      const marker = screen.getByTestId('circle-marker');
      expect(marker).toHaveAttribute('data-dash', '4,3');
      expect(marker).toHaveAttribute('data-radius', '6');
      expect(marker.querySelector('span')).toHaveAttribute('data-permanent', 'false');
    });

    it('a local receiver marker keeps a permanent tooltip and no dash', () => {
      render(<CoverageMap fixes={[]} receivers={receivers} metric="snr" senderNames={SENDER_NAMES} fitKey="k" />);
      const markers = screen.getAllByTestId('circle-marker');
      for (const marker of markers) {
        expect(marker).toHaveAttribute('data-dash', '');
        expect(marker.querySelector('span')).toHaveAttribute('data-permanent', 'true');
      }
    });

    it('collapses receptions from two sources for the same gateway+path into one popup line with a Gateway badge and a via-sources note', () => {
      const fix: CoverageFix<CoverageReceptionDto> = {
        senderId: '!bbbbbbbb',
        packetKey: '100',
        latitude: 26.15,
        longitude: -80.25,
        receivedAt: 1_700_000_000_000,
        receptions: [
          reception({
            id: 1, sourceId: 'src-a', receiverKind: 'mqtt_gateway', receiverId: '!gw1', pathKey: 'r0:h0',
            snr: 3, receiverLatitude: 26.2, receiverLongitude: -80.3,
          }),
          reception({
            id: 2, sourceId: 'src-b', receiverKind: 'mqtt_gateway', receiverId: '!gw1', pathKey: 'r0:h0',
            snr: 8, receiverLatitude: 26.2, receiverLongitude: -80.3,
          }),
        ],
        bestSnr: 8,
        bestRssi: -85,
      };

      render(
        <CoverageMap fixes={[fix]} receivers={gatewayReceivers} metric="snr" senderNames={SENDER_NAMES} fitKey="k" />,
      );

      const popup = within(screen.getByTestId('coverage-fix-popup'));
      // One collapsed line, not two.
      expect(popup.getAllByText('Gateway One')).toHaveLength(1);
      expect(popup.getByText('Gateway')).toBeInTheDocument();
      expect(popup.getByText('via Source A, Source B')).toBeInTheDocument();
      // The representative row is the higher-SNR one (id 2, snr 8).
      expect(popup.getByText(/SNR 8\.0 dB/)).toBeInTheDocument();
    });

    it('does not show a via-sources line for a single-source (local) reception', () => {
      const fix: CoverageFix<CoverageReceptionDto> = {
        senderId: '!bbbbbbbb',
        packetKey: '100',
        latitude: 26.15,
        longitude: -80.25,
        receivedAt: 1_700_000_000_000,
        receptions: [reception({ id: 1 })],
        bestSnr: 5.5,
        bestRssi: -85,
      };

      render(<CoverageMap fixes={[fix]} receivers={receivers} metric="snr" senderNames={SENDER_NAMES} fitKey="k" />);
      const popup = within(screen.getByTestId('coverage-fix-popup'));
      expect(popup.queryByText(/^via /)).not.toBeInTheDocument();
      expect(popup.queryByText('Gateway')).not.toBeInTheDocument();
    });
  });

  describe('MeshCore (#5277 Phase 3 WP3, spec §2.6)', () => {
    const PUBKEY = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2';
    const meshcoreReceivers: CoverageReceiverDto[] = [
      {
        sourceId: 'src-mc', sourceName: 'Source MC', protocol: 'meshcore', receiverKind: 'local',
        receiverId: PUBKEY, receiverNodeNum: null, longName: 'Companion One', shortName: null,
        latitude: 26.1, longitude: -80.2, lastReceivedAt: 1, receptionCount: 5,
      },
    ];

    function meshcoreReception(overrides: Partial<CoverageReceptionDto>): CoverageReceptionDto {
      return reception({
        protocol: 'meshcore',
        receiverId: PUBKEY,
        receiverKind: 'local',
        receiverNodeNum: null,
        senderId: PUBKEY,
        senderNodeNum: null,
        packetId: null,
        relayNode: null,
        ...overrides,
      });
    }

    it('shows "Direct" for a zero-hop MeshCore reception', () => {
      const fix: CoverageFix<CoverageReceptionDto> = {
        senderId: PUBKEY,
        packetKey: '100',
        latitude: 26.15,
        longitude: -80.25,
        receivedAt: 1_700_000_000_000,
        receptions: [meshcoreReception({ id: 1, hopsAway: 0, pathKey: 'h0:-' })],
        bestSnr: 5.5,
        bestRssi: -85,
      };

      render(<CoverageMap fixes={[fix]} receivers={meshcoreReceivers} metric="snr" senderNames={new Map()} fitKey="k" />);
      const popup = within(screen.getByTestId('coverage-fix-popup'));
      expect(popup.getByText('Direct')).toBeInTheDocument();
    });

    it('shows "N hops via <lastHop>" from the pathKey, upper-cased, for a relayed MeshCore reception', () => {
      const fix: CoverageFix<CoverageReceptionDto> = {
        senderId: PUBKEY,
        packetKey: '100',
        latitude: 26.15,
        longitude: -80.25,
        receivedAt: 1_700_000_000_000,
        receptions: [meshcoreReception({ id: 2, hopsAway: 2, pathKey: 'h2:a1b2' })],
        bestSnr: 5.5,
        bestRssi: -85,
      };

      render(<CoverageMap fixes={[fix]} receivers={meshcoreReceivers} metric="snr" senderNames={new Map()} fitKey="k" />);
      expect(screen.getByText('2 hops via A1B2')).toBeInTheDocument();
      // Never calls relayHex (Meshtastic's `0x..` convention) on a MeshCore row.
      expect(screen.queryByText(/0x/)).not.toBeInTheDocument();
    });

    it('never calls relayHex for a MeshCore row even when relayNode happens to be set', () => {
      const fix: CoverageFix<CoverageReceptionDto> = {
        senderId: PUBKEY,
        packetKey: '100',
        latitude: 26.15,
        longitude: -80.25,
        receivedAt: 1_700_000_000_000,
        receptions: [meshcoreReception({ id: 3, hopsAway: 1, pathKey: 'h1:aa', relayNode: 0xab })],
        bestSnr: 5.5,
        bestRssi: -85,
      };

      render(<CoverageMap fixes={[fix]} receivers={meshcoreReceivers} metric="snr" senderNames={new Map()} fitKey="k" />);
      expect(screen.getByText('1 hops via AA')).toBeInTheDocument();
      expect(screen.queryByText(/via 0x/)).not.toBeInTheDocument();
    });

    it('abbreviates the sender pubkey in the popup header via formatCoverageNodeId', () => {
      const fix: CoverageFix<CoverageReceptionDto> = {
        senderId: PUBKEY,
        packetKey: '100',
        latitude: 26.15,
        longitude: -80.25,
        receivedAt: 1_700_000_000_000,
        receptions: [meshcoreReception({ id: 4, hopsAway: 0, pathKey: 'h0:-' })],
        bestSnr: 5.5,
        bestRssi: -85,
      };

      render(<CoverageMap fixes={[fix]} receivers={meshcoreReceivers} metric="snr" senderNames={new Map()} fitKey="k" />);
      const popup = within(screen.getByTestId('coverage-fix-popup'));
      expect(popup.getByText('a1b2c3d4… — 1 reception(s)')).toBeInTheDocument();
      expect(popup.queryByText(new RegExp(PUBKEY))).not.toBeInTheDocument();
    });

    it('an Observer (mqtt_gateway + meshcore) marker keeps the dashed gateway style and labels itself "Observer"', () => {
      const observerReceivers: CoverageReceiverDto[] = [
        {
          sourceId: 'src-obs', sourceName: 'Source Observer', protocol: 'meshcore', receiverKind: 'mqtt_gateway',
          receiverId: PUBKEY, receiverNodeNum: null, longName: 'Observer One', shortName: null,
          latitude: 26.2, longitude: -80.3, lastReceivedAt: 1, receptionCount: 5,
        },
      ];

      render(<CoverageMap fixes={[]} receivers={observerReceivers} metric="snr" senderNames={new Map()} fitKey="k" />);
      const marker = screen.getByTestId('circle-marker');
      expect(marker).toHaveAttribute('data-dash', '4,3');
      expect(marker).toHaveTextContent('Observer One · Observer');
      expect(marker).not.toHaveTextContent('Gateway');
    });

    it('a MeshCore mqtt_gateway popup badge reads "Observer", not "Gateway"', () => {
      const observerReceivers: CoverageReceiverDto[] = [
        {
          sourceId: 'src-obs', sourceName: 'Source Observer', protocol: 'meshcore', receiverKind: 'mqtt_gateway',
          receiverId: PUBKEY, receiverNodeNum: null, longName: 'Observer One', shortName: null,
          latitude: 26.2, longitude: -80.3, lastReceivedAt: 1, receptionCount: 5,
        },
      ];
      const fix: CoverageFix<CoverageReceptionDto> = {
        senderId: PUBKEY,
        packetKey: '100',
        latitude: 26.15,
        longitude: -80.25,
        receivedAt: 1_700_000_000_000,
        receptions: [
          meshcoreReception({
            id: 5, hopsAway: 0, pathKey: 'h0:-', receiverKind: 'mqtt_gateway', sourceId: 'src-obs',
            receiverLatitude: 26.2, receiverLongitude: -80.3,
          }),
        ],
        bestSnr: 5.5,
        bestRssi: -85,
      };

      render(
        <CoverageMap fixes={[fix]} receivers={observerReceivers} metric="snr" senderNames={new Map()} fitKey="k" />,
      );
      const popup = within(screen.getByTestId('coverage-fix-popup'));
      expect(popup.getByText('Observer')).toBeInTheDocument();
      expect(popup.queryByText('Gateway')).not.toBeInTheDocument();
    });
  });

  describe('gaps + grid view (#5277 Phase 4a WP2, spec §2a.6)', () => {
    const gap: CoverageGap = {
      from: { packetKey: '100', firstReceivedAt: 1_700_000_000_000, latitude: 26.1, longitude: -80.2 },
      to: { packetKey: '105', firstReceivedAt: 1_700_000_150_000, latitude: 26.11, longitude: -80.21 },
      durationSec: 150,
      distanceM: 250,
      missedEstimate: 4,
    };

    it('always passes preferCanvas to BaseMap (decision A6)', () => {
      render(<CoverageMap fixes={[]} receivers={[]} metric="snr" senderNames={new Map()} fitKey="k" />);
      expect(screen.getByTestId('base-map')).toHaveAttribute('data-prefer-canvas', 'true');
    });

    it('renders no gap polylines when gaps is omitted', () => {
      render(<CoverageMap fixes={[]} receivers={[]} metric="snr" senderNames={new Map()} fitKey="k" />);
      expect(screen.queryByTestId('gap-polyline')).not.toBeInTheDocument();
    });

    it('renders one dashed Polyline per gap with the right endpoints, weight and tooltip', () => {
      render(
        <CoverageMap fixes={[]} receivers={[]} metric="snr" senderNames={new Map()} fitKey="k" gaps={[gap]} />,
      );
      const line = screen.getByTestId('gap-polyline');
      expect(line).toHaveAttribute(
        'data-positions',
        JSON.stringify([
          [26.1, -80.2],
          [26.11, -80.21],
        ]),
      );
      expect(line).toHaveAttribute('data-dash', '6 6');
      expect(line).toHaveAttribute('data-weight', '2');
      expect(line).toHaveTextContent('Likely gap: 2 min 30 s, about 4 fixes missed');
    });

    it('falls back to the default neutral colour for the gap line when no CSS var resolves (jsdom)', () => {
      render(
        <CoverageMap fixes={[]} receivers={[]} metric="snr" senderNames={new Map()} fitKey="k" gaps={[gap]} />,
      );
      expect(screen.getByTestId('gap-polyline')).toHaveAttribute('data-color', '#6c7086');
    });

    it('formats a sub-minute gap duration without a minutes component', () => {
      const shortGap: CoverageGap = { ...gap, durationSec: 45, missedEstimate: 1 };
      render(
        <CoverageMap fixes={[]} receivers={[]} metric="snr" senderNames={new Map()} fitKey="k" gaps={[shortGap]} />,
      );
      expect(screen.getByTestId('gap-polyline')).toHaveTextContent('Likely gap: 45 s, about 1 fixes missed');
    });

    it('draws gap polylines before markers so they sit under them (Leaflet stacks by add order)', () => {
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
      render(
        <CoverageMap
          fixes={[fix]}
          receivers={receivers}
          metric="snr"
          senderNames={SENDER_NAMES}
          fitKey="k"
          gaps={[gap]}
        />,
      );
      const baseMap = screen.getByTestId('base-map');
      const nodes = Array.from(baseMap.querySelectorAll('[data-testid]'));
      const gapIndex = nodes.findIndex((n) => n.getAttribute('data-testid') === 'gap-polyline');
      const markerIndex = nodes.findIndex((n) => n.getAttribute('data-testid') === 'circle-marker');
      expect(gapIndex).toBeGreaterThanOrEqual(0);
      expect(markerIndex).toBeGreaterThan(gapIndex);
    });

    describe('grid view', () => {
      const gridCells: CoverageGridCell[] = [
        { key: '1:1', south: 26.1, west: -80.2, north: 26.11, east: -80.19, medianValue: -4.5, fixCount: 6 },
        { key: '2:2', south: 26.2, west: -80.3, north: 26.21, east: -80.29, medianValue: null, fixCount: 3 },
      ];

      it('does not render grid cells in the default (dots) view even when gridCells is passed', () => {
        render(
          <CoverageMap
            fixes={[]}
            receivers={[]}
            metric="snr"
            senderNames={new Map()}
            fitKey="k"
            gridCells={gridCells}
          />,
        );
        expect(screen.queryByTestId('grid-cell')).not.toBeInTheDocument();
      });

      it('renders one Rectangle per cell in grid view, coloured by median value', () => {
        render(
          <CoverageMap
            fixes={[]}
            receivers={[]}
            metric="snr"
            senderNames={new Map()}
            fitKey="k"
            view="grid"
            gridCells={gridCells}
          />,
        );
        const cells = screen.getAllByTestId('grid-cell');
        expect(cells).toHaveLength(2);
        expect(cells[0]).toHaveAttribute(
          'data-bounds',
          JSON.stringify([
            [26.1, -80.2],
            [26.11, -80.19],
          ]),
        );
        expect(cells[0]).toHaveAttribute('data-fill', '#f97316'); // -4.5 dB => fair band
        expect(cells[0]).toHaveAttribute('data-fill-opacity', '0.55');
        expect(cells[0]).toHaveTextContent('Median SNR -4.5 dB · 6 fixes');
      });

      it('shows the no-data tooltip and the noData band colour for a cell with a null median', () => {
        render(
          <CoverageMap
            fixes={[]}
            receivers={[]}
            metric="snr"
            senderNames={new Map()}
            fitKey="k"
            view="grid"
            gridCells={gridCells}
          />,
        );
        const cells = screen.getAllByTestId('grid-cell');
        expect(cells[1]).toHaveAttribute('data-fill', '#6c7086');
        expect(cells[1]).toHaveTextContent('No SNR data · 3 fixes');
      });

      it('colours grid cells with the RSSI band and unit when metric is rssi', () => {
        render(
          <CoverageMap
            fixes={[]}
            receivers={[]}
            metric="rssi"
            senderNames={new Map()}
            fitKey="k"
            view="grid"
            gridCells={[
              { key: '3:3', south: 26.3, west: -80.4, north: 26.31, east: -80.39, medianValue: -70, fixCount: 2 },
            ]}
          />,
        );
        const cell = screen.getByTestId('grid-cell');
        expect(cell).toHaveTextContent('Median RSSI -70.0 dBm · 2 fixes');
        expect(cell).toHaveAttribute('data-fill', '#22c55e'); // -70 dBm => excellent band
      });

      it('hides fix dots but still shows receiver markers in grid view', () => {
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
        render(
          <CoverageMap
            fixes={[fix]}
            receivers={receivers}
            metric="snr"
            senderNames={SENDER_NAMES}
            fitKey="k"
            view="grid"
          />,
        );
        // Only the 2 receiver markers — no fix dot, no popup.
        expect(screen.getAllByTestId('circle-marker')).toHaveLength(2);
        expect(screen.queryByTestId('coverage-fix-popup')).not.toBeInTheDocument();
      });

      it('shows fix dots (not rectangles) in the default dots view even when gridCells is passed', () => {
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
        render(
          <CoverageMap
            fixes={[fix]}
            receivers={receivers}
            metric="snr"
            senderNames={SENDER_NAMES}
            fitKey="k"
            gridCells={gridCells}
          />,
        );
        expect(screen.getAllByTestId('circle-marker')).toHaveLength(3); // 2 receivers + 1 fix
        expect(screen.queryByTestId('grid-cell')).not.toBeInTheDocument();
      });
    });
  });
});
