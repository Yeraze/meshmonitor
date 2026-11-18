/**
 * meshTxQueueStore (#6493)
 *
 * Module-level store for manual MeshCore actions that take the next radio
 * slot. A manual POST (telemetry poll, time sync) now WAITS on the server when
 * the 60 s mesh-TX floor is closed and answers when the packet is sent. This
 * store owns the open POST, polls the queue position while it waits, and
 * keeps the terminal result, so a panel that unmounts (node switch) and
 * remounts still shows the outcome. It never resends: a rejected request
 * (429) only counts down and re-enables the button.
 *
 * Entries are keyed by source, then by slot (action + node + variant).
 * The queue owner on the server is per user per source, so one new action
 * replaces the one that is waiting; this store mirrors that.
 */

import { newLoginRequestId } from './useMeshCoreLoginProgress';

export type MeshTxAction = 'telemetry' | 'neighbours' | 'time-sync';

export type MeshTxPhase = 'idle' | 'starting' | 'queued' | 'sending' | 'cooldown' | 'superseded' | 'done' | 'error';

type Fetcher = (url: string, options?: RequestInit) => Promise<Response>;

/** The last server answer for a finished action. */
export interface MeshTxResult {
  ok: boolean;
  status: number;
  code?: string;
  /** The `data` object of a success body. */
  data?: Record<string, unknown>;
  /** Seconds the request waited for the slot (success only). */
  waitedSecs?: number;
  error?: string;
  txDisabled?: boolean;
  /** The server's full JSON body, for caller-specific error codes. */
  body?: Record<string, unknown>;
}

export interface MeshTxEntry {
  slot: string;
  sourceId: string;
  action: MeshTxAction;
  publicKey: string;
  variant: string;
  label: string;
  /** Display name of the node, when the panel knows it. */
  nodeLabel: string | null;
  requestId: string;
  phase: Exclude<MeshTxPhase, 'idle'>;
  /** 1-based place in the queue while `queued`. */
  position: number | null;
  /** Local countdown (queued ETA or cooldown), whole seconds. */
  secondsLeft: number | null;
  result: MeshTxResult | null;
  /** The earlier queued action this one replaced. */
  replaced: { action: MeshTxAction; label: string; publicKey: string; nodeLabel: string | null } | null;
  /** Set on a superseded entry: the action that replaced it, when known. */
  supersededBy: { action: MeshTxAction; publicKey: string | null } | null;
  /** Button label of the action the user clicked that replaced this one. */
  supersededByLabel: string | null;
}

export const MESH_TX_POLL_MS = 2000;
/** First GET waits so the server has enqueued the POST; an early 404 would read as granted. */
export const MESH_TX_FIRST_POLL_MS = 1000;
export const MESH_TX_TICK_MS = 1000;
/** How long "Replaced by your newer request" stays on the old button. */
export const MESH_TX_SUPERSEDED_SHOW_MS = 8000;
/** A finished result stays available to a remounting panel this long. */
export const MESH_TX_RESULT_KEEP_MS = 5 * 60 * 1000;

const QUEUE_CODES = new Set(['MESH_TX_QUEUE_TIMEOUT', 'MESH_TX_QUEUE_FULL', 'RATE_LIMITED']);

interface Live {
  deadline: number | null;
  pollTimer: ReturnType<typeof setTimeout> | null;
  tickTimer: ReturnType<typeof setInterval> | null;
  keepTimer: ReturnType<typeof setTimeout> | null;
  /** The POST is open. */
  open: boolean;
}

const entries = new Map<string, Map<string, MeshTxEntry>>(); // sourceId -> slot -> entry
const live = new Map<string, Live>(); // `${sourceId}|${slot}` -> timers
const listeners = new Set<() => void>();
let version = 0;
const snapshots = new Map<string, { version: number; list: readonly MeshTxEntry[] }>();
const EMPTY: readonly MeshTxEntry[] = Object.freeze([]);

function emit(): void {
  version++;
  listeners.forEach((l) => l());
}

