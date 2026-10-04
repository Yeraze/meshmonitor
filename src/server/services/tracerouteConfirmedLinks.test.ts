/**
 * #5580: the rule for a traceroute-confirmed reciprocal link.
 *
 * Out leg `[us, ...route, dest]`, back leg `[dest, ...routeBack, us]`; SNR
 * arrays are raw firmware ints (dB x4).
 *
 * The table stores a completed run in TWO orientations (see the module doc):
 * `{ from: dest, to: us }` when the reply was inserted as it arrived, and
 * `{ from: us, to: dest }` when the reply updated the pending row written at
 * send time. The default fixture is the first; `sent()` is the second. The
 * route harness test writes rows through the real DatabaseService path.
 */
import { describe, it, expect } from 'vitest';
import {
  confirmedLinkFromTraceroute,
  aggregateConfirmedLinks,
  buildConfirmedLinks,
  type ConfirmedLinkTracerouteRow,
} from './tracerouteConfirmedLinks.js';
import { TX_LORA, TX_MQTT, TX_MULTICAST_UDP } from '../../utils/nodeTransport.js';

const US = 0x0a000001;
const DEST = 0x0b000002;
const HOP_A = 0x0c000003;
const HOP_B = 0x0d000004;
const HOP_C = 0x0e000005;
const SENTINEL = -128;

const row = (o: Partial<ConfirmedLinkTracerouteRow> = {}): ConfirmedLinkTracerouteRow => ({
  sourceId: 'src-a',
  fromNodeNum: DEST,
  toNodeNum: US,
  route: '[]',
  routeBack: '[]',
  snrTowards: '[-33]',
  snrBack: '[-45]',
  transportMechanism: TX_LORA,
  timestamp: 1_000,
  ...o,
});

/** The pending-row orientation: we sent it from MeshMonitor, the reply updated the row. */
const sent = (o: Partial<ConfirmedLinkTracerouteRow> = {}): ConfirmedLinkTracerouteRow =>
  row({ fromNodeNum: US, toNodeNum: DEST, ...o });

describe('confirmedLinkFromTraceroute — stored orientation', () => {
  it('reads the row MeshMonitor writes for its own traceroute: our radio in fromNodeNum', () => {
    // The live row that exposed the bug: Sandbox -> BLESandbox, zero hops.
    const obs = confirmedLinkFromTraceroute({
      sourceId: 'sandbox', fromNodeNum: 3639506708, toNodeNum: 944633591,
      route: '[]', routeBack: '[]', snrTowards: '[44]', snrBack: '[46]',
      transportMechanism: TX_LORA, timestamp: 5,
    }, 3639506708);
    expect(obs).toEqual({
      sourceId: 'sandbox', localNodeNum: 3639506708, neighborNodeNum: 944633591, transportClass: 'rf',
      direct: true, snrOutDb: 11, snrBackDb: 11.5, timestamp: 5,
    });
  });

  it('both orientations of one run give the same link and the same SNR directions', () => {
    const arrays = {
      route: JSON.stringify([HOP_A, HOP_B]), snrTowards: '[20, 8, -12]',
      routeBack: JSON.stringify([HOP_C, HOP_A]), snrBack: '[4, -8, 28]',
    };
    const replyInserted = confirmedLinkFromTraceroute(row(arrays), US);
    const pendingUpdated = confirmedLinkFromTraceroute(sent(arrays), US);
    expect(pendingUpdated).toEqual(replyInserted);
    // snrTowards[0]: the neighbour hearing us. Last snrBack: us hearing it.
    expect(pendingUpdated).toMatchObject({ neighborNodeNum: HOP_A, snrOutDb: 5, snrBackDb: 7, direct: false });
  });

  it('the mismatch rule holds in the pending-row orientation too', () => {
    expect(confirmedLinkFromTraceroute(sent({
      route: JSON.stringify([HOP_A]), snrTowards: '[0, -54]',
      routeBack: JSON.stringify([HOP_B]), snrBack: '[-48, 0]',
    }), US)).toBeNull();
  });

  it('our own outgoing reply to someone else\'s traceroute confirms nothing', () => {
    // Recorded as { from: us (responder), to: requester } before any relay
    // filled in the return leg: route data, but no return path.
    expect(confirmedLinkFromTraceroute(sent({ snrTowards: '[20]', routeBack: '[]', snrBack: '[]' }), US)).toBeNull();
    expect(confirmedLinkFromTraceroute(sent({
      route: JSON.stringify([HOP_A]), snrTowards: '[20, 8]', routeBack: '[]', snrBack: '[]',
    }), US)).toBeNull();
  });

  it('a pending row (sent, no reply yet) confirms nothing', () => {
    expect(confirmedLinkFromTraceroute(sent({ route: null, routeBack: null, snrTowards: null, snrBack: null }), US)).toBeNull();
  });

  it('a row our radio is not an endpoint of confirms nothing', () => {
    expect(confirmedLinkFromTraceroute(row({ toNodeNum: HOP_B }), US)).toBeNull();
    expect(confirmedLinkFromTraceroute(sent({ fromNodeNum: HOP_B }), US)).toBeNull();
    expect(confirmedLinkFromTraceroute(row({ fromNodeNum: US, toNodeNum: US }), US)).toBeNull();
  });
});

