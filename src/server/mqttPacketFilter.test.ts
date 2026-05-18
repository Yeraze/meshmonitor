import { describe, it, expect } from 'vitest';
import {
  MqttPacketFilter,
  mqttPatternToRegExp,
  nodeNumToId,
  normalizeNodeId,
  PortNum,
  type ServiceEnvelopeShape,
} from './mqttPacketFilter.js';

function env(opts: {
  channelId?: string;
  from?: number;
  to?: number;
  portnum?: number;
}): ServiceEnvelopeShape {
  return {
    channelId: opts.channelId,
    packet: {
      from: opts.from,
      to: opts.to,
      decoded: opts.portnum !== undefined ? { portnum: opts.portnum } : undefined,
    },
  };
}

describe('mqttPatternToRegExp', () => {
  it('matches a literal topic', () => {
    const r = mqttPatternToRegExp('msh/US/2/e/LongFast/!abc');
    expect(r.test('msh/US/2/e/LongFast/!abc')).toBe(true);
    expect(r.test('msh/US/2/e/LongFast/!def')).toBe(false);
  });

  it('treats + as single-segment wildcard', () => {
    const r = mqttPatternToRegExp('msh/+/2/e/+/!abc');
    expect(r.test('msh/US/2/e/LongFast/!abc')).toBe(true);
    expect(r.test('msh/US/CA/2/e/LongFast/!abc')).toBe(false);
  });

  it('treats trailing # as multi-segment wildcard', () => {
    const r = mqttPatternToRegExp('msh/US/#');
    expect(r.test('msh/US/2/e/LongFast/!abc')).toBe(true);
    expect(r.test('msh/CA/2/e/LongFast/!abc')).toBe(false);
  });

  it('escapes regex metacharacters in the literal portion', () => {
    const r = mqttPatternToRegExp('msh.test/+/e');
    expect(r.test('msh.test/US/e')).toBe(true);
    expect(r.test('mshXtest/US/e')).toBe(false);
  });
});

describe('nodeNumToId / normalizeNodeId', () => {
  it('formats uint32 to !xxxxxxxx zero-padded lowercase hex', () => {
    expect(nodeNumToId(0x7ff80a48)).toBe('!7ff80a48');
    expect(nodeNumToId(0x00000001)).toBe('!00000001');
    expect(nodeNumToId(0xffffffff)).toBe('!ffffffff');
  });

  it('normalizes node id strings to !lowercase form', () => {
    expect(normalizeNodeId('!ABC123')).toBe('!abc123');
    expect(normalizeNodeId('abc123')).toBe('!abc123');
    expect(normalizeNodeId(' !DeadBeef ')).toBe('!deadbeef');
  });
});

describe('MqttPacketFilter.preFilter — topic', () => {
  it('passes when no topic filters configured', () => {
    const f = new MqttPacketFilter({});
    expect(f.preFilter('msh/US/2/e/LongFast/!abc', env({}))).toBe(true);
  });

  it('drops topic on block match and increments counter', () => {
    const f = new MqttPacketFilter({ topics: { block: ['msh/CA/QC/#'] } });
    expect(f.preFilter('msh/CA/QC/2/e/LongFast/!abc', env({}))).toBe(false);
    expect(f.getDropCounters().topic).toBe(1);
  });

  it('passes when topic is on allow list', () => {
    const f = new MqttPacketFilter({ topics: { allow: ['msh/US/#'] } });
    expect(f.preFilter('msh/US/2/e/LongFast/!abc', env({}))).toBe(true);
  });

  it('drops topic when allow list set and topic does not match', () => {
    const f = new MqttPacketFilter({ topics: { allow: ['msh/US/#'] } });
    expect(f.preFilter('msh/CA/2/e/LongFast/!abc', env({}))).toBe(false);
    expect(f.getDropCounters().topic).toBe(1);
  });

  it('block list takes precedence over allow list', () => {
    const f = new MqttPacketFilter({
      topics: { allow: ['msh/US/#'], block: ['msh/US/CA/#'] },
    });
    expect(f.preFilter('msh/US/CA/2/e/LongFast/!abc', env({}))).toBe(false);
    expect(f.preFilter('msh/US/NY/2/e/LongFast/!abc', env({}))).toBe(true);
  });
});

