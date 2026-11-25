/**
 * Walkabout service (#5891 P1, spec §2.5). The repository is mocked.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const repo = vi.hoisted(() => ({
  createSession: vi.fn(),
  getSession: vi.fn(),
  getOpenSession: vi.fn(),
  getOpenSessionsAllSources: vi.fn(),
  endSession: vi.fn(),
  deleteSession: vi.fn(),
  insertSample: vi.fn(),
  getLatestSample: vi.fn(),
  recordReception: vi.fn(),
  getCounts: vi.fn(),
}));
const getAllNodes = vi.hoisted(() => vi.fn());
const getNodesBySource = vi.hoisted(() => vi.fn());
const getManager = vi.hoisted(() => vi.fn());
const verify = vi.hoisted(() => vi.fn());

vi.mock('../../services/database.js', () => ({
  default: { coverageWalkabout: repo, nodes: { getAllNodes }, meshcore: { getNodesBySource } },
}));
vi.mock('../sourceManagerRegistry.js', () => ({ sourceManagerRegistry: { getManager } }));
vi.mock('@michaelhart/meshcore-decoder', () => ({ Ed25519SignatureVerifier: { verifyAdvertisementSignature: verify } }));

import { WalkaboutService, WalkaboutError } from './walkaboutService.js';
import { TransportMechanism } from '../constants/meshtastic.js';

const NOW = 1_760_000_000_000;
const CAP = 2 * 3_600_000;
const SRC = 'src-a';
const USER = 7;
const tick = () => new Promise((r) => setImmediate(r));

const sessionRow = (over: Record<string, unknown> = {}) => ({
  id: 'sess-1', sourceId: SRC, name: null, startedAt: NOW, endedAt: null, endReason: null, startedBy: USER,
  createdAt: NOW, updatedAt: NOW, ...over,
});
const sample = (over: Record<string, unknown> = {}) => ({
  latitude: 30, longitude: -97, accuracyM: 10, deviceFixAt: 1_000_000, ageMs: 0, ...over,
});

function setup() {
  vi.setSystemTime(NOW);
  getManager.mockImplementation((id: string) => (id === 'mqtt' ? { sourceType: 'mqtt_broker' } : { sourceType: 'meshtastic_tcp' }));
  repo.getOpenSessionsAllSources.mockResolvedValue([]);
  repo.getOpenSession.mockResolvedValue(null);
  repo.createSession.mockImplementation(async (p: any) => sessionRow({ id: p.id, sourceId: p.sourceId, startedAt: p.startedAt, startedBy: p.startedBy, name: p.name }));
  repo.getSession.mockResolvedValue(sessionRow());
  repo.endSession.mockResolvedValue(true);
  repo.deleteSession.mockResolvedValue(true);
  repo.insertSample.mockImplementation(async (r: any) => ({ id: 42, ...r }));
  repo.getLatestSample.mockResolvedValue(null);
  repo.recordReception.mockResolvedValue(true);
  repo.getCounts.mockResolvedValue({ samples: 1, receptions: 0, nodes: 0, lastSampleAt: NOW });
  getAllNodes.mockResolvedValue([]);
  getNodesBySource.mockResolvedValue([]);
  verify.mockResolvedValue(true);
}

async function ready(): Promise<WalkaboutService> {
  const svc = new WalkaboutService();
  await svc.init(NOW);
  return svc;
}
/** A live session with a fresh fix. */
async function live(svc: WalkaboutService, sourceId = SRC) {
  const row = await svc.startSession(sourceId, USER, null, NOW);
  repo.getSession.mockResolvedValue({ ...row });
  await svc.addSamples(sourceId, row.id, USER, [sample()], NOW);
  return row;
}
const mtPacket = (over: Record<string, unknown> = {}) => ({
  from: 0xdeadbeef, id: 99, rxSnr: 4, rxRssi: -80, hopStart: 0, hopLimit: 0, rxTime: Math.floor(Date.now() / 1000),
  viaMqtt: false, transportMechanism: TransportMechanism.LORA, decoded: { bitfield: 1 }, relayNode: 0, ...over,
});
const capture = (svc: WalkaboutService, over: Record<string, unknown> = {}, sourceId = SRC) =>
  svc.maybeCaptureMeshtastic({ sourceId, localNodeNum: 0x11111111, packet: mtPacket(over) as any, replayed: false });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.clearAllMocks();
  setup();
});
afterEach(() => vi.useRealTimers());

