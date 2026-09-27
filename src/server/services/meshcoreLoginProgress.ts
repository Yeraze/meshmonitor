/**
 * In-flight MeshCore login tracking (#5400).
 *
 * A remote login now waits max(estTimeout × 2, 10 s) per attempt and retries
 * up to three times on silence, so one click can take 30 s or more. The login
 * POST still answers with the final outcome, but while it is open the UI
 * polls this registry (GET /admin/login-progress/:requestId) to show
 * "attempt 2 of 3, waiting up to 12 s", and can cancel it
 * (POST /admin/login-cancel).
 *
 * The client picks the `requestId` and sends it with the login POST. Entries
 * are bound to the user and source that started them: nobody else can read
 * or cancel them. They hold no password or key material, only counters.
 *
 * In-memory by design: a login cannot outlive the process, so neither can
 * its progress.
 */

import type { MeshCoreLoginProgressEvent, MeshCoreLoginRetryOutcome } from '../meshcoreManager.js';

/** How long a finished entry stays readable, so a final poll still sees it. */
export const LOGIN_PROGRESS_RETAIN_MS = 60_000;

/** Upper bound on tracked logins, so a buggy or hostile client cannot grow it without limit. */
export const LOGIN_PROGRESS_MAX_ENTRIES = 500;

/** Client-chosen id: UUID-like, no path or query metacharacters. */
const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

export function isValidLoginRequestId(value: unknown): value is string {
  return typeof value === 'string' && REQUEST_ID_PATTERN.test(value);
}

export type LoginProgressPhase = 'starting' | 'sending' | 'waiting' | 'retrying' | 'done';

/** What the progress endpoint returns. */
export interface LoginProgressSnapshot {
  requestId: string;
  phase: LoginProgressPhase;
  attempt: number;
  maxAttempts: number;
  /** Length of the current wait (reply wait or retry pause), when known. */
  waitMs: number | null;
  /** Time left in the current wait, computed server-side (no clock skew). */
  waitRemainingMs: number | null;
  cancelRequested: boolean;
  outcome: MeshCoreLoginRetryOutcome | null;
}

interface Entry {
  requestId: string;
  userId: number;
  sourceId: string;
  phase: LoginProgressPhase;
  attempt: number;
  maxAttempts: number;
  waitMs: number | null;
  waitStartedAt: number | null;
  outcome: MeshCoreLoginRetryOutcome | null;
  controller: AbortController;
  expiry: ReturnType<typeof setTimeout> | null;
}

export interface LoginProgressHandle {
  signal: AbortSignal;
  onProgress: (event: MeshCoreLoginProgressEvent) => void;
  finish: (outcome: MeshCoreLoginRetryOutcome) => void;
}

export class MeshCoreLoginProgressRegistry {
  private readonly entries = new Map<string, Entry>();
  private readonly now: () => number;

  constructor(opts: { now?: () => number } = {}) {
    this.now = opts.now ?? Date.now;
  }

  /**
   * Start tracking a login. Returns null when `requestId` is already in use
   * (the caller answers 409) or the registry is full of live logins.
   */
  start(requestId: string, userId: number, sourceId: string, maxAttempts: number): LoginProgressHandle | null {
    if (this.entries.has(requestId)) return null;
    if (this.entries.size >= LOGIN_PROGRESS_MAX_ENTRIES && !this.evictOneFinished()) return null;

    const entry: Entry = {
      requestId,
      userId,
      sourceId,
      phase: 'starting',
      attempt: 0,
      maxAttempts,
      waitMs: null,
      waitStartedAt: null,
      outcome: null,
      controller: new AbortController(),
      expiry: null,
    };
    this.entries.set(requestId, entry);

    return {
      signal: entry.controller.signal,
      onProgress: (event) => {
        if (entry.phase === 'done') return;
        entry.phase = event.phase;
        entry.attempt = event.attempt;
        entry.maxAttempts = event.maxAttempts;
        if (event.phase === 'waiting') {
          entry.waitMs = event.waitMs;
          entry.waitStartedAt = this.now();
        } else if (event.phase === 'retrying') {
          entry.waitMs = event.pauseMs;
          entry.waitStartedAt = this.now();
        } else {
          entry.waitMs = null;
          entry.waitStartedAt = null;
        }
      },
      finish: (outcome) => {
        if (entry.phase === 'done') return;
        entry.phase = 'done';
        entry.outcome = outcome;
        entry.waitMs = null;
        entry.waitStartedAt = null;
        entry.expiry = setTimeout(() => {
          if (this.entries.get(requestId) === entry) this.entries.delete(requestId);
        }, LOGIN_PROGRESS_RETAIN_MS);
        entry.expiry.unref?.();
      },
    };
  }

  /** Snapshot for its owner, or null (unknown id, other user, other source). */
  get(requestId: string, userId: number, sourceId: string): LoginProgressSnapshot | null {
    const entry = this.ownedEntry(requestId, userId, sourceId);
    if (!entry) return null;
    let waitRemainingMs: number | null = null;
    if (entry.waitMs !== null && entry.waitStartedAt !== null) {
      waitRemainingMs = Math.max(0, entry.waitMs - (this.now() - entry.waitStartedAt));
    }
    return {
      requestId: entry.requestId,
      phase: entry.phase,
      attempt: entry.attempt,
      maxAttempts: entry.maxAttempts,
      waitMs: entry.waitMs,
      waitRemainingMs,
      cancelRequested: entry.controller.signal.aborted,
      outcome: entry.outcome,
    };
  }

  /**
   * Ask a login to stop. True when the caller owns a login with that id
   * (already finished counts: cancelling is then a harmless no-op).
   */
  cancel(requestId: string, userId: number, sourceId: string): boolean {
    const entry = this.ownedEntry(requestId, userId, sourceId);
    if (!entry) return false;
    if (entry.phase !== 'done') entry.controller.abort();
    return true;
  }

  /** Test hook: forget everything and stop expiry timers. */
  clear(): void {
    for (const entry of this.entries.values()) {
      if (entry.expiry) clearTimeout(entry.expiry);
    }
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }

  private ownedEntry(requestId: string, userId: number, sourceId: string): Entry | null {
    const entry = this.entries.get(requestId);
    if (!entry || entry.userId !== userId || entry.sourceId !== sourceId) return null;
    return entry;
  }

  private evictOneFinished(): boolean {
    for (const [id, entry] of this.entries) {
      if (entry.phase === 'done') {
        if (entry.expiry) clearTimeout(entry.expiry);
        this.entries.delete(id);
        return true;
      }
    }
    return false;
  }
}

let singleton: MeshCoreLoginProgressRegistry | null = null;

export function getMeshCoreLoginProgressRegistry(): MeshCoreLoginProgressRegistry {
  if (!singleton) singleton = new MeshCoreLoginProgressRegistry();
  return singleton;
}