describe('MqttPacketFilter.preFilter — channel', () => {
  it('drops envelope channelId on block', () => {
    const f = new MqttPacketFilter({ channels: { block: ['Private'] } });
    expect(f.preFilter('any/topic', env({ channelId: 'Private' }))).toBe(false);
    expect(f.getDropCounters().channel).toBe(1);
  });

  it('drops when channel allow list set but envelope has no channelId', () => {
    const f = new MqttPacketFilter({ channels: { allow: ['LongFast'] } });
    expect(f.preFilter('any/topic', env({}))).toBe(false);
    expect(f.getDropCounters().channel).toBe(1);
  });
});

describe('MqttPacketFilter.preFilter — node', () => {
  it('drops when from is on block list', () => {
    const f = new MqttPacketFilter({ nodes: { block: ['!7ff80a48'] } });
    expect(f.preFilter('any/topic', env({ from: 0x7ff80a48, to: 0xffffffff }))).toBe(false);
    expect(f.getDropCounters().node).toBe(1);
  });

  it('drops when to is on block list', () => {
    const f = new MqttPacketFilter({ nodes: { block: ['!deadbeef'] } });
    expect(f.preFilter('any/topic', env({ from: 0x01010101, to: 0xdeadbeef }))).toBe(false);
  });

  it('passes when either from or to is on allow list', () => {
    const f = new MqttPacketFilter({ nodes: { allow: ['!7ff80a48'] } });
    expect(f.preFilter('any/topic', env({ from: 0x7ff80a48, to: 0xffffffff }))).toBe(true);
    expect(f.preFilter('any/topic', env({ from: 0x11111111, to: 0x7ff80a48 }))).toBe(true);
    expect(f.preFilter('any/topic', env({ from: 0x11111111, to: 0x22222222 }))).toBe(false);
  });

  it('normalizes node ids regardless of case or ! prefix in config', () => {
    const f = new MqttPacketFilter({ nodes: { block: ['7FF80A48'] } });
    expect(f.preFilter('any/topic', env({ from: 0x7ff80a48, to: 0 }))).toBe(false);
  });
});

describe('MqttPacketFilter.preFilter — portnum', () => {
  it('drops on portnum block list', () => {
    const f = new MqttPacketFilter({ portnums: { block: [PortNum.ADMIN_APP] } });
    expect(f.preFilter('any/topic', env({ portnum: PortNum.ADMIN_APP }))).toBe(false);
    expect(f.getDropCounters().portnum).toBe(1);
  });

  it('drops when allow list set and portnum not in list', () => {
    const f = new MqttPacketFilter({ portnums: { allow: [PortNum.POSITION_APP] } });
    expect(f.preFilter('any/topic', env({ portnum: PortNum.TEXT_MESSAGE_APP }))).toBe(false);
  });

  it('drops encrypted packets when portnum allow list is set', () => {
    const f = new MqttPacketFilter({ portnums: { allow: [PortNum.POSITION_APP] } });
    expect(f.preFilter('any/topic', env({}))).toBe(false);
    expect(f.getDropCounters().portnum).toBe(1);
  });

  it('passes encrypted packets when no portnum filter is set', () => {
    const f = new MqttPacketFilter({});
    expect(f.preFilter('any/topic', env({}))).toBe(true);
  });
});

