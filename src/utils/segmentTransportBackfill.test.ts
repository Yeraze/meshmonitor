/**
 * Tests for the pure migration-171 backfill logic (#5101): matching a stored
 * `route_segments` record holder back to the traceroute that produced it,
 * and deciding which of several now-colliding record holders survives.
 */
import { describe, it, expect } from 'vitest';
import {
  matchSegmentTransport,
  recordHolderIdsToDemote,
  RECLASSIFY_WINDOW_MS,
  type BackfillTraceroute,
  type RecordHolderRow,
} from './segmentTransportBackfill';
import { TX_LORA, TX_MQTT, TX_MULTICAST_UDP } from './nodeTransport';

const T = 1_800_000_000_000;
const REQUESTER = 100;
const RESPONDER = 200;

function makeTraceroute(overrides: Partial<BackfillTraceroute> = {}): BackfillTraceroute {
  return {
    fromNodeNum: REQUESTER,
    toNodeNum: RESPONDER,
    timestamp: T,
    route: '[10,20]',
    routeBack: null,
    snrTowards: '[40,60,80]',
    snrBack: null,
    transportMechanism: TX_LORA,
    ...overrides,
  };
}

describe('matchSegmentTransport', () => {
  it('direct-insert row (from = responder): matches on the forward list, record mechanism passes through', () => {
    const tr = makeTraceroute();
    const result = matchSegmentTransport(
      { fromNodeNum: RESPONDER, toNodeNum: 10, timestamp: T },
      [tr],
    );
    expect(result).toEqual({ matched: true, transportMechanism: TX_LORA, tracerouteTimestamp: T });
  });

  it('direct-insert row with a sentinel on that hop stores MQTT (5)', () => {
    const tr = makeTraceroute({ snrTowards: '[-128,60,80]' });
    const result = matchSegmentTransport(
      { fromNodeNum: RESPONDER, toNodeNum: 10, timestamp: T },
      [tr],
    );
    expect(result).toEqual({ matched: true, transportMechanism: TX_MQTT, tracerouteTimestamp: T });
  });

  it('pending-updated row (endpoints swapped) is found via the forward-prime list', () => {
    const tr = makeTraceroute();
    const result = matchSegmentTransport(
      { fromNodeNum: REQUESTER, toNodeNum: 10, timestamp: T },
      [tr],
    );
    expect(result).toEqual({ matched: true, transportMechanism: TX_LORA, tracerouteTimestamp: T });
  });

  it('a pair present only on the return leg uses snrBack[i]', () => {
    const tr = makeTraceroute({
      routeBack: '[30]',
      snrBack: '[70,-128]',
      transportMechanism: TX_MULTICAST_UDP,
    });
    // return list = [fromNodeNum, ...routeBack, toNodeNum] = [100, 30, 200]
    const result = matchSegmentTransport(
      { fromNodeNum: 30, toNodeNum: RESPONDER, timestamp: T },
      [tr],
    );
    expect(result).toEqual({ matched: true, transportMechanism: TX_MQTT, tracerouteTimestamp: T });
  });

  it('an endpoint pair (requester -> first hop, last hop -> responder) matches', () => {
    const tr = makeTraceroute();
    const first = matchSegmentTransport(
      { fromNodeNum: REQUESTER, toNodeNum: 10, timestamp: T },
      [tr],
    );
    expect(first.matched).toBe(true);

    const last = matchSegmentTransport(
      { fromNodeNum: 20, toNodeNum: RESPONDER, timestamp: T },
      [tr],
    );
    expect(last.matched).toBe(true);
  });

  it('a pre-#5097 row (NULL mechanism) with a sentinel hop still yields MQTT', () => {
    const tr = makeTraceroute({ transportMechanism: null, snrTowards: '[-128,60,80]' });
    const result = matchSegmentTransport(
      { fromNodeNum: RESPONDER, toNodeNum: 10, timestamp: T },
      [tr],
    );
    expect(result).toEqual({ matched: true, transportMechanism: TX_MQTT, tracerouteTimestamp: T });
  });

  it('a pre-#5097 row (NULL mechanism) with no sentinel matches but stays NULL (reads RF)', () => {
    const tr = makeTraceroute({ transportMechanism: null });
    const result = matchSegmentTransport(
      { fromNodeNum: RESPONDER, toNodeNum: 10, timestamp: T },
      [tr],
    );
    expect(result).toEqual({ matched: true, transportMechanism: null, tracerouteTimestamp: T });
  });

  it('ignores a candidate newer than the segment', () => {
    const tr = makeTraceroute({ timestamp: T + 1 });
    const result = matchSegmentTransport(
      { fromNodeNum: RESPONDER, toNodeNum: 10, timestamp: T },
      [tr],
    );
    expect(result).toEqual({ matched: false });
  });

  it('ignores a candidate older than the reclassify window', () => {
    const tr = makeTraceroute({ timestamp: T - RECLASSIFY_WINDOW_MS - 1 });
    const result = matchSegmentTransport(
      { fromNodeNum: RESPONDER, toNodeNum: 10, timestamp: T },
      [tr],
    );
    expect(result).toEqual({ matched: false });
  });

  it('picks the nearest (latest <=) candidate when two both match', () => {
    const older = makeTraceroute({ timestamp: T - 5 * 60 * 1000, transportMechanism: TX_MULTICAST_UDP });
    const nearest = makeTraceroute({ timestamp: T, transportMechanism: TX_LORA });
    const result = matchSegmentTransport(
      { fromNodeNum: RESPONDER, toNodeNum: 10, timestamp: T },
      [older, nearest],
    );
    expect(result).toEqual({ matched: true, transportMechanism: TX_LORA, tracerouteTimestamp: T });
  });

  it('returns { matched: false } when the pair is absent from every list', () => {
    const tr = makeTraceroute();
    const result = matchSegmentTransport(
      { fromNodeNum: 999, toNodeNum: 888, timestamp: T },
      [tr],
    );
    expect(result).toEqual({ matched: false });
  });

  it('tolerates malformed JSON without throwing, and does not match', () => {
    const malformed: BackfillTraceroute[] = [
      makeTraceroute({ route: '[1,2', snrTowards: '{}' }),
      makeTraceroute({ route: 'null', routeBack: 'null' }),
      makeTraceroute({ route: '{}' }),
      makeTraceroute({ route: null, routeBack: null, snrTowards: null, snrBack: null }),
    ];
    expect(() => matchSegmentTransport(
      { fromNodeNum: REQUESTER, toNodeNum: 10, timestamp: T },
      malformed,
    )).not.toThrow();
    const result = matchSegmentTransport(
      { fromNodeNum: REQUESTER, toNodeNum: 10, timestamp: T },
      malformed,
    );
    expect(result).toEqual({ matched: false });
  });

  it('keeps SNR index alignment across a raw placeholder hop (0xFFFFFFFF) in an MQTT route', () => {
    const PLACEHOLDER = 0xffffffff;
    const tr = makeTraceroute({ route: `[${PLACEHOLDER},20]`, snrTowards: '[10,-128,30]' });
    // forward list = [toNodeNum(200), PLACEHOLDER, 20, fromNodeNum(100)]
    // pair (PLACEHOLDER -> 20) is index 1 -> snrTowards[1] = -128 (sentinel)
    const result = matchSegmentTransport(
      { fromNodeNum: PLACEHOLDER, toNodeNum: 20, timestamp: T },
      [tr],
    );
    expect(result).toEqual({ matched: true, transportMechanism: TX_MQTT, tracerouteTimestamp: T });
  });
});

