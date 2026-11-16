/**
 * MeshCore raises `connection:status` data events (#6437) so the automation
 * system events `source-connected` / `source-disconnected` fire for MeshCore
 * sources. Edge-triggered: a reconnect loop raises one disconnected event, not
 * one per attempt.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MeshCoreManager } from './meshcoreManager.js';
import { dataEventEmitter, type DataEvent } from './services/dataEventEmitter.js';
import { routeEventToEngine } from './services/automation/automationEngineSingleton.js';
import type { AutomationEngineService } from './services/automation/automationEngineService.js';

describe('MeshCoreManager connection status events (#6437)', () => {
  let events: DataEvent[];
  const listener = (e: DataEvent) => {
    if (e.type === 'connection:status') events.push(e);
  };

  beforeEach(() => {
    events = [];
    dataEventEmitter.on('data', listener);
  });
  afterEach(() => {
    dataEventEmitter.off('data', listener);
  });

  const setState = (m: MeshCoreManager, s: string) => {
    (m as any).connectionState = s;
  };
  const flags = () => events.map((e) => (e.data as { connected: boolean }).connected);

  it('raises one connected event on connect, tagged with the source id', () => {
    const m = new MeshCoreManager('mc-1');
    setState(m, 'connecting');
    expect(events).toHaveLength(0);
    setState(m, 'connected');
    expect(flags()).toEqual([true]);
    expect(events[0].sourceId).toBe('mc-1');
  });

  it('raises one disconnected event across a whole reconnect loop', () => {
    const m = new MeshCoreManager('mc-1');
    setState(m, 'connected');
    setState(m, 'reconnecting');
    // Failed attempts: connecting -> reconnecting, several times.
    for (let i = 0; i < 5; i++) {
      setState(m, 'connecting');
      setState(m, 'reconnecting');
    }
    setState(m, 'failed');
    expect(flags()).toEqual([true, false]);
  });

  it('raises one connected event when the reconnect succeeds', () => {
    const m = new MeshCoreManager('mc-1');
    setState(m, 'connected');
    setState(m, 'reconnecting');
    setState(m, 'connecting');
    setState(m, 'connected');
    expect(flags()).toEqual([true, false, true]);
  });

  it('raises one disconnected event for a user disconnect, none if already down', () => {
    const m = new MeshCoreManager('mc-1');
    setState(m, 'connected');
    setState(m, 'disconnected');
    setState(m, 'disconnected');
    expect(flags()).toEqual([true, false]);
    // A second user disconnect while down raises nothing.
    setState(m, 'disconnected');
    expect(events).toHaveLength(2);
  });

  it('does not raise an event for a source that never connected', () => {
    const m = new MeshCoreManager('mc-1');
    setState(m, 'connecting');
    setState(m, 'reconnecting');
    setState(m, 'failed');
    expect(events).toHaveLength(0);
  });

  it('does not share dedup state between sources', () => {
    const a = new MeshCoreManager('mc-a');
    const b = new MeshCoreManager('mc-b');
    setState(a, 'connected');
    setState(b, 'connected');
    setState(a, 'reconnecting');
    expect(events.map((e) => [e.sourceId, (e.data as { connected: boolean }).connected])).toEqual([
      ['mc-a', true],
      ['mc-b', true],
      ['mc-a', false],
    ]);
  });

  it('reaches the automation engine as source-connected / source-disconnected', async () => {
    const onSystem = vi.fn().mockResolvedValue(0);
    const engine = { onSystem } as unknown as AutomationEngineService;
    const route = (e: DataEvent) => {
      if (e.type === 'connection:status') void routeEventToEngine(engine, e);
    };
    dataEventEmitter.on('data', route);
    try {
      const m = new MeshCoreManager('mc-1');
      setState(m, 'connected');
      setState(m, 'reconnecting');
      setState(m, 'connecting');
      setState(m, 'reconnecting');
      await Promise.resolve();
      expect(onSystem.mock.calls.map((c) => [c[0], c[1]])).toEqual([
        ['source-connected', 'mc-1'],
        ['source-disconnected', 'mc-1'],
      ]);
    } finally {
      dataEventEmitter.off('data', route);
    }
  });
});
