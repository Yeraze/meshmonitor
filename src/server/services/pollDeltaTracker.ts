/**
 * Incremental `/api/poll` replies.
 *
 * The poll used to send every node of a source on every tick: 1-5 MB per
 * source page, every 5-30 s, though most nodes had not changed. A client that
 * opts in (sends `cursor`) now gets only what changed since the reply it last
 * merged.
 *
 * How it stays correct: the route still builds the full, permission-filtered
 * reply exactly as before. This tracker only compares that reply with the
 * history of earlier replies for the same caller and source, and leaves out
 * what the client already holds:
 *
 * - each node (keyed by `nodeNum`) carries the hash of its serialized form and
 *   the version it last changed in; a node gone from the build leaves a
 *   tombstone with the version it went in;
 * - the node order and every other section carry a hash and a version too.
 *
 * A delta from cursor version `v` holds every node whose version is above `v`
 * (its current content), every tombstone above `v`, the full node order when
 * the order changed after `v`, and names the sections unchanged since `v`.
 * Merged onto the reply the client held at `v`, that gives the full reply,
 * field for field. Nothing is ever sent that the current build does not hold,
 * so the permission filtering is the route's own; a node a permission change
 * hides simply leaves the build and goes out as a removal.
 *
 * The client gets the full reply instead when its cursor is missing, from
 * another epoch (server restart, state evicted), older than a pruned
 * tombstone, or when the build has two nodes with one `nodeNum` (the key would
 * be ambiguous).
 */
import { createHash, randomBytes } from 'crypto';

/** A state not used for this long is dropped; its clients get a full reply. */
const STATE_IDLE_MS = 10 * 60 * 1000;
/** Most states held at once (one per signed-in user and source polled; ~100 bytes per node each). */
const MAX_STATES = 100;
/** How long a removal is remembered. A cursor older than that gets a full reply. */
const TOMBSTONE_TTL_MS = 15 * 60 * 1000;
/** Most removals remembered per state. */
const MAX_TOMBSTONES = 20000;
/** How often idle states are swept. */
const SWEEP_EVERY_MS = 60 * 1000;

const ABSENT = '-';

interface Versioned {
  hash: string;
  ver: number;
}

interface PollState {
  epoch: string;
  version: number;
  nodes: Map<number, Versioned>;
  tombstones: Map<number, { ver: number; at: number }>;
  /** The lowest cursor version a delta can still be built from. */
  floor: number;
  order: Versioned;
  sections: Map<string, Versioned>;
  lastUsed: number;
}

export interface PollBuild {
  /** Each node's serialized JSON, in reply order. */
  nodesJson: string[];
  /** Each node's `nodeNum`, same order as `nodesJson`. */
  nodeNums: number[];
  /** Every other section, serialized; `undefined` when absent from the reply. */
  sectionsJson: Record<string, string | undefined>;
}

export interface PollDeltaResult {
  /** Cursor for the client's next poll; null when no delta can follow. */
  cursor: string | null;
  /** True when this is a delta, false when it is the full reply. */
  delta: boolean;
  /** Node JSON to send: every node (full) or the changed ones (delta). */
  nodesJson: string[];
  /** Delta only: nodeNums removed since the cursor. */
  removedNodes?: number[];
  /** Delta only, when the order changed since the cursor: every nodeNum in reply order. */
  nodeOrder?: number[];
  /** Delta only: sections the client already holds; left out of the reply. */
  unchangedSections?: string[];
}

function hashOf(text: string): string {
  return createHash('sha1').update(text).digest('base64');
}

export class PollDeltaTracker {
  private states = new Map<string, PollState>();
  private lastSweep = 0;

  constructor(private readonly now: () => number = Date.now) {}

  /** States held (tests). */
  get size(): number {
    return this.states.size;
  }

  /** Drop every state, as a server restart would (tests). */
  reset(): void {
    this.states.clear();
  }

