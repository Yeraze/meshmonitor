/**
 * Which sources the socket asks for.
 *
 * The server sends a socket nothing until it subscribes. A source view joins
 * its source; a unified view (no source in context) used to join nothing and
 * rely on "no room = every source", and must now ask for every permitted
 * source. Without that the unified pages get no live updates.
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

function wrapperFor(sourceId: string | null) {
  const client = new QueryClient();
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={client}>
      {sourceId
        ? <SourceProvider sourceId={sourceId} sourceName="Source" sourceType="meshtastic_tcp">{children}</SourceProvider>
        : children}
    </QueryClientProvider>
  );
}

describe('useWebSocket subscription', () => {
  beforeEach(() => {
    fake.handlers.clear();
    fake.socket.emit.mockClear();
  });

  it('a source view joins its source when the server greets it', () => {
    renderHook(() => useWebSocket(true), { wrapper: wrapperFor('src-1') });
    expect(fake.socket.emit).not.toHaveBeenCalled();
    act(() => fake.fire('connected', { socketId: 'fake-socket', timestamp: 1 }));
    expect(fake.socket.emit.mock.calls).toEqual([['join-source', 'src-1']]);
  });

  it('a unified view asks for every permitted source', () => {
    renderHook(() => useWebSocket(true), { wrapper: wrapperFor(null) });
    act(() => fake.fire('connected', { socketId: 'fake-socket', timestamp: 1 }));
    expect(fake.socket.emit.mock.calls).toEqual([['join-all-sources']]);
  });

  it('subscribes again after a reconnect (the server greets each connection)', () => {
    renderHook(() => useWebSocket(true), { wrapper: wrapperFor(null) });
    act(() => fake.fire('connected', { socketId: 'a', timestamp: 1 }));
    act(() => fake.fire('connected', { socketId: 'b', timestamp: 2 }));
    expect(fake.socket.emit.mock.calls).toEqual([['join-all-sources'], ['join-all-sources']]);
  });

  it('opens no socket when not enabled (signed out)', () => {
    renderHook(() => useWebSocket(false), { wrapper: wrapperFor(null) });
    expect(fake.handlers.size).toBe(0);
  });
});
