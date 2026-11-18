/**
 * Manual-action queue for the shared per-source mesh-TX floor (#6493).
 *
 * A user click (poll status, time sync, neighbours fetch) used to get a 429
 * whenever a scheduler had stamped the 60 s floor first. This queue lets a
 * click wait for the next slot and take it ahead of the schedulers: while an
 * entry is queued, schedulers and auto-ping skip their tick
 * (`isHeld()`), and they claim through `tryClaim()` so a claim and a
 * reservation can never both win.
 *
 * Mesh safety:
 *  - A queued entry ends in at most one send (a grant). Supersede, timeout,
 *    abort and `unavailable` never stamp the floor.
 *  - The floor check and its stamp run in one synchronous tick, so two
 *    grants are always at least `floorMs` apart, even with concurrent waiters.
 *  - The queue lives in memory on purpose: the floor itself is unchanged.
 */

import { abortableSleep, MESH_TX_FLOOR_MS } from './meshcoreNeighboursPaging.js';

export type ManualMeshAction = 'telemetry' | 'neighbours' | 'time-sync' | string;

export interface ManualMeshTxHost {
  getLastMeshTxAt(): number;
  recordMeshTx(when?: number): void;
}

export interface ManualMeshTxOptions {
  floorMs?: number;
  /** A waiter that has not heartbeat for this long is treated as leaked. */
  ttlMs?: number;
  maxWaitMs?: number;
  maxDepth?: number;
  now?: () => number;
  /** Abortable sleep; resolves false when aborted. Injected by tests. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<boolean>;
}

export interface ManualMeshTxRequest {
  ownerKey: string;
  requestId?: string;
  action: ManualMeshAction;
  publicKey?: string;
  signal: AbortSignal;
  /** Checked in the same tick as the claim; false gives `unavailable`. */
  beforeClaim?: () => boolean;
}

export interface ManualMeshTxRef {
  action: ManualMeshAction;
  publicKey?: string;
  requestId?: string;
}

export type ManualMeshTxResult =
  | { kind: 'granted'; grantedAt: number; waitedMs: number }
  | { kind: 'superseded'; by: ManualMeshTxRef }
  | { kind: 'aborted' }
  | { kind: 'unavailable' }
  | { kind: 'timeout' | 'full'; retryAfterSecs: number };

export interface ManualMeshTxStatus {
  position: number;
  depth: number;
  startsInSecs: number;
  action: ManualMeshAction;
  publicKey?: string;
}

interface Entry {
  ownerKey: string;
  requestId?: string;
  action: ManualMeshAction;
  publicKey?: string;
  waitStartedAt: number;
  heartbeatAt: number;
  ctrl: AbortController;
  /** Set when a newer request from the same owner replaced this one. */
  supersededBy?: ManualMeshTxRef;
}

const MIN_SLEEP_MS = 250;
const MAX_SLEEP_MS = 5000;

export class ManualMeshTxQueue {
  private readonly floorMs: number;
  private readonly ttlMs: number;
  private readonly maxWaitMs: number;
  private readonly maxDepth: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<boolean>;
  /** FIFO; index 0 is the head. */
  private entries: Entry[] = [];

  constructor(
    private readonly host: ManualMeshTxHost,
    opts: ManualMeshTxOptions = {},
  ) {
    this.floorMs = opts.floorMs ?? MESH_TX_FLOOR_MS;
    this.ttlMs = opts.ttlMs ?? 90_000;
    this.maxWaitMs = opts.maxWaitMs ?? 180_000;
    this.maxDepth = opts.maxDepth ?? 5;
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? abortableSleep;
  }

  /** True while any live manual request waits. Prunes leaked entries first. */
  isHeld(): boolean {
    this.prune();
    return this.entries.length > 0;
  }

  /**
   * Atomic claim for schedulers and pager pages 2+. Refuses while a
   * reservation is held or the floor is closed; otherwise stamps the floor.
   */
  tryClaim(now: number = this.now(), floorMs: number = this.floorMs): boolean {
    this.prune();
    if (this.entries.length > 0) return false;
    if (this.floorRemaining(now, floorMs) > 0) return false;
    this.host.recordMeshTx(now);
    return true;
  }