describe('startSession', () => {
  it('a second start on the same source is ALREADY_LIVE, also in the same tick; another source is fine', async () => {
    const svc = await ready();
    const [a, b] = await Promise.allSettled([svc.startSession(SRC, USER, null, NOW), svc.startSession(SRC, 8, null, NOW)]);
    expect(a.status).toBe('fulfilled');
    expect(b.status).toBe('rejected');
    expect((b as PromiseRejectedResult).reason).toMatchObject({ code: 'WALKABOUT_ALREADY_LIVE' });
    await expect(svc.startSession(SRC, USER, null, NOW)).rejects.toMatchObject({ code: 'WALKABOUT_ALREADY_LIVE', extra: { sessionId: expect.any(String) } });
    await expect(svc.startSession('src-b', USER, null, NOW)).resolves.toBeTruthy();
    expect(repo.createSession).toHaveBeenCalledTimes(2);
  });

  it('a failed insert releases the claim', async () => {
    const svc = await ready();
    repo.createSession.mockRejectedValueOnce(new Error('db down'));
    await expect(svc.startSession(SRC, USER, null, NOW)).rejects.toThrow('db down');
    await expect(svc.startSession(SRC, USER, null, NOW)).resolves.toBeTruthy();
  });

  it('an open session past its cap does not block a new start; it ends at startedAt + cap', async () => {
    const svc = await ready();
    const first = await svc.startSession(SRC, USER, null, NOW);
    const later = NOW + CAP + 1000;
    vi.setSystemTime(later);
    await expect(svc.startSession(SRC, USER, null, later)).resolves.toBeTruthy();
    expect(repo.endSession).toHaveBeenCalledWith(SRC, first.id, NOW + CAP, 'cap');
  });

  it('a DB row the map lacks (failed init) is ALREADY_LIVE; a capped one is ended first', async () => {
    const svc = await ready();
    repo.getOpenSession.mockResolvedValueOnce(sessionRow({ id: 'orphan' }));
    await expect(svc.startSession(SRC, USER, null, NOW + 1000)).rejects.toMatchObject({ code: 'WALKABOUT_ALREADY_LIVE', extra: { sessionId: 'orphan' } });
    const svc2 = await ready(); // the orphan above was adopted into svc's map
    repo.getOpenSession.mockResolvedValueOnce(sessionRow({ id: 'old', startedAt: NOW - CAP - 1 }));
    await expect(svc2.startSession(SRC, USER, null, NOW)).resolves.toBeTruthy();
    expect(repo.endSession).toHaveBeenCalledWith(SRC, 'old', NOW - 1, 'cap');
  });

  it('refuses an MQTT-type source', async () => {
    const svc = await ready();
    await expect(svc.startSession('mqtt', USER, null, NOW)).rejects.toMatchObject({ code: 'WALKABOUT_SOURCE_UNSUPPORTED' });
    getManager.mockReturnValueOnce(undefined);
    await expect(svc.startSession('gone', USER, null, NOW)).rejects.toBeInstanceOf(WalkaboutError);
    expect(repo.createSession).not.toHaveBeenCalled();
  });

  it('waits for init(); capture is a no-op meanwhile; a rejected init still releases it', async () => {
    const svc = new WalkaboutService();
    repo.getOpenSessionsAllSources.mockRejectedValueOnce(new Error('boom'));
    let started = false;
    const p = svc.startSession(SRC, USER, null, NOW).then((r) => { started = true; return r; });
    capture(svc);
    await tick();
    expect(started).toBe(false);
    expect(repo.recordReception).not.toHaveBeenCalled();
    await svc.init(NOW);
    await expect(p).resolves.toBeTruthy();
  });

  it('addSamples waits for init()', async () => {
    const svc = new WalkaboutService();
    repo.getSession.mockResolvedValue(null);
    let done = false;
    const p = svc.addSamples(SRC, 'sess-1', USER, [sample()], NOW).catch(() => { done = true; });
    await tick();
    expect(done).toBe(false);
    await svc.init(NOW);
    await p;
    expect(done).toBe(true);
  });
});

