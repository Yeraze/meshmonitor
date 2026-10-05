/**
 * Route test — a MeshCore Repeater source's contact list (#5632).
 *
 * The MeshCore Nodes list reads `nodes`; the Nodes map, Node Details and the
 * DM sidebar read `contacts`. A Repeater has no contact table and never fills
 * the manager's in-memory map, so `contacts` came back empty: the list showed
 * a hundred named nodes and each one opened as a bare public key.
 *
 * REAL `MeshCoreManager` instances over the real `:memory:` database, behind
 * the real-middleware harness: the rows are written by the manager's own
 * advert ingest from wire-accurate frames, and the per-source grants are
 * checked by real SQL.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';
import { MeshCoreManager, MeshCoreDeviceType } from '../meshcoreManager.js';
import { dataEventEmitter } from '../services/dataEventEmitter.js';
import meshcorePacketLogService from '../services/meshcorePacketLogService.js';
import { buildAdvertFrame } from '../test-helpers/meshcoreFrames.js';

const managers = new Map<string, MeshCoreManager>();

vi.mock('../sourceManagerRegistry.js', () => ({
  sourceManagerRegistry: {
    getManager: (sourceId: string) => managers.get(sourceId),
    getAllManagers: () => Array.from(managers.values()),
    getPrimarySourceId: () => null,
    getPrimaryMeshtasticSourceId: () => null,
  },
}));

const { default: meshcoreRoutes } = await import('./meshcoreRoutes.js');
const { default: databaseService } = await import('../../services/database.js');

const KEY_FIX = 'a4'.repeat(32);
const KEY_ADVERT_ONLY = 'b5'.repeat(32);
const KEY_ON_B = 'c6'.repeat(32);
const SELF_A = 'fa'.repeat(32);
const SELF_B = 'fb'.repeat(32);

type Internals = {
  deviceType: MeshCoreDeviceType;
  connected: boolean;
  repeaterPublicKey: string | null;
  handleSerialData: (line: string) => void;
};

function repeater(sourceId: string, selfKey: string): (rawHex: string) => void {
  const m = new MeshCoreManager(sourceId);
  const i = m as unknown as Internals;
  i.deviceType = MeshCoreDeviceType.REPEATER;
  i.connected = true;
  i.repeaterPublicKey = selfKey;
  managers.set(sourceId, m);
  // RAW then RX is how a MESH_PACKET_LOGGING build prints one packet.
  return (rawHex: string) => {
    i.handleSerialData(`14:02:07 - 30/9/2026 U RAW: ${rawHex.toUpperCase()}`);
    i.handleSerialData(
      `14:02:07 - 30/9/2026 U: RX, len=${rawHex.length / 2} (type=5, route=F, payload_len=1) SNR=7 RSSI=-92 score=1000 time=1 hash=00`,
    );
  };
}

interface WireContact {
  publicKey: string;
  advName?: string;
  advType?: number;
  latitude?: number;
  longitude?: number;
  lastSeen?: number;
  lastAdvertHadPosition?: boolean;
  isLocal?: boolean;
}

describe('MeshCore Repeater source — contact list (#5632)', () => {
  let harness: RouteTestHarness;

  const grantNodes = async (userId: number, sourceId: string, actions: { read?: boolean; viewOnMap?: boolean }) => {
    await harness.db.auth.createPermission({
      userId,
      resource: 'nodes',
      canRead: actions.read === true,
      canViewOnMap: actions.viewOnMap === true,
      canWrite: false,
      sourceId,
      grantedAt: Date.now(),
      grantedBy: null,
    });
  };

  const stored = (key: string, sourceId: string) => databaseService.meshcore.getNodeByPublicKeyAndSource(key, sourceId);

  beforeEach(async () => {
    harness = await createRouteTestApp({
      mount: (app) => app.use('/sources/:id/meshcore', meshcoreRoutes),
    });
    vi.spyOn(meshcorePacketLogService, 'isEnabled').mockResolvedValue(false);
    vi.spyOn(dataEventEmitter, 'emitMeshCoreContactUpdated').mockImplementation(() => undefined);

    const feedA = repeater(harness.sourceA, SELF_A);
    const feedB = repeater(harness.sourceB, SELF_B);
    feedA(buildAdvertFrame({ publicKey: KEY_FIX, advType: 2, name: 'Ridge', lat: 45.5, lon: -122.5 }));
    feedA(buildAdvertFrame({ publicKey: KEY_ADVERT_ONLY, advType: 1, name: 'Walker' }));
    // Source B hears the SAME key as A's positioned node, under another name
    // and somewhere else, plus one node of its own.
    feedB(buildAdvertFrame({ publicKey: KEY_FIX, advType: 2, name: 'Ridge seen from B', lat: 1.5, lon: 2.5 }));
    feedB(buildAdvertFrame({ publicKey: KEY_ON_B, advType: 1, name: 'Only On B' }));
    await vi.waitFor(async () => {
      expect(await stored(KEY_FIX, harness.sourceA)).toBeTruthy();
      expect(await stored(KEY_ADVERT_ONLY, harness.sourceA)).toBeTruthy();
      expect(await stored(KEY_FIX, harness.sourceB)).toBeTruthy();
      expect(await stored(KEY_ON_B, harness.sourceB)).toBeTruthy();
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const [sourceId] of managers) {
      for (const key of [KEY_FIX, KEY_ADVERT_ONLY, KEY_ON_B]) {
        await databaseService.meshcore.deleteNode(key, sourceId);
      }
    }
    managers.clear();
    await harness.cleanup();
  });

  for (const route of ['contacts', 'snapshot'] as const) {
    const contactsOf = (body: { data: WireContact[] | { contacts: WireContact[] } }): WireContact[] =>
      Array.isArray(body.data) ? body.data : body.data.contacts;

    describe(`GET /${route}`, () => {
      it('lists every stored node, with and without a position', async () => {
        const agent = await harness.loginAs(harness.admin);
        const res = await agent.get(`/sources/${harness.sourceA}/meshcore/${route}`);
        expect(res.status).toBe(200);
        const contacts = contactsOf(res.body);

        const fix = contacts.find((c) => c.publicKey === KEY_FIX)!;
        expect(fix).toMatchObject({ advName: 'Ridge', advType: 2, lastAdvertHadPosition: true, isLocal: false });
        expect(fix.latitude).toBeCloseTo(45.5, 4);
        expect(fix.longitude).toBeCloseTo(-122.5, 4);
        expect(typeof fix.lastSeen).toBe('number');

        const advertOnly = contacts.find((c) => c.publicKey === KEY_ADVERT_ONLY)!;
        expect(advertOnly).toMatchObject({ advName: 'Walker', advType: 1, lastAdvertHadPosition: false });
        expect(advertOnly.latitude).toBeUndefined();
        expect(advertOnly.longitude).toBeUndefined();
      });

      it("never lists another source's node, and keeps a same-key node's own data", async () => {
        const agent = await harness.loginAs(harness.admin);
        const a = contactsOf((await agent.get(`/sources/${harness.sourceA}/meshcore/${route}`)).body);
        const b = contactsOf((await agent.get(`/sources/${harness.sourceB}/meshcore/${route}`)).body);

        expect(a.map((c) => c.publicKey).sort()).toEqual([KEY_FIX, KEY_ADVERT_ONLY].sort());
        expect(b.map((c) => c.publicKey).sort()).toEqual([KEY_FIX, KEY_ON_B].sort());
        expect(a.find((c) => c.publicKey === KEY_FIX)!.advName).toBe('Ridge');
        const onB = b.find((c) => c.publicKey === KEY_FIX)!;
        expect(onB.advName).toBe('Ridge seen from B');
        expect(onB.latitude).toBeCloseTo(1.5, 4);
      });
    });
  }

  it('the contact list holds the same keys the Nodes list shows', async () => {
    const agent = await harness.loginAs(harness.admin);
    const snap = (await agent.get(`/sources/${harness.sourceA}/meshcore/snapshot`)).body.data;
    const nodeKeys = (snap.nodes as Array<{ publicKey: string }>).map((n) => n.publicKey);
    const contactKeys = (snap.contacts as WireContact[]).map((c) => c.publicKey);
    for (const key of [KEY_FIX, KEY_ADVERT_ONLY]) {
      expect(nodeKeys).toContain(key);
      expect(contactKeys).toContain(key);
    }
  });

  it('a later advert without a position leaves the listed position in place', async () => {
    const m = managers.get(harness.sourceA)!;
    const i = m as unknown as Internals;
    const frame = buildAdvertFrame({ publicKey: KEY_FIX, advType: 2, name: 'Ridge', timestamp: 1_700_000_120 });
    i.handleSerialData(`14:04:07 - 30/9/2026 U RAW: ${frame.toUpperCase()}`);
    i.handleSerialData(
      `14:04:07 - 30/9/2026 U: RX, len=${frame.length / 2} (type=5, route=F, payload_len=1) SNR=7 RSSI=-92 score=1000 time=1 hash=00`,
    );
    await vi.waitFor(async () => {
      expect((await stored(KEY_FIX, harness.sourceA))!.lastAdvertHadPosition).toBe(false);
    });

    const agent = await harness.loginAs(harness.admin);
    const res = await agent.get(`/sources/${harness.sourceA}/meshcore/contacts`);
    const fix = (res.body.data as WireContact[]).find((c) => c.publicKey === KEY_FIX)!;
    expect(fix.latitude).toBeCloseTo(45.5, 4);
    expect(fix.longitude).toBeCloseTo(-122.5, 4);
    expect(fix.lastAdvertHadPosition).toBe(false);
  });

  describe('permissions', () => {
    it('GET /contacts refuses a viewer with no nodes:read on the source', async () => {
      await grantNodes(harness.limited.id, harness.sourceB, { read: true, viewOnMap: true });
      const agent = await harness.loginAs(harness.limited);
      const res = await agent.get(`/sources/${harness.sourceA}/meshcore/contacts`);
      expect(res.status).toBe(403);
      expect(JSON.stringify(res.body)).not.toContain('Ridge');
    });

    it('GET /contacts refuses an anonymous caller', async () => {
      const agent = await harness.loginAs(null);
      const res = await agent.get(`/sources/${harness.sourceA}/meshcore/contacts`);
      expect(res.status).not.toBe(200);
      expect(JSON.stringify(res.body)).not.toContain('Ridge');
    });

    it('nodes:read without nodes:viewOnMap lists the nodes but no position data', async () => {
      await grantNodes(harness.limited.id, harness.sourceA, { read: true });
      const agent = await harness.loginAs(harness.limited);
      const res = await agent.get(`/sources/${harness.sourceA}/meshcore/contacts`);
      expect(res.status).toBe(200);
      const contacts = res.body.data as WireContact[];
      expect(contacts.map((c) => c.advName).sort()).toEqual(['Ridge', 'Walker']);
      for (const c of contacts) {
        expect(c.latitude).toBeUndefined();
        expect(c.longitude).toBeUndefined();
        expect(c).not.toHaveProperty('lastAdvertHadPosition');
      }
    });

    it('nodes:viewOnMap adds the position back', async () => {
      await grantNodes(harness.limited.id, harness.sourceA, { read: true, viewOnMap: true });
      const agent = await harness.loginAs(harness.limited);
      const res = await agent.get(`/sources/${harness.sourceA}/meshcore/contacts`);
      const fix = (res.body.data as WireContact[]).find((c) => c.publicKey === KEY_FIX)!;
      expect(fix.latitude).toBeCloseTo(45.5, 4);
    });
  });
});
