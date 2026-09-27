/**
 * #5414 — `dropAutomationUplinks` keeps MeshMonitor's own automation sends off
 * the upstream broker. Drives the private `handleUplink` directly with a fake
 * upstream client, so no real broker is needed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../services/database.js', () => ({ default: {} }));
// ok_to_mqtt gate: allow everything, so the only drop under test is ours.
vi.mock('./utils/okToMqtt.js', () => ({
  allowsUplink: () => true,
  resolveOkToMqttForEnvelope: async () => 'allowed',
}));

import { MqttBridgeManager, type MqttBridgeSourceConfig } from './mqttBridgeManager.js';
import type { MqttBrokerLocalPacket } from './mqttBrokerManager.js';
import { automationPacketTracker } from './utils/automationPacketTracker.js';

const NODE_A = 0xaaaa0001;
const NODE_B = 0xbbbb0002;

function makeBridge(extra: Partial<MqttBridgeSourceConfig> = {}) {
  const bridge = new MqttBridgeManager('bridge-1', 'Bridge', {
    brokerSourceId: 'local-broker',
    upstream: { url: 'mqtt://127.0.0.1:1' },
    subscriptions: [],
    mode: 'publish_only',
    forwardingMode: 'single',
    ...extra,
  });
  const publish = vi.fn(async () => undefined);
  (bridge as any).client = {
    isConnected: () => true,
    publish,
    getCapabilities: () => ({ canSubscribe: true, canPublish: true, authFailed: false, deniedSubscriptions: [] }),
    getLastError: () => null,
  };
  const uplink = (from: number, id: number) =>
    (bridge as any).handleUplink({
      topic: 'msh/US/2/e/LongFast/!aaaa0001',
      payload: Buffer.from([1, 2, 3]),
      retained: false,
      envelope: { channelId: 'LongFast', gatewayId: '!aaaa0001', packet: { from, id } },
      clientId: '!aaaa0001',
    } satisfies MqttBrokerLocalPacket) as Promise<void>;
  return { bridge, publish, uplink };
}

describe('MqttBridgeManager — dropAutomationUplinks (#5414)', () => {
  beforeEach(() => {
    automationPacketTracker.clear();
  });

  it('drops a packet an automation on this node just sent, and counts it', async () => {
    const { bridge, publish, uplink } = makeBridge({ dropAutomationUplinks: true });
    automationPacketTracker.record('src-a', NODE_A, 0x1001);

    await uplink(NODE_A, 0x1001);

    expect(publish).not.toHaveBeenCalled();
    expect(bridge.getStatus().uplinkAutomationDrops).toBe(1);
    expect(bridge.getStatus().uplinkOkToMqttDrops).toBe(0);
  });

  it('uplinks a manual send (id never tagged)', async () => {
    const { bridge, publish, uplink } = makeBridge({ dropAutomationUplinks: true });
    automationPacketTracker.record('src-a', NODE_A, 0x1001);

    await uplink(NODE_A, 0x2002);

    expect(publish).toHaveBeenCalledTimes(1);
    expect(bridge.getStatus().uplinkAutomationDrops).toBe(0);
  });

  it('flag off (the default) uplinks automation sends as before', async () => {
    const { bridge, publish, uplink } = makeBridge();
    automationPacketTracker.record('src-a', NODE_A, 0x1001);

    await uplink(NODE_A, 0x1001);

    expect(publish).toHaveBeenCalledTimes(1);
    expect(bridge.getStatus().uplinkAutomationDrops).toBe(0);
  });

  it('uplinks once the 30 s TTL has passed', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
      const { publish, uplink } = makeBridge({ dropAutomationUplinks: true });
      automationPacketTracker.record('src-a', NODE_A, 0x1001);
      vi.setSystemTime(new Date('2026-01-01T00:00:31Z'));

      await uplink(NODE_A, 0x1001);

      expect(publish).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not drop another source\'s node that reuses the same packet id', async () => {
    const { bridge, publish, uplink } = makeBridge({ dropAutomationUplinks: true });
    // Automation on source A (node A) used id 0x1001 ...
    automationPacketTracker.record('src-a', NODE_A, 0x1001);
    // ... and source B's node sends its own (manual) packet with the same id.
    await uplink(NODE_B, 0x1001);

    expect(publish).toHaveBeenCalledTimes(1);
    expect(bridge.getStatus().uplinkAutomationDrops).toBe(0);
  });

  it('uplinks a packet with no id even when the flag is on', async () => {
    const { bridge, publish } = makeBridge({ dropAutomationUplinks: true });
    automationPacketTracker.record('src-a', NODE_A, 0x1001);
    await (bridge as any).handleUplink({
      topic: 'msh/US/2/e/LongFast/!aaaa0001',
      payload: Buffer.from([1]),
      retained: false,
      envelope: { channelId: 'LongFast', gatewayId: '!aaaa0001', packet: { from: NODE_A } },
      clientId: '!aaaa0001',
    });
    expect(publish).toHaveBeenCalledTimes(1);
    expect(bridge.getStatus().uplinkAutomationDrops).toBe(0);
  });

  it('matches a from field decoded as a non-number (Long-like)', async () => {
    const { bridge, publish } = makeBridge({ dropAutomationUplinks: true });
    automationPacketTracker.record('src-a', NODE_A, 0x1001);
    const longFrom = { valueOf: () => NODE_A, toString: () => String(NODE_A) };
    await (bridge as any).handleUplink({
      topic: 'msh/US/2/e/LongFast/!aaaa0001',
      payload: Buffer.from([1]),
      retained: false,
      envelope: { channelId: 'LongFast', gatewayId: '!aaaa0001', packet: { from: longFrom, id: 0x1001 } },
      clientId: '!aaaa0001',
    });
    expect(publish).not.toHaveBeenCalled();
    expect(bridge.getStatus().uplinkAutomationDrops).toBe(1);
  });

  it('drops every uplinked copy within the window (several gateways heard it)', async () => {
    const { bridge, publish, uplink } = makeBridge({ dropAutomationUplinks: true });
    automationPacketTracker.record('src-a', NODE_A, 0x1001);

    await uplink(NODE_A, 0x1001);
    await uplink(NODE_A, 0x1001);

    expect(publish).not.toHaveBeenCalled();
    expect(bridge.getStatus().uplinkAutomationDrops).toBe(2);
  });
});