export function subscribeMeshTxQueue(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Stable snapshot of one source's entries (new array only after a change). */
export function getMeshTxEntries(sourceId: string | null): readonly MeshTxEntry[] {
  if (!sourceId) return EMPTY;
  const m = entries.get(sourceId);
  if (!m || m.size === 0) return EMPTY;
  const cached = snapshots.get(sourceId);
  if (cached && cached.version === version) return cached.list;
  const list = Array.from(m.values());
  snapshots.set(sourceId, { version, list });
  return list;
}

export function makeSlot(action: MeshTxAction, publicKey: string, variant = ''): string {
  return `${action}|${publicKey}|${variant}`;
}

export function getMeshTxEntry(sourceId: string | null, slot: string): MeshTxEntry | null {
  if (!sourceId) return null;
  return entries.get(sourceId)?.get(slot) ?? null;
}

function clearTimers(key: string): void {
  const l = live.get(key);
  if (!l) return;
  if (l.pollTimer) clearTimeout(l.pollTimer);
  if (l.tickTimer) clearInterval(l.tickTimer);
  if (l.keepTimer) clearTimeout(l.keepTimer);
  l.pollTimer = l.tickTimer = l.keepTimer = null;
}

function remove(sourceId: string, slot: string): void {
  clearTimers(`${sourceId}|${slot}`);
  live.delete(`${sourceId}|${slot}`);
  const m = entries.get(sourceId);
  if (m) {
    m.delete(slot);
    if (m.size === 0) entries.delete(sourceId);
  }
  emit();
}

function patch(e: MeshTxEntry, changes: Partial<MeshTxEntry>): MeshTxEntry {
  const next = { ...e, ...changes };
  let m = entries.get(e.sourceId);
  if (!m) {
    m = new Map();
    entries.set(e.sourceId, m);
  }
  // Only a request still in the store may change; a removed one stays gone.
  if (m.get(e.slot)?.requestId === e.requestId) {
    m.set(e.slot, next);
    emit();
  }
  return next;
}

/** Seconds from a 429 body or header; null when it carries no number. */
export function parseRetrySeconds(status: number, body: Record<string, unknown>, headers?: Headers): number | null {
  if (status !== 429) return null;
  const known = typeof body.code === 'string' && QUEUE_CODES.has(body.code);
  // The device limiter answers with a string like '1 minute' and no code:
  // that is a plain error, not a countdown.
  if (!known && typeof body.retryAfter === 'string') return null;
  const candidates: unknown[] = [body.retryAfterSecs, body.retryAfterSeconds, body.retryAfter];
  for (const c of candidates) {
    if (typeof c === 'number' && Number.isFinite(c) && c > 0) return Math.ceil(c);
  }
  const h = headers?.get?.('Retry-After');
  if (h && /^\d+$/.test(h.trim()) && Number(h) > 0) return Number(h);
  return null;
}

export interface MeshTxRunOptions {
  fetcher: Fetcher;
  sourceId: string;
  action: MeshTxAction;
  publicKey: string;
  /** Distinguishes two buttons of one action (telemetry `status` / `lpp`). */
  variant?: string;
  /** Short human name shown in "Replaces your queued …" ("Poll Status"). */
  label: string;
  /** Display name of the node, for "Replaces your queued … for <node>". */
  nodeLabel?: string;
  /** `${baseUrl}/api/sources/${id}/meshcore`. */
  mcPrefix: string;
  /** Path under mcPrefix, e.g. `nodes/<pk>/telemetry/poll`. */
  path: string;
  body?: Record<string, unknown>;
}

/**
 * Start one manual action. Resolves with the server's final answer; the same
 * answer is kept in the store. Resolves `null` if the slot is already busy.
 */
export async function runMeshTxAction(opts: MeshTxRunOptions): Promise<MeshTxResult | null> {
  const { fetcher, sourceId, action, publicKey, label, mcPrefix, path } = opts;
  const variant = opts.variant ?? '';
  const slot = makeSlot(action, publicKey, variant);
  const key = `${sourceId}|${slot}`;
  const existing = getMeshTxEntry(sourceId, slot);
  if (existing && (existing.phase === 'starting' || existing.phase === 'queued' || existing.phase === 'sending' || existing.phase === 'cooldown')) {
    return null;
  }
  if (existing) remove(sourceId, slot);

  // A queued action of this user on this source is about to be replaced.
  let replaced: MeshTxEntry['replaced'] = null;
  for (const other of getMeshTxEntries(sourceId)) {
    if (other.phase === 'queued') {
      patch(other, { supersededByLabel: label });
      replaced ??= { action: other.action, label: other.label, publicKey: other.publicKey, nodeLabel: other.nodeLabel };
    }
  }

  const requestId = newLoginRequestId();
  const entry: MeshTxEntry = {
    slot,
    sourceId,
    action,
    publicKey,
    variant,
    label,
    nodeLabel: opts.nodeLabel ?? null,
    requestId,
    phase: 'starting',
    position: null,
    secondsLeft: null,
    result: null,
    replaced,
    supersededBy: null,
    supersededByLabel: null,
  };
  let m = entries.get(sourceId);
  if (!m) {
    m = new Map();
    entries.set(sourceId, m);
  }
  m.set(slot, entry);
  const l: Live = { deadline: null, pollTimer: null, tickTimer: null, keepTimer: null, open: true };
  live.set(key, l);
  emit();

  const current = () => entries.get(sourceId)?.get(slot)?.requestId === requestId;

  const tick = () => {
    if (!current() || l.deadline === null) return;
    const secs = Math.max(0, Math.ceil((l.deadline - Date.now()) / 1000));
    const cur = getMeshTxEntry(sourceId, slot);
    if (cur && cur.secondsLeft !== secs) patch(cur, { secondsLeft: secs });
  };

  const poll = async () => {
    l.pollTimer = null;
    if (!l.open || !current()) return;
    try {
      const resp = await fetcher(`${mcPrefix}/tx-queue/${encodeURIComponent(requestId)}`);
      if (l.open && current()) {
        if (resp.ok) {
          const j = await resp.json();
          const d = j?.data;
          if (j?.success && d && typeof d.position === 'number') {
            const eta = typeof d.startsInSecs === 'number' ? Math.max(0, d.startsInSecs) : 0;
            l.deadline = Date.now() + eta * 1000;
            const cur = getMeshTxEntry(sourceId, slot);
            if (cur && cur.phase !== 'cooldown') {
              patch(cur, { phase: 'queued', position: d.position, secondsLeft: Math.ceil(eta) });
              if (!l.tickTimer) l.tickTimer = setInterval(tick, MESH_TX_TICK_MS);
            }
          }
        } else if (resp.status === 404) {
          // Granted: the POST is open but no longer queued.
          const cur = getMeshTxEntry(sourceId, slot);
          if (cur && (cur.phase === 'queued' || cur.phase === 'starting')) patch(cur, { phase: 'sending', position: null, secondsLeft: null });
          if (l.tickTimer) {
            clearInterval(l.tickTimer);
            l.tickTimer = null;
          }
          l.deadline = null;
        }
      }
    } catch {
      /* display-only: the POST carries the answer */
    }
    if (l.open && current()) l.pollTimer = setTimeout(() => void poll(), MESH_TX_POLL_MS);
  };
  l.pollTimer = setTimeout(() => void poll(), MESH_TX_FIRST_POLL_MS);

  const finishKeep = (ms: number) => {
    if (l.keepTimer) clearTimeout(l.keepTimer);
    l.keepTimer = setTimeout(() => {
      if (current()) remove(sourceId, slot);
    }, ms);
  };

  const stopLive = () => {
    l.open = false;
    if (l.pollTimer) clearTimeout(l.pollTimer);
    if (l.tickTimer) clearInterval(l.tickTimer);
    l.pollTimer = l.tickTimer = null;
    l.deadline = null;
  };

  let result: MeshTxResult;
  try {
    const response = await fetcher(`${mcPrefix}/${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...(opts.body ?? {}), requestId }),
    });
    let body: Record<string, unknown> = {};
    try {
      body = (await response.json()) ?? {};
    } catch {
      body = {};
    }
    stopLive();
    const data = (body.data && typeof body.data === 'object' ? body.data : undefined) as Record<string, unknown> | undefined;
    result = {
      ok: response.ok && body.success === true,
      status: response.status,
      code: typeof body.code === 'string' ? body.code : undefined,
      data,
      waitedSecs: typeof data?.waitedSecs === 'number' ? data.waitedSecs : undefined,
      error: typeof body.error === 'string' ? body.error : undefined,
      txDisabled: response.status === 409 && body.code === 'TX_DISABLED',
      body,
    };
    if (result.ok) {
      if (current()) {
        patch(getMeshTxEntry(sourceId, slot)!, { phase: 'done', position: null, secondsLeft: null, result });
        finishKeep(MESH_TX_RESULT_KEEP_MS);
      }
    } else if (response.status === 409 && result.code === 'MESH_TX_SUPERSEDED') {
      const by = body.supersededBy as { action?: MeshTxAction; publicKey?: string | null } | undefined;
      if (current()) {
        patch(getMeshTxEntry(sourceId, slot)!, {
          phase: 'superseded',
          position: null,
          secondsLeft: null,
          result,
          supersededBy: by?.action ? { action: by.action, publicKey: by.publicKey ?? null } : null,
        });
        finishKeep(MESH_TX_SUPERSEDED_SHOW_MS);
      }
    } else {
      const secs = parseRetrySeconds(response.status, body, response.headers);
      if (secs !== null) {
        l.deadline = Date.now() + secs * 1000;
        if (current()) {
          patch(getMeshTxEntry(sourceId, slot)!, {
            phase: 'cooldown',
            position: null,
            secondsLeft: secs,
            result,
          });
          l.tickTimer = setInterval(() => {
            tick();
            const cur = getMeshTxEntry(sourceId, slot);
            if (cur && cur.requestId === requestId && (cur.secondsLeft ?? 0) <= 0) {
              // Re-enable the button. Nothing is resent.
              remove(sourceId, slot);
            }
          }, MESH_TX_TICK_MS);
        }
      } else if (current()) {
        patch(getMeshTxEntry(sourceId, slot)!, { phase: 'error', position: null, secondsLeft: null, result });
        finishKeep(MESH_TX_RESULT_KEEP_MS);
      }
    }
  } catch (err) {
    stopLive();
    result = { ok: false, status: 0, error: err instanceof Error ? err.message : 'Network error' };
    if (current()) {
      patch(getMeshTxEntry(sourceId, slot)!, { phase: 'error', position: null, secondsLeft: null, result });
      finishKeep(MESH_TX_RESULT_KEEP_MS);
    }
  }
  return result;
}

/** Drop every entry and timer. Tests only. */
export function resetMeshTxQueueStoreForTests(): void {
  for (const key of Array.from(live.keys())) clearTimers(key);
  live.clear();
  entries.clear();
  snapshots.clear();
  emit();
}
