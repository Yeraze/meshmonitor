import { describe, it, expect } from 'vitest';
import { MqttPacketFilter, mqttPatternToRegExp } from './mqttPacketFilter.js';

describe('mqttPatternToRegExp', () => {
  it('matches literal topics', () => {
    const rx = mqttPatternToRegExp('msh/US/2/e/LongFast');
    expect(rx.test('msh/US/2/e/LongFast')).toBe(true);
    expect(rx.test('msh/US/2/e/LongFast/extra')).toBe(false);
  });

  it('treats + as single-level wildcard', () => {
    const rx = mqttPatternToRegExp('msh/+/2/e/+');
    expect(rx.test('msh/US/2/e/LongFast')).toBe(true);
    expect(rx.test('msh/EU/2/e/MediumFast')).toBe(true);
    expect(rx.test('msh/US/2/e/LongFast/x')).toBe(false);
    expect(rx.test('msh/US/3/e/LongFast')).toBe(false);
  });

  it('treats # as multi-level tail wildcard', () => {
    const rx = mqttPatternToRegExp('msh/US/#');
    expect(rx.test('msh/US/2/e/LongFast/!abc')).toBe(true);
    expect(rx.test('msh/US')).toBe(false); // # requires at least the / before it
    expect(rx.test('msh/EU/foo')).toBe(false);
  });

  it('escapes regex metacharacters in literal segments', () => {
    const rx = mqttPatternToRegExp('foo.bar/baz');
    expect(rx.test('foo.bar/baz')).toBe(true);
    expect(rx.test('fooxbar/baz')).toBe(false);
  });
});

describe('MqttPacketFilter — topic filters', () => {
  it('passes everything when no filters set', () => {
    const f = new MqttPacketFilter();
    expect(f.preFilter('any/topic', { packet: { from: 1, to: 2 } })).toBe(true);
  });

  it('blocks topics that match block patterns', () => {
    const f = new MqttPacketFilter({ topics: { block: ['msh/US/2/c/#'] } });
    expect(f.preFilter('msh/US/2/c/Admin', {})).toBe(false);
    expect(f.preFilter('msh/US/2/e/Public', {})).toBe(true);
    expect(f.getDropCounters().topic).toBe(1);
  });

  it('with allow patterns set, drops anything not matching any allow', () => {
    const f = new MqttPacketFilter({ topics: { allow: ['msh/US/2/e/LongFast/#'] } });
    expect(f.preFilter('msh/US/2/e/LongFast/!abc', {})).toBe(true);
    expect(f.preFilter('msh/EU/2/e/Public/!abc', {})).toBe(false);
    expect(f.getDropCounters().topic).toBe(1);
  });

  it('block wins over allow', () => {
    const f = new MqttPacketFilter({
      topics: { allow: ['msh/US/#'], block: ['msh/US/2/c/#'] },
    });
    expect(f.preFilter('msh/US/2/e/foo', {})).toBe(true);
    expect(f.preFilter('msh/US/2/c/Admin', {})).toBe(false);
  });
});

describe('MqttPacketFilter — channel filters', () => {
  it('respects allow list on channelId', () => {
    const f = new MqttPacketFilter({ channels: { allow: ['LongFast'] } });
    expect(f.preFilter('t', { channelId: 'LongFast' })).toBe(true);
    expect(f.preFilter('t', { channelId: 'MediumFast' })).toBe(false);
    expect(f.preFilter('t', {})).toBe(false); // no channel + allow-list → drop
  });

  it('respects block list on channelId', () => {
    const f = new MqttPacketFilter({ channels: { block: ['Spam'] } });
    expect(f.preFilter('t', { channelId: 'Spam' })).toBe(false);
    expect(f.preFilter('t', { channelId: 'LongFast' })).toBe(true);
  });
});

