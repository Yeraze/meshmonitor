/**
 * Key gate on the MQTT ingest read routes (#6308).
 *
 * Before #6308 an MQTT feed stored slot-decrypted rows with no key fingerprint,
 * so anyone with `messages:read` on the feed read plaintext opened with a key
 * held on a Companion they could not read. Real auth middleware, real
 * in-memory database, real key-access gate.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';
import databaseService from '../../services/database.js';
import {
  channelKeyFingerprint,
  keyedChannelIndex,
  MESHCORE_UNRESOLVED_KEY_FINGERPRINT,
} from '../services/meshcoreFrameIngest.js';
import { MESHCORE_PUBLIC_CHANNEL_SECRET } from '../utils/meshcoreGroupEcho.js';
import { MeshCoreMqttManager } from '../meshcoreMqttManager.js';

const managers = new Map<string, unknown>();
vi.mock('../sourceManagerRegistry.js', () => ({
  sourceManagerRegistry: {
    getManager: (id: string) => managers.get(id),
    getAllManagers: () => [...managers.values()],
  },
}));

import ingestReadRoutes from './meshcoreIngestReadRoutes.js';

const SECRET = '0123456789abcdef0123456789abcdef';
const SECRET_B64 = Buffer.from(SECRET, 'hex').toString('base64');
const FP = channelKeyFingerprint(SECRET);
const IDX = keyedChannelIndex(SECRET);
const PUBLIC_HEX = Buffer.from(MESHCORE_PUBLIC_CHANNEL_SECRET).toString('hex');
const PUBLIC_FP = channelKeyFingerprint(PUBLIC_HEX);
const PUBLIC_IDX = keyedChannelIndex(PUBLIC_HEX);
const KEY_SLOT = 3;

describe('MQTT ingest reads are key-gated (#6308)', () => {
  let harness: RouteTestHarness;
  let mqtt: string; // the MQTT feed
  let comp: string; // the Companion that holds the key

  const msgs = () => `/api/sources/${mqtt}/meshcore/ingest/messages`;
  const chans = () => `/api/sources/${mqtt}/meshcore/ingest/channels`;
  const ids = (res: { body: { data: { messages: Array<{ id: string }> } } }) =>
    res.body.data.messages.map((m) => m.id).sort();

  beforeEach(async () => {
    harness = await createRouteTestApp({
      mount: (app) => app.use('/api/sources/:id/meshcore', ingestReadRoutes),
    });
    mqtt = harness.sourceA;
    comp = harness.sourceB;
    await databaseService.sources.deleteSource(mqtt);
    await databaseService.sources.deleteSource(comp);
    await databaseService.sources.createSource({ id: mqtt, name: 'Feed', type: 'meshcore_mqtt', config: {}, enabled: true });
    await databaseService.sources.createSource({ id: comp, name: 'Companion', type: 'meshcore', config: {}, enabled: true });
    await databaseService.channels.upsertChannel({ id: KEY_SLOT, name: 'ops', psk: SECRET_B64, role: 2 }, comp);

    await databaseService.meshcore.deleteAllMessagesForSource(mqtt);
    const base = { fromName: 'Alice', messageType: 'channel', createdAt: 5_000 };
    await databaseService.meshcore.insertMessage(
      { ...base, id: 'keyed', fromPublicKey: `channel-${IDX}`, text: 'secret', timestamp: 5_000,
        keyFingerprint: FP, keySourceId: comp, keyChannelIdx: KEY_SLOT } as never, mqtt);
    await databaseService.meshcore.insertMessage(
      { ...base, id: 'public', fromPublicKey: `channel-${PUBLIC_IDX}`, text: 'hello', timestamp: 5_001,
        keyFingerprint: PUBLIC_FP, keySourceId: comp, keyChannelIdx: 0 } as never, mqtt);
    await databaseService.meshcore.insertMessage(
      { ...base, id: 'legacy', fromPublicKey: 'channel-3', text: 'old', timestamp: 5_002,
        keyFingerprint: MESHCORE_UNRESOLVED_KEY_FINGERPRINT } as never, mqtt);

    managers.clear();
    managers.set(mqtt, new MeshCoreMqttManager(mqtt, 'Feed', { brokerUrl: 'wss://b.example/mqtt', region: 'mco' }));
  });

  afterEach(async () => {
    await databaseService.meshcore.deleteAllMessagesForSource(mqtt);
    await harness.cleanup();
  });

  it('a viewer with messages:read on the feed but no access to the key does NOT see the row', async () => {
    await harness.grant(harness.limited.id, 'messages', 'read', mqtt);
    const agent = await harness.loginAs(harness.limited);
    const res = await agent.get(msgs());
    expect(res.status).toBe(200);
    expect(ids(res)).not.toContain('keyed');
    // Unresolved legacy rows are admin-only.
    expect(ids(res)).not.toContain('legacy');
    // The Public channel passes for any signed-in viewer with feed access.
    expect(ids(res)).toEqual(['public']);
    const list = await agent.get(chans());
    expect(list.body.data.map((c: { id: number }) => c.id)).not.toContain(IDX);
  });

  it('a viewer who can read the key on the Companion sees the row, named', async () => {
    await harness.grant(harness.limited.id, 'messages', 'read', mqtt);
    await harness.grant(harness.limited.id, `channel_${KEY_SLOT}`, 'read', comp);
    const agent = await harness.loginAs(harness.limited);
    const res = await agent.get(msgs());
    expect(ids(res)).toEqual(['keyed', 'public']);
    const keyed = res.body.data.messages.find((m: { id: string }) => m.id === 'keyed');
    expect(keyed).toMatchObject({ channelIdx: IDX, channelName: 'ops' });
    const list = await agent.get(chans());
    expect(list.body.data).toContainEqual(expect.objectContaining({ id: IDX, name: 'ops', keyed: true }));
  });

  it('admins see everything, with the legacy row flagged', async () => {
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.get(msgs());
    expect(ids(res)).toEqual(['keyed', 'legacy', 'public']);
    const legacy = res.body.data.messages.find((m: { id: string }) => m.id === 'legacy');
    expect(legacy).toMatchObject({ legacy: true, channelIdx: 3 });
    expect(legacy.channelName).toBeUndefined();
    const list = await agent.get(chans());
    expect(list.body.data).toContainEqual(expect.objectContaining({ id: 3, legacy: true }));
  });
});
