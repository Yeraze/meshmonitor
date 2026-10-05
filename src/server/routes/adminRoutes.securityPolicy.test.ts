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
      getLocalNodeInfo: vi.fn().mockReturnValue({ nodeNum: LOCAL, nodeId: '!00000001', longName: 'Local', shortName: 'LOC' }),
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

    it('ignores a client-supplied policy: the node\'s own value wins', async () => {
      // No UI sets the policy yet (#5612), so a value in the body is not a
      // user's choice. Neither a downgrade nor an upgrade may pass.
      const refreshLocalSecurityConfig = vi.fn().mockResolvedValue(
        deviceAnswer({ publicKey: PUB, privateKey: PRIV, packetSignaturePolicy: STRICT }),
      );
      await sourceManagerRegistry.addManager(makeManager({ refreshLocalSecurityConfig }));

      const res = await saveLocal({ ...clientConfig, packetSignaturePolicy: COMPATIBLE });

      expect(res.status).toBe(200);
      expect(sent().fields.get(POLICY_FIELD)).toEqual([STRICT]);
    });

    it('ignores a client-supplied policy when the node has none (no upgrade either)', async () => {
      const refreshLocalSecurityConfig = vi.fn().mockResolvedValue(
        deviceAnswer({ publicKey: PUB, privateKey: PRIV }),
      );
      await sourceManagerRegistry.addManager(makeManager({ refreshLocalSecurityConfig }));

      const res = await saveLocal({ ...clientConfig, packetSignaturePolicy: STRICT });

      expect(res.status).toBe(200);
      expect(sent().fields.has(POLICY_FIELD)).toBe(false);
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

    it('ignores a client-supplied policy', async () => {
      await sourceManagerRegistry.addManager(makeManager({
        requestRemoteConfig: vi.fn().mockResolvedValue(
          deviceAnswer({ publicKey: PUB, privateKey: PRIV, packetSignaturePolicy: STRICT }),
        ),
      }));

      await saveRemote({ ...clientConfig, packetSignaturePolicy: COMPATIBLE });

      expect(sent().fields.get(POLICY_FIELD)).toEqual([STRICT]);
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
});
