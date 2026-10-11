/**
 * getChannelName() — the lookup behind `{{ trigger.channelName }}` and the
 * channel-name filter (#5738). Runs against the real in-memory database so the
 * two tables it reads (`channels`, `channel_database`) are the real ones.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRouteTestApp, type RouteTestHarness } from '../../test-helpers/routeTestApp.js';
import { createMeshNodeDataProvider } from './meshNodeData.js';
import { CHANNEL_DB_OFFSET } from '../../constants/meshtastic.js';

const MQTT_SOURCE = 'rt-mqtt-5738';
const MC_SOURCE = 'rt-mc-5738';

describe('getChannelName (#5738)', () => {
  let harness: RouteTestHarness;
  const created: number[] = [];
  const provider = createMeshNodeDataProvider();
  const nameOf = (sourceId: string | null, idx: number) => provider.getChannelName!(sourceId, idx);

  const addKey = async (name: string, protocol: 'meshtastic' | 'meshcore' = 'meshtastic') => {
    const id = await harness.db.channelDatabase.createAsync({ name, psk: 'AQ==', pskLength: 1, protocol });
    created.push(id);
    return id;
  };

  beforeEach(async () => {
    harness = await createRouteTestApp({ mount: () => {} });
    for (const [id, type] of [[MQTT_SOURCE, 'mqtt_broker'], [MC_SOURCE, 'meshcore']] as const) {
      await harness.db.sources.deleteSource(id).catch(() => {});
      await harness.db.sources.createSource({ id, name: id, type, config: {}, enabled: true });
    }
  });

  afterEach(async () => {
    for (const id of created.splice(0)) await harness.db.channelDatabase.deleteAsync(id).catch(() => {});
    await harness.db.sources.deleteSource(MQTT_SOURCE).catch(() => {});
    await harness.db.sources.deleteSource(MC_SOURCE).catch(() => {});
    await harness.cleanup();
  });

  it('names an MQTT source channel from the Channel Database', async () => {
    const id = await addKey('LongFast');
    expect(await nameOf(MQTT_SOURCE, CHANNEL_DB_OFFSET + id)).toBe('LongFast');
  });

  it('names a virtual channel on a TCP source too', async () => {
    const id = await addKey('Alerts');
    expect(await nameOf(harness.sourceA, CHANNEL_DB_OFFSET + id)).toBe('Alerts');
  });

  it('a stored channel row still wins, blank name included', async () => {
    await harness.db.channels.upsertChannel({ id: 1, name: 'Admin', role: 2 }, harness.sourceA);
    await harness.db.channels.upsertChannel({ id: 0, name: '', role: 1 }, harness.sourceA, { allowBlankName: true });

    expect(await nameOf(harness.sourceA, 1)).toBe('Admin');
    // '' is the unnamed primary slot: a filter may target it (#4507).
    expect(await nameOf(harness.sourceA, 0)).toBe('');
  });

  it('returns null for a slot with no row and for an unknown key id', async () => {
    expect(await nameOf(MQTT_SOURCE, 0)).toBeNull();
    expect(await nameOf(MQTT_SOURCE, CHANNEL_DB_OFFSET + 999_999)).toBeNull();
  });

  it('never names a MeshCore key for a Meshtastic source', async () => {
    const id = await addKey('mc-secret-room', 'meshcore');
    expect(await nameOf(MQTT_SOURCE, CHANNEL_DB_OFFSET + id)).toBeNull();
  });

  it('never reads the Channel Database for a MeshCore source', async () => {
    const id = await addKey('LongFast');
    expect(await nameOf(MC_SOURCE, CHANNEL_DB_OFFSET + id)).toBeNull();
  });
});