describe('addSamples', () => {
  async function started() {
    const svc = await ready();
    const row = await svc.startSession(SRC, USER, null, NOW);
    repo.getSession.mockResolvedValue({ ...row });
    return { svc, id: row.id };
  }

  it('accuracy 101 is dropped, 100 kept', async () => {
    const { svc, id } = await started();
    const r = await svc.addSamples(SRC, id, USER, [sample({ accuracyM: 101, deviceFixAt: 1_000_000 }), sample({ accuracyM: 100, deviceFixAt: 1_010_000 })], NOW);
    expect(r.accepted).toBe(1);
    expect(r.dropped.accuracy).toBe(1);
  });

  it('spacing: 4 999 ms dropped, 5 000 ms kept; 10 s backwards dropped; 2 min backwards rebases', async () => {
    const { svc, id } = await started();
    const post = (deviceFixAt: number) => svc.addSamples(SRC, id, USER, [sample({ deviceFixAt })], NOW);
    expect((await post(1_000_000)).accepted).toBe(1);
    expect((await post(1_004_999)).dropped.spacing).toBe(1);
    expect((await post(1_005_000)).accepted).toBe(1);
    expect((await post(995_000)).dropped.spacing).toBe(1);
    expect((await post(1_005_000 - 120_000)).accepted).toBe(1);
    expect((await post(1_005_000 - 120_000 + 5_000)).accepted).toBe(1);
  });

  it('samples are processed in deviceFixAt order', async () => {
    const { svc, id } = await started();
    const r = await svc.addSamples(SRC, id, USER, [sample({ deviceFixAt: 1_010_000 }), sample({ deviceFixAt: 1_000_000 })], NOW);
    expect(r.accepted).toBe(2);
    expect(repo.insertSample.mock.calls.map((c) => c[0].deviceFixAt)).toEqual([1_000_000, 1_010_000]);
  });

  it('ageMs 31 s is stale; (0,0) and non-finite values are invalid; negative age clamps to 0', async () => {
    const { svc, id } = await started();
    const r = await svc.addSamples(SRC, id, USER, [
      sample({ ageMs: 31_000, deviceFixAt: 1_000_000 }),
      sample({ latitude: 0, longitude: 0, deviceFixAt: 1_010_000 }),
      sample({ latitude: NaN, deviceFixAt: 1_020_000 }),
      sample({ ageMs: -500, deviceFixAt: 1_030_000 }),
    ], NOW);
    expect(r.dropped).toEqual({ accuracy: 0, spacing: 0, stale: 1, invalid: 2 });
    expect(r.accepted).toBe(1);
    expect(repo.insertSample.mock.calls[0][0]).toMatchObject({ fixAt: NOW, receivedAt: NOW, sessionId: id });
  });

  it('fixAt is server now minus ageMs', async () => {
    const { svc, id } = await started();
    await svc.addSamples(SRC, id, USER, [sample({ ageMs: 4_000 })], NOW);
    expect(repo.insertSample.mock.calls[0][0].fixAt).toBe(NOW - 4_000);
  });

  it('only the starter may post', async () => {
    const { svc, id } = await started();
    await expect(svc.addSamples(SRC, id, 99, [sample()], NOW)).rejects.toMatchObject({ code: 'WALKABOUT_NOT_OWNER' });
  });

  it('counts come from getCounts (DB truth)', async () => {
    const { svc, id } = await started();
    repo.getCounts.mockResolvedValue({ samples: 12, receptions: 34, nodes: 5, lastSampleAt: NOW });
    const r = await svc.addSamples(SRC, id, USER, [sample()], NOW);
    expect(r.session).toMatchObject({ sampleCount: 12, receptionCount: 34, nodeCount: 5, startedByMe: true, isLive: true });
    expect(r.skipped).toEqual({ noFix: 0, relayAmbiguous: 0, relayUnknown: 0, noSender: 0 });
  });

  it('an unknown or ended session: NOT_FOUND / NOT_LIVE', async () => {
    const svc = await ready();
    repo.getSession.mockResolvedValueOnce(null);
    await expect(svc.addSamples(SRC, 'nope', USER, [sample()], NOW)).rejects.toMatchObject({ code: 'WALKABOUT_NOT_FOUND' });
    repo.getSession.mockResolvedValueOnce(sessionRow({ endedAt: NOW }));
    await expect(svc.addSamples(SRC, 'sess-1', USER, [sample()], NOW)).rejects.toMatchObject({ code: 'WALKABOUT_NOT_LIVE' });
  });

  it('at startedAt + cap: NOT_LIVE and the session ends at startedAt + cap', async () => {
    const { svc, id } = await started();
    const at = NOW + CAP;
    vi.setSystemTime(at);
    await expect(svc.addSamples(SRC, id, USER, [sample()], at)).rejects.toMatchObject({ code: 'WALKABOUT_NOT_LIVE' });
    expect(repo.endSession).toHaveBeenCalledWith(SRC, id, NOW + CAP, 'cap');
  });
});

