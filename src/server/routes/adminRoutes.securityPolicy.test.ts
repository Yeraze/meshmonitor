/**
 * setSecurityConfig must carry the node's CURRENT packet_signature_policy.
 *
 * Firmware 2.8 added `SecurityConfig.packet_signature_policy` (field 9) and
 * replaces the whole security struct on a set, so a write without field 9
 * resets the node to COMPATIBLE (0). The remote path carried the policy; the
 * local path did not, so every local Security save downgraded a node that the
 * phone app had set to BALANCED or STRICT.
 *
 * These tests run the REAL encoder and assert on the bytes handed to
 * `sendAdminCommand` — the object passed to the encoder can look right while
 * the wire is wrong.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import protobuf from 'protobufjs';
import adminRoutes from './adminRoutes.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';
import { sourceManagerRegistry, type ISourceManager } from '../sourceManagerRegistry.js';
import protobufService from '../protobufService.js';
import { loadProtobufDefinitions, getProtobufRoot } from '../protobufLoader.js';

const LOCAL = 1;
const REMOTE = 999;
const COMPATIBLE = 0;
const BALANCED = 1;
const STRICT = 2;
const POLICY_FIELD = 9;
/** A firmware version that has the policy field. */
const FW_28 = '2.8.0.abcdef0';

const PUB = Buffer.alloc(32, 0x11);
const PRIV = Buffer.alloc(32, 0x22);

/** One level of protobuf wire format: field number -> raw values, in order. */
function wireFields(buf: Uint8Array): Map<number, Array<Uint8Array | number>> {
  const reader = protobuf.Reader.create(buf);
  const out = new Map<number, Array<Uint8Array | number>>();
  while (reader.pos < reader.len) {
    const tag = reader.uint32();
    const field = tag >>> 3;
    const wireType = tag & 7;
    let value: Uint8Array | number;
    if (wireType === 2) value = reader.bytes();
    else if (wireType === 0) value = reader.uint32();
    else { reader.skipType(wireType); value = -1; }
    out.set(field, [...(out.get(field) ?? []), value]);
  }
  return out;
}

/** The raw SecurityConfig bytes inside an encoded set_config AdminMessage. */
function securityBytes(adminMessage: Uint8Array): Uint8Array {
  const root = getProtobufRoot()!;
  const setConfigId = root.lookupType('meshtastic.AdminMessage').fields.setConfig.id;
  const securityId = root.lookupType('meshtastic.Config').fields.security.id;
  const config = wireFields(adminMessage).get(setConfigId)?.[0] as Uint8Array;
  expect(config, 'AdminMessage carries set_config').toBeInstanceOf(Uint8Array);
  const security = wireFields(config).get(securityId)?.[0] as Uint8Array;
  expect(security, 'set_config carries security').toBeInstanceOf(Uint8Array);
  return security;
}

/**
 * What a node answers to get_config(SECURITY), run through the same decode the
 * manager uses — so a pre-2.8 answer has the shape the server really sees
 * (`defaults: true` reports an absent enum as 0).
 */
function deviceAnswer(security: Record<string, unknown>): Record<string, unknown> {
  const AdminMessage = getProtobufRoot()!.lookupType('meshtastic.AdminMessage');
  const bytes = AdminMessage.encode(AdminMessage.create({ getConfigResponse: { security } })).finish();
  return protobufService.decodeAdminMessage(bytes).getConfigResponse.security;
}

