/**
 * Local channel edits show up without a restart (discussion #5183).
 *
 * The device does not push channel changes to a connected client, and for the
 * local node both Admin Commands' read-back (`/get-channel`) and `/load-config`
 * serve channels from the database. A local `setChannel` therefore has to
 * mirror the new channel into the database itself, and the local channel load
 * has to read it — it used to send get_config_request(0) (DEVICE_CONFIG) and
 * return a blank placeholder.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import adminRoutes from './adminRoutes.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';
import { sourceManagerRegistry, type ISourceManager } from '../sourceManagerRegistry.js';
import { loadProtobufDefinitions } from '../protobufLoader.js';

const LOCAL = 0x0a0b0c0d;
const KEY = Buffer.alloc(32, 9).toString('base64');

describe('adminRoutes — local channel mirror (#5183)', () => {
  let harness: RouteTestHarness;
  let sendAdminCommand: ReturnType<typeof vi.fn>;

  function makeManager(overrides: Record<string, unknown> = {}): ISourceManager {
    return {
      sourceId: harness.sourceA,
      sourceType: 'meshtastic_tcp',
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
      getStatus: vi.fn().mockReturnValue({ sourceId: harness.sourceA, sourceName: 'A', sourceType: 'meshtastic_tcp', connected: true }),
      getLocalNodeInfo: vi.fn().mockReturnValue({ nodeNum: LOCAL, nodeId: '!0a0b0c0d', longName: 'Local', shortName: 'LOC' }),
      getSessionPasskey: vi.fn().mockReturnValue(null),
      sendAdminCommand,
      sendAdminCommandAwaitAck: vi.fn().mockResolvedValue({ acked: true, timedOut: false }),
      requestConfig: vi.fn().mockResolvedValue(undefined),
      getCurrentConfig: vi.fn().mockReturnValue({}),
      updateCachedDeviceConfig: vi.fn(),
      isTxEnabled: vi.fn().mockReturnValue(true),
      ...overrides,
    } as unknown as ISourceManager;
  }

  beforeAll(async () => {
    await loadProtobufDefinitions();
  });

  beforeEach(async () => {
    harness = await createRouteTestApp({ mount: (app) => app.use('/', adminRoutes) });
    sendAdminCommand = vi.fn().mockResolvedValue(undefined);
    await sourceManagerRegistry.addManager(makeManager());
    await harness.db.channels.upsertChannel({ id: 5, name: '', role: 0 }, harness.sourceA, { allowBlankName: true });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await sourceManagerRegistry.removeManager(harness.sourceA);
    await harness.cleanup();
  });

  it('a local setChannel is readable straight back from get-channel', async () => {
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.post('/commands').send({
      command: 'setChannel',
      sourceId: harness.sourceA,
      nodeNum: LOCAL,
      channelIndex: 5,
      config: { name: 'Hiking', psk: KEY, role: 2, uplinkEnabled: false, downlinkEnabled: true, positionPrecision: 13 },
    });
    expect(res.status).toBe(200);
    expect(sendAdminCommand).toHaveBeenCalledTimes(1);

    const back = await agent.post('/get-channel').send({ sourceId: harness.sourceA, nodeNum: LOCAL, channelIndex: 5 });
    expect(back.status).toBe(200);
    expect(back.body.channel).toMatchObject({
      name: 'Hiking', psk: KEY, role: 2, uplinkEnabled: false, downlinkEnabled: true, positionPrecision: 13,
    });
  });

  it('stores shorthand PSKs as the key bytes the device will report', async () => {
    const agent = await harness.loginAs(harness.admin);
    await agent.post('/commands').send({
      command: 'setChannel', sourceId: harness.sourceA, nodeNum: LOCAL, channelIndex: 5,
      config: { name: 'Public', psk: 'default', role: 2 },
    });
    const stored = await harness.db.channels.getChannelById(5, harness.sourceA);
    // Firmware reports the default key as the single byte 0x01.
    expect(stored?.psk).toBe(Buffer.from([1]).toString('base64'));
  });

  it("only writes this source's channel row", async () => {
    await harness.db.channels.upsertChannel({ id: 5, name: 'Other', psk: 'AQ==', role: 2 }, harness.sourceB);
    const agent = await harness.loginAs(harness.admin);
    await agent.post('/commands').send({
      command: 'setChannel', sourceId: harness.sourceA, nodeNum: LOCAL, channelIndex: 5,
      config: { name: 'Hiking', psk: KEY, role: 2 },
    });
    expect((await harness.db.channels.getChannelById(5, harness.sourceB))?.name).toBe('Other');
  });

  it('load-config serves the stored local channel instead of a blank placeholder', async () => {
    await harness.db.channels.upsertChannel(
      { id: 5, name: 'Hiking', psk: KEY, role: 2, downlinkEnabled: true, positionPrecision: 13 },
      harness.sourceA,
    );
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.post('/load-config').send({
      configType: 'channel', channelIndex: 5, sourceId: harness.sourceA, nodeNum: LOCAL,
    });
    expect(res.status).toBe(200);
    expect(res.body.config).toMatchObject({ name: 'Hiking', psk: KEY, role: 2, downlinkEnabled: true, positionPrecision: 13 });
  });
});