describe('stop and delete', () => {
  it('stopSession ends with reason user and stops capture; a second stop is idempotent', async () => {
    const svc = await ready();
    const row = await live(svc);
    repo.getSession.mockResolvedValueOnce({ ...row });
    await svc.stopSession(SRC, row.id, NOW + 1000);
    expect(repo.endSession).toHaveBeenCalledWith(SRC, row.id, NOW + 1000, 'user');
    capture(svc);
    expect(repo.recordReception).not.toHaveBeenCalled();
    repo.getSession.mockResolvedValue({ ...row, endedAt: NOW + 1000, endReason: 'user' });
    repo.endSession.mockClear();
    await expect(svc.stopSession(SRC, row.id)).resolves.toMatchObject({ endedAt: NOW + 1000 });
    expect(repo.endSession).not.toHaveBeenCalled();
    repo.getSession.mockResolvedValue(null);
    await expect(svc.stopSession(SRC, 'zzz')).resolves.toBeNull();
  });

  it('deleteSession drops the map entry before the rows go', async () => {
    const svc = await ready();
    const row = await live(svc);
    repo.deleteSession.mockImplementation(async () => {
      capture(svc);
      expect(repo.recordReception).not.toHaveBeenCalled();
      return true;
    });
    await expect(svc.deleteSession(SRC, row.id)).resolves.toBe(true);
  });
});

