/**
 * @vitest-environment jsdom
 *
 * Smoke tests for the MeshCore Node Info view.
 *
 * Verifies the page renders the identity / radio / health blocks pulled
 * from `/api/sources/:id/meshcore/info` and that the graph grid is hidden
 * for device types with no local stats (Companion and Repeater have them). The TanStack Query layer is shimmed via a
 * fresh `QueryClientProvider` per test so caches don't bleed across runs.
 */
import type { ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MeshCoreInfoView } from './MeshCoreInfoView';

vi.mock('react-i18next', async () => {
  const { createReactI18nextMock } = await import('../../test/mockI18n');
  return createReactI18nextMock();
});

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

  function stubInfo(data: Record<string, unknown>) {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.endsWith('/meshcore/info')) {
          return new Response(JSON.stringify({ success: true, data }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        return new Response(JSON.stringify([]), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }) as unknown as typeof fetch,
    );
  }

  it('shows health and graphs for a directly-attached Repeater, without the Sync button (#5533)', async () => {
    stubInfo({
      sourceId: 'src-rpt',
      connected: true,
      deviceType: 2, // Repeater
      deviceTypeName: 'Repeater',
      identity: { publicKey: 'repeater', name: 'Repeater Rico', advType: 2 },
      latest: {
        timestamp: 1700000000000,
        batteryMv: 3950,
        uptimeSecs: 2 * 3600 + 5 * 60,
        queueLen: 0,
        noiseFloor: -112,
        lastRssi: -87,
        lastSnr: 7.25,
        rtcDriftSecs: 0,
      },
      telemetryRef: { nodeId: PK, nodeNum: 1, sourceId: 'src-rpt' },
    });

    render(
      withQueryClient(
        <MeshCoreInfoView baseUrl="" sourceId="src-rpt" status={null} onSyncTime={vi.fn()} />,
      ),
    );

    await waitFor(() => {
      expect(screen.getByText('Repeater Rico')).toBeTruthy();
    });

    expect(screen.getByText('3.95 V')).toBeTruthy();
    expect(screen.getByText('2h 5m')).toBeTruthy();
    expect(screen.queryByText(/Local stats are only available/)).toBeNull();
    expect(screen.getByTestId('meshcore-info-graphs')).toBeTruthy();
    // RTC sync writes over the companion protocol: not offered on a Repeater.
    expect(screen.queryByRole('button', { name: /sync/i })).toBeNull();
  });

  it('suppresses graphs and shows a note for device types without local stats', async () => {
    stubInfo({
      sourceId: 'src-room',
      connected: true,
      deviceType: 3, // Room server
      deviceTypeName: 'ROOM_SERVER',
      identity: { publicKey: PK, name: 'Room Rita', advType: 3 },
      latest: null,
      telemetryRef: null,
    });

    render(
      withQueryClient(
        <MeshCoreInfoView baseUrl="" sourceId="src-room" status={null} />,
      ),
    );

    await waitFor(() => {
      expect(screen.getByText('Room Rita')).toBeTruthy();
    });

    expect(screen.getByText(/Local stats are only available for Companion and Repeater devices/)).toBeTruthy();
    expect(screen.queryByTestId('meshcore-info-graphs')).toBeNull();
  });

  it('mounts the Virtual Node card with PKI rows for this source (#5380)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const json = (body: unknown) =>
          new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
        if (url.endsWith('/meshcore/info')) {
          return json({
            success: true,
            data: {
              sourceId: 'src-vn',
              connected: true,
              deviceType: 1,
              deviceTypeName: 'Companion',
              identity: { publicKey: PK, name: 'VN Host', advType: 1 },
              latest: null,
              telemetryRef: null,
            },
          });
        }
        if (url.endsWith('/api/virtual-node/status')) {
          return json({
            sources: [{
              sourceId: 'src-vn', sourceName: 'VN', enabled: true, isRunning: true,
              allowAdminCommands: false, allowPkiExport: true, allowPkiImport: false,
              clientCount: 1, clients: [],
            }],
          });
        }
        return json([]);
      }) as unknown as typeof fetch,
    );

    render(
      withQueryClient(
        <MeshCoreInfoView baseUrl="" sourceId="src-vn" status={null} />,
      ),
    );

    expect(await screen.findByTestId('meshcore-info-virtual-node')).toBeTruthy();
    expect(screen.getByTestId('meshcore-vn-pki-export').textContent).toBe('info.virtual_node_admin_allowed');
    expect(screen.getByTestId('meshcore-vn-pki-import').textContent).toBe('info.virtual_node_admin_blocked');
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
