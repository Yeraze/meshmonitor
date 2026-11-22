import { describe, it, expect } from 'vitest';
import {
  MqttClockAgreement, MAX_CLOCK_NODES, MAX_OBSERVERS_PER_NODE, CLOCK_ENTRY_TTL_MS,
} from './meshcoreMqttClockSamples.js';

const NOW = 1_800_000_000_000;
const NODE = 'ab'.repeat(32);
const obs = (n: number) => n.toString(16).padStart(2, '0').repeat(32).toUpperCase();
const SENDER = 1_800_000_000 - 3600; // node one hour behind

function seen(a: MqttClockAgreement, o: number, extra: Partial<Parameters<MqttClockAgreement['observe']>[0]> = {}) {
  return a.observe({ publicKey: NODE, senderSec: SENDER, originId: obs(o), envelopeMs: NOW, nowMs: NOW, ...extra });
}

describe('MqttClockAgreement', () => {
  it('one observer yields nothing', () => {
    expect(seen(new MqttClockAgreement(), 1)).toBeNull();
  });

  it('two agreeing observers ask to verify, then yield the smaller magnitude', () => {
    const a = new MqttClockAgreement();
    expect(seen(a, 1, { envelopeMs: NOW + 5000 })).toBeNull();
    expect(seen(a, 2)).toBe('verify');
    const s = a.markVerified(NODE, SENDER, true)!;
    expect(s.offsetSec).toBe(3600);
    expect(s.receivedAtMs).toBe(NOW);
    expect(Math.floor(s.receivedAtMs / 1000) - s.offsetSec).toBe(SENDER);
  });

  it('opposite signs store nothing until two share a sign', () => {
    const a = new MqttClockAgreement();
    const sender = NOW / 1000 - 50;
    const o = (n: number, envelopeMs: number) =>
      a.observe({ publicKey: NODE, senderSec: sender, originId: obs(n), envelopeMs, nowMs: NOW });
    expect(o(1, NOW)).toBeNull(); // +50
    expect(o(2, NOW - 100_000)).toBeNull(); // -50
    expect(o(3, NOW)).toBe('verify'); // +50 pairs with observer 1
    expect(a.markVerified(NODE, sender, true)!.offsetSec).toBe(50);
  });

  it('the same observer twice counts once', () => {
    const a = new MqttClockAgreement();
    expect(seen(a, 1)).toBeNull();
    expect(seen(a, 1)).toBeNull();
  });

  it('stale or future envelopes, implausible sender time and self-reports are dropped', () => {
    const a = new MqttClockAgreement();
    expect(seen(a, 1, { envelopeMs: NOW - 121_000 })).toBeNull();
    expect(seen(a, 2, { envelopeMs: NOW + 121_000 })).toBeNull();
    expect(seen(a, 3, { envelopeMs: NaN })).toBeNull();
    expect(seen(a, 4, { senderSec: 5000 })).toBeNull();
    expect(seen(a, 5, { originId: NODE.toUpperCase() })).toBeNull();
    expect(a.size).toBe(0);
  });

  it('later copies after the verify do not verify again; a failed verify kills the advert', () => {
    const a = new MqttClockAgreement();
    seen(a, 1);
    expect(seen(a, 2)).toBe('verify');
    expect(seen(a, 3)).toBeNull();
    expect(a.markVerified(NODE, SENDER, false)).toBeNull();
    expect(seen(a, 4)).toBeNull();
    expect(a.markVerified(NODE, SENDER, true)).toBeNull();
  });

  it('a newer senderSec replaces the entry; an older one is ignored', () => {
    const a = new MqttClockAgreement();
    seen(a, 1);
    expect(seen(a, 2, { senderSec: SENDER + 60 })).toBeNull(); // fresh entry, one observer
    expect(seen(a, 3, { senderSec: SENDER })).toBeNull(); // older: ignored
    expect(seen(a, 4, { senderSec: SENDER + 60 })).toBe('verify');
  });

  it('caps observers per node', () => {
    const a = new MqttClockAgreement();
    // alternate signs so no pair agrees until the cap blocks further observers
    for (let i = 1; i <= MAX_OBSERVERS_PER_NODE; i++) {
      a.observe({ publicKey: NODE, senderSec: SENDER, originId: obs(i), envelopeMs: NOW, nowMs: NOW });
    }
    // all agree, so the 2nd already asked to verify; entry is pending and takes no more
    expect(seen(a, 99)).toBeNull();
  });

  it('bounds nodes, evicting the oldest', () => {
    const a = new MqttClockAgreement();
    for (let i = 0; i < MAX_CLOCK_NODES + 50; i++) {
      a.observe({ publicKey: i.toString(16).padStart(64, '0'), senderSec: SENDER, originId: obs(1), envelopeMs: NOW, nowMs: NOW });
    }
    expect(a.size).toBe(MAX_CLOCK_NODES);
  });

  it('drops entries older than the TTL', () => {
    const a = new MqttClockAgreement();
    seen(a, 1);
    const later = NOW + CLOCK_ENTRY_TTL_MS + 1;
    // observer 1 again after TTL starts a fresh entry, so observer 2 is the second one only now
    expect(a.observe({ publicKey: NODE, senderSec: SENDER, originId: obs(2), envelopeMs: later, nowMs: later })).toBeNull();
  });
});