describe('capture', () => {
  it('no live session: the repository is never called (one Map lookup)', async () => {
    const svc = await ready();
    repo.getOpenSessionsAllSources.mockClear();
    capture(svc);
    svc.maybeCaptureMeshCore({ sourceId: SRC, localPubKey: null, event: { raw_hex: '00' } });
    await tick();
    for (const fn of Object.values(repo)) {
      if (fn !== repo.getOpenSessionsAllSources) expect(fn).not.toHaveBeenCalled();
    }
    expect(getAllNodes).not.toHaveBeenCalled();
  });

  it('a fix 24 s old is written with the copied lat/lon, sampleId and sampleAgeMs', async () => {
    const svc = await ready();
    const row = await live(svc);
    vi.setSystemTime(NOW + 24_000);
    capture(svc);
    await tick();
    expect(repo.recordReception).toHaveBeenCalledTimes(1);
    expect(repo.recordReception.mock.calls[0][0]).toMatchObject({
      sessionId: row.id, sourceId: SRC, protocol: 'meshtastic', creditedKey: '!deadbeef', creditKind: 'direct',
      latitude: 30, longitude: -97, accuracyM: 10, sampleId: 42, sampleAgeMs: 24_000, heardAt: NOW + 24_000, packetKey: 'deadbeef:99',
    });
  });

  it('a fix 26 s old counts noFix and writes nothing', async () => {
    const svc = await ready();
    const row = await live(svc);
    vi.setSystemTime(NOW + 26_000);
    capture(svc);
    await tick();
    expect(repo.recordReception).not.toHaveBeenCalled();
    expect(svc.getSkipped(SRC, row.id)).toMatchObject({ noFix: 1 });
    expect(svc.getSkipped(SRC, 'other')).toBeNull();
  });

  it('no fix yet counts noFix', async () => {
    const svc = await ready();
    const row = await svc.startSession(SRC, USER, null, NOW);
    capture(svc);
    expect(svc.getSkipped(SRC, row.id)).toMatchObject({ noFix: 1 });
  });

  it('MQTT-delivered receptions on a radio source are skipped', async () => {
    const svc = await ready();
    await live(svc);
    capture(svc, { viaMqtt: true });
    capture(svc, { transportMechanism: TransportMechanism.MQTT });
    await tick();
    expect(repo.recordReception).not.toHaveBeenCalled();
  });

  it('a relayed packet loads candidates lazily (24 h, not CLIENT_MUTE) and credits a unique relayer', async () => {
    const svc = await ready();
    await live(svc);
    const sec = Math.floor(NOW / 1000);
    getAllNodes.mockResolvedValue([
      { nodeNum: 0xaabbcc4f, shortName: 'RLY', role: 2, hopsAway: 1, lastHeard: sec - 60 },
      { nodeNum: 0x1122334f, shortName: 'OLD', role: 2, hopsAway: 1, lastHeard: sec - 3 * 86400 }, // too old to count
      { nodeNum: 0x5566774f, shortName: 'MUTE', role: 1, hopsAway: 1, lastHeard: sec - 60 },
    ]);
    capture(svc, { hopStart: 3, hopLimit: 2, relayNode: 0x4f });
    await tick();
    expect(getAllNodes).toHaveBeenCalledTimes(1);
    expect(repo.recordReception).toHaveBeenCalledTimes(1);
    expect(repo.recordReception.mock.calls[0][0]).toMatchObject({ creditedKey: '!aabbcc4f', creditedNodeNum: 0xaabbcc4f, creditKind: 'relay', hopsAway: 1 });
    // cache hit: no second load
    capture(svc, { hopStart: 3, hopLimit: 2, relayNode: 0x4f, id: 100 });
    await tick();
    expect(getAllNodes).toHaveBeenCalledTimes(1);
    expect(repo.recordReception).toHaveBeenCalledTimes(2);
  });

  it('an ambiguous relayer is counted, not written', async () => {
    const svc = await ready();
    const row = await live(svc);
    const sec = Math.floor(NOW / 1000);
    getAllNodes.mockResolvedValue([
      { nodeNum: 0xaabbcc4f, role: 2, lastHeard: sec }, { nodeNum: 0x1122334f, role: 2, lastHeard: sec },
    ]);
    capture(svc, { hopStart: 3, hopLimit: 2, relayNode: 0x4f });
    await tick();
    expect(repo.recordReception).not.toHaveBeenCalled();
    expect(svc.getSkipped(SRC, row.id)).toMatchObject({ relayUnknown: 0, relayAmbiguous: 1 }); // re-evaluated after the lazy load
    capture(svc, { hopStart: 3, hopLimit: 2, relayNode: 0x4f, id: 5 });
    await tick();
    expect(svc.getSkipped(SRC, row.id)?.relayAmbiguous).toBe(2);
  });

  it('a rejecting repository never throws', async () => {
    const svc = await ready();
    await live(svc);
    repo.recordReception.mockRejectedValue(new Error('db'));
    expect(() => capture(svc)).not.toThrow();
    repo.recordReception.mockImplementation(() => { throw new Error('sync'); });
    expect(() => capture(svc)).not.toThrow();
    await tick();
  });

  it('at startedAt + cap, capture ends the session with endedAt = startedAt + cap', async () => {
    const svc = await ready();
    const row = await live(svc);
    vi.setSystemTime(NOW + CAP);
    capture(svc);
    await tick();
    expect(repo.endSession).toHaveBeenCalledWith(SRC, row.id, NOW + CAP, 'cap');
    expect(repo.recordReception).not.toHaveBeenCalled();
    capture(svc);
    await tick();
    expect(repo.endSession).toHaveBeenCalledTimes(1);
  });

  describe('MeshCore', () => {
    const KEY = 'ab'.repeat(32);
    const advertRaw = (() => {
      const header = (1 | (0x04 << 2)).toString(16).padStart(2, '0');
      return header + '00' + KEY + '01000000' + '55'.repeat(64) + '02';
    })();

    it('a verified zero-hop advert is written; a bad signature is not', async () => {
      const svc = await ready();
      await live(svc);
      svc.maybeCaptureMeshCore({ sourceId: SRC, localPubKey: '11'.repeat(32), event: { raw_hex: advertRaw, snr: 5, rssi: -90 } });
      await tick();
      expect(repo.recordReception).toHaveBeenCalledTimes(1);
      expect(repo.recordReception.mock.calls[0][0]).toMatchObject({ protocol: 'meshcore', creditedKey: KEY, creditKind: 'direct', creditedNodeNum: null });
      verify.mockResolvedValue(false);
      svc.maybeCaptureMeshCore({ sourceId: SRC, localPubKey: '11'.repeat(32), event: { raw_hex: advertRaw } });
      await tick();
      expect(repo.recordReception).toHaveBeenCalledTimes(1);
    });

    it('relay candidates are repeaters and room servers only', async () => {
      const svc = await ready();
      const row = await live(svc);
      getNodesBySource.mockResolvedValue([
        { publicKey: 'ab'.repeat(32), advType: 1 }, // companion: not a relay candidate
        { publicKey: 'ab' + 'cd'.repeat(31), advType: 2 },
      ]);
      const floodGrp = (1 | (0x05 << 2)).toString(16).padStart(2, '0') + '01' + 'ab' + 'bbcc';
      svc.maybeCaptureMeshCore({ sourceId: SRC, localPubKey: '11'.repeat(32), event: { raw_hex: floodGrp } });
      await tick();
      expect(repo.recordReception).toHaveBeenCalledTimes(1);
      expect(repo.recordReception.mock.calls[0][0]).toMatchObject({ creditedKey: 'ab' + 'cd'.repeat(31), creditKind: 'relay' });
      // GRP_TXT with an empty path has no sender
      const grpEmpty = (1 | (0x05 << 2)).toString(16).padStart(2, '0') + '00' + 'bbcc';
      svc.maybeCaptureMeshCore({ sourceId: SRC, localPubKey: null, event: { raw_hex: grpEmpty } });
      expect(svc.getSkipped(SRC, row.id)?.noSender).toBe(1);
    });
  });
});