describe('confirmedLinkFromTraceroute', () => {
  it('zero-hop run: the destination itself is the reciprocal neighbour, with the SNR each way', () => {
    // The issue's RF-direct pair: SKYB -> PARC (-8.25 dB), PARC -> SKYB (-11.25 dB).
    expect(confirmedLinkFromTraceroute(row(), US)).toEqual({
      sourceId: 'src-a', localNodeNum: US, neighborNodeNum: DEST, transportClass: 'rf',
      direct: true, snrOutDb: -8.25, snrBackDb: -11.25, timestamp: 1_000,
    });
  });

  it('multi-hop run through the same neighbour both ways confirms the link to that neighbour', () => {
    const obs = confirmedLinkFromTraceroute(row({
      route: JSON.stringify([HOP_A, HOP_B]),
      snrTowards: '[20, 8, -12]',     // at A, at B, at DEST
      routeBack: JSON.stringify([HOP_C, HOP_A]),
      snrBack: '[4, -8, 28]',          // at C, at A, at US
    }), US);
    expect(obs).toMatchObject({ neighborNodeNum: HOP_A, direct: false, snrOutDb: 5, snrBackDb: 7 });
  });

  it('out through one neighbour and back through another confirms nothing', () => {
    // The issue's MQTT pair: out via PTBZ, back via SKYC.
    expect(confirmedLinkFromTraceroute(row({
      route: JSON.stringify([HOP_A]), snrTowards: '[0, -54]',
      routeBack: JSON.stringify([HOP_B]), snrBack: '[-48, 0]',
    }), US)).toBeNull();
  });

  it('direct out but relayed back (or the reverse) confirms nothing', () => {
    expect(confirmedLinkFromTraceroute(row({ routeBack: JSON.stringify([HOP_A]), snrBack: '[4, 8]' }), US)).toBeNull();
    expect(confirmedLinkFromTraceroute(row({ route: JSON.stringify([HOP_A]), snrTowards: '[4, 8]' }), US)).toBeNull();
  });

  it('a run with no recorded return path is not completed', () => {
    expect(confirmedLinkFromTraceroute(row({ routeBack: '[]', snrBack: '[]' }), US)).toBeNull();
    expect(confirmedLinkFromTraceroute(row({ routeBack: null, snrBack: null }), US)).toBeNull();
    expect(confirmedLinkFromTraceroute(row({ routeBack: '', snrBack: 'null' }), US)).toBeNull();
  });

  it('a pending run with no outbound route data is not completed', () => {
    expect(confirmedLinkFromTraceroute(row({ route: null }), US)).toBeNull();
    expect(confirmedLinkFromTraceroute(row({ route: 'null' }), US)).toBeNull();
  });

  it('a placeholder first hop (a relay that never named itself) confirms nothing', () => {
    expect(confirmedLinkFromTraceroute(row({
      route: '[4294967295]', snrTowards: '[4, 8]', routeBack: '[4294967295]', snrBack: '[4, 8]',
    }), US)).toBeNull();
  });

  it('coerces BIGINT node numbers handed back as strings', () => {
    const obs = confirmedLinkFromTraceroute(row({ fromNodeNum: String(DEST), toNodeNum: String(US) }), US);
    expect(obs).toMatchObject({ neighborNodeNum: DEST, localNodeNum: US });
  });

  it('missing SNR samples read as null, not zero', () => {
    const obs = confirmedLinkFromTraceroute(row({ snrTowards: null, routeBack: JSON.stringify([]), snrBack: '[12]' }), US);
    expect(obs).toMatchObject({ snrOutDb: null, snrBackDb: 3, transportClass: 'rf' });
  });

  describe('transport class', () => {
    it("uses the record's own mechanism", () => {
      expect(confirmedLinkFromTraceroute(row({ transportMechanism: TX_MQTT }), US)?.transportClass).toBe('mqtt');
      expect(confirmedLinkFromTraceroute(row({ transportMechanism: TX_MULTICAST_UDP }), US)?.transportClass).toBe('udp');
    });

    it('a pre-migration row (no mechanism) reads as RF', () => {
      expect(confirmedLinkFromTraceroute(row({ transportMechanism: null }), US)?.transportClass).toBe('rf');
    });

    it('the unknown-SNR sentinel on either hop makes it MQTT, and that SNR is null', () => {
      const out = confirmedLinkFromTraceroute(row({ snrTowards: `[${SENTINEL}]` }), US);
      expect(out).toMatchObject({ transportClass: 'mqtt', snrOutDb: null, snrBackDb: -11.25 });
      const back = confirmedLinkFromTraceroute(row({ snrBack: `[${SENTINEL}]` }), US);
      expect(back).toMatchObject({ transportClass: 'mqtt', snrOutDb: -8.25, snrBackDb: null });
    });

    it('a sentinel on a hop further out does not change our link', () => {
      const obs = confirmedLinkFromTraceroute(row({
        route: JSON.stringify([HOP_A]), snrTowards: `[20, ${SENTINEL}]`,
        routeBack: JSON.stringify([HOP_A]), snrBack: `[${SENTINEL}, 24]`,
      }), US);
      expect(obs).toMatchObject({ transportClass: 'rf', snrOutDb: 5, snrBackDb: 6 });
    });
  });
});

