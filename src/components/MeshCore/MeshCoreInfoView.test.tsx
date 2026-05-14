/**
 * @vitest-environment jsdom
 *
 * Smoke tests for the MeshCore Node Info view.
 *
 * Verifies the page renders the identity / radio / health blocks pulled
 * from `/api/sources/:id/meshcore/info` and that the graph grid is hidden
 * for non-Companion devices. The TanStack Query layer is shimmed via a
 * fresh `QueryClientProvider` per test so caches don't bleed across runs.
 */
import type { ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MeshCoreInfoView } from './MeshCoreInfoView';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string | Record<string, unknown>) => {
      if (typeof fallback === 'string') return fallback;
      return key;
    },
  }),
}));

// Recharts uses ResizeObserver. jsdom doesn't ship it, and the graph grid
// only renders when there's *no* matching `mc_` telemetry anyway in these
// tests — but pulling Recharts in still triggers it, so stub.
class StubResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
// @ts-expect-error - polyfill for jsdom
globalThis.ResizeObserver = StubResizeObserver;

function withQueryClient(ui: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
  });
  return <QueryClientProvider client={client}>{ui}</QueryClientProvider>;
}

const PK = 'a'.repeat(60) + 'beef';

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('MeshCoreInfoView', () => {
  it('renders identity, radio, and health blocks from the info endpoint', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('/meshcore/info')) {
        return new Response(
          JSON.stringify({
            success: true,
            data: {
              sourceId: 'src-a',
              connected: true,
              deviceType: 1,
              deviceTypeName: 'Companion',
              identity: {
                publicKey: PK,
                name: 'MerlinNode',
                advType: 1,
                radioFreq: 869.525,
                radioBw: 250,
                radioSf: 11,
                radioCr: 5,
                txPower: 20,
                maxTxPower: 22,
                latitude: 30.123,
                longitude: -90.456,
                firmwareVer: 9,
                firmwareBuild: '2024-11-01',
                model: 'Heltec V3',
                ver: '1.2.3',
              },
              latest: {
                timestamp: 1700000000000,
                batteryMv: 4080,
                uptimeSecs: 3 * 3600 + 17 * 60,
                queueLen: 3,
                noiseFloor: -126,
                lastRssi: -85,
                lastSnr: 7.25,
                rtcDriftSecs: -1,
              },
              telemetryRef: { nodeId: PK, nodeNum: 0xbeef, sourceId: 'src-a' },
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      // Telemetry endpoint — no rows yet, so the graphs grid stays empty.
      return new Response(JSON.stringify([]), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    render(
      withQueryClient(
        <MeshCoreInfoView baseUrl="" sourceId="src-a" status={null} />,
      ),
    );

    await waitFor(() => {
      expect(screen.getByText('MerlinNode')).toBeTruthy();
    });

    // Identity card — pubkey is shown in shortened form (first 12 + last 4).
    expect(screen.getByText(`${PK.substring(0, 12)}…${PK.substring(PK.length - 4)}`)).toBeTruthy();
    expect(screen.getByText('Heltec V3')).toBeTruthy();
    expect(screen.getByText(/1\.2\.3/)).toBeTruthy();
    expect(screen.getByText('30.12300, -90.45600')).toBeTruthy();

    // Radio card
    expect(screen.getByText('869.525 MHz')).toBeTruthy();
    expect(screen.getByText('250 kHz')).toBeTruthy();
    expect(screen.getByText('11')).toBeTruthy();
    expect(screen.getByText('4/5')).toBeTruthy();
    expect(screen.getByText('20 / 22 dBm')).toBeTruthy();

    // Health card
    expect(screen.getByText('4.08 V')).toBeTruthy();
    expect(screen.getByText('3h 17m')).toBeTruthy();
    expect(screen.getByText('3')).toBeTruthy();
    expect(screen.getByText('-1 s')).toBeTruthy();
  });

  it('suppresses graphs and shows a note for non-Companion sources', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.endsWith('/meshcore/info')) {
          return new Response(
            JSON.stringify({
              success: true,
              data: {
                sourceId: 'src-rpt',
                connected: true,
                deviceType: 2, // Repeater
                deviceTypeName: 'Repeater',
                identity: { publicKey: PK, name: 'Repeater Rico', advType: 2 },
                latest: null,
                telemetryRef: { nodeId: PK, nodeNum: 1, sourceId: 'src-rpt' },
              },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        return new Response(JSON.stringify([]), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }) as unknown as typeof fetch,
    );

    render(
      withQueryClient(
        <MeshCoreInfoView baseUrl="" sourceId="src-rpt" status={null} />,
      ),
    );

    await waitFor(() => {
      expect(screen.getByText('Repeater Rico')).toBeTruthy();
    });

    // The repeater path renders the note and *not* the graphs grid.
    expect(screen.getByText(/Local stats are only available for Companion devices/)).toBeTruthy();
    expect(screen.queryByTestId('meshcore-info-graphs')).toBeNull();
  });

  it('renders an empty-state when the source has no localNode', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              success: true,
              data: {
                sourceId: 'src-disconnected',
                connected: false,
                deviceType: 0,
                deviceTypeName: 'Unknown',
                identity: null,
                latest: null,
                telemetryRef: null,
              },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
      ) as unknown as typeof fetch,
    );

    render(
      withQueryClient(
        <MeshCoreInfoView baseUrl="" sourceId="src-disconnected" status={null} />,
      ),
    );

    await waitFor(() => {
      expect(screen.getByText(/source disconnected/i)).toBeTruthy();
    });
  });
});
