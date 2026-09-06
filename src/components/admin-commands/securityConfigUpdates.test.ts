/**
 * Security-config load gate (#5077, extends #4736).
 *
 * The Save Security Config button is gated on `loadedForNodeNum` matching the
 * selected node. The payload used to be applied from two near-identical inline
 * copies — the "load all" sequence and the per-section Load button — and only
 * the first stamped the gate. A per-section load therefore showed the node's
 * security config and left Save disabled forever.
 *
 * These pin the property that actually matters: the stamp does not depend on
 * how many fields the device sent.
 */
import { describe, it, expect } from 'vitest';
import { buildSecurityConfigUpdates } from './useAdminCommandsState';

describe('buildSecurityConfigUpdates (#5077)', () => {
  it('stamps loadedForNodeNum so the Save gate opens', () => {
    const { updates } = buildSecurityConfigUpdates({ isManaged: true }, 42);
    expect(updates.loadedForNodeNum).toBe(42);
  });

  it('stamps it even when the device reported no recognised fields', () => {
    // The regression: an empty payload previously produced no stamp, so Save
    // stayed disabled. The gate records which node the values came from — a
    // fact about the load, not about the field count.
    const { updates } = buildSecurityConfigUpdates({}, 42);
    expect(updates.loadedForNodeNum).toBe(42);
  });

  it('stamps it when every flag is false — falsy is not absent', () => {
    const { updates } = buildSecurityConfigUpdates(
      { isManaged: false, serialEnabled: false, debugLogApiEnabled: false, adminChannelEnabled: false },
      7,
    );
    expect(updates).toMatchObject({
      isManaged: false,
      serialEnabled: false,
      debugLogApiEnabled: false,
      adminChannelEnabled: false,
      loadedForNodeNum: 7,
    });
  });

  it('carries a null node through rather than dropping the key', () => {
    const { updates } = buildSecurityConfigUpdates({ isManaged: true }, null);
    expect('loadedForNodeNum' in updates).toBe(true);
    expect(updates.loadedForNodeNum).toBeNull();
  });

  it('omits flags the device did not send, so they keep their current value', () => {
    const { updates } = buildSecurityConfigUpdates({ isManaged: true }, 1);
    expect('serialEnabled' in updates).toBe(false);
    expect('adminChannelEnabled' in updates).toBe(false);
  });

  it('pads an empty admin-key list to one blank input', () => {
    const { adminKeys } = buildSecurityConfigUpdates({ adminKeys: [] }, 1);
    expect(adminKeys).toEqual(['']);
  });

  it('pads a short admin-key list with a blank slot', () => {
    const { adminKeys } = buildSecurityConfigUpdates({ adminKeys: ['a', 'b'] }, 1);
    expect(adminKeys).toEqual(['a', 'b', '']);
  });

  it('caps admin keys at the firmware maximum of three', () => {
    const { adminKeys } = buildSecurityConfigUpdates({ adminKeys: ['a', 'b', 'c', 'd'] }, 1);
    expect(adminKeys).toEqual(['a', 'b', 'c']);
  });

  it('leaves adminKeys undefined when the device sent none', () => {
    const { adminKeys } = buildSecurityConfigUpdates({ isManaged: true }, 1);
    expect(adminKeys).toBeUndefined();
  });
});
