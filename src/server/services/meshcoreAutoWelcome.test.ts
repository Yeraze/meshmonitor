/**
 * MeshCore Auto Welcome (#6224) — the decision and helpers. The safety rules
 * (greet once, hop gate, hourly cap, wait-for-name) live in the pure
 * `decideAutoWelcome`, so they are unit-tested here without a device.
 */
import { describe, it, expect } from 'vitest';
import {
  decideAutoWelcome,
  renderWelcomeMessage,
  welcomeHopCount,
  sendsInLastHour,
  contactDisplayName,
  clampMaxHops,
  clampDelaySeconds,
  clampMaxPerHour,
  type AutoWelcomeSettings,
  type AutoWelcomeContact,
} from './meshcoreAutoWelcome.js';

const NOW = 1_700_000_000_000;

const settings = (over: Partial<AutoWelcomeSettings> = {}): AutoWelcomeSettings => ({
  enabled: true,
  message: 'Welcome {NAME}!',
  target: 'dm',
  waitForName: true,
  maxHops: 3,
  delaySeconds: 30,
  maxPerHour: 6,
  ...over,
});

const contact = (over: Partial<AutoWelcomeContact> = {}): AutoWelcomeContact => ({
  publicKey: 'ABCDEF',
  advName: 'Repeater One',
  pathLen: 2,
  ...over,
});

describe('renderWelcomeMessage', () => {
  it('replaces {NAME} (any case) with the display name', () => {
    expect(renderWelcomeMessage('Hi {NAME}, hello {name}', contact({ advName: 'Zed' }))).toBe('Hi Zed, hello Zed');
  });
  it('falls back to "neighbor" when the contact is nameless', () => {
    expect(renderWelcomeMessage('Hi {NAME}', contact({ advName: '', name: '' }))).toBe('Hi neighbor');
  });
});

describe('welcomeHopCount', () => {
  it('returns null for no cached path', () => {
    expect(welcomeHopCount(null)).toBeNull();
    expect(welcomeHopCount(undefined)).toBeNull();
  });
  it('maps the 0xff direct sentinel to 0 hops', () => {
    expect(welcomeHopCount(0xff)).toBe(0);
  });
  it('passes a small hop count through and masks a packed byte', () => {
    expect(welcomeHopCount(3)).toBe(3);
    expect(welcomeHopCount(0x42)).toBe(2); // top 2 bits are hash width, low 6 = hops
  });
});

describe('sendsInLastHour', () => {
  it('keeps only timestamps within the trailing hour', () => {
    const times = [NOW - 10_000, NOW - 3_500_000, NOW - 7_200_000];
    expect(sendsInLastHour(times, NOW)).toEqual([NOW - 10_000, NOW - 3_500_000]);
  });
});

describe('contactDisplayName', () => {
  it('prefers advName, treats "" as nameless', () => {
    expect(contactDisplayName(contact({ advName: 'A', name: 'B' }))).toBe('A');
    expect(contactDisplayName(contact({ advName: '', name: 'B' }))).toBe('B');
    expect(contactDisplayName(contact({ advName: '', name: '' }))).toBeNull();
  });
});

describe('decideAutoWelcome', () => {
  const base = { alreadyWelcomed: false, recentSendTimes: [] as number[], now: NOW };

  it('sends a rendered DM for a fresh near node', () => {
    const d = decideAutoWelcome({ ...base, settings: settings(), contact: contact({ advName: 'Nina' }) });
    expect(d).toEqual({ action: 'send', text: 'Welcome Nina!', target: 'dm' });
  });

  it('sends to a channel when target is a channel index', () => {
    const d = decideAutoWelcome({ ...base, settings: settings({ target: '2' }), contact: contact() });
    expect(d).toMatchObject({ action: 'send', target: 'channel', channelIdx: 2 });
  });

  it('skips when disabled', () => {
    expect(decideAutoWelcome({ ...base, settings: settings({ enabled: false }), contact: contact() }))
      .toEqual({ action: 'skip', reason: 'disabled' });
  });

  it('skips a node already welcomed', () => {
    expect(decideAutoWelcome({ ...base, alreadyWelcomed: true, settings: settings(), contact: contact() }))
      .toEqual({ action: 'skip', reason: 'already_welcomed' });
  });

  it('waits for a name when wait-for-name is on', () => {
    expect(decideAutoWelcome({ ...base, settings: settings(), contact: contact({ advName: '', name: '' }) }))
      .toEqual({ action: 'skip', reason: 'waiting_for_name' });
  });

  it('greets a nameless node when wait-for-name is off', () => {
    const d = decideAutoWelcome({ ...base, settings: settings({ waitForName: false }), contact: contact({ advName: '', name: '' }) });
    expect(d).toMatchObject({ action: 'send', text: 'Welcome neighbor!' });
  });

  it('skips a node past the hop limit', () => {
    expect(decideAutoWelcome({ ...base, settings: settings({ maxHops: 2 }), contact: contact({ pathLen: 5 }) }))
      .toEqual({ action: 'skip', reason: 'too_far' });
  });

  it('greets a node with no known path (unknown hops pass the gate)', () => {
    const d = decideAutoWelcome({ ...base, settings: settings({ maxHops: 2 }), contact: contact({ pathLen: null }) });
    expect(d.action).toBe('send');
  });

  it('drops a welcome once the hourly cap is reached', () => {
    const recentSendTimes = Array.from({ length: 6 }, (_, i) => NOW - i * 60_000);
    expect(decideAutoWelcome({ ...base, recentSendTimes, settings: settings({ maxPerHour: 6 }), contact: contact() }))
      .toEqual({ action: 'skip', reason: 'rate_capped' });
  });

  it('does not count sends older than an hour against the cap', () => {
    const recentSendTimes = Array.from({ length: 6 }, () => NOW - 4_000_000); // all > 1h old
    const d = decideAutoWelcome({ ...base, recentSendTimes, settings: settings({ maxPerHour: 6 }), contact: contact() });
    expect(d.action).toBe('send');
  });
});

describe('clamps', () => {
  it('maxHops: default on garbage, 0..7 range', () => {
    expect(clampMaxHops('abc')).toBe(3);
    expect(clampMaxHops('99')).toBe(7);
    expect(clampMaxHops('-1')).toBe(0);
  });
  it('delay: default on garbage, 0..600 range', () => {
    expect(clampDelaySeconds(null)).toBe(30);
    expect(clampDelaySeconds('9999')).toBe(600);
  });
  it('maxPerHour: default on garbage, 1..60 range', () => {
    expect(clampMaxPerHour('')).toBe(6);
    expect(clampMaxPerHour('0')).toBe(1);
    expect(clampMaxPerHour('999')).toBe(60);
  });
});
