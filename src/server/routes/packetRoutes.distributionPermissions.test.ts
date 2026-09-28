/**
 * `GET /api/packets/stats/distribution` honours per-channel permissions.
 * It used to count every packet on the source, so a user limited to one
 * channel saw totals and top talkers for channels they cannot read. The counts
 * now apply the same rule as the packet list (`filterPacketsByPermissions`).
 * Real-middleware harness, so the grants are enforced by real SQL.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import packetRoutes from './packetRoutes.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';
import { PortNum } from '../constants/meshtastic.js';
import type { DbPacketLog } from '../../db/types.js';

describe('GET /api/packets/stats/distribution - channel permissions', () => {
  let harness: RouteTestHarness;
  let nextId = 1;

  async function seed(fromNode: number, channel: number, opts: { dmTo?: number; encrypted?: boolean } = {}) {
    const packet: Omit<DbPacketLog, 'id' | 'created_at'> = {
      packet_id: nextId++,
      timestamp: Date.now(),
      from_node: fromNode,
      to_node: opts.dmTo ?? 4294967295,
      channel,
      portnum: opts.dmTo ? PortNum.TEXT_MESSAGE_APP : PortNum.POSITION_APP,
      portnum_name: 'X',
      encrypted: opts.encrypted ?? false,
      direction: 'rx',
      sourceId: harness.sourceA,
    };
    await harness.db.insertPacketLogAsync(packet);
  }

  beforeEach(async () => {
    harness = await createRouteTestApp({ mount: (app) => app.use('/api/packets', packetRoutes) });
    harness.db.setSetting('packet_log_enabled', '1');
    await harness.grant(harness.limited.id, 'packetmonitor', 'read', harness.sourceA);
    await harness.grant(harness.limited.id, 'channel_0', 'read', harness.sourceA);

    await seed(200, 0);                       // visible: channel 0
    await seed(200, 0);                       // visible: channel 0
    await seed(201, 2);                       // hidden: channel 2
    await seed(201, 2);                       // hidden: channel 2
    await seed(202, 2, { encrypted: true });  // visible: encrypted
    await seed(203, 0, { dmTo: 999 });        // hidden: DM without messages:read
  });

  afterEach(async () => {
    await harness.db.packetLog.clearPacketLogs(harness.sourceA);
    await harness.cleanup();
  });

  it('a channel-0-only user counts only what the packet list would show', async () => {
    const agent = await harness.loginAs(harness.limited);
    const res = await agent.get(`/api/packets/stats/distribution?sourceId=${harness.sourceA}`);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(3);
    const devices = res.body.byDevice.map((d: { from_node: number }) => d.from_node).sort();
    expect(devices).toEqual([200, 202]);
    expect(res.body.byType.reduce((s: number, r: { count: number }) => s + r.count, 0)).toBe(3);
  });

  it('messages:read adds the DM', async () => {
    await harness.grant(harness.limited.id, 'messages', 'read', harness.sourceA);
    const agent = await harness.loginAs(harness.limited);
    const res = await agent.get(`/api/packets/stats/distribution?sourceId=${harness.sourceA}`);
    expect(res.body.total).toBe(4);
  });

  it('an admin still counts everything', async () => {
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.get(`/api/packets/stats/distribution?sourceId=${harness.sourceA}`);
    expect(res.body.total).toBe(6);
  });
});
