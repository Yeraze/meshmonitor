/**
 * MeshCore side of GET /api/v1/metrics (#6263 WP2), against the real route
 * harness (real auth, real in-memory DB, real permission rows).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRouteTestApp, type RouteTestHarness } from '../../test-helpers/routeTestApp.js';
import metricsRouter from './metrics.js';

const MC = 'mc-metrics-src';
const MC_HIDDEN = 'mc-metrics-hidden';
const PK_A = 'a'.repeat(64);
const PK_OLD = 'b'.repeat(64);
const PK_NOWIN = 'c'.repeat(64);
const now = () => Date.now();

describe('GET /metrics (MeshCore sources)', () => {
  let h: RouteTestHarness;

  beforeEach(async () => {
    h = await createRouteTestApp({ mount: (app) => app.use('/metrics', metricsRouter) });
    for (const id of [MC, MC_HIDDEN]) {
      await h.db.sources.deleteSource(id).catch(() => {});
      await h.db.sources.createSource({ id, name: `Name ${id}`, type: 'meshcore', config: {}, enabled: true });
    }
    await h.db.meshcore.deleteAllPackets(MC);
    await h.db.meshcore.deleteAllMessagesForSource(MC);
    const t = now();
    // heard 10 min ago (active), 5 h ago (in 24h window, not active), 3 days ago (out of window)
    await h.db.meshcore.upsertNode({ publicKey: PK_A, name: 'Alphabet', rssi: -90, snr: 6.5, lastHeard: t - 600_000, pathLen: 2, batteryMv: 4100, latitude: 12.34, longitude: 56.78 }, MC);
    await h.db.meshcore.upsertNode({ publicKey: PK_OLD, name: 'Old1', lastHeard: t - 5 * 3600_000 }, MC);
    await h.db.meshcore.upsertNode({ publicKey: PK_NOWIN, name: 'Gone', lastHeard: t - 3 * 86400_000 }, MC);
    await h.db.meshcore.upsertNode({ publicKey: 'd'.repeat(64), name: 'Hid', lastHeard: t - 1000 }, MC_HIDDEN);
    await h.db.meshcore.insertMessage({ id: 'm1', fromPublicKey: PK_A, text: 'hi', timestamp: t, createdAt: t }, MC);
    await h.db.meshcore.insertMessage({ id: 'm2', fromPublicKey: PK_A, text: 'yo', timestamp: t, createdAt: t - 2 * 3600_000 }, MC);
    for (const [pt, name, n] of [[4, 'ADVERT', 3], [5, 'GRP_TXT', 1]] as const) {
      for (let i = 0; i < n; i++) {
        await h.db.meshcore.insertPacket({ sourceId: MC, timestamp: t - 1000, payloadType: pt, payloadTypeName: name, createdAt: t });
      }
    }
    await h.db.meshcore.insertPacket({ sourceId: MC, timestamp: t - 2 * 3600_000, payloadType: 4, payloadTypeName: 'ADVERT', createdAt: t });
  });

  afterEach(async () => {
    for (const id of [MC, MC_HIDDEN]) await h.db.sources.deleteSource(id).catch(() => {});
    await h.cleanup();
  });

  const scrape = async (user = h.admin, query = '') => {
    const agent = await h.loginAs(user);
    const res = await agent.get(`/metrics${query}`).expect(200);
    return res.text as string;
  };

  it('exports nonzero totals and active count', async () => {
    const body = await scrape();
    expect(body).toContain(`meshmonitor_nodes_total{source="${MC}"} 3`);
    expect(body).toContain(`meshmonitor_nodes_active{source="${MC}"} 1`);
    expect(body).toContain(`meshmonitor_messages_last_hour{source="${MC}"} 1`);
    expect(body).toContain(`meshmonitor_source_info{source="${MC}",name="Name ${MC}",type="meshcore"} 1`);
  });

  it('exports payload-type series for the last hour only', async () => {
    const body = await scrape();
    expect(body).toContain(`meshmonitor_packets_by_payload_type_last_hour{source="${MC}",payload_type="4",payload_type_name="ADVERT"} 3`);
    expect(body).toContain(`meshmonitor_packets_by_payload_type_last_hour{source="${MC}",payload_type="5",payload_type_name="GRP_TXT"} 1`);
  });

  it('exports per-node labels and units, never positions', async () => {
    const body = await scrape();
    const l = `source="${MC}",node_id="mc:${PK_A}",short_name="Alph"`;
    expect(body).toContain(`meshmonitor_node_snr_db{${l}} 6.5`);
    expect(body).toContain(`meshmonitor_node_rssi_dbm{${l}} -90`);
    expect(body).toContain(`meshmonitor_node_hops_away{${l}} 2`);
    expect(body).toContain(`meshmonitor_node_voltage_volts{${l}} 4.1`);
    expect(body).toMatch(new RegExp(`meshmonitor_node_last_heard_timestamp_seconds\\{${l.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\} \\d{10}\\n`));
    expect(body).not.toContain('meshmonitor_node_last_position_timestamp_seconds{source="' + MC);
    expect(body).not.toContain('12.34');
  });

  it('applies the window and the node-series cap', async () => {
    let body = await scrape();
    expect(body).toContain(`node_id="mc:${PK_OLD}"`);
    expect(body).not.toContain(`mc:${PK_NOWIN}`);
    body = await scrape(h.admin, '?window=3600');
    expect(body).toContain(`node_id="mc:${PK_A}"`);
    expect(body).not.toContain(`mc:${PK_OLD}`);
  });

  it('withholds volume without messages:read and the payload mix without packetmonitor:read', async () => {
    await h.grant(h.limited.id, 'nodes', 'read', MC);
    const body = await scrape(h.limited);
    expect(body).toContain(`meshmonitor_nodes_total{source="${MC}"} 3`);
    expect(body).not.toContain('meshmonitor_messages_last_hour{');
    expect(body).not.toContain('meshmonitor_packets_by_payload_type_last_hour{');
    await h.grant(h.limited.id, 'packetmonitor', 'read', MC);
    expect(await scrape(h.limited)).toContain('meshmonitor_packets_by_payload_type_last_hour{');
  });

  it('omits an unpermitted source entirely', async () => {
    await h.grant(h.limited.id, 'nodes', 'read', MC);
    const body = await scrape(h.limited);
    expect(body).not.toContain(MC_HIDDEN);
  });

  it('a Meshtastic-only scrape carries no payload-type metric', async () => {
    await h.db.sources.deleteSource(MC);
    await h.db.sources.deleteSource(MC_HIDDEN);
    expect(await scrape()).not.toContain('payload_type');
  });
});
