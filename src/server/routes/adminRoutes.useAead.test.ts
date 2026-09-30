/**
 * Admin Commands setChannel keeps ChannelSettings.use_aead (#5248 Phase 1).
 *
 * Local node: an omitted flag is filled from this source's stored row, since
 * set_channel replaces the whole ChannelSettings. get-channel reports it so
 * the UI can carry it back on remote edits.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import adminRoutes from './adminRoutes.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';
import { sourceManagerRegistry, type ISourceManager } from '../sourceManagerRegistry.js';
import { loadProtobufDefinitions, getProtobufRoot } from '../protobufLoader.js';

const LOCAL = 0x0a0b0c0d;
const KEY = Buffer.alloc(32, 9).toString('base64');

describe('adminRoutes setChannel — use_aead (#5248)', () => {
  let harness: RouteTestHarness;
  let sendAdminCommand: ReturnType<typeof vi.fn>;

  const decodeSettings = (bytes: Uint8Array) => {
    const AdminMessage = getProtobufRoot()!.lookupType('meshtastic.AdminMessage');
    return (AdminMessage.toObject(AdminMessage.decode(bytes), { defaults: true, oneofs: true }) as any).setChannel.settings;
  };

  function makeManager(): ISourceManager {
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
    } as unknown as ISourceManager;
  }

  beforeAll(async () => {
    await loadProtobufDefinitions();
  });

  beforeEach(async () => {
    harness = await createRouteTestApp({ mount: (app) => app.use('/', adminRoutes) });
    sendAdminCommand = vi.fn().mockResolvedValue(undefined);
    await sourceManagerRegistry.addManager(makeManager());
    await harness.db.channels.upsertChannel({ id: 5, name: 'Secure', psk: KEY, role: 2, useAead: true }, harness.sourceA);
    await harness.db.channels.upsertChannel({ id: 5, name: 'Secure', psk: KEY, role: 2, useAead: false }, harness.sourceB);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await sourceManagerRegistry.removeManager(harness.sourceA);
    await harness.cleanup();
  });

  it('get-channel reports the stored flag', async () => {
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.post('/get-channel').send({ sourceId: harness.sourceA, nodeNum: LOCAL, channelIndex: 5 });
    expect(res.status).toBe(200);
    expect(res.body.channel.useAead).toBe(true);
  });

  it('a local setChannel without useAead sends the stored true, and the mirror keeps it', async () => {
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.post('/commands').send({
      command: 'setChannel',
      sourceId: harness.sourceA,
      nodeNum: LOCAL,
      channelIndex: 5,
      config: { name: 'Renamed', psk: KEY, role: 2, uplinkEnabled: false, downlinkEnabled: true, positionPrecision: 13 },
    });
    expect(res.status).toBe(200);
    expect(sendAdminCommand).toHaveBeenCalledTimes(1);
    const settings = decodeSettings(sendAdminCommand.mock.calls[0][0]);
    expect(settings.name).toBe('Renamed');
    expect(settings.useAead).toBe(true);
    expect((await harness.db.channels.getChannelById(5, harness.sourceA))!.useAead).toBe(true);
    expect((await harness.db.channels.getChannelById(5, harness.sourceB))!.useAead).toBe(false);
  });

  it('an explicit useAead in the config is sent as given', async () => {
    const agent = await harness.loginAs(harness.admin);
    await agent.post('/commands').send({
      command: 'setChannel', sourceId: harness.sourceA, nodeNum: LOCAL, channelIndex: 5,
      config: { name: 'Secure', psk: KEY, role: 2, useAead: false },
    });
    expect(decodeSettings(sendAdminCommand.mock.calls[0][0]).useAead).toBe(false);
  });
});
