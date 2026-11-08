/**
 * `GET /api/packets/stats/node-activity` on a MeshCore source (#6263 S7).
 * The route dispatches by source type and reads the MeshCore packet log.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { vi } from 'vitest';
import packetRoutes from './packetRoutes.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';
import { sourceManagerRegistry } from '../sourceManagerRegistry.js';
import { meshcoreNodeKey } from '../utils/protocolRows.js';

const MC = 'rt-mc-source';
const pk = (prefix: string) => prefix.padEnd(64, '0');
const KEY_A = pk('aa11');
const KEY_B1 = pk('bb01');
const KEY_B2 = pk('bb02'); // shares the "bb" hash with B1
const KEY_LOCAL = pk('cc99');

describe('GET /api/packets/stats/node-activity (MeshCore source)', () => {
  let harness: RouteTestHarness;

  async function packet(over: { srcHash?: string | null; senderPubKey?: string | null; ts?: number }) {
    await harness.db.meshcore.insertPacket({
      sourceId: MC,
      timestamp: over.ts ?? Date.now(),
      payloadType: 4,
      srcHash: over.srcHash ?? null,
      senderPubKey: over.senderPubKey ?? null,
      createdAt: Date.now(),
    });
  }

  const url = `/api/packets/stats/node-activity?sourceId=${MC}`;

  beforeEach(async () => {
    harness = await createRouteTestApp({ mount: (app) => app.use('/api/packets', packetRoutes) });
    await harness.db.sources.deleteSource(MC).catch(() => {});
    await harness.db.sources.createSource({ id: MC, name: 'MC', type: 'meshcore', config: {}, enabled: true });
    harness.db.setSetting('meshcore_packet_log_enabled', '1');
    for (const [key, name] of [[KEY_A, 'Alpha'], [KEY_B1, 'Bravo1'], [KEY_B2, 'Bravo2'], [KEY_LOCAL, 'Local']] as const) {
      await harness.db.meshcore.upsertNode({ publicKey: key, name, advType: 1, lastHeard: Date.now() }, MC);
    }
    vi.spyOn(sourceManagerRegistry, 'getManager').mockImplementation(((id: string) =>
      id === MC ? { sourceType: 'meshcore', getLocalNode: () => ({ publicKey: KEY_LOCAL }), getLocalNodeInfo: () => null } : undefined) as never);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await harness.db.meshcore.deleteAllPackets(MC);
    await harness.db.sources.deleteSource(MC).catch(() => {});
    await harness.cleanup();
  });

  it('returns enabled:false when the MeshCore packet log is off', async () => {
    harness.db.setSetting('meshcore_packet_log_enabled', '0');
    await packet({ senderPubKey: KEY_A });
    const res = await (await harness.loginAs(harness.admin)).get(url);
    expect(res.status).toBe(200);
    expect(res.body.data.enabled).toBe(false);
    expect(res.body.data.nodes).toEqual([]);
  });

  it('keys rows on the public key and excludes the local node', async () => {
    await packet({ senderPubKey: KEY_A });
    await packet({ senderPubKey: KEY_A });
    await packet({ senderPubKey: KEY_LOCAL });
    const res = await (await harness.loginAs(harness.admin)).get(url);
    expect(res.status).toBe(200);
    expect(res.body.data.enabled).toBe(true);
    expect(res.body.data.nodes).toHaveLength(1);
    expect(res.body.data.nodes[0]).toMatchObject({
      nodeKey: meshcoreNodeKey(KEY_A),
      publicKey: KEY_A,
      packets: 2,
      longName: 'Alpha',
    });
  });

  it('resolves a bare hash only when exactly one node has the prefix', async () => {
    await packet({ srcHash: 'aa' }); // unique -> Alpha
    await packet({ srcHash: 'bb' }); // ambiguous -> unresolved
    await packet({ srcHash: 'bb' });
    await packet({ srcHash: 'ee' }); // unknown -> unresolved
    const res = await (await harness.loginAs(harness.admin)).get(url);
    expect(res.body.data.nodes.map((n: { publicKey: string }) => n.publicKey)).toEqual([KEY_A]);
    expect(res.body.data.unresolvedPackets).toBe(3);
  });

  it('counts packets with no sender in unresolvedPackets and honours the window', async () => {
    await packet({});
    await packet({ senderPubKey: KEY_A, ts: Date.now() - 20 * 60_000 }); // outside 10 min
    const res = await (await harness.loginAs(harness.admin)).get(url);
    expect(res.body.data.nodes).toEqual([]);
    expect(res.body.data.unresolvedPackets).toBe(1);
  });

  it('rf and all agree on a MeshCore source', async () => {
    await packet({ senderPubKey: KEY_A });
    const agent = await harness.loginAs(harness.admin);
    const rf = await agent.get(`${url}&transport=rf`);
    const all = await agent.get(`${url}&transport=all`);
    expect(rf.body.data.nodes).toHaveLength(1);
    expect(all.body.data.nodes).toHaveLength(1);
  });

  it('403s without packetmonitor:read on the source', async () => {
    const res = await (await harness.loginAs(harness.limited)).get(url);
    expect(res.status).toBe(403);
  });

  it('withholds names without nodes:read', async () => {
    await harness.grant(harness.limited.id, 'packetmonitor', 'read', MC);
    await packet({ senderPubKey: KEY_A });
    const res = await (await harness.loginAs(harness.limited)).get(url);
    expect(res.status).toBe(200);
    expect(res.body.data.nodes[0].longName).toBeNull();
    expect(res.body.data.nodes[0].publicKey).toBe(KEY_A);
  });
});