describe('init: restart sweep', () => {
  it('ends a 3 h session at startedAt + 2 h, resumes a 30 min one with its stored startedAt and spacing baseline', async () => {
    const old = sessionRow({ id: 'old', sourceId: 'src-old', startedAt: NOW - 3 * 3_600_000 });
    const young = sessionRow({ id: 'young', startedAt: NOW - 30 * 60_000 });
    repo.getOpenSessionsAllSources.mockResolvedValue([old, young]);
    repo.getLatestSample.mockResolvedValue({ id: 9, sessionId: 'young', sourceId: SRC, latitude: 30, longitude: -97, accuracyM: 8, deviceFixAt: 5_000_000, fixAt: NOW - 600_000, receivedAt: NOW - 600_000 });
    const svc = new WalkaboutService();
    await svc.init(NOW);
    expect(repo.endSession).toHaveBeenCalledTimes(1);
    expect(repo.endSession).toHaveBeenCalledWith('src-old', 'old', old.startedAt + CAP, 'cap');

    // second init changes nothing more
    await svc.init(NOW);
    expect(repo.endSession).toHaveBeenCalledTimes(1 + 1); // the old row is still returned by the mock, so it is re-ended at the same time
    expect(repo.endSession).toHaveBeenLastCalledWith('src-old', 'old', old.startedAt + CAP, 'cap');
    expect(repo.getLatestSample).toHaveBeenCalledTimes(1);

    repo.getSession.mockResolvedValue({ ...young });
    // spacing baseline = stored deviceFixAt: 3 s after it is dropped
    const r = await svc.addSamples(SRC, 'young', USER, [sample({ deviceFixAt: 5_003_000 })], NOW);
    expect(r.dropped.spacing).toBe(1);
    // ends 90 min after the restart, from the stored startedAt
    const at = young.startedAt + CAP;
    vi.setSystemTime(at);
    await expect(svc.addSamples(SRC, 'young', USER, [sample({ deviceFixAt: 6_000_000 })], at)).rejects.toMatchObject({ code: 'WALKABOUT_NOT_LIVE' });
    expect(repo.endSession).toHaveBeenLastCalledWith(SRC, 'young', young.startedAt + CAP, 'cap');
  });

  it('forgetSource drops the live entry', async () => {
    const svc = await ready();
    const row = await live(svc);
    svc.forgetSource(SRC);
    capture(svc);
    expect(svc.getSkipped(SRC, row.id)).toBeNull();
    expect(repo.recordReception).not.toHaveBeenCalled();
  });
});