describe('recordHolderIdsToDemote', () => {
  function row(overrides: Partial<RecordHolderRow>): RecordHolderRow {
    return {
      id: 1,
      sourceId: 's1',
      distanceKm: 10,
      timestamp: T,
      transportMechanism: TX_LORA,
      ...overrides,
    };
  }

  it('one row per group -> nothing to demote', () => {
    const rows = [
      row({ id: 1, transportMechanism: TX_LORA }),
      row({ id: 2, transportMechanism: TX_MQTT }),
    ];
    expect(recordHolderIdsToDemote(rows)).toEqual([]);
  });

  it('two RF rows in one source: demotes the shorter', () => {
    const rows = [
      row({ id: 1, distanceKm: 10, timestamp: 100 }),
      row({ id: 2, distanceKm: 20, timestamp: 200 }),
    ];
    expect(recordHolderIdsToDemote(rows)).toEqual([1]);
  });

  it('RF + MQTT in one source: nothing to demote (different classes)', () => {
    const rows = [
      row({ id: 1, distanceKm: 10, transportMechanism: TX_LORA }),
      row({ id: 2, distanceKm: 20, transportMechanism: TX_MQTT }),
    ];
    expect(recordHolderIdsToDemote(rows)).toEqual([]);
  });

  it('same class across two sources: nothing to demote (scoped per source)', () => {
    const rows = [
      row({ id: 1, sourceId: 's1', distanceKm: 10 }),
      row({ id: 2, sourceId: 's2', distanceKm: 20 }),
    ];
    expect(recordHolderIdsToDemote(rows)).toEqual([]);
  });

  it('NULL-source rows group together', () => {
    const rows = [
      row({ id: 1, sourceId: null, distanceKm: 10, timestamp: 100 }),
      row({ id: 2, sourceId: null, distanceKm: 5, timestamp: 200 }),
    ];
    expect(recordHolderIdsToDemote(rows)).toEqual([2]);
  });

  it('distance tie: keeps the newer, demotes the older', () => {
    const rows = [
      row({ id: 1, distanceKm: 10, timestamp: 100 }),
      row({ id: 2, distanceKm: 10, timestamp: 200 }),
    ];
    expect(recordHolderIdsToDemote(rows)).toEqual([1]);
  });
});