describe('MqttPacketFilter.postFilterPosition — geo bbox', () => {
  it('passes when no bbox configured', () => {
    const f = new MqttPacketFilter({});
    expect(f.postFilterPosition({ latitudeI: 44_300_000, longitudeI: -78_300_000 })).toBe(true);
  });

  it('passes position inside the bbox', () => {
    const f = new MqttPacketFilter({
      geo: { minLat: 43, maxLat: 45, minLng: -80, maxLng: -77 },
    });
    expect(f.postFilterPosition({ latitudeI: 440_000_000, longitudeI: -780_000_000 })).toBe(true);
  });

  it('drops position south of minLat', () => {
    const f = new MqttPacketFilter({ geo: { minLat: 43, maxLat: 45 } });
    expect(f.postFilterPosition({ latitudeI: 420_000_000, longitudeI: 0 })).toBe(false);
    expect(f.getDropCounters().geo).toBe(1);
  });

  it('drops position north of maxLat', () => {
    const f = new MqttPacketFilter({ geo: { minLat: 43, maxLat: 45 } });
    expect(f.postFilterPosition({ latitudeI: 460_000_000, longitudeI: 0 })).toBe(false);
  });

  it('drops position west of minLng', () => {
    const f = new MqttPacketFilter({ geo: { minLng: -80, maxLng: -77 } });
    expect(f.postFilterPosition({ latitudeI: 0, longitudeI: -810_000_000 })).toBe(false);
  });

  it('drops position east of maxLng', () => {
    const f = new MqttPacketFilter({ geo: { minLng: -80, maxLng: -77 } });
    expect(f.postFilterPosition({ latitudeI: 0, longitudeI: -760_000_000 })).toBe(false);
  });

  it('accepts snake_case field names from raw protobuf decode', () => {
    const f = new MqttPacketFilter({ geo: { minLat: 43, maxLat: 45 } });
    expect(f.postFilterPosition({ latitude_i: 420_000_000, longitude_i: 0 })).toBe(false);
    // Sanity: snake_case inside the bbox still passes.
    expect(f.postFilterPosition({ latitude_i: 440_000_000, longitude_i: 0 })).toBe(true);
  });

  it('passes when position lacks lat/lon (cannot filter)', () => {
    const f = new MqttPacketFilter({ geo: { minLat: 43, maxLat: 45 } });
    expect(f.postFilterPosition({})).toBe(true);
  });
});

