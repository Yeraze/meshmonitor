import { describe, it, expect } from 'vitest';
import { securityCapabilities } from './securityCapabilities.js';

describe('securityCapabilities', () => {
  it('Meshtastic keeps today\'s set and none of the MeshCore-only cards', () => {
    const c = securityCapabilities('meshtastic_tcp');
    expect(c).toMatchObject({
      lowEntropy: true, duplicateKeys: true, keyMismatchLog: true, scanner: true, spam: true,
      timeOffset: true, deadNodes: true, deviceDelete: true, digest: true, notifyDm: true,
      pathHashCollisions: false, advertSignatures: false, nameReuse: false, ownKeyChange: false,
    });
    expect(securityCapabilities(undefined)).toEqual(c);
    expect(securityCapabilities('mqtt')).toEqual(c);
  });

  it('MeshCore Companion gets the P7a + P7b set with device delete and the notification DM', () => {
    const c = securityCapabilities('meshcore', 'companion');
    expect(c).toMatchObject({
      deadNodes: true, deviceDelete: true, pathHashCollisions: true, advertSignatures: true,
      nameReuse: true, ownKeyChange: true,
      lowEntropy: false, duplicateKeys: false, keyMismatchLog: false, scanner: true, spam: true,
      timeOffset: true, digest: true, notifyDm: true,
    });
    expect(securityCapabilities('meshcore', 1).deviceDelete).toBe(true);
    expect(securityCapabilities('meshcore', 1).notifyDm).toBe(true);
  });

  it('MeshCore Repeater deletes from MeshMonitor only but still tracks its own key', () => {
    for (const d of ['repeater', 2, 3] as const) {
      const c = securityCapabilities('meshcore', d);
      expect(c.deviceDelete).toBe(false);
      expect(c.ownKeyChange).toBe(true);
      expect(c.deadNodes).toBe(true);
      // Rates, clock and digest apply, but a Repeater cannot send the notification DM.
      expect(c).toMatchObject({ scanner: true, spam: true, timeOffset: true, digest: true, notifyDm: false });
    }
    expect(securityCapabilities('meshcore').deviceDelete).toBe(false);
    // Unknown device kind: no DM until the kind is known.
    expect(securityCapabilities('meshcore').notifyDm).toBe(false);
  });

  it('meshcore_mqtt: findings and DB-only delete, no own key', () => {
    const c = securityCapabilities('meshcore_mqtt');
    expect(c.deadNodes).toBe(true);
    expect(c.deviceDelete).toBe(false);
    expect(c.ownKeyChange).toBe(false);
    expect(c.advertSignatures).toBe(true);
    expect(c).toMatchObject({ scanner: true, spam: true, timeOffset: true, digest: true, notifyDm: false });
    expect(securityCapabilities('meshcore_mqtt', 'companion').notifyDm).toBe(false);
  });
});