  /**
   * Fold one full build into the history of `stateKey` and return what to
   * send to a client holding `cursor` (empty string: holds nothing yet).
   */
  apply(stateKey: string, cursor: string, build: PollBuild): PollDeltaResult {
    const now = this.now();
    this.sweep(now);

    const full = (state: PollState | null): PollDeltaResult => ({
      cursor: state ? `${state.epoch}.${state.version}` : null,
      delta: false,
      nodesJson: build.nodesJson,
    });

    // Two rows with one nodeNum: a key-based delta would be ambiguous.
    if (new Set(build.nodeNums).size !== build.nodeNums.length) {
      this.states.delete(stateKey);
      return full(null);
    }

    let state = this.states.get(stateKey);
    if (!state) {
      state = {
        epoch: randomBytes(6).toString('hex'),
        version: 0,
        nodes: new Map(),
        tombstones: new Map(),
        floor: 0,
        order: { hash: '', ver: 0 },
        sections: new Map(),
        lastUsed: now,
      };
      this.states.set(stateKey, state);
    }
    state.lastUsed = now;
    // Most recently used last, so eviction takes the oldest first.
    this.states.delete(stateKey);
    this.states.set(stateKey, state);
    while (this.states.size > MAX_STATES) {
      const oldest = this.states.keys().next().value as string;
      this.states.delete(oldest);
    }

    this.fold(state, build, now);

    const since = this.cursorVersion(state, cursor);
    if (since === null) return full(state);

    const nodesJson: string[] = [];
    build.nodeNums.forEach((nodeNum, i) => {
      if (state.nodes.get(nodeNum)!.ver > since) nodesJson.push(build.nodesJson[i]);
    });
    const removedNodes: number[] = [];
    for (const [nodeNum, t] of state.tombstones) {
      if (t.ver > since) removedNodes.push(nodeNum);
    }
    const unchangedSections: string[] = [];
    for (const [name, entry] of state.sections) {
      if (entry.hash !== ABSENT && entry.ver <= since) unchangedSections.push(name);
    }
    return {
      cursor: `${state.epoch}.${state.version}`,
      delta: true,
      nodesJson,
      removedNodes,
      ...(state.order.ver > since ? { nodeOrder: build.nodeNums } : {}),
      unchangedSections,
    };
  }

  /** The cursor's version when a delta can be built from it, else null. */
  private cursorVersion(state: PollState, cursor: string): number | null {
    const dot = cursor.lastIndexOf('.');
    if (dot <= 0) return null;
    if (cursor.slice(0, dot) !== state.epoch) return null;
    const v = Number(cursor.slice(dot + 1));
    if (!Number.isInteger(v) || v < state.floor || v > state.version) return null;
    return v;
  }

  /** Record the build as the state's newest version (if anything changed). */
  private fold(state: PollState, build: PollBuild, now: number): void {
    const next = state.version + 1;
    let changed = false;

    const present = new Set<number>();
    build.nodeNums.forEach((nodeNum, i) => {
      present.add(nodeNum);
      const hash = hashOf(build.nodesJson[i]);
      const entry = state.nodes.get(nodeNum);
      if (!entry || entry.hash !== hash) {
        state.nodes.set(nodeNum, { hash, ver: next });
        state.tombstones.delete(nodeNum);
        changed = true;
      }
    });
    for (const nodeNum of [...state.nodes.keys()]) {
      if (!present.has(nodeNum)) {
        state.nodes.delete(nodeNum);
        state.tombstones.set(nodeNum, { ver: next, at: now });
        changed = true;
      }
    }

    const orderHash = hashOf(build.nodeNums.join(','));
    if (orderHash !== state.order.hash) {
      state.order = { hash: orderHash, ver: next };
      changed = true;
    }

    const names = new Set([...state.sections.keys(), ...Object.keys(build.sectionsJson)]);
    for (const name of names) {
      const json = build.sectionsJson[name];
      const hash = json === undefined ? ABSENT : hashOf(json);
      const entry = state.sections.get(name);
      if (!entry ? hash !== ABSENT : entry.hash !== hash) {
        state.sections.set(name, { hash, ver: next });
        changed = true;
      }
    }

    if (changed) state.version = next;

    // Forget old removals. A cursor that predates one can no longer be served
    // a delta (it would miss the removal), so the floor moves past it.
    const tooOld = now - TOMBSTONE_TTL_MS;
    const overCap = state.tombstones.size - MAX_TOMBSTONES;
    let dropped = 0;
    for (const [nodeNum, t] of state.tombstones) {
      if (t.at >= tooOld && dropped >= overCap) break;
      state.tombstones.delete(nodeNum);
      state.floor = Math.max(state.floor, t.ver);
      dropped++;
    }
  }

  private sweep(now: number): void {
    if (now - this.lastSweep < SWEEP_EVERY_MS) return;
    this.lastSweep = now;
    for (const [key, state] of this.states) {
      if (now - state.lastUsed > STATE_IDLE_MS) this.states.delete(key);
    }
  }
}

/** The process-wide tracker the poll route uses. */
export const pollDeltaTracker = new PollDeltaTracker();

/**
 * Serialize a poll reply from pre-serialized parts. `sectionsJson` entries
 * that are `undefined` are left out, as `JSON.stringify` leaves out undefined
 * properties.
 */
export function serializePollReply(
  sectionsJson: Record<string, string | undefined>,
  nodesJson: string[] | null,
  extra: Record<string, unknown> = {},
): string {
  const parts: string[] = [];
  for (const [name, json] of Object.entries(sectionsJson)) {
    if (json !== undefined) parts.push(`${JSON.stringify(name)}:${json}`);
  }
  if (nodesJson) parts.push(`"nodes":[${nodesJson.join(',')}]`);
  for (const [name, value] of Object.entries(extra)) {
    if (value !== undefined) parts.push(`${JSON.stringify(name)}:${JSON.stringify(value)}`);
  }
  return `{${parts.join(',')}}`;
}
