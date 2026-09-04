/**
 * Node identity-change detection — Meshtastic 2.8 node-number migration
 * (issue #5032).
 *
 * ## The problem
 *
 * Up to firmware 2.7.x a node's number was derived from its hardware MAC
 * address. Meshtastic 2.8 derives it from the node's public-key identity
 * instead, and the change is one-way. A node that upgrades therefore arrives
 * in MeshMonitor as a brand-new node: new `nodeNum`, new `nodeId`, empty
 * history. Its telemetry, packet log, positions and messages stay attached to
 * the old number, and the node list shows what looks like a duplicate with the
 * same long name. After a mesh-wide upgrade, half the node list goes dark at
 * once.
 *
 * ## What this module does — and deliberately does not do
 *
 * It **detects and reports**. It never mutates, merges, re-keys or deletes
 * anything. Detection is a heuristic over names and keys; two genuinely
 * different nodes can share a long name, and silently merging them would
 * corrupt both histories irreversibly. A human decides.
 *
 * ## Signals, strongest first
 *
 * 1. **The firmware's own derivation** (`basis: 'derivedNodeNum'`, confidence
 *    `high`). 2.8's `NodeDB::createNewIdentity()` sets
 *    `my_node_num = crc32(public_key.bytes)`, so if some older row's key
 *    CRC-32s to exactly the new row's node number, the new row *is* that key's
 *    2.8 identity. This is verification against the firmware rule, not a guess
 *    — and it holds even when the operator renamed the node in between.
 *    Reuses `nodeNumFromPublicKey()` (`services/lowEntropyKeyService.ts`),
 *    already used by the #4251 duplicate-key classifier.
 * 2. **Same public key, different node number** (`basis: 'publicKey'`,
 *    confidence `high`). The upgrading node keeps its keypair byte-for-byte
 *    (`regeneratePublicKey()` is unchanged between 2.7 and 2.8), so two rows
 *    sharing a key but not a number is the upgrade signature even when we hold
 *    a key we cannot CRC (wrong length, truncated).
 * 3. **Same long name and short name** (`basis: 'name'`, confidence `medium`).
 *    The fallback for nodes with no key on file. Firmware-default
 *    `Node !xxxxxxxx` long names are excluded — they would match every unnamed
 *    node to every other one.
 *
 * A **differing public key is a hard veto**: if both rows carry a key and the
 * keys differ, they cannot be the same node under 2.8's derivation, no matter
 * how well the names line up. This is what stops two same-named neighbours
 * being reported as one.
 *
 * ## Relationship to the #4251 duplicate-key classifier
 *
 * `isBenign28UpgradeRenumber()` answers a narrower question — "should this
 * shared-key group still raise a *security* warning?" — and only ever
 * *suppresses*. This module answers the operator-facing one: which old node
 * does the orphaned history belong to? Both lean on the same liveness
 * reasoning, because it is the same discriminator that separates an upgrade
 * (the old identity never speaks again) from an impersonation (both parties
 * transmit concurrently).
 *
 * ## Liveness gate (what makes a pair a *succession* rather than a coincidence)
 *
 * The predecessor must have gone quiet around the time the successor first
 * appeared, and must still be quiet now:
 *
 * ```
 *   predecessor.lastHeard <= successor.createdAt + graceSeconds
 *   successor.createdAt - predecessor.lastHeard <= quietLookbackSeconds
 *   predecessor.lastHeard <= now - minQuietSeconds
 *   successor.lastHeard  >  predecessor.lastHeard
 *   successor.createdAt  >= now - appearWindowSeconds
 * ```
 *
 * The `appearWindow` is what makes this a transient notice: a pair stops being
 * reported once the successor is no longer new, so a long-lived mesh does not
 * carry permanent badges over an ancient name collision.
 *
 * ## Per-source, always
 *
 * Every comparison happens inside ONE source. A node on source A is never
 * matched against a node on source B — those are different meshes, and a name
 * or key collision across them says nothing about a firmware upgrade
 * (CLAUDE.md multi-source rules; the #3745 leak class).
 */
