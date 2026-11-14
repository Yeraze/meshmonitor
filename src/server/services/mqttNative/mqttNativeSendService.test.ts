/**
 * #4305 MQTT-native send service, against the real (in-memory SQLite) DB.
 * Only the source manager is faked: a publisher that records what it was
 * asked to publish. Nothing connects to a broker.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import crypto from 'node:crypto';
import databaseService from '../../../services/database.js';
import { loadProtobufDefinitions } from '../../protobufLoader.js';
import meshtasticProtobufService from '../../meshtasticProtobufService.js';
import { sourceManagerRegistry } from '../../sourceManagerRegistry.js';
import type { ISourceManager } from '../../sourceManagerRegistry.js';
import { SourcePkiKeyStore, setSourcePkiKeyStoreForTesting } from '../sourcePkiKeyStore.js';
import { channelDecryptionService } from '../channelDecryptionService.js';
import { pkiDecryptionService } from '../pkiDecryptionService.js';
import { ingestServiceEnvelope } from '../../mqttIngestion.js';
import { getOwnNodeNums, isOwnNodeNum } from '../../utils/ownNodes.js';
import { CHANNEL_DB_OFFSET, PortNum } from '../../constants/meshtastic.js';
import { generateMqttNativeIdentity } from './mqttNativeCrypto.js';
import { ensureMqttNativeIdentity, loadMqttNativeIdentity } from './mqttNativeIdentity.js';
import { MQTT_NATIVE_SETTING_KEYS } from './mqttNativeConfig.js';
import { resetMqttNativeStateForTesting } from './mqttNativeState.js';
import {
  MqttNativeSendError,
  sendMqttNativeNodeInfoIfDue,
  sendMqttNativeUserText,
  type MqttNativeReadiness,
} from './mqttNativeSendService.js';
import {
  checkMqttNativeNodeInfoNow,
  resetMqttNativeNodeInfoSchedulerForTesting,
  runMqttNativeNodeInfoTick,
  startMqttNativeNodeInfoScheduler,
  MQTT_NATIVE_SCHEDULER_TICK_MS,
} from './mqttNativeNodeInfoScheduler.js';

const SRC = 'mqtt-native-svc-src';
const SRC_OTHER = 'mqtt-native-svc-other';
const USER_ID = 1;

interface Published { topic: string; payload: Buffer; retained: boolean }

function fakeMqttManager(sourceId: string, sourceType: 'mqtt_bridge' | 'mqtt_broker' = 'mqtt_bridge') {
  const published: Published[] = [];
  let readiness: MqttNativeReadiness = { ok: true };
  const manager = {
    sourceId,
    sourceType,
    published,
    setReadiness(r: MqttNativeReadiness) { readiness = r; },
    publish: vi.fn(async (topic: string, payload: Buffer, retained = false) => {
      published.push({ topic, payload, retained });
    }),
    getNativePublishReadiness: () => readiness,
    getNativeRootTopicHint: () => 'msh/US/FL',
    getLocalNodeInfo: () => null,
  };
  return manager;
}

let managers: Record<string, ReturnType<typeof fakeMqttManager>>;
let channelId = 0;
const channelPsk = crypto.randomBytes(16).toString('base64');

async function enable(sourceId: string, extra: Record<string, string> = {}) {
  await databaseService.settings.setSourceSettings(sourceId, { [MQTT_NATIVE_SETTING_KEYS.enabled]: 'true', ...extra });
  await ensureMqttNativeIdentity(sourceId);
}

beforeAll(async () => {
  await loadProtobufDefinitions();
  channelId = await databaseService.channelDatabase.createAsync({
    name: 'NativeSvc', psk: channelPsk, pskLength: 16, isEnabled: true, enforceNameValidation: true,
  });
  await channelDecryptionService.refreshChannelCache();
});

beforeEach(async () => {
  setSourcePkiKeyStoreForTesting(new SourcePkiKeyStore('test-session-secret-4305', true));
  resetMqttNativeStateForTesting();
  for (const s of [SRC, SRC_OTHER]) {
    await databaseService.mqttNativeIdentities.deleteBySourceId(s);
    await databaseService.settings.setSourceSettings(s, {
      [MQTT_NATIVE_SETTING_KEYS.enabled]: 'false',
      [MQTT_NATIVE_SETTING_KEYS.maxPerMinute]: '',
      [MQTT_NATIVE_SETTING_KEYS.maxPerHour]: '',
      [MQTT_NATIVE_SETTING_KEYS.hopLimit]: '',
      [MQTT_NATIVE_SETTING_KEYS.announceChannelId]: String(channelId),
    });
  }
  managers = { [SRC]: fakeMqttManager(SRC), [SRC_OTHER]: fakeMqttManager(SRC_OTHER, 'mqtt_broker') };
  vi.spyOn(sourceManagerRegistry, 'getManager').mockImplementation(
    (id: string) => managers[id] as unknown as ISourceManager | undefined,
  );
  vi.spyOn(sourceManagerRegistry, 'getAllManagers').mockImplementation(
    () => Object.values(managers) as unknown as ISourceManager[],
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  resetMqttNativeNodeInfoSchedulerForTesting();
  vi.useRealTimers();
  setSourcePkiKeyStoreForTesting(null);
});

describe('identity', () => {
  it('generates once, persists sealed, and reloads the same key', async () => {
    const first = await ensureMqttNativeIdentity(SRC);
    const again = await ensureMqttNativeIdentity(SRC);
    expect(again.nodeNum).toBe(first.nodeNum);
    expect(first.nodeId).toBe(`!${first.nodeNum.toString(16).padStart(8, '0')}`);

    const row = await databaseService.mqttNativeIdentities.getBySourceId(SRC);
    expect(row).not.toBeNull();
    const loaded = await loadMqttNativeIdentity(SRC);
    expect(loaded.kind).toBe('ok');
    if (loaded.kind !== 'ok') return;
    // The private key is never stored in the clear.
    expect(row!.encryptedPrivateKey).not.toContain(loaded.privateKey.toString('base64'));
    expect(row!.encryptedPrivateKey).not.toContain(loaded.privateKey.toString('hex'));
    // ...and it opens back to the key whose public half is stored.
    const { x25519PublicFromPrivate } = await import('./mqttNativeCrypto.js');
    expect(x25519PublicFromPrivate(loaded.privateKey).toString('base64')).toBe(row!.publicKey);
    // Our node is now "ours" for the self-origin guard.
    expect(getOwnNodeNums()).toContain(first.nodeNum);
    expect(isOwnNodeNum(first.nodeNum)).toBe(true);
  });

  it('reports key_unavailable under a different SESSION_SECRET', async () => {
    await ensureMqttNativeIdentity(SRC);
    setSourcePkiKeyStoreForTesting(new SourcePkiKeyStore('another-secret', true));
    expect((await loadMqttNativeIdentity(SRC)).kind).toBe('key_unavailable');
  });

  it('refuses to create an identity when SESSION_SECRET is auto-generated', async () => {
    setSourcePkiKeyStoreForTesting(new SourcePkiKeyStore('ephemeral', false));
    await expect(ensureMqttNativeIdentity(SRC)).rejects.toThrow(/SESSION_SECRET/);
    expect(await databaseService.mqttNativeIdentities.getBySourceId(SRC)).toBeNull();
  });
});

describe('user channel send', () => {
  it('publishes an envelope the MQTT decrypt opens and stores the sent message', async () => {
    await enable(SRC);
    const identity = (await loadMqttNativeIdentity(SRC)) as Extract<Awaited<ReturnType<typeof loadMqttNativeIdentity>>, { kind: 'ok' }>;
    const result = await sendMqttNativeUserText({
      sourceId: SRC, userId: USER_ID, text: 'hello from mqtt', channel: CHANNEL_DB_OFFSET + channelId,
    });

    const pub = managers[SRC].published;
    expect(pub).toHaveLength(1);
    expect(pub[0].retained).toBe(false);
    expect(pub[0].topic).toBe(`msh/US/FL/2/e/NativeSvc/${identity.info.nodeId}`);
    expect(result.topic).toBe(pub[0].topic);

    const env = meshtasticProtobufService.decodeServiceEnvelope(pub[0].payload)!;
    expect(env.gatewayId).toBe(identity.info.nodeId);
    expect(env.channelId).toBe('NativeSvc');
    expect(env.packet.from >>> 0).toBe(identity.info.nodeNum);
    expect(env.packet.hopLimit).toBe(3);
    expect(env.packet.hopStart).toBe(3);
    expect(env.packet.wantAck).toBeFalsy();
    const r = await channelDecryptionService.tryDecrypt(
      env.packet.encrypted, env.packet.id >>> 0, env.packet.from >>> 0, env.packet.channel, env.packet.to >>> 0,
    );
    expect(r.success).toBe(true);
    expect(Buffer.from(r.payload!).toString()).toBe('hello from mqtt');

    const stored = await databaseService.messages.getMessage(result.messageId);
    expect(stored?.text).toBe('hello from mqtt');
    expect(stored?.channel).toBe(CHANNEL_DB_OFFSET + channelId);
    expect(Number(stored?.fromNodeNum)).toBe(identity.info.nodeNum);
    expect(result.messageId).toBe(`${SRC}_${identity.info.nodeNum}_${result.packetId}`);
  });

  it('uses the configured hop limit, clamped 0-7', async () => {
    await enable(SRC, { [MQTT_NATIVE_SETTING_KEYS.hopLimit]: '0' });
    await sendMqttNativeUserText({ sourceId: SRC, userId: USER_ID, text: 'a', channel: CHANNEL_DB_OFFSET + channelId });
    await databaseService.settings.setSourceSetting(SRC, MQTT_NATIVE_SETTING_KEYS.hopLimit, '42');
    await sendMqttNativeUserText({ sourceId: SRC, userId: USER_ID, text: 'b', channel: CHANNEL_DB_OFFSET + channelId });
    const hops = managers[SRC].published.map((p) => meshtasticProtobufService.decodeServiceEnvelope(p.payload)!.packet.hopLimit ?? 0);
    expect(hops).toEqual([0, 7]);
  });

  it('refuses when the feature is off, the source is read-only, or the caller is not a user', async () => {
    await ensureMqttNativeIdentity(SRC);
    const send = (userId = USER_ID) =>
      sendMqttNativeUserText({ sourceId: SRC, userId, text: 'x', channel: CHANNEL_DB_OFFSET + channelId });
    await expect(send()).rejects.toMatchObject({ code: 'MQTT_NATIVE_DISABLED' });

    await enable(SRC);
    managers[SRC].setReadiness({ ok: false, code: 'READ_ONLY', reason: 'subscribe-only' });
    await expect(send()).rejects.toMatchObject({ code: 'READ_ONLY', status: 409 });
    managers[SRC].setReadiness({ ok: false, code: 'NOT_CONNECTED', reason: 'down' });
    await expect(send()).rejects.toMatchObject({ code: 'NOT_CONNECTED' });
    managers[SRC].setReadiness({ ok: true });

    // Automations have no user id: an id of 0 / NaN never transmits.
    await expect(send(0)).rejects.toMatchObject({ code: 'INVALID_ORIGIN' });
    await expect(send(Number.NaN)).rejects.toMatchObject({ code: 'INVALID_ORIGIN' });
    expect(managers[SRC].published).toHaveLength(0);
  });

  it('refuses a non-MQTT source', async () => {
    managers['tcp'] = { ...fakeMqttManager('tcp'), sourceType: 'meshtastic_tcp' } as unknown as ReturnType<typeof fakeMqttManager>;
    await expect(
      sendMqttNativeUserText({ sourceId: 'tcp', userId: USER_ID, text: 'x', channel: CHANNEL_DB_OFFSET + channelId }),
    ).rejects.toMatchObject({ code: 'NOT_MQTT_SOURCE' });
  });

  it('refuses over-long text and unknown channels', async () => {
    await enable(SRC);
    await expect(sendMqttNativeUserText({ sourceId: SRC, userId: USER_ID, text: 'x'.repeat(201), channel: CHANNEL_DB_OFFSET + channelId }))
      .rejects.toMatchObject({ code: 'MESSAGE_TOO_LONG' });
    await expect(sendMqttNativeUserText({ sourceId: SRC, userId: USER_ID, text: 'x', channel: 3 }))
      .rejects.toMatchObject({ code: 'CHANNEL_NOT_FOUND' });
    await expect(sendMqttNativeUserText({ sourceId: SRC, userId: USER_ID, text: 'x', channel: CHANNEL_DB_OFFSET + 999999 }))
      .rejects.toMatchObject({ code: 'CHANNEL_NOT_FOUND' });
  });
});

describe('user PKI DM', () => {
  it('needs the recipient public key, then publishes on the PKI topic', async () => {
    await enable(SRC);
    const them = generateMqttNativeIdentity();
    await expect(sendMqttNativeUserText({ sourceId: SRC, userId: USER_ID, text: 'dm', destinationNum: them.nodeNum }))
      .rejects.toMatchObject({ code: 'NO_PUBLIC_KEY' });

    await databaseService.upsertNodeAsync({
      nodeNum: them.nodeNum, nodeId: `!${them.nodeNum.toString(16).padStart(8, '0')}`,
      publicKey: them.publicKey.toString('base64'), createdAt: Date.now(), updatedAt: Date.now(),
    }, SRC);
    // The key is per-source: the other source does not know it.
    await enable(SRC_OTHER);
    await expect(sendMqttNativeUserText({ sourceId: SRC_OTHER, userId: USER_ID, text: 'dm', destinationNum: them.nodeNum }))
      .rejects.toMatchObject({ code: 'NO_PUBLIC_KEY' });

    const res = await sendMqttNativeUserText({ sourceId: SRC, userId: USER_ID, text: 'private hi', destinationNum: them.nodeNum });
    const us = (await loadMqttNativeIdentity(SRC)) as Extract<Awaited<ReturnType<typeof loadMqttNativeIdentity>>, { kind: 'ok' }>;
    const pub = managers[SRC].published.at(-1)!;
    expect(pub.topic).toBe(`msh/US/FL/2/e/PKI/${us.info.nodeId}`);
    const env = meshtasticProtobufService.decodeServiceEnvelope(pub.payload)!;
    expect(env.channelId).toBe('PKI');
    expect(env.packet.pkiEncrypted).toBe(true);
    expect(env.packet.to >>> 0).toBe(them.nodeNum);
    const r = pkiDecryptionService.tryDecryptDirectMessage(
      them.privateKey, us.publicKeyBytes, env.packet.id >>> 0, env.packet.from >>> 0, env.packet.encrypted,
    );
    expect(r.success).toBe(true);
    expect(Buffer.from(r.payload!).toString()).toBe('private hi');
    const stored = await databaseService.messages.getMessage(res.messageId);
    expect(stored?.channel).toBe(-1);
  });

  it('opens a PKI DM reply addressed to our node on MQTT ingest', async () => {
    await enable(SRC);
    const them = generateMqttNativeIdentity();
    await databaseService.upsertNodeAsync({
      nodeNum: them.nodeNum, nodeId: `!${them.nodeNum.toString(16).padStart(8, '0')}`,
      publicKey: them.publicKey.toString('base64'), createdAt: Date.now(), updatedAt: Date.now(),
    }, SRC);
    const us = (await loadMqttNativeIdentity(SRC)) as Extract<Awaited<ReturnType<typeof loadMqttNativeIdentity>>, { kind: 'ok' }>;
    const { encryptPkiPayload } = await import('./mqttNativeCrypto.js');
    const { encodeDataMessage, encodeMqttNativeEnvelope } = await import('./mqttNativePacket.js');
    const id = 0x5151;
    const blob = encryptPkiPayload(encodeDataMessage({ portnum: PortNum.TEXT_MESSAGE_APP, payload: Buffer.from('reply!') }), {
      localPrivateKey: them.privateKey, remotePublicKey: us.publicKeyBytes, packetId: id, fromNode: them.nodeNum,
    });
    const payload = encodeMqttNativeEnvelope({
      from: them.nodeNum, to: us.info.nodeNum, id, channel: 0, hopLimit: 3, encrypted: blob,
      pkiEncrypted: true, channelId: 'PKI', gatewayId: '!0badf00d',
    });
    const envelope = meshtasticProtobufService.decodeServiceEnvelope(payload)!;
    const result = await ingestServiceEnvelope({ sourceId: SRC, envelope: envelope as never });
    expect(result.ingested).toBe(true);
    const stored = await databaseService.messages.getMessage(`${SRC}_${them.nodeNum}_${id}`);
    expect(stored?.text).toBe('reply!');
    expect(stored?.channel).toBe(-1);
  });
});

describe('rate limit (6/min, 60/h per source, persisted, lower-only)', () => {
  const send = (sourceId = SRC) =>
    sendMqttNativeUserText({ sourceId, userId: USER_ID, text: 'r', channel: CHANNEL_DB_OFFSET + channelId });

  it('allows 6 in a minute and refuses the 7th with Retry-After', async () => {
    await enable(SRC);
    for (let i = 0; i < 6; i++) await send();
    const err = await send().catch((e) => e);
    expect(err).toBeInstanceOf(MqttNativeSendError);
    expect(err.code).toBe('RATE_LIMITED');
    expect(err.status).toBe(429);
    expect(err.retryAfterSeconds).toBeGreaterThan(0);
    expect(managers[SRC].published).toHaveLength(6);
    // Per source: the other source still has its full budget.
    await enable(SRC_OTHER);
    await expect(send(SRC_OTHER)).resolves.toBeTruthy();
  });

  it('keeps the hourly window across a restart (state is in the DB, not memory)', async () => {
    await enable(SRC);
    const now = Date.now();
    // 60 sends spread over the last 50 minutes, as a previous process left them.
    const times = Array.from({ length: 60 }, (_, i) => now - 50 * 60_000 + i * 30_000 - 60_000);
    await databaseService.mqttNativeIdentities.setSendTimes(SRC, times);
    resetMqttNativeStateForTesting(); // a "restart": nothing in memory survives
    await expect(send()).rejects.toMatchObject({ code: 'RATE_LIMITED' });
    expect(managers[SRC].published).toHaveLength(0);
  });

  it('persists the slot before publishing', async () => {
    await enable(SRC);
    await send();
    const row = await databaseService.mqttNativeIdentities.getBySourceId(SRC);
    expect(JSON.parse(row!.sendTimes!)).toHaveLength(1);
  });

  it('an admin can lower the caps but never raise them', async () => {
    await enable(SRC, { [MQTT_NATIVE_SETTING_KEYS.maxPerMinute]: '2' });
    await send();
    await send();
    await expect(send()).rejects.toMatchObject({ code: 'RATE_LIMITED' });

    await databaseService.mqttNativeIdentities.setSendTimes(SRC, []);
    // A value above the hard cap (written straight to the DB) still clamps to 6.
    await databaseService.settings.setSourceSetting(SRC, MQTT_NATIVE_SETTING_KEYS.maxPerMinute, '99');
    for (let i = 0; i < 6; i++) await send();
    await expect(send()).rejects.toMatchObject({ code: 'RATE_LIMITED' });
  });
});

describe('own echo', () => {
  it('our publish coming back on the same source is dropped, not stored twice, and emits nothing', async () => {
    await enable(SRC);
    const res = await sendMqttNativeUserText({ sourceId: SRC, userId: USER_ID, text: 'echo me', channel: CHANNEL_DB_OFFSET + channelId });
    const envelope = meshtasticProtobufService.decodeServiceEnvelope(managers[SRC].published[0].payload)!;
    const { dataEventEmitter } = await import('../dataEventEmitter.js');
    const emitSpy = vi.spyOn(dataEventEmitter, 'emitNewMessage');
    const result = await ingestServiceEnvelope({ sourceId: SRC, envelope: envelope as never });
    expect(result).toEqual({ ingested: false, reason: 'own-echo' });
    expect(emitSpy).not.toHaveBeenCalled();
    const all = await databaseService.messages.getMessages(500, 0, SRC);
    expect(all.filter((m: { id: string }) => m.id === res.messageId)).toHaveLength(1);
  });
});

describe('NodeInfo announce', () => {
  it('fires once when enabled, then only every 3 hours', async () => {
    let now = 1_800_000_000_000;
    const clock = () => now;
    await enable(SRC);
    expect(await sendMqttNativeNodeInfoIfDue(SRC, clock)).toBe('sent');
    const pub = managers[SRC].published;
    expect(pub).toHaveLength(1);
    const env = meshtasticProtobufService.decodeServiceEnvelope(pub[0].payload)!;
    const r = await channelDecryptionService.tryDecrypt(
      env.packet.encrypted, env.packet.id >>> 0, env.packet.from >>> 0, env.packet.channel, env.packet.to >>> 0,
    );
    expect(r.portnum).toBe(PortNum.NODEINFO_APP);

    expect(await sendMqttNativeNodeInfoIfDue(SRC, clock)).toBe('not-due');
    now += 3 * 3600_000 - 1;
    expect(await sendMqttNativeNodeInfoIfDue(SRC, clock)).toBe('not-due');
    now += 1;
    expect(await sendMqttNativeNodeInfoIfDue(SRC, clock)).toBe('sent');
    expect(pub).toHaveLength(2);
    expect((await databaseService.mqttNativeIdentities.getBySourceId(SRC))!.lastNodeInfoAt).toBe(now);
  });

  it('does not count NodeInfo against the user send cap', async () => {
    await enable(SRC);
    await sendMqttNativeNodeInfoIfDue(SRC);
    const row = await databaseService.mqttNativeIdentities.getBySourceId(SRC);
    expect(row!.sendTimes).toBeNull();
  });

  it('does nothing while disabled', async () => {
    await ensureMqttNativeIdentity(SRC);
    expect(await sendMqttNativeNodeInfoIfDue(SRC)).toBe('disabled');
    expect(managers[SRC].published).toHaveLength(0);
  });

  it('a scheduler restart is not a trigger', async () => {
    await enable(SRC);
    await sendMqttNativeNodeInfoIfDue(SRC);
    expect(managers[SRC].published).toHaveLength(1);

    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    // Restart the scheduler a few times: no immediate send, and the first
    // tick finds the persisted timestamp fresh.
    for (let i = 0; i < 3; i++) {
      resetMqttNativeNodeInfoSchedulerForTesting();
      startMqttNativeNodeInfoScheduler();
    }
    expect(managers[SRC].published).toHaveLength(1);
    const results = await runMqttNativeNodeInfoTick();
    expect(results[SRC]).toBe('not-due');
    vi.advanceTimersByTime(MQTT_NATIVE_SCHEDULER_TICK_MS);
    await new Promise((r) => setImmediate(r));
    expect(managers[SRC].published).toHaveLength(1);
  });

  it('a settings save does not fire and does not clear the timestamp', async () => {
    await enable(SRC);
    expect(await checkMqttNativeNodeInfoNow(SRC)).toBe('sent');
    const before = (await databaseService.mqttNativeIdentities.getBySourceId(SRC))!.lastNodeInfoAt;
    // Save other settings, then the same post-save check the route runs.
    await databaseService.settings.setSourceSettings(SRC, {
      [MQTT_NATIVE_SETTING_KEYS.hopLimit]: '2', [MQTT_NATIVE_SETTING_KEYS.longName]: 'Renamed',
    });
    expect(await checkMqttNativeNodeInfoNow(SRC)).toBe('not-due');
    // Disable + re-enable inside 3 h: still nothing.
    await databaseService.settings.setSourceSetting(SRC, MQTT_NATIVE_SETTING_KEYS.enabled, 'false');
    await databaseService.settings.setSourceSetting(SRC, MQTT_NATIVE_SETTING_KEYS.enabled, 'true');
    expect(await checkMqttNativeNodeInfoNow(SRC)).toBe('not-due');
    expect(managers[SRC].published).toHaveLength(1);
    expect((await databaseService.mqttNativeIdentities.getBySourceId(SRC))!.lastNodeInfoAt).toBe(before);
  });

  it('a failed publish sends nothing, keeps the timestamp unset, and backs off', async () => {
    await enable(SRC);
    managers[SRC].publish.mockRejectedValueOnce(new Error('broker gone'));
    expect(await checkMqttNativeNodeInfoNow(SRC)).toBe('failed');
    expect((await databaseService.mqttNativeIdentities.getBySourceId(SRC))!.lastNodeInfoAt).toBeNull();
    expect(await checkMqttNativeNodeInfoNow(SRC)).toBe('backoff');
  });

  it('read-only sources never announce', async () => {
    await enable(SRC);
    managers[SRC].setReadiness({ ok: false, code: 'READ_ONLY', reason: 'subscribe-only' });
    expect(await sendMqttNativeNodeInfoIfDue(SRC)).toBe('not-ready');
    expect(managers[SRC].published).toHaveLength(0);
  });
});
