/**
 * @vitest-environment jsdom
 *
 * MeshCoreIngestView — the per-source surface for a `meshcore_mqtt` source (#5096).
 *
 * Before this, an ingest source fell through main.tsx's routing to the
 * Meshtastic `<App />` shell. These tests cover the parts that would otherwise
 * only be caught by looking at the page: that it renders the ingest identity,
 * that it says plainly this source cannot transmit, and that each tab asks for
 * its own endpoint rather than a device one.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

const get = vi.fn();
vi.mock('../../services/api', () => ({ default: { get: (...a: unknown[]) => get(...a) } }));

// The packet monitor has its own suite; stub it so this one stays about the
// ingest shell rather than re-testing that view's fetching.
vi.mock('./MeshCorePacketMonitorView', () => ({
  MeshCorePacketMonitorView: ({ sourceId }: { sourceId: string }) => (
    <div data-testid="packet-monitor">{sourceId}</div>
  ),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_k: string, fallback?: string) => fallback ?? _k }),
}));

vi.mock('../icons', () => ({ UiIcon: () => <span /> }));

import { MeshCoreIngestView } from './MeshCoreIngestView';

const OVERVIEW = {
  success: true,
  data: {
    connected: true,
    status: { region: 'MCO', brokerUrl: 'wss://broker.example' },
    nodeCount: 47,
    observers: [
      {
        publicKey: 'a'.repeat(64),
        online: true,
        lastSeenMs: Date.now() - 30_000,
        batteryMv: 4100,
        uptimeSecs: 7200,
        noiseFloor: -95,
      },
    ],
  },
};

beforeEach(() => {
  get.mockReset();
  get.mockImplementation(async (url: string) => {
    if (url.includes('/overview')) return OVERVIEW;
    if (url.includes('/nodes')) {
      return {
        success: true,
        data: {
          nodes: [
            {
              publicKey: 'b'.repeat(64),
              name: 'Observed Repeater',
              latitude: 39.5,
              longitude: -104.5,
              lastHeard: Date.now() - 60_000,
            },
          ],
        },
      };
    }
    if (url.includes('/messages')) {
      return {
        success: true,
        data: { messages: [{ id: 'm1', channelIdx: 0, text: 'hello region', timestamp: Date.now() }] },
      };
    }
    return { success: true, data: {} };
  });
});

const renderView = () => render(<MeshCoreIngestView sourceId="src-1" baseUrl="/mm" />);

describe('MeshCoreIngestView (#5096)', () => {
  it('shows the region and broker it reads', async () => {
    renderView();
    expect(await screen.findByText('MCO')).toBeTruthy();
    expect(screen.getByText('wss://broker.example')).toBeTruthy();
  });

  it('states plainly that the source cannot transmit', async () => {
    // The one thing a user must not have to discover by experiment.
    renderView();
    expect(await screen.findByText(/cannot transmit/i)).toBeTruthy();
  });

  it('requests only ingest endpoints, never a device route', async () => {
    renderView();
    await waitFor(() => expect(get).toHaveBeenCalled());
    for (const [url] of get.mock.calls) {
      expect(String(url)).toContain('/meshcore/ingest/');
    }
  });

  it('reports the node and observer counts from the overview', async () => {
    renderView();
    expect(await screen.findByText('47')).toBeTruthy();
    expect(screen.getByText('1')).toBeTruthy();
  });

  it('renders the observer noise floor, which has no other per-source surface', async () => {
    renderView();
    expect(await screen.findByText('-95 dB')).toBeTruthy();
  });

  it('loads nodes only once the Nodes tab is opened', async () => {
    renderView();
    await waitFor(() => expect(get).toHaveBeenCalled());
    expect(get.mock.calls.some(([u]) => String(u).includes('/nodes'))).toBe(false);

    fireEvent.click(screen.getByText('Nodes', { selector: 'button' }));
    expect(await screen.findByText('Observed Repeater')).toBeTruthy();
  });

  it('loads channel messages only once the Channels tab is opened', async () => {
    renderView();
    await waitFor(() => expect(get).toHaveBeenCalled());

    fireEvent.click(screen.getByText('Channels', { selector: 'button' }));
    expect(await screen.findByText('hello region')).toBeTruthy();
  });

  it('mounts the packet monitor for this source on the Packets tab', async () => {
    // The Phase 2b ingest packet monitor had no route into the UI at all
    // before this page existed.
    renderView();
    await waitFor(() => expect(get).toHaveBeenCalled());

    fireEvent.click(screen.getByText('Packets', { selector: 'button' }));
    expect(await screen.findByTestId('packet-monitor')).toBeTruthy();
  });

  it('shows an empty state rather than a blank panel when no observers report', async () => {
    get.mockImplementation(async () => ({
      success: true,
      data: { connected: false, status: {}, nodeCount: 0, observers: [] },
    }));
    renderView();
    expect(await screen.findByText(/No observer status heartbeats/i)).toBeTruthy();
  });

  it('surfaces a failed overview fetch instead of rendering a silently empty page', async () => {
    get.mockRejectedValue(new Error('broker unreachable'));
    renderView();
    expect(await screen.findByText(/broker unreachable/i)).toBeTruthy();
  });
});
