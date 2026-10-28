import { describe, it, expect, vi } from 'vitest';
import { preferConfiguredDefault, applyDefaultMeshtasticSource } from './defaultMeshtasticSource.js';

const rows = [
  { id: 'old', type: 'meshcore', enabled: true },
  { id: 'a', type: 'meshtastic_tcp', enabled: true },
  { id: 'b', type: 'meshtastic_tcp', enabled: true },
  { id: 'off', type: 'meshtastic_tcp', enabled: false },
  { id: 'mq', type: 'mqtt_broker', enabled: true },
];

describe('preferConfiguredDefault (#5245)', () => {
  it('moves the chosen enabled TCP source to the front, keeping the rest in order', () => {
    expect(preferConfiguredDefault(rows, 'b').map((r) => r.id)).toEqual(['b', 'old', 'a', 'off', 'mq']);
  });

  it('leaves the order alone when unset, missing, disabled or not TCP', () => {
    for (const id of [null, undefined, '', 'gone', 'off', 'mq']) {
      expect(preferConfiguredDefault(rows, id)).toBe(rows);
    }
  });

  it('leaves the order alone when the choice is already first', () => {
    const list = rows.slice(1);
    expect(preferConfiguredDefault(list, 'a')).toBe(list);
  });
});

describe('applyDefaultMeshtasticSource (#5245)', () => {
  it('passes a trimmed id, and null for blank', () => {
    const registry = { setPreferredMeshtasticSource: vi.fn() };
    applyDefaultMeshtasticSource(registry, ' b ');
    applyDefaultMeshtasticSource(registry, '  ');
    applyDefaultMeshtasticSource(registry, null);
    expect(registry.setPreferredMeshtasticSource.mock.calls).toEqual([['b'], [null], [null]]);
  });
});
