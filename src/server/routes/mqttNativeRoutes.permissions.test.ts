/**
 * #4305 MQTT-native send routes: real auth + real permission SQL via the
 * route harness. Only the source managers are faked (a recording publisher);
 * nothing reaches a broker.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import crypto from 'node:crypto';
import mqttNativeRoutes from './mqttNativeRoutes.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';
import { sourceManagerRegistry, type ISourceManager } from '../sourceManagerRegistry.js';
import { loadProtobufDefinitions } from '../protobufLoader.js';
import { SourcePkiKeyStore, setSourcePkiKeyStoreForTesting } from '../services/sourcePkiKeyStore.js';
import { channelDecryptionService } from '../services/channelDecryptionService.js';
import { MQTT_NATIVE_SETTING_KEYS } from '../services/mqttNative/mqttNativeConfig.js';
import { resetMqttNativeStateForTesting } from '../services/mqttNative/mqttNativeState.js';
import type { MqttNativeReadiness } from '../services/mqttNative/mqttNativeSendService.js';
import { CHANNEL_DB_OFFSET } from '../constants/meshtastic.js';

function fakeMqttManager(sourceId: string) {
  const published: Array<{ topic: string; payload: Buffer }> = [];
  let readiness: MqttNativeReadiness = { ok: true };
  let hint: string | null = 'msh/US/FL';
  return {
    sourceId,
    sourceType: 'mqtt_bridge',
    published,
    setReadiness(r: MqttNativeReadiness) { readiness = r; },
    setHint(h: string | null) { hint = h; },
    publish: vi.fn(async (topic: string, payload: Buffer) => { published.push({ topic, payload }); }),
    getNativePublishReadiness: () => readiness,
    getNativeRootTopicHint: () => hint,
    getLocalNodeInfo: () => null,
  };
}

let harness: RouteTestHarness;
let managers: Record<string, ReturnType<typeof fakeMqttManager>>;
let channelDbId = 0;

beforeAll(async () => {
  await loadProtobufDefinitions();
});

beforeEach(async () => {
  harness = await createRouteTestApp({
    mount: (app) => app.use('/api/sources/:id/mqtt/native', mqttNativeRoutes),
  });
  setSourcePkiKeyStoreForTesting(new SourcePkiKeyStore('route-test-secret-4305', true));
  resetMqttNativeStateForTesting();
  managers = { [harness.sourceA]: fakeMqttManager(harness.sourceA), [harness.sourceB]: fakeMqttManager(harness.sourceB) };
  vi.spyOn(sourceManagerRegistry, 'getManager').mockImplementation(
    (id: string) => managers[id] as unknown as ISourceManager | undefined,
  );
  vi.spyOn(sourceManagerRegistry, 'getAllManagers').mockImplementation(
    () => Object.values(managers) as unknown as ISourceManager[],
  );
  channelDbId = await harness.db.channelDatabase.createAsync({
    name: `RouteNative${Date.now() % 100000}`, psk: crypto.randomBytes(16).toString('base64'), pskLength: 16,
    isEnabled: true, enforceNameValidation: true,
  });
  await channelDecryptionService.refreshChannelCache();
  for (const s of [harness.sourceA, harness.sourceB]) {
    await harness.db.mqttNativeIdentities.deleteBySourceId(s);
    await harness.db.settings.setSourceSettings(s, {
      [MQTT_NATIVE_SETTING_KEYS.enabled]: 'false',
      [MQTT_NATIVE_SETTING_KEYS.maxPerMinute]: '',
      [MQTT_NATIVE_SETTING_KEYS.maxPerHour]: '',
      [MQTT_NATIVE_SETTING_KEYS.hopLimit]: '',
      [MQTT_NATIVE_SETTING_KEYS.rootTopic]: '',
      [MQTT_NATIVE_SETTING_KEYS.announceChannelId]: String(channelDbId),
    });
  }
});

afterEach(async () => {
  vi.restoreAllMocks();
  setSourcePkiKeyStoreForTesting(null);
  for (const s of [harness.sourceA, harness.sourceB]) {
    await harness.db.mqttNativeIdentities.deleteBySourceId(s);
  }
  await harness.db.channelDatabase.deleteAsync(channelDbId);
  await harness.cleanup();
});

async function enableAsAdmin(sourceId: string) {
  const admin = await harness.loginAs(harness.admin);
  const res = await admin.put(`/api/sources/${sourceId}/mqtt/native`).send({ enabled: true });
  expect(res.status).toBe(200);
  return res;
}

describe('PUT /api/sources/:id/mqtt/native', () => {
  it('needs sources:write', async () => {
    await harness.grant(harness.limited.id, 'messages', 'write', harness.sourceA);
    const limited = await harness.loginAs(harness.limited);
    const res = await limited.put(`/api/sources/${harness.sourceA}/mqtt/native`).send({ enabled: true });
    expect(res.status).toBe(403);
    expect(await harness.db.mqttNativeIdentities.getBySourceId(harness.sourceA)).toBeNull();

    const anon = await harness.loginAs(null);
    expect((await anon.put(`/api/sources/${harness.sourceA}/mqtt/native`).send({ enabled: true })).status).toBe(401);
  });

  it('enabling generates the identity, returns the node id, and announces NodeInfo once', async () => {
    const res = await enableAsAdmin(harness.sourceA);
    expect(res.body.success).toBe(true);
    expect(res.body.data.enabled).toBe(true);
    expect(res.body.data.identity.nodeId).toMatch(/^![0-9a-f]{8}$/);
    // The NodeInfo check runs after the response; let it finish.
    await vi.waitFor(() => expect(managers[harness.sourceA].published).toHaveLength(1));

    // A later save (new hop limit, new name) does not announce again.
    const admin = await harness.loginAs(harness.admin);
    const save = await admin.put(`/api/sources/${harness.sourceA}/mqtt/native`).send({ hopLimit: 2, longName: 'Bob' });
    expect(save.status).toBe(200);
    expect(save.body.data.config.hopLimit).toBe(2);
    await new Promise((r) => setTimeout(r, 50));
    expect(managers[harness.sourceA].published).toHaveLength(1);
    // Source B was untouched.
    expect(await harness.db.mqttNativeIdentities.getBySourceId(harness.sourceB)).toBeNull();
  });

  it('rejects limits above the server caps and hop limits outside 0-7', async () => {
    const admin = await harness.loginAs(harness.admin);
    const url = `/api/sources/${harness.sourceA}/mqtt/native`;
    expect((await admin.put(url).send({ maxPerMinute: 7 })).body.code).toBe('INVALID_RATE_LIMIT');
    expect((await admin.put(url).send({ maxPerHour: 61 })).body.code).toBe('INVALID_RATE_LIMIT');
    expect((await admin.put(url).send({ hopLimit: 8 })).body.code).toBe('INVALID_HOP_LIMIT');
    expect((await admin.put(url).send({ hopLimit: -1 })).status).toBe(400);
    const lower = await admin.put(url).send({ maxPerMinute: 2, maxPerHour: 10, hopLimit: 0 });
    expect(lower.status).toBe(200);
    expect(lower.body.data.config).toMatchObject({ maxPerMinute: 2, maxPerHour: 10, hopLimit: 0 });
  });

  it('refuses to enable on a subscribe-only (read-only) source', async () => {
    managers[harness.sourceA].setReadiness({ ok: false, code: 'READ_ONLY', reason: 'subscribe-only' });
    const admin = await harness.loginAs(harness.admin);
    const res = await admin.put(`/api/sources/${harness.sourceA}/mqtt/native`).send({ enabled: true });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('READ_ONLY');
    expect(await harness.db.mqttNativeIdentities.getBySourceId(harness.sourceA)).toBeNull();
  });

  it('refuses to enable with no root topic to publish under', async () => {
    managers[harness.sourceA].setHint(null);
    const admin = await harness.loginAs(harness.admin);
    const url = `/api/sources/${harness.sourceA}/mqtt/native`;
    expect((await admin.put(url).send({ enabled: true })).body.code).toBe('NO_ROOT_TOPIC');
    expect((await admin.put(url).send({ rootTopic: 'msh/#' })).body.code).toBe('INVALID_ROOT_TOPIC');
    const ok = await admin.put(url).send({ enabled: true, rootTopic: 'msh/EU_868' });
    expect(ok.status).toBe(200);
    expect(ok.body.data.effectiveRootTopic).toBe('msh/EU_868');
  });

  it('refuses a non-MQTT source', async () => {
    delete managers[harness.sourceA];
    const admin = await harness.loginAs(harness.admin);
    const res = await admin.put(`/api/sources/${harness.sourceA}/mqtt/native`).send({ enabled: true });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('NOT_MQTT_SOURCE');
  });
});

describe('GET /api/sources/:id/mqtt/native', () => {
  it('is scoped to messages:read on that source', async () => {
    await enableAsAdmin(harness.sourceA);
    await harness.grant(harness.limited.id, 'messages', 'read', harness.sourceA);
    const limited = await harness.loginAs(harness.limited);
    const a = await limited.get(`/api/sources/${harness.sourceA}/mqtt/native`);
    expect(a.status).toBe(200);
    expect(a.body.data.enabled).toBe(true);
    expect(a.body.data.identity.nodeId).toMatch(/^!/);
    expect(a.body.data.limits).toMatchObject({ hardMaxPerMinute: 6, hardMaxPerHour: 60, maxHopLimit: 7 });
    expect((await limited.get(`/api/sources/${harness.sourceB}/mqtt/native`)).status).toBe(403);
  });
});

describe('POST /api/sources/:id/mqtt/native/send', () => {
  const body = () => ({ text: 'hi there', channel: CHANNEL_DB_OFFSET + channelDbId });

  it('needs messages:write on THAT source (per-source isolation)', async () => {
    await enableAsAdmin(harness.sourceA);
    await enableAsAdmin(harness.sourceB);
    await vi.waitFor(() => expect(managers[harness.sourceB].published).toHaveLength(1));
    const baseline = { a: managers[harness.sourceA].published.length, b: managers[harness.sourceB].published.length };

    await harness.grant(harness.limited.id, 'messages', 'write', harness.sourceA);
    await harness.db.channelDatabase.setPermissionAsync({
      userId: harness.limited.id, channelDatabaseId: channelDbId, canRead: true, canViewOnMap: false,
    });
    const limited = await harness.loginAs(harness.limited);

    const okRes = await limited.post(`/api/sources/${harness.sourceA}/mqtt/native/send`).send(body());
    expect(okRes.status).toBe(200);
    expect(okRes.body.data.messageId).toMatch(new RegExp(`^${harness.sourceA}_`));
    expect(managers[harness.sourceA].published).toHaveLength(baseline.a + 1);

    const denied = await limited.post(`/api/sources/${harness.sourceB}/mqtt/native/send`).send(body());
    expect(denied.status).toBe(403);
    expect(managers[harness.sourceB].published).toHaveLength(baseline.b);
  });

  it('needs read access to the Channel Database channel for a channel send', async () => {
    await enableAsAdmin(harness.sourceA);
    await harness.grant(harness.limited.id, 'messages', 'write', harness.sourceA);
    const limited = await harness.loginAs(harness.limited);
    const res = await limited.post(`/api/sources/${harness.sourceA}/mqtt/native/send`).send(body());
    expect(res.status).toBe(403);
  });

  it('refuses anonymous callers', async () => {
    await enableAsAdmin(harness.sourceA);
    const anon = await harness.loginAs(null);
    expect((await anon.post(`/api/sources/${harness.sourceA}/mqtt/native/send`).send(body())).status).toBe(401);
  });

  it('refuses when the feature is off (default)', async () => {
    const admin = await harness.loginAs(harness.admin);
    const res = await admin.post(`/api/sources/${harness.sourceA}/mqtt/native/send`).send(body());
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('MQTT_NATIVE_DISABLED');
    expect(managers[harness.sourceA].published).toHaveLength(0);
  });

  it('refuses a read-only source', async () => {
    await enableAsAdmin(harness.sourceA);
    managers[harness.sourceA].setReadiness({ ok: false, code: 'READ_ONLY', reason: 'subscribe-only' });
    const admin = await harness.loginAs(harness.admin);
    const res = await admin.post(`/api/sources/${harness.sourceA}/mqtt/native/send`).send(body());
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('READ_ONLY');
  });

  it('returns 429 with Retry-After at the cap', async () => {
    await enableAsAdmin(harness.sourceA);
    const admin = await harness.loginAs(harness.admin);
    await admin.put(`/api/sources/${harness.sourceA}/mqtt/native`).send({ maxPerMinute: 1 });
    expect((await admin.post(`/api/sources/${harness.sourceA}/mqtt/native/send`).send(body())).status).toBe(200);
    const res = await admin.post(`/api/sources/${harness.sourceA}/mqtt/native/send`).send(body());
    expect(res.status).toBe(429);
    expect(res.body.code).toBe('RATE_LIMITED');
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
  });
});