import databaseService from '../../services/database.js';
import type { NodeIdentityRow } from '../../db/repositories/nodes.js';
import { nodeNumFromPublicKey } from '../../services/lowEntropyKeyService.js';

const HOUR = 3600;
const DAY = 24 * HOUR;

/** Tunables for {@link detectIdentityChanges}. All values in seconds. */
export interface IdentityChangeOptions {
  /** Only consider successors first seen within this window. Default 90 days. */
  appearWindowSeconds?: number;
  /** Max gap between the predecessor falling silent and the successor appearing. Default 30 days. */
  quietLookbackSeconds?: number;
  /** How long after the successor appeared the predecessor may still have been heard. Default 12 hours. */
  graceSeconds?: number;
  /** The predecessor must have been silent at least this long by now. Default 6 hours. */
  minQuietSeconds?: number;
  /** Clock injection for tests. Unix seconds. */
  nowSeconds?: number;
}

export const IDENTITY_CHANGE_DEFAULTS: Required<Omit<IdentityChangeOptions, 'nowSeconds'>> = {
  // Generous: an operator may only notice a quiet node weeks later. The window
  // is what keeps the notice transient rather than a permanent badge.
  appearWindowSeconds: 90 * DAY,
  // Tighter: the handover itself happens on one reboot. This only has to
  // absorb "we didn't hear the new identity for a while", not months.
  quietLookbackSeconds: 30 * DAY,
  graceSeconds: 12 * HOUR,
  minQuietSeconds: 6 * HOUR,
};

/** Hard cap on returned pairs so a pathological mesh can't produce an unbounded response. */
export const MAX_IDENTITY_CHANGE_DETECTIONS = 500;

/** The subset of a node row echoed back to the client for display. */
export interface IdentityChangeNode {
  nodeNum: number;
  nodeId: string;
  longName: string | null;
  shortName: string | null;
  hwModel: number | null;
  firmwareVersion: string | null;
  lastHeard: number | null;
  createdAt: number;
  /** Whether a public key is on file. The key itself is never echoed. */
  hasPublicKey: boolean;
}

export interface IdentityChangeDetection {
  /** The node that appeared with the new number. */
  successor: IdentityChangeNode;
  /** The best-matching node that fell silent as it appeared. */
  predecessor: IdentityChangeNode;
  /** Which signal carried the match. */
  basis: 'derivedNodeNum' | 'publicKey' | 'name';
  confidence: 'high' | 'medium';
  /**
   * True when `crc32(predecessor.publicKey) === successor.nodeNum` — the
   * firmware's own 2.8 derivation, applied to the old row's key.
   */
  derivedFromPredecessorKey: boolean;
  /** True when the successor's own number is the CRC-32 of its own key (i.e. it is a 2.8 identity). */
  successorNodeNumIsKeyDerived: boolean;
  /** True when the predecessor's number is key-derived too — unexpected for a genuine pre-2.8 row. */
  predecessorNodeNumIsKeyDerived: boolean;
  /** True when both rows carry the same non-empty public key. */
  publicKeyMatches: boolean;
  /** True when long name and short name both match (case-insensitively). */
  nameMatches: boolean;
  /** True when both rows report the same hardware model. */
  hwModelMatches: boolean;
  /** True when the successor reports firmware >= 2.8 — corroboration, never the trigger. */
  successorFirmwareIs28OrLater: boolean;
  /** Seconds the predecessor has been silent, as of the evaluation clock. */
  predecessorQuietForSeconds: number;
  /**
   * Seconds between the predecessor's last packet and the successor's first
   * sighting. **Can be negative** — the liveness gate tolerates up to
   * `graceSeconds` of overlap, e.g. when an MQTT gateway replays the old
   * identity's cached NodeInfo after the new one is already on air. Format it
   * as a signed offset, never as an unsigned duration.
   */
  handoverGapSeconds: number;
  /** How many *other* nodes also matched this successor. >0 means the pick is ambiguous. */
  otherCandidateCount: number;
}

