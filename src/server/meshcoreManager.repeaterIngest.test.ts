/**
 * Repeater RAW-stream ingest (#5553 adverts → Nodes, #5551 GRP_TXT → Messages).
 *
 * Runs against the real `:memory:` database with wire-accurate frames, so the
 * decode, cross-source key lookup, decrypt, insert-or-ignore and event gating
 * all run for real. Nothing here transmits: there is no serial port.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MeshCoreManager, MeshCoreDeviceType, type MeshCoreContact, type MeshCoreMessage } from './meshcoreManager.js';
import databaseService from '../services/database.js';
import meshcorePacketLogService from './services/meshcorePacketLogService.js';
import { dataEventEmitter } from './services/dataEventEmitter.js';
import { notificationService } from './services/notificationService.js';
import { sourceManagerRegistry } from './sourceManagerRegistry.js';
import { channelKeyFingerprint, keyedChannelIndex } from './services/meshcoreFrameIngest.js';
import { buildAdvertFrame, buildGrpTxtFrame } from './test-helpers/meshcoreFrames.js';

const REP = 'src-rep-ingest';
const COMPANION = 'src-companion-ingest';
const SECRET = '0123456789abcdef0123456789abcdef';
const SECRET_B64 = Buffer.from(SECRET, 'hex').toString('base64');
const NODE_KEY = 'ab'.repeat(32);
const SELF_KEY = 'fe'.repeat(32);

type Internals = {
  deviceType: MeshCoreDeviceType;
  connected: boolean;
  repeaterPublicKey: string | null;
  handleSerialData: (line: string) => void;
};

function repeater(): { m: MeshCoreManager; feed: (rawHex: string) => void } {
  const m = new MeshCoreManager(REP);
  const i = m as unknown as Internals;
  i.deviceType = MeshCoreDeviceType.REPEATER;
  i.connected = true;
  i.repeaterPublicKey = SELF_KEY;
  // RAW then RX (same len) is how a MESH_PACKET_LOGGING build prints a packet.
  const feed = (rawHex: string) => {
    i.handleSerialData(`14:02:07 - 30/9/2026 U RAW: ${rawHex.toUpperCase()}`);
    i.handleSerialData(
      `14:02:07 - 30/9/2026 U: RX, len=${rawHex.length / 2} (type=5, route=F, payload_len=1) SNR=7 RSSI=-92 score=1000 time=1 hash=00`,
    );
  };
  return { m, feed };
}

const storedMessages = () => databaseService.meshcore.getRecentMessages(50, REP);

describe('repeater RAW ingest (#5553, #5551)', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let messageSpy: ReturnType<typeof vi.spyOn>;
  let contactSpy: ReturnType<typeof vi.spyOn>;
  let discoveredSpy: ReturnType<typeof vi.spyOn>;
  let changedSpy: ReturnType<typeof vi.spyOn>;
  let notifySpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    // Packet log OFF: ingest must not depend on the Packet Monitor opt-in.
    vi.spyOn(meshcorePacketLogService, 'isEnabled').mockResolvedValue(false);
    logSpy = vi.spyOn(meshcorePacketLogService, 'logPacket').mockResolvedValue(undefined as never);
    messageSpy = vi.spyOn(dataEventEmitter, 'emitMeshCoreMessage').mockImplementation(() => undefined);
    contactSpy = vi.spyOn(dataEventEmitter, 'emitMeshCoreContactUpdated').mockImplementation(() => undefined);
    discoveredSpy = vi.spyOn(dataEventEmitter, 'emitNodeDiscovered').mockImplementation(() => undefined);
    changedSpy = vi.spyOn(dataEventEmitter, 'emitMeshCoreNodeChanged').mockImplementation(() => undefined);
    notifySpy = vi.spyOn(notificationService, 'notifyNewMeshCoreNode').mockResolvedValue(undefined as never);
    await databaseService.meshcore.deleteAllMessagesForSource(REP);
    await databaseService.channels.upsertChannel({ id: 3, name: 'ops', psk: SECRET_B64, role: 2 }, COMPANION);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await databaseService.channels.deleteChannel(3, COMPANION);
  });

  describe('adverts → Nodes (#5553)', () => {
    it('creates a node on the repeater source with the packet log disabled', async () => {
      const { feed } = repeater();
      feed(buildAdvertFrame({ publicKey: NODE_KEY, advType: 1, name: 'Walker', lat: 45.5, lon: -122.5 }));

      await vi.waitFor(async () => {
        expect(await databaseService.meshcore.getNodeByPublicKeyAndSource(NODE_KEY, REP)).toBeTruthy();
      });
      const node = await databaseService.meshcore.getNodeByPublicKeyAndSource(NODE_KEY, REP);
      expect(node).toMatchObject({ name: 'Walker', advType: 1, sourceId: REP });
      expect(node!.latitude).toBeCloseTo(45.5, 4);
      expect(logSpy).not.toHaveBeenCalled();
    });

    it('fires no new-node notification and no node automation events', async () => {
      const { feed } = repeater();
      feed(buildAdvertFrame({ publicKey: 'cd'.repeat(32), name: 'Quiet' }));
      await vi.waitFor(() => expect(contactSpy).toHaveBeenCalledTimes(1));
      // Only the list-refresh socket event; nothing an automation or a
      // notification channel listens to.
      expect(notifySpy).not.toHaveBeenCalled();
      expect(discoveredSpy).not.toHaveBeenCalled();
      expect(changedSpy).not.toHaveBeenCalled();
    });

    it('does not mark an advert-only node as a zero-hop neighbour, or write link signal', async () => {
      const key = '12'.repeat(32);
      const { feed } = repeater();
      feed(buildAdvertFrame({ publicKey: key, name: 'Far' }));
      await vi.waitFor(async () => {
        expect(await databaseService.meshcore.getNodeByPublicKeyAndSource(key, REP)).toBeTruthy();
      });
      const node = await databaseService.meshcore.getNodeByPublicKeyAndSource(key, REP);
      expect(node!.repeaterNeighborAt ?? null).toBeNull();
      expect(node!.snr ?? null).toBeNull();
      expect(await databaseService.meshcore.getNeighborsForReporter(REP, SELF_KEY)).toEqual([]);
    });

    it('the neighbours poll is what marks a node as a zero-hop neighbour', async () => {
      const key = '34567890' + '5'.repeat(56);
      const { m, feed } = repeater();
      feed(buildAdvertFrame({ publicKey: key, advType: 2, name: 'Near' }));
      await vi.waitFor(async () => {
        expect(await databaseService.meshcore.getNodeByPublicKeyAndSource(key, REP)).toBeTruthy();
      });
      await m.ingestRepeaterNeighborsReply('-> 34567890:5:-8');
      const node = await databaseService.meshcore.getNodeByPublicKeyAndSource(key, REP);
      expect(node!.repeaterNeighborAt).toBeGreaterThan(0);
      const all = await m.getAllNodes();
      expect(all.find((n) => n.publicKey === key)?.repeaterNeighborAt).toBeGreaterThan(0);
    });

    // #5632: a Repeater keeps no in-memory contact map, and the client
    // replaces its contact record with each pushed event. The push used to
    // carry the bare advert, so an advert without coordinates took the node
    // off the map though the stored row still had them.
    describe('position survives a later advert without one (#5632)', () => {
      const key = '77'.repeat(32);
      const lastEventFor = (publicKey: string) =>
        contactSpy.mock.calls
          .map((call: unknown[]) => call[0] as MeshCoreContact)
          .filter((c: MeshCoreContact) => c.publicKey === publicKey)
          .at(-1);

      it('the stored row and the pushed contact both keep the coordinates', async () => {
        const { feed } = repeater();
        feed(buildAdvertFrame({ publicKey: key, advType: 2, name: 'Ridge', lat: 45.5, lon: -122.5 }));
        await vi.waitFor(() => expect(lastEventFor(key)).toBeTruthy());
        expect(lastEventFor(key)).toMatchObject({ advName: 'Ridge', advType: 2, lastAdvertHadPosition: true });
        expect(lastEventFor(key)!.latitude).toBeCloseTo(45.5, 4);

        // Same node, next advert: name only, no position flag on the wire.
        feed(buildAdvertFrame({ publicKey: key, advType: 2, name: 'Ridge', timestamp: 1_700_000_120 }));
        await vi.waitFor(() => expect(lastEventFor(key)?.lastAdvertHadPosition).toBe(false));

        const row = await databaseService.meshcore.getNodeByPublicKeyAndSource(key, REP);
        expect(row!.latitude).toBeCloseTo(45.5, 4);
        expect(row!.longitude).toBeCloseTo(-122.5, 4);
        expect(row!.lastAdvertHadPosition).toBe(false);

        const pushed = lastEventFor(key)!;
        expect(pushed.latitude).toBeCloseTo(45.5, 4);
        expect(pushed.longitude).toBeCloseTo(-122.5, 4);
        expect(pushed).toMatchObject({ advName: 'Ridge', advType: 2 });
        expect(typeof pushed.lastSeen).toBe('number');
      });

      it('a nameless later advert keeps the stored name in the pushed contact', async () => {
        const nameKey = '78'.repeat(32);
        const { feed } = repeater();
        feed(buildAdvertFrame({ publicKey: nameKey, advType: 1, name: 'Ridge', lat: 45.5, lon: -122.5 }));
        await vi.waitFor(() => expect(lastEventFor(nameKey)).toBeTruthy());
        contactSpy.mockClear();
        feed(buildAdvertFrame({ publicKey: nameKey, advType: 1, timestamp: 1_700_000_240 }));
        await vi.waitFor(() => expect(lastEventFor(nameKey)).toBeTruthy());
        expect(lastEventFor(nameKey)).toMatchObject({ advName: 'Ridge', name: 'Ridge' });
      });

      it('the neighbours poll pushes the stored row, not its own fields alone', async () => {
        const nKey = '9abcdef0' + '6'.repeat(56);
        const { m, feed } = repeater();
        feed(buildAdvertFrame({ publicKey: nKey, advType: 2, name: 'Tower', lat: 10.25, lon: 20.5 }));
        await vi.waitFor(() => expect(lastEventFor(nKey)).toBeTruthy());
        feed(buildAdvertFrame({ publicKey: nKey, advType: 2, name: 'Tower', timestamp: 1_700_000_300 }));
        await vi.waitFor(() => expect(lastEventFor(nKey)?.lastAdvertHadPosition).toBe(false));
        contactSpy.mockClear();

        await m.ingestRepeaterNeighborsReply('-> 9abcdef0:5:-8');
        const pushed = lastEventFor(nKey)!;
        expect(pushed).toMatchObject({ advName: 'Tower', advType: 2, snr: -2, lastAdvertHadPosition: false });
        expect(pushed.latitude).toBeCloseTo(10.25, 4);
      });
    });

    // #5632: Node Details and the Nodes map look a node up in the CONTACT
    // list. A Repeater never fills the in-memory map, so that list was empty
    // and every node the Nodes list showed opened as a bare public key.
    describe('contact list for the client views (#5632)', () => {
      it('is built from the stored rows, with and without a position', async () => {
        const withFix = '21'.repeat(32);
        const advertOnly = '43'.repeat(32);
        const { m, feed } = repeater();
        feed(buildAdvertFrame({ publicKey: withFix, advType: 2, name: 'Has Fix', lat: 45.5, lon: -122.5 }));
        feed(buildAdvertFrame({ publicKey: advertOnly, advType: 1, name: 'No Fix' }));
        await vi.waitFor(async () => {
          expect(await databaseService.meshcore.getNodeByPublicKeyAndSource(advertOnly, REP)).toBeTruthy();
          expect(await databaseService.meshcore.getNodeByPublicKeyAndSource(withFix, REP)).toBeTruthy();
        });

        expect(m.getContacts()).toEqual([]);
        const contacts = await m.getContactsForView();
        const a = contacts.find((c) => c.publicKey === withFix)!;
        const b = contacts.find((c) => c.publicKey === advertOnly)!;
        expect(a).toMatchObject({ advName: 'Has Fix', advType: 2, lastAdvertHadPosition: true });
        expect(a.latitude).toBeCloseTo(45.5, 4);
        expect(typeof a.lastSeen).toBe('number');
        expect(b).toMatchObject({ advName: 'No Fix', advType: 1, lastAdvertHadPosition: false });
        expect(b.latitude).toBeUndefined();
        expect(b.longitude).toBeUndefined();
        // Every contact is a row the Nodes list also reads.
        const nodeKeys = (await m.getAllNodes()).map((n) => n.publicKey);
        for (const c of contacts) expect(nodeKeys).toContain(c.publicKey);
      });

      it("never lists another source's node, even one with the same key", async () => {
        const shared = '65'.repeat(32);
        await databaseService.meshcore.upsertNode(
          { publicKey: shared, name: 'On Companion', advType: 1, latitude: 1, longitude: 2 },
          COMPANION,
        );
        const onlyThere = '87'.repeat(32);
        await databaseService.meshcore.upsertNode({ publicKey: onlyThere, name: 'Elsewhere', advType: 1 }, COMPANION);
        const { m, feed } = repeater();
        feed(buildAdvertFrame({ publicKey: shared, advType: 2, name: 'On Repeater' }));
        await vi.waitFor(async () => {
          expect(await databaseService.meshcore.getNodeByPublicKeyAndSource(shared, REP)).toBeTruthy();
        });

        const contacts = await m.getContactsForView();
        expect(contacts.find((c) => c.publicKey === onlyThere)).toBeUndefined();
        const mine = contacts.find((c) => c.publicKey === shared)!;
        expect(mine).toMatchObject({ advName: 'On Repeater', advType: 2 });
        expect(mine.latitude).toBeUndefined();
      });

      it("leaves out the repeater's own key", async () => {
        await databaseService.meshcore.upsertNode({ publicKey: SELF_KEY, name: 'Me' }, REP);
        const { m } = repeater();
        expect((await m.getContactsForView()).find((c) => c.publicKey === SELF_KEY)).toBeUndefined();
        await databaseService.meshcore.deleteNode(SELF_KEY, REP);
      });

      it('a companion still answers from its in-memory map', async () => {
        const m = new MeshCoreManager(COMPANION);
        (m as unknown as Internals).deviceType = MeshCoreDeviceType.COMPANION;
        await databaseService.meshcore.upsertNode({ publicKey: 'f0'.repeat(32), name: 'Row Only' }, COMPANION);
        expect(await m.getContactsForView()).toEqual([]);
      });
    });

    it("skips the repeater's own advert", async () => {
      const { feed } = repeater();
      feed(buildAdvertFrame({ publicKey: SELF_KEY, name: 'Me' }));
      await new Promise((r) => setTimeout(r, 30));
      expect(await databaseService.meshcore.getNodeByPublicKeyAndSource(SELF_KEY, REP)).toBeFalsy();
    });
  });

  describe('GRP_TXT → channel messages (#5551)', () => {
    it("decrypts with another source's key and records which key did it", async () => {
      const { m, feed } = repeater();
      feed(buildGrpTxtFrame(1_700_000_000, 'Alice: hello mesh', SECRET));
      await vi.waitFor(() => expect(messageSpy).toHaveBeenCalledTimes(1));

      const rows = await storedMessages();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        fromPublicKey: `channel-${keyedChannelIndex(SECRET)}`,
        fromName: 'Alice',
        text: 'hello mesh',
        timestamp: 1_700_000_000_000,
        sourceId: REP,
        keySourceId: COMPANION,
        keyChannelIdx: 3,
        keyFingerprint: channelKeyFingerprint(SECRET),
        snr: 7,
        rssi: -92,
      });
      // The secret itself is never copied onto the row.
      expect(JSON.stringify(rows[0])).not.toContain(SECRET);
      expect(JSON.stringify(rows[0])).not.toContain(SECRET_B64);

      const [event, sourceId] = messageSpy.mock.calls[0] as [MeshCoreMessage, string];
      expect(sourceId).toBe(REP);
      expect(event.keyFingerprint).toBe(channelKeyFingerprint(SECRET));
      expect(event.selfOrigin).toBeUndefined();
      // The in-memory tail serves the same message.
      expect(m.getRecentMessages(10).map((x) => x.text)).toContain('hello mesh');
      expect(logSpy).not.toHaveBeenCalled();
    });

    it('a second copy of the same flood writes no row and emits no second event', async () => {
      const { feed } = repeater();
      const frame = buildGrpTxtFrame(1_700_000_100, 'Bob: once', SECRET);
      feed(frame);
      await vi.waitFor(() => expect(messageSpy).toHaveBeenCalledTimes(1));
      feed(frame);
      await new Promise((r) => setTimeout(r, 400));
      expect(messageSpy).toHaveBeenCalledTimes(1);
      expect((await storedMessages()).filter((r) => r.text === 'once')).toHaveLength(1);
    });

    it('stores nothing when no source holds a matching key', async () => {
      const { feed } = repeater();
      feed(buildGrpTxtFrame(1_700_000_200, 'Eve: secret', 'ffeeddccbbaa99887766554433221100'));
      await new Promise((r) => setTimeout(r, 400));
      expect(messageSpy).not.toHaveBeenCalled();
      expect(await storedMessages()).toHaveLength(0);
    });

    it("flags a message from one of our own nodes so automations treat it as self-sent", async () => {
      vi.spyOn(sourceManagerRegistry, 'getAllManagers').mockReturnValue([
        { sourceType: 'meshcore', getLocalNode: () => ({ name: 'MyCompanion' }) } as never,
      ]);
      const { feed } = repeater();
      feed(buildGrpTxtFrame(1_700_000_300, 'MyCompanion: pong', SECRET));
      await vi.waitFor(() => expect(messageSpy).toHaveBeenCalledTimes(1));
      expect((messageSpy.mock.calls[0][0] as MeshCoreMessage).selfOrigin).toBe(true);
      // Still stored: it is real traffic.
      expect((await storedMessages()).map((r) => r.text)).toContain('pong');
    });
  });
});
