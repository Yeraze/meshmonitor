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

describe('MqttPacketFilter.resetCounters', () => {
  it('zeroes all drop counters', () => {
    const f = new MqttPacketFilter({ topics: { block: ['x'] } });
    f.preFilter('x', env({}));
    expect(f.getDropCounters().topic).toBe(1);
    f.resetCounters();
    expect(f.getDropCounters()).toEqual({ topic: 0, channel: 0, node: 0, portnum: 0, geo: 0 });
  });
});