export interface IdentityChangeReport {
  sourceId: string;
  detections: IdentityChangeDetection[];
  /** True when {@link MAX_IDENTITY_CHANGE_DETECTIONS} clipped the list. */
  truncated: boolean;
  /** The thresholds actually used, echoed so a UI or a bug report can show them. */
  options: Required<Omit<IdentityChangeOptions, 'nowSeconds'>>;
}

/** Lower is stronger — drives which candidate wins when several match. */
const BASIS_RANK: Record<IdentityChangeDetection['basis'], number> = {
  derivedNodeNum: 0,
  publicKey: 1,
  name: 2,
};

/**
 * The firmware's placeholder long name for a node whose NodeInfo we've never
 * received. Matching on it would pair every unnamed node with every other.
 */
const FIRMWARE_DEFAULT_LONG_NAME = /^Node !?[0-9a-f]{8}$/i;

/**
 * Unit trap: `nodes.createdAt` is written as `Date.now()` — **milliseconds** —
 * while `nodes.lastHeard` is unix **seconds**. Comparing them raw makes every
 * gap look like ~56,000 years and silently kills every detection. Everything
 * inside this module, and everything it returns, is in seconds.
 *
 * The threshold is deliberately generous (any plausible seconds timestamp is
 * far below 1e11, any ms timestamp since 1973 is far above) so a legacy row
 * stored in seconds is handled too.
 */
function toSeconds(value: number): number {
  return value > 1e11 ? Math.floor(value / 1000) : value;
}

function normalizeName(value: string | null): string | null {
  const trimmed = (value ?? '').trim();
  return trimmed.length > 0 ? trimmed.toLowerCase() : null;
}

function hasKey(row: NodeIdentityRow): boolean {
  return typeof row.publicKey === 'string' && row.publicKey.length > 0;
}

/** True when a version string parses to 2.8.0 or later. Unparseable/absent → false. */
export function firmwareIs28OrLater(version: string | null | undefined): boolean {
  if (!version) return false;
  // Firmware reports "2.8.0.47db0e3"; accept a bare "2.8" too rather than
  // silently reading it as pre-2.8.
  const match = version.match(/^(\d+)\.(\d+)/);
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  if (major !== 2) return major > 2;
  return minor >= 8;
}

function nameKeyOf(row: NodeIdentityRow): string | null {
  const long = normalizeName(row.longName);
  const short = normalizeName(row.shortName);
  if (!long || !short) return null;
  // A firmware-default long name means NodeInfo never arrived — it identifies
  // nothing, so it must not seed a match. (`long` is already lower-cased here;
  // the pattern's `i` flag is belt-and-braces in case that ever changes.)
  if (FIRMWARE_DEFAULT_LONG_NAME.test(long)) return null;
  return `${long} ${short}`;
}

function toDisplay(row: NodeIdentityRow): IdentityChangeNode {
  return {
    nodeNum: Number(row.nodeNum),
    nodeId: row.nodeId,
    longName: row.longName,
    shortName: row.shortName,
    hwModel: row.hwModel,
    firmwareVersion: row.firmwareVersion,
    lastHeard: row.lastHeard == null ? null : Number(row.lastHeard),
    createdAt: toSeconds(Number(row.createdAt)),
    hasPublicKey: hasKey(row),
  };
}

/**
 * Pure core of the detector: given one source's rows, return the candidate
 * identity changes. Exported for testing — the DB-backed entry point is
 * {@link detectIdentityChanges}.
 *
 * @param rows every node row for a SINGLE source. Passing rows from more than
 *   one source would produce cross-source matches and is a caller bug.
 */