describe('review fixes', () => {
  it('init: one failing row does not leave later sessions unloaded; addSamples lazily loads a DB-live session', async () => {
    const bad = sessionRow({ id: 'bad', sourceId: 'src-bad' });
    const good = sessionRow({ id: 'good', sourceId: SRC });
    repo.getOpenSessionsAllSources.mockResolvedValue([bad, good]);
    repo.getLatestSample.mockImplementation(async (src: string) => {
      if (src === 'src-bad') throw new Error('read failed');
      return null;
    });
    const svc = new WalkaboutService();
    await svc.init(NOW);
    repo.getSession.mockResolvedValue({ ...good });
    await expect(svc.addSamples(SRC, 'good', USER, [sample()], NOW)).resolves.toMatchObject({ accepted: 1 });
    // the failed one loads lazily once the read works
    repo.getLatestSample.mockResolvedValue(null);
    repo.getSession.mockResolvedValue({ ...bad });
    await expect(svc.addSamples('src-bad', 'bad', USER, [sample()], NOW)).resolves.toMatchObject({ accepted: 1 });
  });

  it('ensureLoaded adopts a DB-open session and ends a capped one', async () => {
    const svc = await ready();
    repo.getOpenSession.mockResolvedValueOnce(sessionRow({ id: 'orph' }));
    await expect(svc.ensureLoaded(SRC, NOW)).resolves.toMatchObject({ id: 'orph' });
    expect(svc.getSkipped(SRC, 'orph')).not.toBeNull();
    const svc2 = await ready();
    repo.getOpenSession.mockResolvedValueOnce(sessionRow({ id: 'old', startedAt: NOW - CAP - 5 }));
    await expect(svc2.ensureLoaded(SRC, NOW)).resolves.toBeNull();
    expect(repo.endSession).toHaveBeenCalledWith(SRC, 'old', NOW - 5, 'cap');
  });

  it('stopSession: a DB error keeps the session live and capturing', async () => {
    const svc = await ready();
    const row = await live(svc);
    repo.getSession.mockResolvedValue({ ...row });
    repo.endSession.mockRejectedValueOnce(new Error('db'));
    await expect(svc.stopSession(SRC, row.id, NOW + 1000)).rejects.toThrow('db');
    expect(svc.getSkipped(SRC, row.id)).not.toBeNull();
    capture(svc);
    await tick();
    expect(repo.recordReception).toHaveBeenCalledTimes(1);
  });

  it('addSamples stops inserting once a stop or delete lands mid-post', async () => {
    const svc = await ready();
    const row = await live(svc);
    repo.insertSample.mockClear();
    repo.insertSample.mockImplementation(async (r: any) => {
      await svc.deleteSession(SRC, row.id); // lands during the first insert
      return { id: 50, ...r };
    });
    await expect(svc.addSamples(SRC, row.id, USER, [sample({ deviceFixAt: 2_000_000 }), sample({ deviceFixAt: 2_010_000 })], NOW))
      .rejects.toMatchObject({ code: 'WALKABOUT_NOT_LIVE' });
    expect(repo.insertSample).toHaveBeenCalledTimes(1);
  });

  it('startSession: a source forgotten during the pending insert leaves no live entry or row', async () => {
    const svc = await ready();
    repo.createSession.mockImplementationOnce(async (p: any) => {
      svc.forgetSource(SRC);
      return sessionRow({ id: p.id });
    });
    await expect(svc.startSession(SRC, USER, null, NOW)).rejects.toBeInstanceOf(WalkaboutError);
    expect(repo.deleteSession).toHaveBeenCalledWith(SRC, expect.any(String));
    expect(svc.getSkipped(SRC, 'x')).toBeNull();
    await expect(svc.startSession(SRC, USER, null, NOW)).resolves.toBeTruthy();
  });

  it('noFix counts only packets a fix could have credited', async () => {
    const svc = await ready();
    const row = await svc.startSession(SRC, USER, null, NOW);
    capture(svc, { from: 0x11111111 }); // own
    capture(svc, { viaMqtt: true });
    capture(svc, { rxTime: Math.floor(NOW / 1000) - 600 }); // not live
    expect(svc.getSkipped(SRC, row.id)).toMatchObject({ noFix: 0 });
    capture(svc); // creditable, no fix
    expect(svc.getSkipped(SRC, row.id)).toMatchObject({ noFix: 1 });
  });
});
