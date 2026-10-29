/**
 * `node:batch` coalescing: UI-only node changes from high-volume ingest (MQTT)
 * leave as at most one event per source per window, with repeated updates to
 * one node merged.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { dataEventEmitter, NODE_BATCH_INTERVAL_MS, type DataEvent } from './dataEventEmitter.js';

describe('dataEventEmitter.emitNodeBatchUpdate', () => {
  let events: DataEvent[];
  const listener = (e: DataEvent) => events.push(e);

  beforeEach(() => {
    vi.useFakeTimers();
    dataEventEmitter.flushPending();
    events = [];
    dataEventEmitter.on('data', listener);
  });

  afterEach(() => {
    dataEventEmitter.off('data', listener);
    dataEventEmitter.flushPending();
    vi.useRealTimers();
  });

  it('holds updates until the window closes, then sends one event per source', () => {
    dataEventEmitter.emitNodeBatchUpdate(1, { lastHeard: 10 }, 'src-a');
    dataEventEmitter.emitNodeBatchUpdate(2, { lastHeard: 11 }, 'src-a');
    dataEventEmitter.emitNodeBatchUpdate(1, { lastHeard: 12 }, 'src-b');
    vi.advanceTimersByTime(NODE_BATCH_INTERVAL_MS - 1);
    expect(events).toHaveLength(0);

    vi.advanceTimersByTime(1);
    expect(events.map((e) => [e.type, e.sourceId])).toEqual([['node:batch', 'src-a'], ['node:batch', 'src-b']]);
    expect(events[0].data).toEqual({ 1: { lastHeard: 10 }, 2: { lastHeard: 11 } });
    expect(events[1].data).toEqual({ 1: { lastHeard: 12 } });
  });

  it('merges repeated updates to one node, latest value winning, and drops undefined fields', () => {
    dataEventEmitter.emitNodeBatchUpdate(1, { lastHeard: 10, latitude: 1, longitude: 2 }, 'src-a');
    dataEventEmitter.emitNodeBatchUpdate(1, { lastHeard: 20, latitude: undefined }, 'src-a');
    vi.advanceTimersByTime(NODE_BATCH_INTERVAL_MS);
    expect(events).toHaveLength(1);
    expect(events[0].data).toEqual({ 1: { lastHeard: 20, latitude: 1, longitude: 2 } });
  });

  it('a burst of 500 updates across 50 nodes is one event', () => {
    for (let i = 0; i < 500; i++) dataEventEmitter.emitNodeBatchUpdate(i % 50, { lastHeard: i }, 'src-a');
    vi.advanceTimersByTime(NODE_BATCH_INTERVAL_MS);
    expect(events).toHaveLength(1);
    expect(Object.keys(events[0].data as object)).toHaveLength(50);
  });

  it('queues nothing without a source or without any defined field', () => {
    dataEventEmitter.emitNodeBatchUpdate(1, { lastHeard: 10 }, '');
    dataEventEmitter.emitNodeBatchUpdate(2, { lastHeard: undefined }, 'src-a');
    vi.advanceTimersByTime(NODE_BATCH_INTERVAL_MS);
    expect(events).toHaveLength(0);
  });

  it('flushPending sends a queued batch at once', () => {
    dataEventEmitter.emitNodeBatchUpdate(1, { lastHeard: 10 }, 'src-a');
    dataEventEmitter.flushPending();
    expect(events).toHaveLength(1);
    vi.advanceTimersByTime(NODE_BATCH_INTERVAL_MS);
    expect(events).toHaveLength(1);
  });
});
