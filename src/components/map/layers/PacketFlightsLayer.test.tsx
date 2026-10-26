/**
 * @vitest-environment jsdom
 *
 * Live packet traffic (#4835): the layer subscribes the socket while it is
 * mounted (the toggle is on), unsubscribes when it unmounts, re-subscribes
 * after a reconnect, and drops flights past the per-viewer rate.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, act } from '@testing-library/react';
import type { PacketFlight } from '../../../types/packetFlight';
import type { PacketFlightStats } from '../../../utils/packetFlightEdges';

type Handler = (...args: unknown[]) => void;

const { fakeSocket, animator } = vi.hoisted(() => {
  const handlers = new Map<string, Set<(...args: unknown[]) => void>>();
  const fakeSocket = {
    connected: true,
    emit: vi.fn(),
    on: vi.fn((event: string, fn: (...args: unknown[]) => void) => {
      if (!handlers.has(event)) handlers.set(event, new Set());
      handlers.get(event)!.add(fn);
    }),
    off: vi.fn((event: string, fn: (...args: unknown[]) => void) => {
      handlers.get(event)?.delete(fn);
    }),
    fire(event: string, ...args: unknown[]) {
      for (const fn of handlers.get(event) ?? []) fn(...args);
    },
    listeners(event: string) {
      return handlers.get(event)?.size ?? 0;
    },
    reset() {
      handlers.clear();
    },
  };
  const animator = { add: vi.fn(), destroy: vi.fn(), instances: 0 };
  return { fakeSocket, animator };
});

vi.mock('react-leaflet', () => ({ useMap: () => ({}) }));
vi.mock('../../../contexts/WebSocketContext', () => ({
  useWebSocketContext: () => ({ state: { socket: fakeSocket, connected: true, socketId: 'x', error: null }, enabled: true }),
}));
vi.mock('./packetFlightAnimator', () => ({
  PacketFlightAnimator: class {
    constructor() {
      animator.instances++;
    }
    add = animator.add;
    destroy = animator.destroy;
  },
}));

import { PacketFlightsLayer } from './PacketFlightsLayer';

const NODES = [
  { nodeNum: 1, lat: 30, lng: -90 },
  { nodeNum: 2, lat: 31, lng: -91 },
];

const flight = (sourceId = 'A'): PacketFlight => ({
  sourceId, protocol: 'meshtastic', receivedAt: 0, from: 2, to: 1, relay: null, hopsUsed: 0, kind: 'TEXT_MESSAGE_APP',
});

function Harness({ on, rate = 0, onStats }: { on: boolean; rate?: number; onStats?: (s: PacketFlightStats | null) => void }) {
  return on ? <PacketFlightsLayer sourceIds={['A']} nodes={NODES} maxPerSecond={rate} onStatsChange={onStats} /> : null;
}

describe('PacketFlightsLayer', () => {
  beforeEach(() => {
    fakeSocket.reset();
    fakeSocket.emit.mockClear();
    fakeSocket.connected = true;
    animator.add.mockClear();
    animator.destroy.mockClear();
    animator.instances = 0;
  });

  it('subscribes when the toggle turns on and unsubscribes when it turns off', () => {
    const view = render(<Harness on={false} />);
    expect(fakeSocket.emit).not.toHaveBeenCalled();

    view.rerender(<Harness on />);
    expect(fakeSocket.emit).toHaveBeenCalledWith('packet-flights:subscribe', ['A']);
    expect(fakeSocket.listeners('packet:flight')).toBe(1);

    view.rerender(<Harness on={false} />);
    expect(fakeSocket.emit).toHaveBeenLastCalledWith('packet-flights:unsubscribe', ['A']);
    expect(fakeSocket.listeners('packet:flight')).toBe(0);
    expect(animator.destroy).toHaveBeenCalledTimes(1);
  });

  it('subscribes again after a reconnect', () => {
    render(<Harness on />);
    fakeSocket.emit.mockClear();
    act(() => fakeSocket.fire('connected', { socketId: 'y' }));
    expect(fakeSocket.emit).toHaveBeenCalledWith('packet-flights:subscribe', ['A']);
  });

  it('animates a flight it can place, and skips one from another source or with no position', () => {
    render(<Harness on />);
    act(() => {
      (fakeSocket.fire as Handler)('packet:flight', flight());
      (fakeSocket.fire as Handler)('packet:flight', flight('B'));
      (fakeSocket.fire as Handler)('packet:flight', { ...flight(), from: 99 });
    });
    expect(animator.add).toHaveBeenCalledTimes(1);
    expect(animator.add.mock.calls[0][0]).toEqual({ from: { lat: 31, lng: -91 }, to: { lat: 30, lng: -90 }, viaMesh: false });
  });

  it('drops flights past the rate and reports the last minute by outcome', () => {
    vi.useFakeTimers();
    try {
      const onStats = vi.fn();
      const view = render(<Harness on rate={2} onStats={onStats} />);
      expect(onStats).toHaveBeenLastCalledWith({ received: 0, drawn: 0, noPosition: 0, overRate: 0 });
      act(() => {
        for (let i = 0; i < 5; i++) (fakeSocket.fire as Handler)('packet:flight', flight());
        (fakeSocket.fire as Handler)('packet:flight', { ...flight(), from: 99 });
      });
      expect(animator.add).toHaveBeenCalledTimes(2);
      act(() => {
        vi.advanceTimersByTime(1000);
      });
      expect(onStats).toHaveBeenLastCalledWith({ received: 6, drawn: 2, noPosition: 1, overRate: 3 });
      view.rerender(<Harness on={false} onStats={onStats} />);
      expect(onStats).toHaveBeenLastCalledWith(null);
    } finally {
      vi.useRealTimers();
    }
  });
});
