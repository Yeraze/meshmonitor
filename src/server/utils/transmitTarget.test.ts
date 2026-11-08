import { describe, it, expect, vi, beforeEach } from 'vitest';

const getManager = vi.fn();
const getSource = vi.fn();
vi.mock('../sourceManagerRegistry.js', () => ({ sourceManagerRegistry: { getManager: (id: string) => getManager(id) } }));
vi.mock('../../services/database.js', () => ({ default: { sources: { getSource: (id: string) => getSource(id) } } }));

import { resolveTransmitTarget } from './transmitTarget.js';

const mgr = (sourceType: string) => ({ sourceType });

describe('resolveTransmitTarget', () => {
  beforeEach(() => { getManager.mockReset(); getSource.mockReset(); });

  it('resolves a live Meshtastic TCP manager', async () => {
    const m = mgr('meshtastic_tcp');
    getManager.mockReturnValue(m);
    expect(await resolveTransmitTarget('s')).toEqual({ kind: 'meshtastic', sourceId: 's', manager: m });
  });

  it('resolves a registered device MeshCore manager', async () => {
    const m = mgr('meshcore');
    getManager.mockReturnValue(m);
    expect(await resolveTransmitTarget('s')).toEqual({ kind: 'meshcore', sourceId: 's', manager: m });
  });

  it.each(['meshcore_mqtt', 'mqtt_broker', 'mqtt_bridge', 'reticulum'])('refuses a live %s manager with 400', async (t) => {
    getManager.mockReturnValue(mgr(t));
    expect(await resolveTransmitTarget('s')).toMatchObject({ kind: 'refused', status: 400, code: 'SOURCE_NOT_MESHTASTIC' });
  });

  it.each(['meshtastic_tcp', 'meshcore'])('409 for a %s row with no live manager', async (type) => {
    getManager.mockReturnValue(undefined);
    getSource.mockResolvedValue({ type });
    expect(await resolveTransmitTarget('s')).toMatchObject({ kind: 'refused', status: 409, code: 'SOURCE_NOT_CONNECTED' });
  });

  it.each(['meshcore_mqtt', 'mqtt_broker', 'reticulum'])('400 for a %s row with no live manager', async (type) => {
    getManager.mockReturnValue(undefined);
    getSource.mockResolvedValue({ type });
    expect(await resolveTransmitTarget('s')).toMatchObject({ kind: 'refused', status: 400, code: 'SOURCE_NOT_MESHTASTIC' });
  });

  it('404 when no manager and no row, including when the lookup throws', async () => {
    getManager.mockReturnValue(undefined);
    getSource.mockResolvedValue(null);
    expect(await resolveTransmitTarget('s')).toMatchObject({ kind: 'refused', status: 404, code: 'SOURCE_NOT_FOUND' });
    getSource.mockRejectedValue(new Error('db'));
    expect(await resolveTransmitTarget('s')).toMatchObject({ kind: 'refused', status: 404 });
  });
});