export function findIdentityChanges(
  rows: NodeIdentityRow[],
  options: IdentityChangeOptions = {},
): { detections: IdentityChangeDetection[]; truncated: boolean } {
  const opts = { ...IDENTITY_CHANGE_DEFAULTS, ...options };
  const now = options.nowSeconds ?? Math.floor(Date.now() / 1000);

  // Index by derived number, by key and by name so the scan is linear rather
  // than O(n^2) — a busy MQTT source can hold thousands of rows.
  const byPublicKey = new Map<string, NodeIdentityRow[]>();
  const byName = new Map<string, NodeIdentityRow[]>();
  /** row.publicKey CRC-32s to this number → the 2.8 identity that key would take. */
  const byDerivedNodeNum = new Map<number, NodeIdentityRow[]>();
  /** Memoised crc32(key) per row, keyed by nodeNum — the CRC is not free. */
  const derivedFor = new Map<number, number | null>();

  const push = <K>(map: Map<K, NodeIdentityRow[]>, key: K, row: NodeIdentityRow) => {
    const bucket = map.get(key);
    if (bucket) bucket.push(row);
    else map.set(key, [row]);
  };

  for (const row of rows) {
    const derived = nodeNumFromPublicKey(row.publicKey);
    derivedFor.set(Number(row.nodeNum), derived);
    if (hasKey(row)) push(byPublicKey, row.publicKey as string, row);
    if (derived !== null) push(byDerivedNodeNum, derived, row);
    const nameKey = nameKeyOf(row);
    if (nameKey) push(byName, nameKey, row);
  }

  const detections: IdentityChangeDetection[] = [];

  for (const successor of rows) {
    // Only nodes that turned up recently can be the *new* half of a handover.
    if (toSeconds(Number(successor.createdAt)) < now - opts.appearWindowSeconds) continue;
    if (successor.lastHeard == null) continue;

    // Gather every row that shares a key or a name with this successor, then
    // keep the ones that also pass the liveness gate.
    const seen = new Set<number>();
    const candidates: NodeIdentityRow[] = [];
    const pushCandidates = (bucket: NodeIdentityRow[] | undefined) => {
      if (!bucket) return;
      for (const row of bucket) {
        const num = Number(row.nodeNum);
        if (num === Number(successor.nodeNum) || seen.has(num)) continue;
        seen.add(num);
        candidates.push(row);
      }
    };
    // Any older row whose key CRC-32s to this successor's number — the
    // firmware's own derivation, and the strongest candidate source.
    // Note the successor's OWN row is in this bucket whenever it is a genuine
    // 2.8 identity (its number is its own key's CRC); `pushCandidates` drops
    // it via the self-check, so it can never pair with itself.
    pushCandidates(byDerivedNodeNum.get(Number(successor.nodeNum)));
    if (hasKey(successor)) pushCandidates(byPublicKey.get(successor.publicKey as string));
    const successorNameKey = nameKeyOf(successor);
    if (successorNameKey) pushCandidates(byName.get(successorNameKey));
    if (candidates.length === 0) continue;

    const matches: IdentityChangeDetection[] = [];
    for (const predecessor of candidates) {
      const evaluated = evaluatePair(successor, predecessor, successorNameKey, derivedFor, now, opts);
      if (evaluated) matches.push(evaluated);
    }
    if (matches.length === 0) continue;

    // Best pick: strongest basis, then the predecessor heard most recently
    // (the likeliest handover partner when several names collide).
    matches.sort((a, b) => {
      const rank = (d: IdentityChangeDetection) => BASIS_RANK[d.basis];
      if (rank(a) !== rank(b)) return rank(a) - rank(b);
      return (b.predecessor.lastHeard ?? 0) - (a.predecessor.lastHeard ?? 0);
    });
    const best = matches[0];
    best.otherCandidateCount = matches.length - 1;
    detections.push(best);
  }

  // Newest handover first — that is the one an operator is looking for.
  detections.sort((a, b) => b.successor.createdAt - a.successor.createdAt);

  const truncated = detections.length > MAX_IDENTITY_CHANGE_DETECTIONS;
  return {
    detections: truncated ? detections.slice(0, MAX_IDENTITY_CHANGE_DETECTIONS) : detections,
    truncated,
  };
}

/**
 * Decide whether one (successor, predecessor) pair looks like a 2.8 handover.
 * Returns null when it does not.
 */
