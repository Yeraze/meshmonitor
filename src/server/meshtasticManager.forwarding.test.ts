/**
 * Meshtastic Message Forwarding wiring (#5446). Rule logic lives in
 * utils/forwardingEngine.test.ts; this checks the manager queues forwards as
 * single-attempt automation sends to the right destination, and respects
 * TX-disabled, airtime gating and the self-origin guard.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MeshtasticManager } from './meshtasticManager.js';
import databaseService from '../services/database.js';
import { forwardingRateLimiter } from './utils/forwardingEngine.js';

function makeManager(rules: unknown[]) {
  const m = new MeshtasticManager('fwd-mt-source');
  vi.spyOn(databaseService.settings, 'getSettingForSource').mockImplementation(
    async (_sourceId: string, key: string) => (key === 'forwardingRules' ? JSON.stringify(rules) : null),
  );
  vi.spyOn(databaseService.nodes, 'getNode').mockResolvedValue({ nodeNum: 0x12345678, shortName: 'ALC' } as never);
  vi.spyOn(databaseService.channels, 'getChannelById').mockResolvedValue({ id: 1, name: 'Ops' } as never);
  const enqueue = vi.fn().mockReturnValue('q1');
  (m as any).enqueueAutomation = enqueue;
  (m as any).canTransmit = () => true;
  (m as any).isAutomationAirtimeGated = async () => false;
  (m as any).localNodeInfo = { nodeNum: 0x0000aaaa };
  return { m, enqueue };
}

const dmRule = {
  id: 'r1', name: 'DMs to phone', enabled: true,
  match: { isDM: true }, forwardTo: { destinationNodeId: '!0000beef' }, prefix: '{from}: ',
};
const chanRule = {
  id: 'c1', name: 'Ops to 2', enabled: true,
  match: { channel: 1 }, forwardTo: { channel: 2 }, prefix: '',
};

const dm = { fromNodeNum: 0x12345678, fromNodeId: '!12345678', text: 'hello', channel: 0 };

describe('MeshtasticManager forwarding (#5446)', () => {
  beforeEach(() => forwardingRateLimiter.clear());
  afterEach(() => vi.restoreAllMocks());

  it('queues a DM forward to the destination node with one attempt', async () => {
    const { m, enqueue } = makeManager([dmRule]);
    await (m as any).checkForwarding(dm, true);
    expect(enqueue).toHaveBeenCalledTimes(1);
    const [text, dest, , , , channel, maxAttempts] = enqueue.mock.calls[0];
    expect(text).toBe('[fwd] ALC: hello');
    expect(dest).toBe(0x0000beef);
    expect(channel).toBeUndefined();
    expect(maxAttempts).toBe(1);
  });

  it('queues a channel forward as a broadcast on the target channel', async () => {
    const { m, enqueue } = makeManager([chanRule]);
    await (m as any).checkForwarding({ ...dm, channel: 1 }, false);
    const [text, dest, , , , channel, maxAttempts] = enqueue.mock.calls[0];
    expect(text).toBe('[fwd] hello');
    expect(dest).toBe(0);
    expect(channel).toBe(2);
    expect(maxAttempts).toBe(1);
  });

  it('sends nothing when TX is disabled', async () => {
    const { m, enqueue } = makeManager([dmRule]);
    (m as any).canTransmit = () => false;
    await (m as any).checkForwarding(dm, true);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('sends nothing while the airtime cutoff is active', async () => {
    const { m, enqueue } = makeManager([dmRule]);
    (m as any).isAutomationAirtimeGated = async () => true;
    await (m as any).checkForwarding(dm, true);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('never forwards a message from our own node', async () => {
    const { m, enqueue } = makeManager([dmRule]);
    await (m as any).checkForwarding({ ...dm, fromNodeNum: 0x0000aaaa, fromNodeId: '!0000aaaa' }, true);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('stops after 5 forwards in a minute', async () => {
    const { m, enqueue } = makeManager([dmRule]);
    for (let i = 0; i < 8; i++) await (m as any).checkForwarding(dm, true);
    expect(enqueue).toHaveBeenCalledTimes(5);
  });
});