describe('adminRoutes — setSecurityConfig keeps packet_signature_policy', () => {
  let harness: RouteTestHarness;
  let sendAdminCommand: ReturnType<typeof vi.fn>;

  function makeManager(overrides: Record<string, unknown>): ISourceManager {
    return {
      sourceId: harness.sourceA,
      sourceType: 'meshtastic_tcp',
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
      getStatus: vi.fn().mockReturnValue({ sourceId: harness.sourceA, sourceName: 'A', sourceType: 'meshtastic_tcp', connected: true }),
      getLocalNodeInfo: vi.fn().mockReturnValue({ nodeNum: LOCAL, nodeId: '!00000001', longName: 'Local', shortName: 'LOC', firmwareVersion: FW_28 }),
      isDeviceConnected: vi.fn().mockReturnValue(true),
      getSessionPasskey: vi.fn().mockReturnValue(new Uint8Array([1, 2, 3, 4])),
      getSessionPasskeyStatus: vi.fn().mockReturnValue({ hasPasskey: true }),
      sendAdminCommand,
      sendAdminCommandAwaitAck: vi.fn().mockResolvedValue({ acked: true, timedOut: false }),
      updateCachedDeviceConfig: vi.fn(),
      startDistanceDeleteScheduler: vi.fn().mockResolvedValue(undefined),
      stopDistanceDeleteScheduler: vi.fn(),
      isTxEnabled: vi.fn().mockReturnValue(true),
      ...overrides,
    } as unknown as ISourceManager;
  }

  async function waitForSettled(agent: any, operationId: string, attempts = 80) {
    const { isTerminal } = await import('../services/adminOperationService.js');
    for (let i = 0; i < attempts; i++) {
      const res = await agent.get(`/operations/${operationId}`);
      const op = res.body?.data;
      if (op && isTerminal(op.status)) return op;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`operation ${operationId} never settled`);
  }

  const clientConfig = { adminKeys: [], isManaged: false, serialEnabled: true, debugLogApiEnabled: false, adminChannelEnabled: false };

  async function saveLocal(config: Record<string, unknown> = clientConfig) {
    const agent = await harness.loginAs(harness.admin);
    return agent.post('/commands').send({ command: 'setSecurityConfig', sourceId: harness.sourceA, nodeNum: LOCAL, config });
  }

  /** The decoded SecurityConfig that went to the node, plus its raw fields. */
  function sent() {
    expect(sendAdminCommand).toHaveBeenCalledTimes(1);
    const bytes = sendAdminCommand.mock.calls[0][0] as Uint8Array;
    const raw = securityBytes(bytes);
    const SecurityConfig = getProtobufRoot()!.lookupType('meshtastic.Config.SecurityConfig');
    return { fields: wireFields(raw), decoded: SecurityConfig.decode(raw) as unknown as Record<string, unknown> };
  }

  beforeAll(async () => {
    await loadProtobufDefinitions();
  });

  beforeEach(async () => {
    harness = await createRouteTestApp({ mount: (app) => app.use('/', adminRoutes) });
    sendAdminCommand = vi.fn().mockResolvedValue(undefined);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await sourceManagerRegistry.removeManager(harness.sourceA);
    await harness.cleanup();
  });

  describe('local node', () => {
    it.each([
      ['STRICT', STRICT],
      ['BALANCED', BALANCED],
    ])('a save with the node at %s writes field 9 = that value', async (_name, policy) => {
      const refreshLocalSecurityConfig = vi.fn().mockResolvedValue(
        deviceAnswer({ publicKey: PUB, privateKey: PRIV, packetSignaturePolicy: policy }),
      );
      await sourceManagerRegistry.addManager(makeManager({ refreshLocalSecurityConfig }));

      const res = await saveLocal();

      expect(res.status).toBe(200);
      expect(refreshLocalSecurityConfig).toHaveBeenCalledTimes(1);
      const { fields, decoded } = sent();
      expect(fields.get(POLICY_FIELD)).toEqual([policy]);
      expect(decoded.packetSignaturePolicy).toBe(policy);
      // The keys and the user's edit ride along as before.
      expect(Buffer.from(decoded.privateKey as Uint8Array)).toEqual(PRIV);
      expect(Buffer.from(decoded.publicKey as Uint8Array)).toEqual(PUB);
      expect(decoded.serialEnabled).toBe(true);
    });

    it('reads the device, not the cache: a stale cache cannot downgrade the node', async () => {
      // getSecurityKeys()/the cache know nothing of the policy here — only the
      // fresh read does. If the route used the cache this would write no field 9.
      const refreshLocalSecurityConfig = vi.fn().mockResolvedValue(
        deviceAnswer({ publicKey: PUB, privateKey: PRIV, packetSignaturePolicy: STRICT }),
      );
      const getSecurityKeys = vi.fn().mockReturnValue({ publicKey: null, privateKey: null });
      await sourceManagerRegistry.addManager(makeManager({ refreshLocalSecurityConfig, getSecurityKeys }));

      const res = await saveLocal();

      expect(res.status).toBe(200);
      expect(sent().fields.get(POLICY_FIELD)).toEqual([STRICT]);
      expect(getSecurityKeys).not.toHaveBeenCalled();
    });

    it('fails CLOSED with 409 and sends nothing when the current policy is unknown', async () => {
      // The device did not answer. Unknown is not COMPATIBLE: no write.
      const refreshLocalSecurityConfig = vi.fn().mockResolvedValue(null);
      await sourceManagerRegistry.addManager(makeManager({ refreshLocalSecurityConfig }));

      const res = await saveLocal();

      expect(res.status).toBe(409);
      expect(res.body.success).toBe(false);
      expect(res.body.code).toBe('SECURITY_CONFIG_READBACK_FAILED');
      expect(res.body.error).toMatch(/local node/i);
      expect(sendAdminCommand).not.toHaveBeenCalled();
    });

    it('pre-2.8 node (no field 9 in its answer): field 9 stays off the wire', async () => {
      const answer = deviceAnswer({ publicKey: PUB, privateKey: PRIV, serialEnabled: true });
      // The shape the server really sees: the decode reports the absent enum as 0.
      expect(answer.packetSignaturePolicy).toBe(0);
      await sourceManagerRegistry.addManager(makeManager({
        refreshLocalSecurityConfig: vi.fn().mockResolvedValue(answer),
      }));

      const res = await saveLocal();

      expect(res.status).toBe(200);
      const { fields, decoded } = sent();
      expect(fields.has(POLICY_FIELD)).toBe(false);
      expect(Buffer.from(decoded.privateKey as Uint8Array)).toEqual(PRIV);
    });

    it('2.8 node at COMPATIBLE: no field 9, which firmware reads as COMPATIBLE', async () => {
      await sourceManagerRegistry.addManager(makeManager({
        refreshLocalSecurityConfig: vi.fn().mockResolvedValue(
          deviceAnswer({ publicKey: PUB, privateKey: PRIV, packetSignaturePolicy: COMPATIBLE }),
        ),
      }));

      const res = await saveLocal();

      expect(res.status).toBe(200);
      const { fields, decoded } = sent();
      expect(fields.has(POLICY_FIELD)).toBe(false);
      // A decoder with no field 9 on the wire reads the proto3 default.
      expect(decoded.packetSignaturePolicy).toBe(COMPATIBLE);
    });

    it('a new private key still keeps the policy (#4632 path)', async () => {
      const { generateKeyPairSync } = await import('node:crypto');
      const kp = generateKeyPairSync('x25519');
      const priv = kp.privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32);
      const pub = kp.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
      await sourceManagerRegistry.addManager(makeManager({
        refreshLocalSecurityConfig: vi.fn().mockResolvedValue(
          deviceAnswer({ publicKey: PUB, privateKey: PRIV, packetSignaturePolicy: BALANCED }),
        ),
      }));

      const res = await saveLocal({ ...clientConfig, privateKey: `base64:${priv.toString('base64')}` });

      expect(res.status).toBe(200);
      const { fields, decoded } = sent();
      expect(fields.get(POLICY_FIELD)).toEqual([BALANCED]);
      expect(Buffer.from(decoded.privateKey as Uint8Array)).toEqual(priv);
      expect(Buffer.from(decoded.publicKey as Uint8Array)).toEqual(pub);
    });

    it('does not echo the private key back to the client', async () => {
      await sourceManagerRegistry.addManager(makeManager({
        refreshLocalSecurityConfig: vi.fn().mockResolvedValue(
          deviceAnswer({ publicKey: PUB, privateKey: PRIV, packetSignaturePolicy: STRICT }),
        ),
      }));

      const res = await saveLocal();

      expect(JSON.stringify(res.body)).not.toContain(PRIV.toString('base64'));
    });
  });

  describe('remote node (unchanged behavior, now through the same helper)', () => {
    async function saveRemote(config: Record<string, unknown> = clientConfig) {
      const agent = await harness.loginAs(harness.admin);
      const res = await agent.post('/commands').send({ command: 'setSecurityConfig', sourceId: harness.sourceA, nodeNum: REMOTE, config });
      expect(res.status).toBe(202);
      return waitForSettled(agent, res.body.operationId);
    }

    it.each([
      ['STRICT', STRICT],
      ['BALANCED', BALANCED],
    ])('a save with the node at %s writes field 9 = that value', async (_name, policy) => {
      const requestRemoteConfig = vi.fn().mockResolvedValue(
        deviceAnswer({ publicKey: PUB, privateKey: PRIV, packetSignaturePolicy: policy }),
      );
      const refreshLocalSecurityConfig = vi.fn();
      await sourceManagerRegistry.addManager(makeManager({ requestRemoteConfig, refreshLocalSecurityConfig }));

      const op = await saveRemote();

      expect(op.status).toBe('succeeded');
      expect(requestRemoteConfig).toHaveBeenCalledWith(REMOTE, 7, false);
      // The local node's state is never read for a remote target.
      expect(refreshLocalSecurityConfig).not.toHaveBeenCalled();
      const { fields, decoded } = sent();
      expect(fields.get(POLICY_FIELD)).toEqual([policy]);
      expect(Buffer.from(decoded.privateKey as Uint8Array)).toEqual(PRIV);
    });

    it('pre-2.8 remote node: field 9 stays off the wire', async () => {
      await sourceManagerRegistry.addManager(makeManager({
        requestRemoteConfig: vi.fn().mockResolvedValue(deviceAnswer({ publicKey: PUB, privateKey: PRIV })),
      }));

      await saveRemote();

      expect(sent().fields.has(POLICY_FIELD)).toBe(false);
    });

    it('still fails closed when the remote node cannot be read', async () => {
      await sourceManagerRegistry.addManager(makeManager({
        requestRemoteConfig: vi.fn().mockResolvedValue(null),
      }));

      const op = await saveRemote();

      expect(op.status).not.toBe('succeeded');
      expect(JSON.stringify(op)).toContain('SECURITY_CONFIG_READBACK_FAILED');
      expect(sendAdminCommand).not.toHaveBeenCalled();
    });
  });

  // ── #5612: the Protection Level picker ──────────────────────────────────
  //
  // "Client value wins when sent": the UI sends the policy only when the user
  // changed it. Omitted keeps the node's own (the cases above).

  /** Audit rows for a policy change, newest first, details parsed. */
  async function policyAudits() {
    const { logs } = await harness.db.getAuditLogsAsync({ action: 'admin_set_packet_signature_policy' });
    // The audit log outlives a test; this test's admin is its own user.
    return logs
      .filter((row: { userId: number | null }) => row.userId === harness.admin.id)
      .map((row: { userId: number | null; details: string }) => ({ userId: row.userId, ...JSON.parse(row.details) }));
  }

  /** Give the remote node a firmware version, the way /get-device-metadata does. */
  async function seedRemoteFirmware(firmwareVersion: string | null) {
    // The node row outlives a test; start from none.
    await harness.db.nodes.deleteNodeRecord(REMOTE, harness.sourceA);
    await harness.db.nodes.upsertNode(
      { nodeNum: REMOTE, nodeId: '!000003e7', longName: 'Remote', shortName: 'REM' },
      harness.sourceA,
    );
    if (firmwareVersion !== null) {
      await harness.db.updateNodeRemoteAdminStatusAsync(REMOTE, true, JSON.stringify({ firmwareVersion }), harness.sourceA);
    }
  }

  describe('#5612 local node: a policy sent by the client', () => {
    const nodeAt = (policy: number | undefined, overrides: Record<string, unknown> = {}) =>
      sourceManagerRegistry.addManager(makeManager({
        refreshLocalSecurityConfig: vi.fn().mockResolvedValue(
          deviceAnswer({ publicKey: PUB, privateKey: PRIV, ...(policy === undefined ? {} : { packetSignaturePolicy: policy }) }),
        ),
        ...overrides,
      }));

    it.each([
      ['COMPATIBLE -> STRICT', COMPATIBLE, STRICT, [STRICT]],
      ['COMPATIBLE -> BALANCED', COMPATIBLE, BALANCED, [BALANCED]],
      ['STRICT -> BALANCED', STRICT, BALANCED, [BALANCED]],
    ])('%s: the client value is written to field 9', async (_name, from, to, wire) => {
      await nodeAt(from);

      const res = await saveLocal({ ...clientConfig, packetSignaturePolicy: to });

      expect(res.status).toBe(200);
      const { fields, decoded } = sent();
      expect(fields.get(POLICY_FIELD)).toEqual(wire);
      // The keys still come from the node.
      expect(Buffer.from(decoded.privateKey as Uint8Array)).toEqual(PRIV);
      expect(Buffer.from(decoded.publicKey as Uint8Array)).toEqual(PUB);
    });

    it('STRICT -> COMPATIBLE: an explicit 0 takes field 9 off the wire', async () => {
      await nodeAt(STRICT);

      const res = await saveLocal({ ...clientConfig, packetSignaturePolicy: COMPATIBLE });

      expect(res.status).toBe(200);
      const { fields, decoded } = sent();
      expect(fields.has(POLICY_FIELD)).toBe(false);
      expect(decoded.packetSignaturePolicy).toBe(COMPATIBLE);
    });

    it.each([[3], [-1], ['2'], [null], [1.5], [true]])('rejects the value %j with 400 INVALID_SIGNATURE_POLICY and sends nothing', async (bad) => {
      const refreshLocalSecurityConfig = vi.fn();
      await sourceManagerRegistry.addManager(makeManager({ refreshLocalSecurityConfig }));

      const res = await saveLocal({ ...clientConfig, packetSignaturePolicy: bad });

      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ success: false, code: 'INVALID_SIGNATURE_POLICY' });
      expect(refreshLocalSecurityConfig).not.toHaveBeenCalled();
      expect(sendAdminCommand).not.toHaveBeenCalled();
    });

    it.each([
      ['2.7.15.567b8ea', /2\.7\.15/],
      [undefined, /not known/],
    ])('rejects a policy for firmware %s with 400 SIGNATURE_POLICY_UNSUPPORTED', async (firmwareVersion, message) => {
      const refreshLocalSecurityConfig = vi.fn();
      await sourceManagerRegistry.addManager(makeManager({
        refreshLocalSecurityConfig,
        getLocalNodeInfo: vi.fn().mockReturnValue({ nodeNum: LOCAL, nodeId: '!00000001', longName: 'Local', shortName: 'LOC', firmwareVersion }),
      }));

      const res = await saveLocal({ ...clientConfig, packetSignaturePolicy: STRICT });

      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ success: false, code: 'SIGNATURE_POLICY_UNSUPPORTED' });
      expect(res.body.error).toMatch(message);
      expect(sendAdminCommand).not.toHaveBeenCalled();
      expect(await policyAudits()).toEqual([]);
    });

    it('a pre-2.8 node still saves when no policy is sent', async () => {
      await nodeAt(undefined, {
        getLocalNodeInfo: vi.fn().mockReturnValue({ nodeNum: LOCAL, nodeId: '!00000001', longName: 'Local', shortName: 'LOC', firmwareVersion: '2.7.15.567b8ea' }),
      });

      const res = await saveLocal();

      expect(res.status).toBe(200);
      expect(sent().fields.has(POLICY_FIELD)).toBe(false);
    });

    it('writes an audit entry: who, which node, from -> to', async () => {
      await nodeAt(COMPATIBLE);

      const res = await saveLocal({ ...clientConfig, packetSignaturePolicy: STRICT });

      expect(res.status).toBe(200);
      expect(await policyAudits()).toEqual([
        expect.objectContaining({
          userId: harness.admin.id,
          sourceId: harness.sourceA,
          nodeNum: LOCAL,
          nodeId: '!00000001',
          target: 'local',
          from: 'COMPATIBLE',
          to: 'STRICT',
        }),
      ]);
    });

    it('writes no audit entry when the policy is omitted, or sent unchanged', async () => {
      await nodeAt(BALANCED);

      expect((await saveLocal()).status).toBe(200);
      expect((await saveLocal({ ...clientConfig, packetSignaturePolicy: BALANCED })).status).toBe(200);

      expect(await policyAudits()).toEqual([]);
    });

    it('does not echo the private key when the policy changes', async () => {
      await nodeAt(COMPATIBLE);

      const res = await saveLocal({ ...clientConfig, packetSignaturePolicy: BALANCED });

      expect(res.status).toBe(200);
      expect(JSON.stringify(res.body)).not.toContain(PRIV.toString('base64'));
      expect(JSON.stringify(await policyAudits())).not.toContain(PRIV.toString('base64'));
    });

    it('mirrors the written policy into the cached config', async () => {
      const updateCachedDeviceConfig = vi.fn();
      await nodeAt(COMPATIBLE, { updateCachedDeviceConfig });

      await saveLocal({ ...clientConfig, packetSignaturePolicy: BALANCED });

      expect(updateCachedDeviceConfig).toHaveBeenCalledWith('security', { packetSignaturePolicy: BALANCED });
    });
  });

  describe('#5612 local node: a save while the node restarts', () => {
    it('a disconnected node gets 409 LOCAL_NODE_RESTARTING without waiting on a read', async () => {
      const refreshLocalSecurityConfig = vi.fn();
      await sourceManagerRegistry.addManager(makeManager({
        refreshLocalSecurityConfig,
        isDeviceConnected: vi.fn().mockReturnValue(false),
      }));

      const res = await saveLocal();

      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({ success: false, code: 'LOCAL_NODE_RESTARTING' });
      expect(res.body.error).toMatch(/restarting/i);
      expect(res.body.error).toMatch(/try again in a moment/i);
      expect(refreshLocalSecurityConfig).not.toHaveBeenCalled();
      expect(sendAdminCommand).not.toHaveBeenCalled();
    });

    it('a read that fails right after a save reads as "restarting", not a bare read failure', async () => {
      // The link can still look up for a few seconds after the node starts
      // its reboot: the first save works, the second gets no answer.
      const refreshLocalSecurityConfig = vi.fn()
        .mockResolvedValueOnce(deviceAnswer({ publicKey: PUB, privateKey: PRIV }))
        .mockResolvedValueOnce(null);
      await sourceManagerRegistry.addManager(makeManager({ refreshLocalSecurityConfig }));

      expect((await saveLocal()).status).toBe(200);
      const second = await saveLocal();

      expect(second.status).toBe(409);
      expect(second.body).toMatchObject({ success: false, code: 'LOCAL_NODE_RESTARTING' });
      expect(sendAdminCommand).toHaveBeenCalledTimes(1);
    });
  });

  describe('#5612 remote node: a policy sent by the client', () => {
    async function postRemote(config: Record<string, unknown>) {
      const agent = await harness.loginAs(harness.admin);
      const res = await agent.post('/commands').send({ command: 'setSecurityConfig', sourceId: harness.sourceA, nodeNum: REMOTE, config });
      return { agent, res };
    }
    const remoteAt = (policy: number | undefined) =>
      sourceManagerRegistry.addManager(makeManager({
        requestRemoteConfig: vi.fn().mockResolvedValue(
          deviceAnswer({ publicKey: PUB, privateKey: PRIV, ...(policy === undefined ? {} : { packetSignaturePolicy: policy }) }),
        ),
      }));

    it('the client value is written, the node keys stay, and the change is audited', async () => {
      await seedRemoteFirmware(FW_28);
      await remoteAt(COMPATIBLE);

      const { agent, res } = await postRemote({ ...clientConfig, packetSignaturePolicy: STRICT });
      expect(res.status).toBe(202);
      const op = await waitForSettled(agent, res.body.operationId);

      expect(op.status).toBe('succeeded');
      const { fields, decoded } = sent();
      expect(fields.get(POLICY_FIELD)).toEqual([STRICT]);
      expect(Buffer.from(decoded.privateKey as Uint8Array)).toEqual(PRIV);
      expect(JSON.stringify(op)).not.toContain(PRIV.toString('base64'));
      expect(JSON.stringify(res.body)).not.toContain(PRIV.toString('base64'));
      expect(await policyAudits()).toEqual([
        expect.objectContaining({
          userId: harness.admin.id,
          nodeNum: REMOTE,
          nodeId: '!000003e7',
          target: 'remote',
          from: 'COMPATIBLE',
          to: 'STRICT',
        }),
      ]);
    });

    it('STRICT -> COMPATIBLE: an explicit 0 takes field 9 off the wire', async () => {
      await seedRemoteFirmware(FW_28);
      await remoteAt(STRICT);

      const { agent, res } = await postRemote({ ...clientConfig, packetSignaturePolicy: COMPATIBLE });
      await waitForSettled(agent, res.body.operationId);

      expect(sent().fields.has(POLICY_FIELD)).toBe(false);
    });

    it('omitted keeps the node policy and writes no audit entry', async () => {
      await seedRemoteFirmware(FW_28);
      await remoteAt(BALANCED);

      const { agent, res } = await postRemote(clientConfig);
      await waitForSettled(agent, res.body.operationId);

      expect(sent().fields.get(POLICY_FIELD)).toEqual([BALANCED]);
      expect(await policyAudits()).toEqual([]);
    });

    it('rejects an invalid value with 400 before any operation starts', async () => {
      await seedRemoteFirmware(FW_28);
      await remoteAt(COMPATIBLE);

      const { res } = await postRemote({ ...clientConfig, packetSignaturePolicy: 7 });

      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ success: false, code: 'INVALID_SIGNATURE_POLICY' });
      expect(res.body.operationId).toBeUndefined();
      expect(sendAdminCommand).not.toHaveBeenCalled();
    });

    it.each([
      ['a pre-2.8 node', '2.7.15.567b8ea'],
      ['a node whose firmware we do not know', null],
    ])('rejects a policy for %s with 400 SIGNATURE_POLICY_UNSUPPORTED', async (_name, firmwareVersion) => {
      await seedRemoteFirmware(firmwareVersion);
      const requestRemoteConfig = vi.fn();
      await sourceManagerRegistry.addManager(makeManager({ requestRemoteConfig }));

      const { res } = await postRemote({ ...clientConfig, packetSignaturePolicy: BALANCED });

      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ success: false, code: 'SIGNATURE_POLICY_UNSUPPORTED' });
      // No mesh traffic for a request we refuse.
      expect(requestRemoteConfig).not.toHaveBeenCalled();
      expect(sendAdminCommand).not.toHaveBeenCalled();
    });
  });

  describe('#5612 /load-config security returns the policy', () => {
    async function load(nodeNum: number) {
      const agent = await harness.loginAs(harness.admin);
      return agent.post('/load-config').send({ configType: 'security', sourceId: harness.sourceA, nodeNum });
    }

    it.each([
      ['STRICT', STRICT],
      ['BALANCED', BALANCED],
      ['COMPATIBLE', COMPATIBLE],
    ])('remote node at %s', async (_name, policy) => {
      await seedRemoteFirmware(FW_28);
      await sourceManagerRegistry.addManager(makeManager({
        requestRemoteConfig: vi.fn().mockResolvedValue(
          deviceAnswer({ publicKey: PUB, privateKey: PRIV, packetSignaturePolicy: policy }),
        ),
      }));

      const res = await load(REMOTE);

      expect(res.status).toBe(200);
      expect(res.body.config.packetSignaturePolicy).toBe(policy);
      expect(res.body.config.firmwareVersion).toBe(FW_28);
      // The keys never reach the client (#4736).
      const body = JSON.stringify(res.body);
      expect(body).not.toContain(PRIV.toString('base64'));
      expect(res.body.config.privateKey).toBeUndefined();
      expect(res.body.config.publicKey).toBeUndefined();
    });

    it('remote node with no known firmware: firmwareVersion is null', async () => {
      await seedRemoteFirmware(null);
      await sourceManagerRegistry.addManager(makeManager({
        requestRemoteConfig: vi.fn().mockResolvedValue(deviceAnswer({ publicKey: PUB, privateKey: PRIV })),
      }));

      const res = await load(REMOTE);

      expect(res.status).toBe(200);
      expect(res.body.config.firmwareVersion).toBeNull();
    });

    it('local node: the policy and firmware come from the connected node', async () => {
      await sourceManagerRegistry.addManager(makeManager({
        getCurrentConfig: vi.fn().mockReturnValue({
          deviceConfig: { security: { adminKey: [], privateKey: PRIV, publicKey: PUB, packetSignaturePolicy: STRICT } },
          moduleConfig: {},
        }),
      }));

      const res = await load(LOCAL);

      expect(res.status).toBe(200);
      expect(res.body.config.packetSignaturePolicy).toBe(STRICT);
      expect(res.body.config.firmwareVersion).toBe(FW_28);
      expect(JSON.stringify(res.body)).not.toContain(PRIV.toString('base64'));
    });
  });
});
