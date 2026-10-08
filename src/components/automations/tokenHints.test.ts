import { describe, it, expect } from 'vitest';
import { validTokenSet, classifyToken, tokenize, diagnoseTokens } from './tokenHints';
import { TRIGGER_TOKENS } from './SubstitutionsHelp';
import { numericFields, stringFields } from './catalog';

describe('validTokenSet', () => {
  it('includes NOW, the trigger tokens, universals, and known vars', () => {
    const set = validTokenSet('trigger.message', ['threshold']);
    expect(set.has('NOW')).toBe(true);
    expect(set.has('trigger.from')).toBe(true);      // message token
    expect(set.has('trigger.timestamp')).toBe(true); // universal
    expect(set.has('var.threshold')).toBe(true);
    expect(set.has('trigger.asfd')).toBe(false);
  });
  it('includes node.* on subject-node triggers (becameMobile / leftHome / …)', () => {
    const set = validTokenSet('trigger.becameMobile', []);
    expect(set.has('node.longName')).toBe(true);
    expect(set.has('node.nodeId')).toBe(true);
    expect(set.has('node.shortName')).toBe(true);
    expect(set.has('trigger.nodeNum')).toBe(true);
  });
  it('omits node.* on schedule / system (no subject node)', () => {
    expect(validTokenSet('trigger.schedule', []).has('node.longName')).toBe(false);
    expect(validTokenSet('trigger.system', []).has('node.longName')).toBe(false);
  });
});

describe('classifyToken', () => {
  it('ok for current-trigger tokens, known vars, and NOW', () => {
    const valid = validTokenSet('trigger.message', ['flag']);
    expect(classifyToken('trigger.from', valid)).toBe('ok');
    expect(classifyToken('var.flag', valid)).toBe('ok');
    expect(classifyToken('NOW', valid)).toBe('ok');
  });
  it('ok for {{ trigger.hopEmoji }} on trigger.message (#4340)', () => {
    const valid = validTokenSet('trigger.message', []);
    expect(classifyToken('trigger.hopEmoji', valid)).toBe('ok');
  });
  it('ok for {{ node.longName }} on becameMobile', () => {
    const valid = validTokenSet('trigger.becameMobile', []);
    expect(classifyToken('node.longName', valid)).toBe('ok');
  });
  it('foreign for a real token that belongs to a DIFFERENT trigger', () => {
    const sys = validTokenSet('trigger.system', []);
    // trigger.from is a message token — valid somewhere, but not for system
    expect(classifyToken('trigger.from', sys)).toBe('foreign');
    expect(classifyToken('node.longName', sys)).toBe('foreign');
  });
  it('bad for genuine typos and unknown var names', () => {
    const valid = validTokenSet('trigger.message', ['flag']);
    expect(classifyToken('trigger.asfd', valid)).toBe('bad');
    expect(classifyToken('var.nope', valid)).toBe('bad');
    expect(classifyToken('node.notAThing', valid)).toBe('bad');
  });
});

describe('diagnoseTokens', () => {
  it('gives a type-specific message per problematic token, in order, deduped', () => {
    const sys = validTokenSet('trigger.system', ['known']);
    const text = 'Hi {{ trigger.from }} {{ trigger.asfd }} {{ var.asfd }} {{ trigger.event }} {{ NOW }} {{ foo }} {{ node.longName }} {{ node.nope }}';
    expect(diagnoseTokens(text, sys)).toEqual([
      { token: 'trigger.from', severity: 'warn', detail: 'is undefined for this trigger' },
      { token: 'trigger.asfd', severity: 'error', detail: 'is not a recognized trigger field' },
      { token: 'var.asfd', severity: 'error', detail: 'does not exist' },
      // trigger.event (system token) and NOW are valid → omitted
      { token: 'foo', severity: 'error', detail: 'is not a recognized token' },
      { token: 'node.longName', severity: 'warn', detail: 'needs a subject-node trigger' },
      { token: 'node.nope', severity: 'error', detail: 'is not a recognized node field' },
    ]);
  });
  it('returns nothing when all tokens are valid for the trigger', () => {
    const msg = validTokenSet('trigger.message', ['flag']);
    expect(diagnoseTokens('{{ trigger.from }} {{ var.flag }} {{ NOW }} {{ node.longName }}', msg)).toEqual([]);
  });
  it('ignores empty tokens and de-dups repeats', () => {
    const msg = validTokenSet('trigger.message', []);
    expect(diagnoseTokens('{{ var.x }} {{ var.x }} {{  }}', msg)).toEqual([
      { token: 'var.x', severity: 'error', detail: 'does not exist' },
    ]);
  });
});

