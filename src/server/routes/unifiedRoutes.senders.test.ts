/**
 * GET /api/unified/senders (#3045 Phase 1): who can send where, per
 * (channel, source), for the signed-in viewer. Real auth and permission SQL via
 * the route harness; only the source managers are fakes.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import crypto from 'node:crypto';
import unifiedRoutes from './unifiedRoutes.js';
import mqttNativeRoutes from './mqttNativeRoutes.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';
import { sourceManagerRegistry, type ISourceManager } from '../sourceManagerRegistry.js';
import { loadProtobufDefinitions } from '../protobufLoader.js';
import { SourcePkiKeyStore, setSourcePkiKeyStoreForTesting } from '../services/sourcePkiKeyStore.js';
import { channelDecryptionService } from '../services/channelDecryptionService.js';
import { resetMqttNativeStateForTesting } from '../services/mqttNative/mqttNativeState.js';
import type { MqttNativeReadiness } from '../services/mqttNative/mqttNativeSendService.js';
import { CHANNEL_DB_OFFSET } from '../constants/meshtastic.js';
import databaseService from '../../services/database.js';

const MC = 'sn-mc-3045';
const MQ = 'sn-mqtt-3045';
const RET = 'sn-ret-3045';
const MCM = 'sn-mcmqtt-3045';
const EXTRA = [MC, MQ, RET, MCM];

interface FakeState {
  connected: boolean;
  canTransmit: boolean;
  receiveOnly: boolean;
  repeater: boolean;
  readiness: MqttNativeReadiness;
}

function fakeManagers(a: string, b: string) {
  const st: Record<string, FakeState> = {};
  const mk = (id: string): FakeState => (st[id] = {
    connected: true, canTransmit: true, receiveOnly: false, repeater: false, readiness: { ok: true },
  });
  const tcp = (id: string) => {
    const s = mk(id);
    return {
      sourceId: id, sourceType: 'meshtastic_tcp',
      getStatus: () => ({ connected: s.connected }),
      canTransmit: () => s.canTransmit,
    };
  };
  const mc = (id: string) => {
    const s = mk(id);
    return {
      sourceId: id, sourceType: 'meshcore',
      isConnected: () => s.connected,
      isReceiveOnly: () => s.receiveOnly,
      isRepeaterSource: () => s.repeater,
    };
  };
  const mqtt = (id: string) => {
    const s = mk(id);
    return {
      sourceId: id, sourceType: 'mqtt_bridge',
      publish: vi.fn(async () => undefined),
      getNativePublishReadiness: () => s.readiness,
      getNativeRootTopicHint: () => 'msh/US/FL',
      getLocalNodeInfo: () => null,
    };
  };
  const other = (id: string, sourceType: string) => { mk(id); return { sourceId: id, sourceType }; };
  const managers: Record<string, unknown> = {
    [a]: tcp(a), [b]: tcp(b), [MC]: mc(MC), [MQ]: mqtt(MQ),
    [RET]: other(RET, 'reticulum'), [MCM]: other(MCM, 'meshcore_mqtt'),
  };
  return { st, managers };
}

type Ref = {
  sourceId: string; channelNumber: number; canSend: boolean; sendKind: string | null;
  sendBlockedReason: string | null; reactionsOutbound: boolean | null;
};

describe('GET /api/unified/senders (#3045)', () => {
  let harness: RouteTestHarness;
  let st: Record<string, FakeState>;
  let getManager: ReturnType<typeof vi.spyOn>;
  let vcId = 0;
  let badKeyId = 0;

  beforeAll(async () => {
    await loadProtobufDefinitions();
  });

  beforeEach(async () => {
    harness = await createRouteTestApp({
      useOptionalAuth: false,
      mount: (app) => {
        app.use('/api/unified', unifiedRoutes);
        app.use('/api/sources/:id/mqtt/native', mqttNativeRoutes);
      },
    });
    setSourcePkiKeyStoreForTesting(new SourcePkiKeyStore('senders-test-secret-3045', true));
    resetMqttNativeStateForTesting();
    for (const id of EXTRA) await harness.db.sources.deleteSource(id).catch(() => {});
    await harness.db.sources.createSource({ id: MC, name: 'MC', type: 'meshcore', config: {}, enabled: true });
    await harness.db.sources.createSource({ id: MQ, name: 'MQ', type: 'mqtt_bridge', config: {}, enabled: true });
    await harness.db.sources.createSource({ id: RET, name: 'RET', type: 'reticulum' as any, config: {}, enabled: true });
    await harness.db.sources.createSource({ id: MCM, name: 'MCM', type: 'meshcore_mqtt' as any, config: {}, enabled: true });

    const f = fakeManagers(harness.sourceA, harness.sourceB);
    st = f.st;
    getManager = vi.spyOn(sourceManagerRegistry, 'getManager').mockImplementation(
      (id: string) => f.managers[id] as unknown as ISourceManager | undefined,
    );
    vi.spyOn(sourceManagerRegistry, 'getAllManagers').mockImplementation(
      () => Object.values(f.managers) as unknown as ISourceManager[],
    );

    // Physical slot 1 "Alpha" everywhere; slot 2 "Beta" and slot 9 "Nine" on A.
    for (const s of [harness.sourceA, harness.sourceB, MC, MQ, RET, MCM]) {
      await harness.db.channels.upsertChannel({ id: 1, name: 'Alpha', role: 2 }, s);
    }
    await harness.db.channels.upsertChannel({ id: 2, name: 'Beta', role: 2 }, harness.sourceA);

    vcId = await harness.db.channelDatabase.createAsync({
      name: `Vchan${Date.now() % 100000}`, psk: crypto.randomBytes(16).toString('base64'), pskLength: 16,
      isEnabled: true, enforceNameValidation: true,
    });
    badKeyId = await harness.db.channelDatabase.createAsync({
      name: `BadKey${Date.now() % 100000}`, psk: crypto.randomBytes(16).toString('base64'), pskLength: 16,
      isEnabled: true, enforceNameValidation: true,
    });
    await harness.db.channelDatabase.updateAsync(badKeyId, { psk: Buffer.from('short').toString('base64'), pskLength: 5 });
    await channelDecryptionService.refreshChannelCache();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    setSourcePkiKeyStoreForTesting(null);
    await harness.db.mqttNativeIdentities.deleteBySourceId(MQ).catch(() => {});
    await harness.db.channelDatabase.deleteAsync(vcId).catch(() => {});
    await harness.db.channelDatabase.deleteAsync(badKeyId).catch(() => {});
    for (const id of EXTRA) await harness.db.sources.deleteSource(id).catch(() => {});
    await harness.cleanup();
  });

  const fetchRefs = async (user: Parameters<RouteTestHarness['loginAs']>[0]) => {
    const agent = await harness.loginAs(user);
    const res = await agent.get('/api/unified/senders');
    expect(res.status).toBe(200);
    return (res.body.data.channels as Array<{ name: string; sources: Ref[] }>).flatMap((g) => g.sources);
  };
  const find = (refs: Ref[], sourceId: string, channelNumber: number) => {
    const r = refs.find((x) => x.sourceId === sourceId && x.channelNumber === channelNumber);
    expect(r, `ref ${sourceId}/${channelNumber}`).toBeDefined();
    return r!;
  };
  const enableNative = async () => {
    const admin = await harness.loginAs(harness.admin);
    const res = await admin.put(`/api/sources/${MQ}/mqtt/native`).send({ enabled: true });
    expect(res.status).toBe(200);
  };

  it('anonymous viewers get an empty list and no manager is consulted', async () => {
    for (const s of [harness.sourceA, MC, MQ]) {
      await harness.grant(harness.anonymous.id, 'messages', 'read', s);
      await harness.grant(harness.anonymous.id, 'channel_1', 'write', s);
    }
    const anon = await harness.loginAs(null);
    getManager.mockClear();
    const res = await anon.get('/api/unified/senders');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, data: { channels: [] } });
    expect(getManager).not.toHaveBeenCalled();
  });

  it('virtual refs are never sendable on Meshtastic TCP or MeshCore', async () => {
    const refs = await fetchRefs(harness.admin);
    const vnum = CHANNEL_DB_OFFSET + vcId;
    expect(find(refs, harness.sourceA, vnum)).toMatchObject({ canSend: false, sendBlockedReason: 'VIRTUAL_CHANNEL' });
    expect(find(refs, MC, vnum)).toMatchObject({ canSend: false, sendBlockedReason: 'VIRTUAL_CHANNEL' });
    expect(find(refs, harness.sourceA, 1)).toMatchObject({ canSend: true, sendKind: 'meshtastic' });
    expect(find(refs, MC, 1)).toMatchObject({ canSend: true, sendKind: 'meshcore' });
  });

  it('reports reactionsOutbound for MeshCore refs only (#3045 P3)', async () => {
    let refs = await fetchRefs(harness.admin);
    // Setting unset: the shipped default applies, whatever it is.
    expect(typeof find(refs, MC, 1).reactionsOutbound).toBe('boolean');

    await harness.db.settings.setSourceSetting(MC, 'meshcoreReactionsOutboundEnabled', 'true');
    refs = await fetchRefs(harness.admin);
    expect(find(refs, MC, 1)).toMatchObject({ canSend: true, reactionsOutbound: true });

    await harness.db.settings.setSourceSetting(MC, 'meshcoreReactionsOutboundEnabled', 'false');
    refs = await fetchRefs(harness.admin);
    expect(find(refs, MC, 1)).toMatchObject({ canSend: true, reactionsOutbound: false });

    // Not-sendable MeshCore ref that reached the live-state step still reports it.
    st[MC].connected = false;
    expect(find(await fetchRefs(harness.admin), MC, 1)).toMatchObject({
      sendBlockedReason: 'SOURCE_NOT_CONNECTED', reactionsOutbound: false,
    });
    st[MC].connected = true;

    // Meshtastic and MQTT refs never carry it.
    expect(find(refs, harness.sourceA, 1).reactionsOutbound).toBeNull();
    expect(refs.filter((r) => r.sendKind !== 'meshcore').every((r) => r.reactionsOutbound === null)).toBe(true);
    // A MeshCore ref blocked before the live-state step (virtual) stays null.
    expect(refs.find((r) => r.sourceId === MC && r.sendBlockedReason === 'VIRTUAL_CHANNEL')?.reactionsOutbound).toBeNull();
  });

  it('scopes permissions per source', async () => {
    const lid = harness.limited.id;
    await harness.grant(lid, 'channel_1', 'write', harness.sourceA);
    await harness.grant(lid, 'messages', 'read', harness.sourceA); // lists slots 1 and 2 under A
    await harness.grant(lid, 'channel_1', 'read', harness.sourceB);
    let refs = await fetchRefs(harness.limited);
    expect(find(refs, harness.sourceA, 1)).toMatchObject({ canSend: true, sendKind: 'meshtastic', sendBlockedReason: null });
    expect(find(refs, harness.sourceB, 1)).toMatchObject({ canSend: false, sendKind: null, sendBlockedReason: 'FORBIDDEN' });

    // channel_1:write does not make slot 2 sendable.
    expect(find(refs, harness.sourceA, 2)).toMatchObject({ canSend: false, sendBlockedReason: 'FORBIDDEN' });

    // messages:write alone does not make a Meshtastic slot sendable.
    await harness.revokeAll(lid);
    await harness.grant(lid, 'channel_1', 'read', harness.sourceA);
    await harness.grant(lid, 'messages', 'write', harness.sourceA);
    refs = await fetchRefs(harness.limited);
    expect(find(refs, harness.sourceA, 1)).toMatchObject({ canSend: false, sendBlockedReason: 'FORBIDDEN' });
  });

  it('reports Meshtastic live state, but FORBIDDEN first without the grant', async () => {
    const lid = harness.limited.id;
    await harness.grant(lid, 'channel_1', 'write', harness.sourceA);
    await harness.grant(lid, 'messages', 'read', harness.sourceA);
    await harness.grant(lid, 'channel_1', 'read', harness.sourceB);
    st[harness.sourceA].connected = false;
    st[harness.sourceB].canTransmit = false;
    let refs = await fetchRefs(harness.limited);
    expect(find(refs, harness.sourceA, 1)).toMatchObject({
      canSend: false, sendKind: 'meshtastic', sendBlockedReason: 'SOURCE_NOT_CONNECTED',
    });
    // B has TX off but the viewer has no write grant there.
    expect(find(refs, harness.sourceB, 1)).toMatchObject({ sendBlockedReason: 'FORBIDDEN', sendKind: null });

    st[harness.sourceA].connected = true;
    st[harness.sourceA].canTransmit = false;
    refs = await fetchRefs(harness.limited);
    expect(find(refs, harness.sourceA, 1)).toMatchObject({ canSend: false, sendBlockedReason: 'TX_DISABLED' });
  });

  it('MeshCore: messages:write on that source, with live-state reasons', async () => {
    const lid = harness.limited.id;
    await harness.grant(lid, 'channel_1', 'read', MC);
    await harness.grant(lid, 'messages', 'write', harness.sourceA); // wrong source
    let refs = await fetchRefs(harness.limited);
    expect(find(refs, MC, 1)).toMatchObject({ canSend: false, sendBlockedReason: 'FORBIDDEN' });

    await harness.grant(lid, 'messages', 'write', MC);
    refs = await fetchRefs(harness.limited);
    expect(find(refs, MC, 1)).toMatchObject({ canSend: true, sendKind: 'meshcore' });

    st[MC].receiveOnly = true;
    expect(find(await fetchRefs(harness.limited), MC, 1)).toMatchObject({ canSend: false, sendBlockedReason: 'TX_DISABLED' });
    st[MC].receiveOnly = false;
    st[MC].repeater = true;
    expect(find(await fetchRefs(harness.limited), MC, 1)).toMatchObject({ sendBlockedReason: 'UNSUPPORTED_SOURCE' });
    st[MC].repeater = false;
    st[MC].connected = false;
    expect(find(await fetchRefs(harness.limited), MC, 1)).toMatchObject({ sendBlockedReason: 'SOURCE_NOT_CONNECTED' });
  });

  it('MQTT-native: precondition, permission, physical and unusable-key refs', async () => {
    const vnum = CHANNEL_DB_OFFSET + vcId;
    let refs = await fetchRefs(harness.admin);
    expect(find(refs, MQ, vnum)).toMatchObject({ canSend: false, sendBlockedReason: 'MQTT_NATIVE_DISABLED' });

    await enableNative();
    refs = await fetchRefs(harness.admin);
    expect(find(refs, MQ, vnum)).toMatchObject({ canSend: true, sendKind: 'mqtt_native', sendBlockedReason: null });
    expect(find(refs, MQ, 1)).toMatchObject({ canSend: false, sendBlockedReason: 'PHYSICAL_CHANNEL' });
    expect(find(refs, MQ, CHANNEL_DB_OFFSET + badKeyId)).toMatchObject({ sendBlockedReason: 'CHANNEL_NOT_FOUND' });

    st[MQ].readiness = { ok: false, code: 'READ_ONLY', reason: 'subscribe-only' };
    refs = await fetchRefs(harness.admin);
    expect(find(refs, MQ, vnum)).toMatchObject({ canSend: false, sendKind: 'mqtt_native', sendBlockedReason: 'READ_ONLY' });
    st[MQ].readiness = { ok: true };

    // Non-admin: needs messages:write on the MQTT source AND channel-database read.
    const lid = harness.limited.id;
    await harness.grant(lid, 'channel_1', 'read', MQ);
    await databaseService.channelDatabase.setPermissionAsync({
      userId: lid, channelDatabaseId: vcId, canViewOnMap: false, canRead: true,
    });
    expect(find(await fetchRefs(harness.limited), MQ, vnum)).toMatchObject({ canSend: false, sendBlockedReason: 'FORBIDDEN' });
    await harness.grant(lid, 'messages', 'write', MQ);
    expect(find(await fetchRefs(harness.limited), MQ, vnum)).toMatchObject({ canSend: true, sendKind: 'mqtt_native' });
  });

  it('Reticulum and meshcore_mqtt refs are unsupported', async () => {
    const refs = await fetchRefs(harness.admin);
    expect(find(refs, RET, 1)).toMatchObject({ canSend: false, sendKind: null, sendBlockedReason: 'UNSUPPORTED_SOURCE' });
    expect(find(refs, MCM, 1)).toMatchObject({ canSend: false, sendKind: null, sendBlockedReason: 'UNSUPPORTED_SOURCE' });
  });

  it('hides a source the viewer has no grant on: virtual ref is FORBIDDEN with no kind', async () => {
    await databaseService.channelDatabase.setPermissionAsync({
      userId: harness.limited.id, channelDatabaseId: vcId, canViewOnMap: false, canRead: true,
    });
    const refs = await fetchRefs(harness.limited);
    const r = find(refs, harness.sourceB, CHANNEL_DB_OFFSET + vcId);
    expect(r).toMatchObject({ canSend: false, sendKind: null, sendBlockedReason: 'FORBIDDEN' });
  });

  it('/channels refs keep exactly sourceId, sourceName and channelNumber', async () => {
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.get('/api/unified/channels');
    expect(Array.isArray(res.body)).toBe(true);
    for (const g of res.body) {
      for (const ref of g.sources) {
        expect(Object.keys(ref).sort()).toEqual(['channelNumber', 'sourceId', 'sourceName']);
      }
    }
  });
});
