/**
 * Per-source, in-memory bookkeeping for "new node" alerts (#6306, #6341).
 *
 * Protocol-neutral. The sets only dedupe within one process: whether a key is new
 * comes from the database (`inserted`), and the rate limit lives in the persisted
 * {@link newNodeAlertGate}, so a restart is safe.
 */
import { newNodeAlertGate, type NewNodeAlertGate } from './newNodeAlertGate.js';

/** Cap on each set: a forged-key stream must not grow them without bound. */
export const NEW_NODE_SET_MAX = 4096;

/** An insertion-ordered key set that drops its oldest key past `max`. */
export class BoundedKeySet {
  private readonly set = new Set<string>();

  constructor(private readonly max: number = NEW_NODE_SET_MAX) {}

  has(key: string): boolean {
    return this.set.has(key);
  }

  add(key: string): void {
    this.set.add(key);
    if (this.set.size > this.max) {
      const oldest = this.set.values().next().value;
      if (oldest !== undefined) this.set.delete(oldest);
    }
  }

  delete(key: string): void {
    this.set.delete(key);
  }

  clear(): void {
    this.set.clear();
  }

  keys(): string[] {
    return Array.from(this.set);
  }

  get size(): number {
    return this.set.size;
  }
}

export type AdmitGatedResult = { alert: false } | { alert: true; suppressedCount?: number };

export class NewNodeAlertTracker {
  /** Keys already alerted. */
  readonly notified = new BoundedKeySet();
  /** Keys first seen without a name; the alert waits for one (#5340). */
  readonly pending = new BoundedKeySet();
  private readonly inFlight = new Set<string>();

  constructor(private readonly gate: NewNodeAlertGate = newNodeAlertGate) {}

  /**
   * Synchronous claim: `(isNew || pending) && !notified && !inFlight`. A claim adds
   * the key to the in-flight set, so concurrent copies of one advert cannot each
   * pass the prefilter before `notified` is set. The caller runs {@link release}
   * in `finally`.
   */
  claim(key: string, isNew: boolean): boolean {
    if (!isNew && !this.pending.has(key)) return false;
    if (this.notified.has(key) || this.inFlight.has(key)) return false;
    this.inFlight.add(key);
    return true;
  }

  release(key: string): void {
    this.inFlight.delete(key);
  }

  /**
   * A nameless key parks in `pending` unless the gate is still learning (then the
   * node is part of what the window hides). Otherwise the gate decides; a drop
   * clears `pending`, so a dropped node never alerts later.
   */
  async admitGated(sourceId: string, key: string, named: boolean): Promise<AdmitGatedResult> {
    if (!named) {
      if (!(await this.gate.isLearning(sourceId))) this.pending.add(key);
      return { alert: false };
    }
    const verdict = await this.gate.admit(sourceId);
    if (!verdict.allow) {
      this.pending.delete(key);
      return { alert: false };
    }
    return verdict.suppressedSinceLast
      ? { alert: true, suppressedCount: verdict.suppressedSinceLast }
      : { alert: true };
  }
}
