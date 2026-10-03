/**
 * `GET /api/packets/stats/node-activity` (#5557) — Live Mesh Activity widget.
 * Real-middleware harness: per-source packetmonitor:read and the non-admin
 * channel/DM visibility rule are enforced by real SQL.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import packetRoutes from './packetRoutes.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';
import { PortNum, TransportMechanism } from '../constants/meshtastic.js';
import type { DbPacketLog } from '../../db/types.js';

describe('GET /api/packets/stats/node-activity', () => {
  let harness: RouteTestHarness;
  let nextId = 1;

  async function seed(
    fromNode: number,
    channel: number,
    opts: { dmTo?: number; encrypted?: boolean; ts?: number; transport?: number; sourceId?: string; packetId?: number } = {},
  ) {
    const packet: Omit<DbPacketLog, 'id' | 'created_at'> = {
      packet_id: opts.packetId ?? nextId++,
      timestamp: opts.ts ?? Date.now(),
      from_node: fromNode,
      to_node: opts.dmTo ?? 4294967295,
      channel,
      portnum: opts.dmTo ? PortNum.TEXT_MESSAGE_APP : PortNum.POSITION_APP,
      portnum_name: 'X',
      encrypted: opts.encrypted ?? false,
      direction: 'rx',
      snr: 5,
      hop_start: 3,
      hop_limit: 2,
      transport_mechanism: (opts.transport ?? TransportMechanism.LORA) as any,
      sourceId: opts.sourceId ?? harness.sourceA,
    };
    await harness.db.insertPacketLogAsync(packet);
  }

  const url = (q = '') => `/api/packets/stats/node-activity?sourceId=${harness.sourceA}${q}`;
  const nodeNums = (body: any) => body.data.nodes.map((n: { nodeNum: number }) => n.nodeNum).sort((a: number, b: number) => a - b);

  beforeEach(async () => {
    harness = await createRouteTestApp({ mount: (app) => app.use('/api/packets', packetRoutes) });
    harness.db.setSetting('packet_log_enabled', '1');
  });

  afterEach(async () => {
    await harness.db.packetLog.clearPacketLogs(harness.sourceA);
    await harness.db.packetLog.clearPacketLogs(harness.sourceB);
    await harness.cleanup();
  });

  it('403s a user without packetmonitor:read on that source', async () => {
    await harness.grant(harness.limited.id, 'packetmonitor', 'read', harness.sourceB);
    const agent = await harness.loginAs(harness.limited);
    const res = await agent.get(url());
    expect(res.status).toBe(403);
  });

  it('400s without a sourceId, or with a window outside the offered set', async () => {
    const agent = await harness.loginAs(harness.admin);
    expect((await agent.get('/api/packets/stats/node-activity')).status).toBe(400);
    const bad = await agent.get(url('&windowMinutes=7'));
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe('INVALID_WINDOW');
    expect((await agent.get(url('&transport=bogus'))).body.code).toBe('INVALID_TRANSPORT');
  });

  it('returns enabled:false and no rows when the packet log is off', async () => {
    harness.db.setSetting('packet_log_enabled', '0');
    await seed(200, 0);
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.get(url());
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.enabled).toBe(false);
    expect(res.body.data.nodes).toEqual([]);
  });

  it('scopes to the source and the window, RF-only by default', async () => {
    await seed(200, 0);
    await seed(200, 0);
    await seed(201, 0, { transport: TransportMechanism.MQTT });
    await seed(202, 0, { sourceId: harness.sourceB });
    await seed(203, 0, { ts: Date.now() - 20 * 60_000 }); // outside the 10m default

    const agent = await harness.loginAs(harness.admin);
    const rf = await agent.get(url());
    expect(rf.status).toBe(200);
    expect(nodeNums(rf.body)).toEqual([200]);
    expect(rf.body.data.nodes[0].packets).toBe(2);
    expect(rf.body.data.nodes[0].lastHops).toBe(1);

    expect(nodeNums((await agent.get(url('&transport=all'))).body)).toEqual([200, 201]);
    expect(nodeNums((await agent.get(url('&windowMinutes=30'))).body)).toEqual([200, 203]);
  });

  it('flags truncation when the retained log starts inside the window', async () => {
    await seed(200, 0, { ts: Date.now() - 2 * 60_000 });
    const agent = await harness.loginAs(harness.admin);
    const wide = await agent.get(url('&windowMinutes=10'));
    expect(wide.body.data.truncated).toBe(true);
    expect(wide.body.data.coverageStart).toBeGreaterThan(wide.body.data.windowStart);
    const narrow = await agent.get(url('&windowMinutes=1'));
    expect(narrow.body.data.truncated).toBe(false);
  });

  it('a channel-0-only user sees only rows the packet list would show', async () => {
    await harness.grant(harness.limited.id, 'packetmonitor', 'read', harness.sourceA);
    await harness.grant(harness.limited.id, 'channel_0', 'read', harness.sourceA);
    await seed(200, 0);                       // visible: channel 0
    await seed(201, 2);                       // hidden: channel 2
    await seed(202, 2, { encrypted: true });  // visible: encrypted
    await seed(203, 0, { dmTo: 999 });        // hidden: DM without messages:read

    const agent = await harness.loginAs(harness.limited);
    const res = await agent.get(url());
    expect(res.status).toBe(200);
    expect(nodeNums(res.body)).toEqual([200, 202]);

    await harness.grant(harness.limited.id, 'messages', 'read', harness.sourceA);
    const withDm = await (await harness.loginAs(harness.limited)).get(url());
    expect(nodeNums(withDm.body)).toEqual([200, 202, 203]);
  });
});