describe('MqttPacketFilter.passesMembership — fail-closed geo membership', () => {
  // Bbox approximately covering southern Ontario for these tests.
  const ON_BBOX = { minLat: 43, maxLat: 45, minLng: -80, maxLng: -77 };
  const NODE_IN = 0x7ff80a48;
  const NODE_OUT = 0x11111111;
  const NODE_UNKNOWN = 0x22222222;

  it('no-op (passes everything) when no bbox is configured', () => {
    const f = new MqttPacketFilter({});
    expect(f.passesMembership(NODE_UNKNOWN)).toBe(true);
    expect(f.passesMembership(null)).toBe(true);
    expect(f.passesMembership(undefined)).toBe(true);
    expect(f.getDropCounters().geo).toBe(0);
  });

  it('no-op when geo object exists but has no actual bounds set', () => {
    // {} is truthy but has no min/max — should behave like "no bbox".
    const f = new MqttPacketFilter({ geo: {} });
    expect(f.passesMembership(NODE_UNKNOWN)).toBe(true);
    expect(f.getDropCounters().geo).toBe(0);
  });

  it('drops unknown senders when bbox is enabled (fail-closed)', () => {
    const f = new MqttPacketFilter({ geo: ON_BBOX });
    expect(f.passesMembership(NODE_UNKNOWN)).toBe(false);
    expect(f.getDropCounters().geo).toBe(1);
  });

  it('drops when fromNum is missing entirely', () => {
    const f = new MqttPacketFilter({ geo: ON_BBOX });
    expect(f.passesMembership(null)).toBe(false);
    expect(f.passesMembership(undefined)).toBe(false);
    expect(f.getDropCounters().geo).toBe(2);
  });

  it('learns membership from a position inside the bbox', () => {
    const f = new MqttPacketFilter({ geo: ON_BBOX });
    // Toronto-ish — clearly inside.
    expect(
      f.postFilterPosition({ latitudeI: 437_000_000, longitudeI: -793_000_000 }, NODE_IN),
    ).toBe(true);
    // Subsequent non-position packets pass.
    expect(f.passesMembership(NODE_IN)).toBe(true);
    expect(f.getMembershipSize()).toBe(1);
  });

  it('learns and drops a sender whose position is outside the bbox', () => {
    const f = new MqttPacketFilter({ geo: ON_BBOX });
    // Vancouver — clearly outside.
    expect(
      f.postFilterPosition({ latitudeI: 492_000_000, longitudeI: -1_230_000_000 }, NODE_OUT),
    ).toBe(false);
    // Even though we now "know" this node, it's known-out → still drops.
    expect(f.passesMembership(NODE_OUT)).toBe(false);
    // Both the position itself AND the subsequent membership check increment geo.
    expect(f.getDropCounters().geo).toBe(2);
  });

  it('refreshes membership when a node moves across the boundary', () => {
    const f = new MqttPacketFilter({ geo: ON_BBOX });
    const NODE = 0x7ff80a48;

    // First seen inside.
    f.postFilterPosition({ latitudeI: 437_000_000, longitudeI: -793_000_000 }, NODE);
    expect(f.passesMembership(NODE)).toBe(true);

    // Then moves outside — membership should flip to 'out'.
    f.postFilterPosition({ latitudeI: 492_000_000, longitudeI: -1_230_000_000 }, NODE);
    expect(f.passesMembership(NODE)).toBe(false);

    // ...and back inside.
    f.postFilterPosition({ latitudeI: 437_000_000, longitudeI: -793_000_000 }, NODE);
    expect(f.passesMembership(NODE)).toBe(true);

    // Cache should still have a single entry for this node, not three.
    expect(f.getMembershipSize()).toBe(1);
  });

  it('does NOT record membership when fromNum is omitted', () => {
    const f = new MqttPacketFilter({ geo: ON_BBOX });
    // Position decode-only path (e.g. from older callers that didn't pass fromNum).
    f.postFilterPosition({ latitudeI: 437_000_000, longitudeI: -793_000_000 });
    expect(f.getMembershipSize()).toBe(0);
  });

  it('does NOT record membership when position lacks lat/lon', () => {
    const f = new MqttPacketFilter({ geo: ON_BBOX });
    // Position-shaped payload with no coords — can't decide.
    expect(f.postFilterPosition({}, NODE_IN)).toBe(true);
    // No coords were learned, so the node stays unknown → fail-closed drop.
    expect(f.passesMembership(NODE_IN)).toBe(false);
    expect(f.getMembershipSize()).toBe(0);
  });

  it('does NOT record membership when no bbox is set even if fromNum provided', () => {
    const f = new MqttPacketFilter({});
    f.postFilterPosition({ latitudeI: 437_000_000, longitudeI: -793_000_000 }, NODE_IN);
    // No bbox in use → membership cache should remain empty.
    expect(f.getMembershipSize()).toBe(0);
  });

  it('respects half-open bboxes (only one axis bounded)', () => {
    // Only minLat set: anything below latitude 43 is "out", everything else is "in".
    const f = new MqttPacketFilter({ geo: { minLat: 43 } });
    f.postFilterPosition({ latitudeI: 440_000_000, longitudeI: -793_000_000 }, NODE_IN); // 44.0 → in
    f.postFilterPosition({ latitudeI: 420_000_000, longitudeI: -793_000_000 }, NODE_OUT); // 42.0 → out
    expect(f.passesMembership(NODE_IN)).toBe(true);
    expect(f.passesMembership(NODE_OUT)).toBe(false);
  });

  it('different filter instances do not share membership state', () => {
    const a = new MqttPacketFilter({ geo: ON_BBOX });
    const b = new MqttPacketFilter({ geo: ON_BBOX });
    a.postFilterPosition({ latitudeI: 437_000_000, longitudeI: -793_000_000 }, NODE_IN);
    expect(a.passesMembership(NODE_IN)).toBe(true);
    // Filter b never saw the position → still drops.
    expect(b.passesMembership(NODE_IN)).toBe(false);
  });
});

describe('MqttPacketFilter.resetCounters', () => {
  it('zeroes all drop counters', () => {
    const f = new MqttPacketFilter({ topics: { block: ['x'] } });
    f.preFilter('x', env({}));
    expect(f.getDropCounters().topic).toBe(1);
    f.resetCounters();
    expect(f.getDropCounters()).toEqual({ topic: 0, channel: 0, node: 0, portnum: 0, geo: 0 });
  });
});