  status(ownerKey: string, requestId: string): ManualMeshTxStatus | null {
    this.prune();
    const idx = this.entries.findIndex((e) => e.ownerKey === ownerKey && e.requestId === requestId);
    if (idx < 0) return null;
    const e = this.entries[idx];
    const remaining = this.floorRemaining(this.now(), this.floorMs);
    return {
      position: idx + 1,
      depth: this.entries.length,
      startsInSecs: Math.ceil(Math.max(0, remaining) / 1000) + Math.round((idx * this.floorMs) / 1000),
      action: e.action,
      ...(e.publicKey !== undefined ? { publicKey: e.publicKey } : {}),
    };
  }

  async waitForSlot(o: ManualMeshTxRequest): Promise<ManualMeshTxResult> {
    const startedAt = this.now();
    if (o.signal.aborted) return { kind: 'aborted' };
    this.prune();

    // Fast path: nothing queued and the floor is open.
    if (this.entries.length === 0 && this.floorRemaining(startedAt, this.floorMs) <= 0) {
      if (o.beforeClaim && !o.beforeClaim()) return { kind: 'unavailable' };
      this.host.recordMeshTx(startedAt);
      return { kind: 'granted', grantedAt: startedAt, waitedMs: 0 };
    }

    const entry: Entry = {
      ownerKey: o.ownerKey,
      requestId: o.requestId,
      action: o.action,
      publicKey: o.publicKey,
      waitStartedAt: startedAt,
      heartbeatAt: startedAt,
      ctrl: new AbortController(),
    };

    const existing = this.entries.findIndex((e) => e.ownerKey === o.ownerKey);
    if (existing >= 0) {
      // Same owner: take over the position; the old waiter ends superseded.
      const old = this.entries[existing];
      old.supersededBy = { action: o.action, publicKey: o.publicKey, requestId: o.requestId };
      this.entries[existing] = entry;
      old.ctrl.abort();
    } else if (this.entries.length >= this.maxDepth) {
      return { kind: 'full', retryAfterSecs: this.retryAfterSecs(startedAt) };
    } else {
      this.entries.push(entry);
    }

    const combined = AbortSignal.any([o.signal, entry.ctrl.signal]);
    try {
      for (;;) {
        if (o.signal.aborted) return { kind: 'aborted' };
        if (entry.ctrl.signal.aborted) {
          return entry.supersededBy ? { kind: 'superseded', by: entry.supersededBy } : { kind: 'aborted' };
        }
        const t = this.now();
        entry.heartbeatAt = t;

        this.prune();

        const remaining = this.floorRemaining(t, this.floorMs);
        if (this.entries[0] === entry && remaining <= 0) {
          // Check and stamp in one synchronous tick.
          if (o.beforeClaim && !o.beforeClaim()) return { kind: 'unavailable' };
          this.host.recordMeshTx(t);
          return { kind: 'granted', grantedAt: t, waitedMs: t - entry.waitStartedAt };
        }

        if (t - entry.waitStartedAt > this.maxWaitMs) {
          return { kind: 'timeout', retryAfterSecs: this.retryAfterSecs(t) };
        }

        const ms = Math.min(MAX_SLEEP_MS, Math.max(MIN_SLEEP_MS, remaining));
        await this.sleep(ms, combined);
      }
    } finally {
      // Remove only our own entry: a replacement may hold the slot now.
      const i = this.entries.indexOf(entry);
      if (i >= 0) this.entries.splice(i, 1);
    }
  }

  private floorRemaining(now: number, floorMs: number): number {
    const last = this.host.getLastMeshTxAt();
    return last > 0 ? floorMs - (now - last) : 0;
  }

  private retryAfterSecs(now: number): number {
    const remaining = Math.max(0, this.floorRemaining(now, this.floorMs));
    return Math.max(1, Math.ceil(remaining / 1000) + Math.round((this.entries.length * this.floorMs) / 1000));
  }

  private prune(): void {
    const t = this.now();
    this.entries = this.entries.filter((e) => {
      if (t - e.heartbeatAt <= this.ttlMs) return true;
      // Leaked: let its waiter (if any) end as aborted.
      e.ctrl.abort();
      return false;
    });
  }
}
