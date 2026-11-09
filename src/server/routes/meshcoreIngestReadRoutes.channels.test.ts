/**
 * GET /ingest/channels — the Notifications channel picker source (#6307).
 *
 * Real auth middleware and a real in-memory database. Slot indices come from
 * the message table (name-less, per source); keyed channels come from
 * `listKeyedChannelsForViewer`, which owns the key gate and is mocked here so
 * the route's own union / scoping / permission rules are what is under test.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';
import { MeshCoreMqttManager } from '../meshcoreMqttManager.js';

const managers = new Map<string, unknown>();

vi.mock('../sourceManagerRegistry.js', () => ({
  sourceManagerRegistry: {
    getManager: (id: string) => managers.get(id),
    getAllManagers: () => [...managers.values()],
  },
}));

// The key gate has its own tests; here: admins see the keyed entry, others do not.
vi.mock('../utils/meshcoreKeyedChannels.js', () => ({
  listKeyedChannelsForViewer: vi.fn(async (user: { isAdmin?: boolean } | null | undefined) =>
    user?.isAdmin ? [{ id: 1234, name: 'Secret Club', keyFingerprint: 'ab12', virtual: true }] : [],
  ),
}));

import ingestReadRoutes from './meshcoreIngestReadRoutes.js';

let harness: RouteTestHarness;
let n = 0;

async function seed(sourceId: string, key: string, extra: Record<string, unknown> = {}) {
  n += 1;
  await harness.db.meshcore.insertMessage(
    {
      id: `m${n}`,
      fromPublicKey: key,
      fromName: 'X',
      text: 'hi',
      timestamp: 1_000 + n,
      createdAt: 1_000 + n,
      messageType: 'channel',
      ...extra,
    } as never,
    sourceId,
  );
}

const path = (id: string) => `/api/sources/${id}/meshcore/ingest/channels`;

beforeEach(async () => {
  harness = await createRouteTestApp({
    mount: app => app.use('/api/sources/:id/meshcore', ingestReadRoutes),
  });
  await harness.db.meshcore.deleteAllMessagesForSource(harness.sourceA);
  await harness.db.meshcore.deleteAllMessagesForSource(harness.sourceB);
  managers.clear();
  managers.set(
    harness.sourceA,
    new MeshCoreMqttManager(harness.sourceA, 'Ingest A', { brokerUrl: 'wss://b.example/mqtt', region: 'mco' }),
  );
  // A device-backed source: the ingest routes must refuse it.
  managers.set(harness.sourceB, { sourceId: harness.sourceB, sourceType: 'meshcore' });
});

afterEach(async () => {
  await harness.cleanup();
});

describe('GET /ingest/channels', () => {
  it('lists slot indices with messages, without a name, and never another source', async () => {
    await seed(harness.sourceA, 'channel-3');
    await seed(harness.sourceA, 'channel-3');
    await seed(harness.sourceA, 'channel-1');
    await seed(harness.sourceB, 'channel-5');
    await harness.grant(harness.limited.id, 'messages', 'read', harness.sourceA);
    const agent = await harness.loginAs(harness.limited);
    const res = await agent.get(path(harness.sourceA));
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.map((c: { id: number }) => c.id)).toEqual([1, 3]);
    expect(res.body.data.every((c: { name: string }) => c.name === '')).toBe(true);
  });

  it('ignores DM rows and fingerprinted rows in the slot list', async () => {
    await seed(harness.sourceA, 'channel-2', { messageType: 'text' });
    await seed(harness.sourceA, 'channel-1234', { keyFingerprint: 'ab12' });
    await seed(harness.sourceA, 'channel-4');
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.get(path(harness.sourceA));
    expect(res.body.data.map((c: { id: number }) => c.id)).toEqual([4, 1234]);
  });

  it('shows a keyed channel, named, only to a viewer the key gate admits', async () => {
    await seed(harness.sourceA, 'channel-1234', { keyFingerprint: 'ab12' });
    await harness.grant(harness.limited.id, 'messages', 'read', harness.sourceA);
    const limited = await harness.loginAs(harness.limited);
    const hidden = await limited.get(path(harness.sourceA));
    expect(hidden.body.data.find((c: { id: number }) => c.id === 1234)).toBeUndefined();

    const admin = await harness.loginAs(harness.admin);
    const shown = await admin.get(path(harness.sourceA));
    expect(shown.body.data).toEqual([
      expect.objectContaining({ id: 1234, name: 'Secret Club', keyed: true, virtual: true }),
    ]);
  });

  it('403 without messages:read on the source', async () => {
    await harness.grant(harness.limited.id, 'messages', 'read', harness.sourceB);
    const agent = await harness.loginAs(harness.limited);
    const res = await agent.get(path(harness.sourceA));
    expect(res.status).toBe(403);
  });

  it('404 for a device-backed source', async () => {
    await harness.grant(harness.limited.id, 'messages', 'read', harness.sourceB);
    const agent = await harness.loginAs(harness.limited);
    const res = await agent.get(path(harness.sourceB));
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('NOT_AN_INGEST_SOURCE');
  });
});
