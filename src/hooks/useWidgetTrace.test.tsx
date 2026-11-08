/**
 * @vitest-environment jsdom
 *
 * useWidgetTrace normalises a Meshtastic poll traceroute and a MeshCore
 * latest-trace into one WidgetTrace (#6263 S6).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const traceroutes: unknown[] = [];
vi.mock('./useTraceroutes', () => ({
  useTraceroutes: () => ({ traceroutes, isLoading: false }),
}));
const apiGet = vi.fn();
vi.mock('../services/api', () => ({ default: { get: (...a: unknown[]) => apiGet(...a) } }));

import { useWidgetTrace, buildMeshCoreWidgetTrace } from './useWidgetTrace';

const wrapper = ({ children }: { children: React.ReactNode }) => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
};

const mtNode = (num: number, name: string, lat: number, lon: number) => ({
  nodeNum: num,
  user: { id: `!${num.toString(16).padStart(8, '0')}`, longName: name },
  position: { latitude: lat, longitude: lon },
});

const KEY = (p: string) => p.padEnd(64, '0');

describe('useWidgetTrace', () => {
  beforeEach(() => {
    traceroutes.length = 0;
    apiGet.mockReset();
  });

  it('Meshtastic: parses route + SNR, resolves names and positions, no return leg', () => {
    const nodes = new Map<string, any>([
      ['!00000010', mtNode(0x10, 'From', 1, 1)],
      ['!00000020', mtNode(0x20, 'Relay', 1, 2)],
      ['!00000030', mtNode(0x30, 'To', 1, 3)],
    ]);
    traceroutes.push({
      fromNodeNum: 0x10, toNodeNum: 0x30, fromNodeId: '!00000010', toNodeId: '!00000030',
      route: '[32]', routeBack: '[]', snrTowards: '[20,12]', snrBack: '[]',
      timestamp: 5000, createdAt: 5000, hopCount: 1,
    });
    const { result } = renderHook(
      () => useWidgetTrace('meshtastic', { sourceId: 's', targetNodeId: '!00000030', currentNodeId: null, nodes }),
      { wrapper },
    );
    const t = result.current.trace!;
    expect(t.forward.map((h) => h.label)).toEqual(['From', 'Relay', 'To']);
    expect(t.forward[1].snr).toBe(5);
    expect(t.forward[2].snr).toBe(5);
    expect(t.forward[1].lon).toBe(2);
    expect(t.back).toBeNull();
    expect(apiGet).not.toHaveBeenCalled();
  });

  it('Meshtastic: returns null with no matching traceroute or no target', () => {
    const { result } = renderHook(
      () => useWidgetTrace('meshtastic', { sourceId: 's', targetNodeId: null, currentNodeId: null, nodes: new Map() }),
      { wrapper },
    );
    expect(result.current.trace).toBeNull();
  });

  it('MeshCore: wraps latest-trace into local -> relays -> target and never calls the poll data', async () => {
    const local = KEY('aa01');
    const relay = KEY('bb02');
    const target = KEY('cc03');
    const nodes = new Map<string, any>([
      [local, { nodeNum: 1, user: { id: local, longName: 'Home' }, position: { latitude: 10, longitude: 10 } }],
      [relay, { nodeNum: 2, user: { id: relay, longName: 'Hill' }, position: { latitude: 10, longitude: 11 } }],
      [target, { nodeNum: 3, user: { id: target, longName: 'Far' }, position: { latitude: 10, longitude: 12 } }],
    ]);
    apiGet.mockResolvedValue({
      data: {
        trace: {
          timestamp: 9000,
          hops: [
            { hopIndex: 0, receiverPublicKey: null, receiverHash: null, snr: 3 }, // link into our radio
            { hopIndex: 1, receiverPublicKey: null, receiverHash: 'bb', snr: 6.5 },
            { hopIndex: 2, receiverPublicKey: target, receiverHash: 'cc', snr: -2 },
          ],
        },
      },
    });
    const { result } = renderHook(
      () => useWidgetTrace('meshcore', { sourceId: 'src 1', targetNodeId: target, currentNodeId: local, nodes }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.trace).not.toBeNull());
    expect(apiGet).toHaveBeenCalledWith(
      `/api/sources/src%201/meshcore/hop-snr/latest-trace?publicKey=${target}`,
    );
    const t = result.current.trace!;
    expect(t.forward.map((h) => h.label)).toEqual(['Home', 'Hill', 'Far']);
    expect(t.forward.map((h) => h.snr)).toEqual([null, 6.5, -2]);
    expect(t.timestamp).toBe(9000);
    expect(t.back).toBeNull();
  });

  it('MeshCore: no stored trace gives null', async () => {
    apiGet.mockResolvedValue({ data: { trace: null } });
    const { result } = renderHook(
      () => useWidgetTrace('meshcore', { sourceId: 's', targetNodeId: KEY('cc03'), currentNodeId: null, nodes: new Map() }),
      { wrapper },
    );
    await waitFor(() => expect(apiGet).toHaveBeenCalled());
    expect(result.current.trace).toBeNull();
  });

  it('MeshCore builder: an ambiguous hash stays an unresolved hop', () => {
    const nodes = new Map<string, any>([
      [KEY('bb01'), { nodeNum: 1, user: { id: KEY('bb01'), longName: 'B1' } }],
      [KEY('bb02'), { nodeNum: 2, user: { id: KEY('bb02'), longName: 'B2' } }],
    ]);
    const t = buildMeshCoreWidgetTrace(
      { timestamp: 1, hops: [{ hopIndex: 1, receiverPublicKey: null, receiverHash: 'bb', snr: 1 }] },
      nodes,
      null,
      KEY('cc03'),
    );
    expect(t.forward[0].key).toBe('h:bb');
    expect(t.forward[0].label).toBe('#bb');
    expect(t.forward[0].lat).toBeNull();
  });
});