describe('MqttPacketFilter — node filters', () => {
  it('blocks packets from blocked node IDs', () => {
    const f = new MqttPacketFilter({ nodes: { block: ['!deadbeef'] } });
    const from = 0xdeadbeef;
    expect(f.preFilter('t', { packet: { from, to: 1 } })).toBe(false);
  });

  it('blocks packets TO blocked node IDs', () => {
    const f = new MqttPacketFilter({ nodes: { block: ['!cafebabe'] } });
    expect(f.preFilter('t', { packet: { from: 1, to: 0xcafebabe } })).toBe(false);
  });

  it('with allow list, accepts only when from OR to is allowed', () => {
    const f = new MqttPacketFilter({ nodes: { allow: ['!deadbeef'] } });
    expect(f.preFilter('t', { packet: { from: 0xdeadbeef, to: 1 } })).toBe(true);
    expect(f.preFilter('t', { packet: { from: 1, to: 0xdeadbeef } })).toBe(true);
    expect(f.preFilter('t', { packet: { from: 1, to: 2 } })).toBe(false);
  });

  it('normalizes node ids regardless of case or leading !', () => {
    const f = new MqttPacketFilter({ nodes: { block: ['DEADBEEF', '!CAFEBABE'] } });
    expect(f.preFilter('t', { packet: { from: 0xdeadbeef } })).toBe(false);
    expect(f.preFilter('t', { packet: { from: 0xcafebabe } })).toBe(false);
  });
});

describe('MqttPacketFilter — portnum filters', () => {
  it('blocks specific portnums', () => {
    const f = new MqttPacketFilter({ portnums: { block: [5 /* ROUTING_APP */] } });
    expect(f.preFilter('t', { packet: { decoded: { portnum: 5 } } })).toBe(false);
    expect(f.preFilter('t', { packet: { decoded: { portnum: 1 } } })).toBe(true);
  });

  it('with allow list, drops everything else including encrypted', () => {
    const f = new MqttPacketFilter({ portnums: { allow: [1, 3, 67] } });
    expect(f.preFilter('t', { packet: { decoded: { portnum: 1 } } })).toBe(true);
    expect(f.preFilter('t', { packet: { decoded: { portnum: 67 } } })).toBe(true);
    expect(f.preFilter('t', { packet: { decoded: { portnum: 70 } } })).toBe(false);
    expect(f.preFilter('t', { packet: {} })).toBe(false); // no portnum + allow-list
  });
});

describe('MqttPacketFilter — geo bounding box', () => {
  it('passes when no geo filter is set', () => {
    const f = new MqttPacketFilter();
    expect(f.postFilterPosition({ latitudeI: 400000000, longitudeI: -700000000 })).toBe(true);
  });

  it('drops positions outside the box', () => {
    const f = new MqttPacketFilter({
      geo: { minLat: 30, maxLat: 40, minLng: -125, maxLng: -100 },
    });
    // 45N is north of max
    expect(f.postFilterPosition({ latitudeI: 450000000, longitudeI: -1100000000 })).toBe(false);
    // -80W is east of max
    expect(f.postFilterPosition({ latitudeI: 350000000, longitudeI: -800000000 })).toBe(false);
    // Inside
    expect(f.postFilterPosition({ latitudeI: 350000000, longitudeI: -1100000000 })).toBe(true);
  });

  it('uses snake_case position fields too', () => {
    const f = new MqttPacketFilter({ geo: { minLat: 30, maxLat: 40 } });
    expect(f.postFilterPosition({ latitude_i: 350000000, longitude_i: -1100000000 })).toBe(true);
  });

  it('passes when geo set but packet has no position fields', () => {
    const f = new MqttPacketFilter({ geo: { minLat: 30 } });
    expect(f.postFilterPosition({})).toBe(true);
    expect(f.postFilterPosition(null)).toBe(true);
  });
});

describe('MqttPacketFilter — throughput', () => {
  it('filters 10k envelopes in under 250ms', () => {
    const f = new MqttPacketFilter({
      topics: { allow: ['msh/US/2/e/+/+'] },
      channels: { allow: ['LongFast'] },
      portnums: { allow: [1, 3, 67] },
    });
    const start = process.hrtime.bigint();
    for (let i = 0; i < 10_000; i++) {
      const topic = i % 3 === 0 ? 'msh/US/2/e/LongFast/!a' : 'msh/EU/2/e/X/!a';
      const envelope = {
        channelId: i % 2 === 0 ? 'LongFast' : 'MediumFast',
        packet: { from: i, to: 0xffffffff, decoded: { portnum: i % 4 === 0 ? 1 : 5 } },
      };
      f.preFilter(topic, envelope);
    }
    const elapsedMs = Number(process.hrtime.bigint() - start) / 1_000_000;
    expect(elapsedMs).toBeLessThan(250);
  });
});