describe('aggregateConfirmedLinks / buildConfirmedLinks', () => {
  const locals = new Map([['src-a', US]]);

  it('folds repeat runs into one link: count, direct count, SNR averages, newest time', () => {
    const [a] = buildConfirmedLinks([
      row({ snrTowards: '[-32]', snrBack: '[-40]', timestamp: 10 }),
      row({ snrTowards: '[-16]', snrBack: '[-48]', timestamp: 30 }),
      row({ snrTowards: null, snrBack: '[-44]', timestamp: 20 }),
    ], locals);
    expect(a).toMatchObject({
      sourceId: 'src-a', localNodeNum: US, neighborNodeNum: DEST, transportClass: 'rf',
      count: 3, directCount: 3, snrOutSamples: 2, snrBackSamples: 3, lastConfirmedAt: 30,
    });
    expect(a.snrOutAvg).toBe(-6);
    expect(a.snrBackAvg).toBe(-11);
  });

  it('keeps transport classes apart: the same link over RF and over MQTT is two rows', () => {
    const links = buildConfirmedLinks([
      row({ transportMechanism: TX_LORA }),
      row({ transportMechanism: TX_LORA }),
      row({ transportMechanism: TX_MQTT }),
      row({ transportMechanism: TX_MULTICAST_UDP }),
    ], locals);
    expect(links.map((l) => [l.transportClass, l.count]).sort()).toEqual([['mqtt', 1], ['rf', 2], ['udp', 1]]);
  });

  it('counts both stored orientations of the same link together', () => {
    const [a, ...rest] = buildConfirmedLinks([row({ timestamp: 1 }), sent({ timestamp: 2 })], locals);
    expect(rest).toEqual([]);
    expect(a).toMatchObject({ neighborNodeNum: DEST, count: 2, directCount: 2, lastConfirmedAt: 2 });
  });

  it('keeps neighbours and sources apart', () => {
    const both = new Map([['src-a', US], ['src-b', US]]);
    const links = buildConfirmedLinks([
      row(),
      row({ route: JSON.stringify([HOP_A]), snrTowards: '[4, 8]', routeBack: JSON.stringify([HOP_A]), snrBack: '[4, 8]' }),
      row({ sourceId: 'src-b' }),
    ], both);
    expect(links).toHaveLength(3);
    expect(links.find((l) => l.neighborNodeNum === HOP_A)).toMatchObject({ directCount: 0, count: 1 });
  });

  it('skips a source with no local radio (MQTT, never connected)', () => {
    expect(buildConfirmedLinks([row({ sourceId: 'mqtt-1' })], locals)).toEqual([]);
  });

  it('an average with no samples is null', () => {
    const [a] = aggregateConfirmedLinks([{
      sourceId: 's', localNodeNum: 1, neighborNodeNum: 2, transportClass: 'rf',
      direct: true, snrOutDb: null, snrBackDb: null, timestamp: 5,
    }]);
    expect(a.snrOutAvg).toBeNull();
    expect(a.snrBackAvg).toBeNull();
    expect(a).not.toHaveProperty('outSum');
  });
});
