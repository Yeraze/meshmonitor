/**
 * MeshCore Message Forwarding wiring (#5446). The rule logic is covered in
 * utils/forwardingEngine.test.ts; this checks the manager hands the engine
 * the right message shape and sends through the right primitive.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MeshCoreManager } from './meshcoreManager.js';
import databaseService from '../services/database.js';
import { forwardingRateLimiter } from './utils/forwardingEngine.js';

const PHONE = 'aa11bb22cc33dd44ee55ff6600112233aa11bb22cc33dd44ee55ff6600112233';
const SENDER = 'deadbeefcafebabe0011223344556677deadbeefcafebabe0011223344556677';

function makeManager(rules: unknown[], masterSwitch: string | null = null) {
  const m = new MeshCoreManager('fwd-source');
  vi.spyOn(databaseService.settings, 'getSettingForSource').mockImplementation(
    async (_sourceId: string, key: string) => {
      if (key === 'forwardingRules') return JSON.stringify(rules);
      if (key === 'forwardingEnabled') return masterSwitch;
      return null;
    },
  );
  vi.spyOn(databaseService.channels, 'getChannelById').mockResolvedValue({ id: 1, name: 'Ops' } as never);
  const sendMessage = vi.fn().mockResolvedValue(true);
  (m as any).sendMessage = sendMessage;
  (m as any).localNode = { publicKey: 'ffff0000ffff0000ffff0000ffff0000ffff0000ffff0000ffff0000ffff0000', name: 'Base' };
  return { m, sendMessage };
}

const dmRule = {
  id: 'r1', name: 'DMs to phone', enabled: true,
  match: { isDM: true }, forwardTo: { destinationNodeId: PHONE }, prefix: '{from}: ',
};
const chanRule = {
  id: 'c1', name: 'Ops to 2', enabled: true,
  match: { channel: 1 }, forwardTo: { channel: 2 }, prefix: '#{channel} ',
};

describe('MeshCoreManager forwarding (#5446)', () => {
  beforeEach(() => forwardingRateLimiter.clear());
  afterEach(() => vi.restoreAllMocks());

  it('forwards a DM to the target contact', async () => {
    const { m, sendMessage } = makeManager([dmRule]);
    await (m as any).checkForwarding({ id: 'm', fromPublicKey: SENDER, fromName: 'Alice', text: 'hi' }, true, undefined);
    expect(sendMessage).toHaveBeenCalledWith('[fwd] Alice: hi', PHONE);
  });

  it('forwards a channel message to another channel without auto-retry', async () => {
    const { m, sendMessage } = makeManager([chanRule]);
    await (m as any).checkForwarding({ id: 'm', fromPublicKey: 'chan', fromName: 'Bob', text: 'status?' }, false, 1);
    expect(sendMessage).toHaveBeenCalledWith('[fwd] #Ops status?', undefined, 2);
  });

  it('does not forward in receive-only mode', async () => {
    const { m, sendMessage } = makeManager([dmRule]);
    (m as any).receiveOnly = true;
    await (m as any).checkForwarding({ id: 'm', fromPublicKey: SENDER, text: 'hi' }, true, undefined);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('does not forward our own node', async () => {
    const { m, sendMessage } = makeManager([dmRule]);
    await (m as any).checkForwarding({ id: 'm', fromPublicKey: (m as any).localNode.publicKey, text: 'hi' }, true, undefined);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('does not forward a disabled rule', async () => {
    const { m, sendMessage } = makeManager([{ ...dmRule, enabled: false }]);
    await (m as any).checkForwarding({ id: 'm', fromPublicKey: SENDER, text: 'hi' }, true, undefined);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  describe('source-level master switch (#5537)', () => {
    it('sends nothing when the switch is off, even with an enabled rule', async () => {
      const { m, sendMessage } = makeManager([dmRule], 'false');
      await (m as any).checkForwarding({ id: 'm', fromPublicKey: SENDER, fromName: 'Alice', text: 'hi' }, true, undefined);
      expect(sendMessage).not.toHaveBeenCalled();
      // Gated before the rules are read at all.
      const keys = (databaseService.settings.getSettingForSource as any).mock.calls.map((c: unknown[]) => c[1]);
      expect(keys).not.toContain('forwardingRules');
    });

    it('forwards as before when the switch was never set (absent = on)', async () => {
      const { m, sendMessage } = makeManager([dmRule], null);
      await (m as any).checkForwarding({ id: 'm', fromPublicKey: SENDER, fromName: 'Alice', text: 'hi' }, true, undefined);
      expect(sendMessage).toHaveBeenCalledTimes(1);
    });

    it('forwards when the switch is explicitly on', async () => {
      const { m, sendMessage } = makeManager([dmRule], 'true');
      await (m as any).checkForwarding({ id: 'm', fromPublicKey: SENDER, fromName: 'Alice', text: 'hi' }, true, undefined);
      expect(sendMessage).toHaveBeenCalledTimes(1);
    });
  });
});
