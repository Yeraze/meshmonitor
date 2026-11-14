/**
 * Admin Commands setLoRaConfig keeps LoRaConfig.transparent_mode (#6181).
 *
 * set_config replaces the whole LoRaConfig, so the field must ride along or a
 * save turns it off. MeshMonitor never chooses it: the value sent is what the
 * node last reported, whatever the request body says.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import adminRoutes from './adminRoutes.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';
import { sourceManagerRegistry, type ISourceManager } from '../sourceManagerRegistry.js';
import { loadProtobufDefinitions, getProtobufRoot } from '../protobufLoader.js';

const LOCAL = 0x0a0b0c0d;
const REMOTE = 0x01020304;

describe('adminRoutes setLoRaConfig — transparent_mode (#6181)', () => {
  let harness: RouteTestHarness;
  let sendAdminCommand: ReturnType<typeof vi.fn>;
  let sendAdminCommandAwaitAck: ReturnType<typeof vi.fn>;
  let localTransparent: boolean;
  let remoteLora: Record<string, unknown> | null;

  const decodeLora = (bytes: Uint8Array) => {
    const AdminMessage = getProtobufRoot()!.lookupType('meshtastic.AdminMessage');
    return (AdminMessage.toObject(AdminMessage.decode(bytes), { defaults: true, oneofs: true }) as any).setConfig.lora;
  };

  function makeManager(): ISourceManager {
    return {
      sourceId: harness.sourceA,
      sourceType: 'meshtastic_tcp',
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
      getStatus: vi.fn().mockReturnValue({ sourceId: harness.sourceA, sourceName: 'A', sourceType: 'meshtastic_tcp', connected: true }),
      getLocalNodeInfo: vi.fn().mockReturnValue({ nodeNum: LOCAL, nodeId: '!0a0b0c0d', longName: 'Local', shortName: 'LOC' }),
      getSessionPasskey: vi.fn().mockReturnValue(new Uint8Array([1, 2, 3, 4])),
      sendAdminCommand,
      sendAdminCommandAwaitAck,
      requestConfig: vi.fn().mockResolvedValue(undefined),
      getCurrentConfig: vi.fn().mockReturnValue({}),
      updateCachedDeviceConfig: vi.fn(),
      isTxEnabled: vi.fn().mockReturnValue(true),
      isTransparentMode: vi.fn(() => localTransparent),
      getRemoteNodeConfig: vi.fn(() => (remoteLora ? { deviceConfig: { lora: remoteLora }, moduleConfig: {}, lastUpdated: 0 } : null)),
    } as unknown as ISourceManager;
  }

  beforeAll(async () => {
    await loadProtobufDefinitions();
  });

  beforeEach(async () => {
    harness = await createRouteTestApp({ mount: (app) => app.use('/', adminRoutes) });
    sendAdminCommand = vi.fn().mockResolvedValue(undefined);
    sendAdminCommandAwaitAck = vi.fn().mockResolvedValue({ acked: true, errorReason: null, timedOut: false });
    localTransparent = false;
    remoteLora = null;
    await sourceManagerRegistry.addManager(makeManager());
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await sourceManagerRegistry.removeManager(harness.sourceA);
    await harness.cleanup();
  });

  const send = async (nodeNum: number, config: Record<string, unknown>) => {
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.post('/commands').send({ command: 'setLoRaConfig', sourceId: harness.sourceA, nodeNum, config });
    // Local commands finish inline (200); remote ones are accepted (202) and
    // sent in the background, with or without awaiting an ACK.
    expect(res.status).toBe(nodeNum === LOCAL ? 200 : 202);
    const calls = () => [...sendAdminCommand.mock.calls, ...sendAdminCommandAwaitAck.mock.calls];
    await vi.waitFor(() => expect(calls()).toHaveLength(1));
    return decodeLora(calls()[0][0]);
  };

  it('local: keeps transparentMode on when the node reports it on', async () => {
    localTransparent = true;
    const lora = await send(LOCAL, { region: 1, hopLimit: 4 });
    expect(lora.hopLimit).toBe(4);
    expect(lora.transparentMode).toBe(true);
  });

  it('local: a request cannot turn transparentMode on', async () => {
    const lora = await send(LOCAL, { region: 1, transparentMode: true });
    expect(lora.transparentMode).toBe(false);
  });

  it('remote: keeps the cached remote value, and ignores the request', async () => {
    remoteLora = { region: 1, transparentMode: true };
    expect((await send(REMOTE, { region: 1, transparentMode: false })).transparentMode).toBe(true);
  });

  it('remote: sends false with no cached config, even when the request says true', async () => {
    expect((await send(REMOTE, { region: 1, transparentMode: true })).transparentMode).toBe(false);
  });
});
