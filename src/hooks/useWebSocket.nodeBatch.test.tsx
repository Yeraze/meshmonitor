/**
 * `node:batch`: coalesced node changes (MQTT ingest) merge into the poll cache
 * in one pass, the same way `node:updated` merges one node.
 * @vitest-environment jsdom
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

type Handler = (...args: unknown[]) => void;

const fake = vi.hoisted(() => {
  const handlers = new Map<string, Handler[]>();
  const socket = {
    id: 'fake-socket',
    on: vi.fn((event: string, handler: Handler) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
      return socket;
    }),
    emit: vi.fn(),
    disconnect: vi.fn(),
  };
  return {
    socket,
    handlers,
    fire: (event: string, ...args: unknown[]) => (handlers.get(event) ?? []).forEach((handler) => handler(...args)),
  };
});

vi.mock('socket.io-client', () => ({ io: vi.fn(() => fake.socket) }));
vi.mock('../init', () => ({ appBasename: '' }));

import { useWebSocket } from './useWebSocket';
import { SourceProvider } from '../contexts/SourceContext';
import { sourcePollQueryKey, type PollData } from './usePoll';

describe('useWebSocket node:batch', () => {
  beforeEach(() => {
    fake.handlers.clear();
  });

  function setup(nodes: unknown[]) {
    const client = new QueryClient();
    client.setQueryData(sourcePollQueryKey('src-1'), { nodes, messages: [] } as unknown as PollData);
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={client}>
        <SourceProvider sourceId="src-1" sourceName="Source" sourceType="mqtt_bridge">{children}</SourceProvider>
      </QueryClientProvider>
    );
    renderHook(() => useWebSocket(true), { wrapper });
    return () => client.getQueryData<PollData>(sourcePollQueryKey('src-1'));
  }

  it('merges lastHeard and rebuilds position for every node in the batch', () => {
    const read = setup([
      { nodeNum: 1, lastHeard: 100, user: { id: '!00000001' } },
      { nodeNum: 2, lastHeard: 100, user: { id: '!00000002' } },
      { nodeNum: 3, lastHeard: 100, user: { id: '!00000003' } },
    ]);
    act(() => fake.fire('node:batch', { 1: { lastHeard: 200 }, 2: { lastHeard: 300, latitude: 30, longitude: -90, altitude: 5 }, 99: { lastHeard: 1 } }));
    const nodes = read()!.nodes as Array<Record<string, unknown>>;
    expect(nodes.map((n) => n.lastHeard)).toEqual([200, 300, 100]);
    expect(nodes[1].position).toEqual({ latitude: 30, longitude: -90, altitude: 5 });
    // A node not in the cache is not invented; the next poll brings it in.
    expect(nodes).toHaveLength(3);
  });

  it('leaves the cache untouched when no cached node is in the batch', () => {
    const read = setup([{ nodeNum: 1, lastHeard: 100 }]);
    const before = read();
    act(() => fake.fire('node:batch', { 42: { lastHeard: 1 } }));
    expect(read()).toBe(before);
  });
});