describe('tokenize', () => {
  it('tags each token segment with its status', () => {
    const sys = validTokenSet('trigger.system', []);
    const segs = tokenize('a {{ trigger.event }} {{ trigger.from }} {{ trigger.asfd }}', sys);
    const tokenSegs = segs.filter((s) => s.token);
    expect(tokenSegs.map((s) => s.status)).toEqual(['ok', 'foreign', 'bad']);
  });
});

describe('node trigger packet tokens (#5534)', () => {
  it('offers packetId and packetHash on both node triggers', () => {
    for (const t of ['trigger.nodeUpdated', 'trigger.nodeDiscovered']) {
      const set = validTokenSet(t, []);
      expect(set.has('trigger.packetId')).toBe(true);
      expect(set.has('trigger.packetHash')).toBe(true);
    }
  });
});

describe('MeshCore node trigger tokens (#5595)', () => {
  const NODE_TRIGGERS = ['trigger.nodeUpdated', 'trigger.nodeDiscovered'];

  it('offers roleName, hops, routeHops and lastHeard on both node triggers', () => {
    for (const t of NODE_TRIGGERS) {
      const set = validTokenSet(t, []);
      for (const k of ['roleName', 'hops', 'routeHops', 'lastHeard', 'name', 'publicKey']) {
        expect(set.has(`trigger.${k}`)).toBe(true);
        expect(classifyToken(`trigger.${k}`, set)).toBe('ok');
      }
    }
  });

  it('has no trigger.shortName: MeshCore has no short name, so it reads as a typo', () => {
    for (const t of NODE_TRIGGERS) {
      const set = validTokenSet(t, []);
      expect(set.has('trigger.shortName')).toBe(false);
      expect(classifyToken('trigger.shortName', set)).toBe('bad');
    }
  });

  it('the help text says MeshCore has no short name, and tells hops from routeHops', () => {
    for (const t of NODE_TRIGGERS) {
      const help = Object.fromEntries(TRIGGER_TOKENS[t]);
      expect(help.name).toMatch(/no short name/i);
      expect(help.hops).toMatch(/advert/i);
      expect(help.routeHops).toMatch(/not the same as hops/i);
      expect(help.lastHeard).toMatch(/epoch ms/i);
      expect(help.roleName).toMatch(/Companion, Repeater, Room Server or Sensor/);
    }
  });

  it('offers ageMinutes on both node triggers, and says it is minutes (#5675)', () => {
    for (const t of NODE_TRIGGERS) {
      const set = validTokenSet(t, []);
      expect(set.has('trigger.ageMinutes')).toBe(true);
      expect(classifyToken('trigger.ageMinutes', set)).toBe('ok');
      const help = Object.fromEntries(TRIGGER_TOKENS[t]);
      expect(help.ageMinutes).toMatch(/whole minutes/i);
      expect(help.ageMinutes).toMatch(/node\.ageMinutes/);
      // lastHeard keeps its meaning.
      expect(help.lastHeard).toMatch(/epoch ms/i);
      const numeric = numericFields(t).flatMap((g) => g.options.map((o) => o.value));
      expect(numeric).toContain('ageMinutes');
    }
  });

  it('flags trigger.ageMinutes on triggers that do not carry it (#5675)', () => {
    for (const t of ['trigger.message', 'trigger.telemetry', 'trigger.nodeOnline', 'trigger.schedule']) {
      const set = validTokenSet(t, []);
      expect(set.has('trigger.ageMinutes')).toBe(false);
      expect(classifyToken('trigger.ageMinutes', set)).not.toBe('ok');
    }
    // Node silent already had its own ageMinutes; that is untouched.
    expect(validTokenSet('trigger.nodeStale', []).has('trigger.ageMinutes')).toBe(true);
  });

  it('offers the MeshCore facts as condition fields on both node triggers', () => {
    for (const t of NODE_TRIGGERS) {
      const numeric = numericFields(t).flatMap((g) => g.options.map((o) => o.value));
      const strings = stringFields(t).flatMap((g) => g.options.map((o) => o.value));
      expect(numeric).toEqual(expect.arrayContaining(['nodeNum', 'hops', 'routeHops']));
      expect(strings).toEqual(expect.arrayContaining(['roleName', 'name']));
    }
  });
});