function evaluatePair(
  successor: NodeIdentityRow,
  predecessor: NodeIdentityRow,
  successorNameKey: string | null,
  derivedFor: Map<number, number | null>,
  now: number,
  opts: Required<Omit<IdentityChangeOptions, 'nowSeconds'>>,
): IdentityChangeDetection | null {
  if (predecessor.lastHeard == null) return null;

  const successorCreated = toSeconds(Number(successor.createdAt));
  const predecessorLastHeard = Number(predecessor.lastHeard);
  const successorLastHeard = Number(successor.lastHeard);

  // --- liveness gate ---
  // The predecessor must have fallen silent around the successor's arrival …
  if (predecessorLastHeard > successorCreated + opts.graceSeconds) return null;
  if (successorCreated - predecessorLastHeard > opts.quietLookbackSeconds) return null;
  // … must still be silent now …
  if (predecessorLastHeard > now - opts.minQuietSeconds) return null;
  // … and the successor must be the live one of the two.
  if (successorLastHeard <= predecessorLastHeard) return null;

  // --- matching ---
  const bothKeyed = hasKey(successor) && hasKey(predecessor);
  const publicKeyMatches = bothKeyed && successor.publicKey === predecessor.publicKey;
  // A differing key is a hard veto. Under 2.8 the node number is a function of
  // the key, so two differently-keyed rows are two different nodes however
  // well their names line up — this is what keeps same-named neighbours apart.
  if (bothKeyed && !publicKeyMatches) return null;

  const nameMatches = successorNameKey !== null && successorNameKey === nameKeyOf(predecessor);

  const successorNum = Number(successor.nodeNum);
  const predecessorNum = Number(predecessor.nodeNum);
  const predecessorDerived = derivedFor.get(predecessorNum) ?? null;
  const successorDerived = derivedFor.get(successorNum) ?? null;
  // The firmware's rule, applied to the OLD row's key: if it lands exactly on
  // the new row's number, the new row is that key's 2.8 identity.
  const derivedFromPredecessorKey = predecessorDerived !== null && predecessorDerived === successorNum;

  let basis: IdentityChangeDetection['basis'];
  let confidence: 'high' | 'medium';
  if (derivedFromPredecessorKey) {
    basis = 'derivedNodeNum';
    confidence = 'high';
  } else if (publicKeyMatches) {
    basis = 'publicKey';
    confidence = 'high';
  } else if (nameMatches) {
    basis = 'name';
    confidence = 'medium';
  } else {
    return null;
  }

  return {
    successor: toDisplay(successor),
    predecessor: toDisplay(predecessor),
    basis,
    confidence,
    derivedFromPredecessorKey,
    successorNodeNumIsKeyDerived: successorDerived !== null && successorDerived === successorNum,
    predecessorNodeNumIsKeyDerived: predecessorDerived !== null && predecessorDerived === predecessorNum,
    publicKeyMatches,
    nameMatches,
    hwModelMatches:
      successor.hwModel != null && predecessor.hwModel != null && successor.hwModel === predecessor.hwModel,
    successorFirmwareIs28OrLater: firmwareIs28OrLater(successor.firmwareVersion),
    predecessorQuietForSeconds: Math.max(0, now - predecessorLastHeard),
    handoverGapSeconds: successorCreated - predecessorLastHeard,
    otherCandidateCount: 0,
  };
}

/**
 * Detect possible 2.8 identity changes for ONE source.
 *
 * Read-only: this reads `nodes` and returns findings. Nothing is written,
 * merged or deleted.
 */
export async function detectIdentityChanges(
  sourceId: string,
  options: IdentityChangeOptions = {},
): Promise<IdentityChangeReport> {
  const rows = await databaseService.nodes.getIdentityRows(sourceId);
  const { detections, truncated } = findIdentityChanges(rows, options);
  return {
    sourceId,
    detections,
    truncated,
    options: { ...IDENTITY_CHANGE_DEFAULTS, ...options },
  };
}
