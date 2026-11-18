/**
 * getAirtimeGate() on the real NodeDataProvider: only a Meshtastic TCP manager
 * has a Channel Utilization figure. Every other source — MeshCore, MQTT,
 * Reticulum, or one that is not connected — reads null, and so does a manager
 * that throws, so the Automation Engine fails open.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const getManager = vi.fn();
vi.mock('../../sourceManagerRegistry.js', () => ({
  sourceManagerRegistry: { getManager: (id: string) => getManager(id) },
}));
vi.mock('../../../services/database.js', () => ({ default: {} }));

import { createMeshNodeDataProvider } from './meshNodeData.js';

const VERDICT = { gated: true, channelUtilization: 41, threshold: 30, measuredFrom: 'local' };

describe('meshNodeData getAirtimeGate', () => {
  const provider = createMeshNodeDataProvider();
  beforeEach(() => getManager.mockReset());

  it('returns the Meshtastic manager verdict', async () => {
    getManager.mockReturnValue({ sourceType: 'meshtastic_tcp', getAirtimeGateVerdict: async () => VERDICT });
    expect(await provider.getAirtimeGate!('mt')).toEqual(VERDICT);
  });

  it.each(['meshcore', 'mqtt_broker', 'mqtt_bridge', 'reticulum'])('returns null for a %s source', async (sourceType) => {
    getManager.mockReturnValue({ sourceType, getAirtimeGateVerdict: async () => VERDICT });
    expect(await provider.getAirtimeGate!('x')).toBeNull();
  });

  it('returns null for an unknown source', async () => {
    getManager.mockReturnValue(undefined);
    expect(await provider.getAirtimeGate!('nope')).toBeNull();
  });

  it('returns null when the manager throws', async () => {
    getManager.mockReturnValue({ sourceType: 'meshtastic_tcp', getAirtimeGateVerdict: async () => { throw new Error('boom'); } });
    expect(await provider.getAirtimeGate!('mt')).toBeNull();
  });
});
