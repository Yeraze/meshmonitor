/**
 * Two-observer clock agreement for MeshCore MQTT sources (#6341 P5, D6).
 *
 * An advert reaches us from several observers. Each one stamps its publish with
 * its own clock, so one observer alone cannot tell us whether the NODE or the
 * observer is wrong. When two distinct observers saw the same advert (same
 * `senderSec`) and both measure an offset of the same sign, the node is the
 * outlier. The smaller-magnitude offset is stored: |stored| > T exactly when
 * both observers exceed T, so every rule's own threshold composes unchanged.
 *
 * Pure: no I/O, no clock reads (the caller passes `nowMs`). The caller verifies
 * the signature once when `observe` answers `'verify'` and reports back through
 * `markVerified`, which yields the sample to store.
 */
import { LIVE_RECEPTION_WINDOW_SEC, MIN_PLAUSIBLE_UNIX_SEC } from '../utils/replayGuard.js';

export const MAX_CLOCK_NODES = 2000;
export const MAX_OBSERVERS_PER_NODE = 8;
export const CLOCK_ENTRY_TTL_MS = 10 * 60 * 1000;

export interface MqttClockSample {
  publicKey: string;
  senderSec: number;
  offsetSec: number;
  /** Envelope time of the observer whose offset was chosen, so `floor(ms/1000) - offset === senderSec`. */
  receivedAtMs: number;
}

export interface MqttClockObservation {
  publicKey: string;
  senderSec: number;
  originId: string;
  envelopeMs: number;
  nowMs: number;
}

interface Entry {
  senderSec: number;
  firstAt: number;
  byObserver: Map<string, { offsetSec: number; envelopeMs: number }>;
  /** `open`: collecting. `pending`: a verify is in flight. `done`: sampled or dead; nothing more from this advert. */
  state: 'open' | 'pending' | 'done';
}

export class MqttClockAgreement {
  private readonly entries = new Map<string, Entry>();

  /** Entries held (test hook for the bound). */
  get size(): number {
    return this.entries.size;
  }

  observe(input: MqttClockObservation): 'verify' | null {
    const { publicKey, senderSec, originId, nowMs } = input;
    if (!publicKey || !originId) return null;
    if (!Number.isFinite(senderSec) || senderSec < MIN_PLAUSIBLE_UNIX_SEC) return null;
    if (!Number.isFinite(input.envelopeMs)) return null;
    if (Math.abs(input.envelopeMs - nowMs) > LIVE_RECEPTION_WINDOW_SEC * 1000) return null;
    // An observer timing itself says nothing about its own clock's accuracy.
    if (publicKey.toLowerCase() === originId.toLowerCase()) return null;

    const envelopeMs = Math.min(input.envelopeMs, nowMs);
    const offsetSec = Math.floor(envelopeMs / 1000) - senderSec;
    const observer = originId.toLowerCase();

    let entry = this.entries.get(publicKey);
    if (entry && nowMs - entry.firstAt > CLOCK_ENTRY_TTL_MS) {
      this.entries.delete(publicKey);
      entry = undefined;
    }
    if (entry && senderSec < entry.senderSec) return null;
    if (!entry || senderSec > entry.senderSec) {
      this.evictFor(nowMs);
      entry = { senderSec, firstAt: nowMs, byObserver: new Map(), state: 'open' };
      this.entries.delete(publicKey);
      this.entries.set(publicKey, entry);
    }
    if (entry.state !== 'open') return null;
    if (entry.byObserver.has(observer)) return null;
    if (entry.byObserver.size >= MAX_OBSERVERS_PER_NODE) return null;
    entry.byObserver.set(observer, { offsetSec, envelopeMs });

    if (offsetSec === 0) return null;
    let agree = 0;
    for (const o of entry.byObserver.values()) if (Math.sign(o.offsetSec) === Math.sign(offsetSec)) agree++;
    if (agree < 2) return null;
    entry.state = 'pending';
    return 'verify';
  }

  /**
   * Report the signature check. Returns the sample to store, or null (failed
   * check, or no usable agreement). Either way this advert is finished.
   */
  markVerified(publicKey: string, senderSec: number, ok: boolean): MqttClockSample | null {
    const entry = this.entries.get(publicKey);
    if (!entry || entry.senderSec !== senderSec || entry.state !== 'pending') return null;
    entry.state = 'done';
    if (!ok) return null;
    // The sign shared by the most observers; ties go to the smaller magnitude.
    const pos: Array<{ offsetSec: number; envelopeMs: number }> = [];
    const neg: typeof pos = [];
    for (const o of entry.byObserver.values()) {
      if (o.offsetSec > 0) pos.push(o);
      else if (o.offsetSec < 0) neg.push(o);
    }
    const group = pos.length >= neg.length ? pos : neg;
    if (group.length < 2) return null;
    let best = group[0];
    for (const o of group) if (Math.abs(o.offsetSec) < Math.abs(best.offsetSec)) best = o;
    return { publicKey, senderSec, offsetSec: best.offsetSec, receivedAtMs: best.envelopeMs };
  }

  private evictFor(nowMs: number): void {
    if (this.entries.size < MAX_CLOCK_NODES) return;
    for (const [k, e] of this.entries) {
      if (nowMs - e.firstAt > CLOCK_ENTRY_TTL_MS) this.entries.delete(k);
    }
    while (this.entries.size >= MAX_CLOCK_NODES) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }
}
