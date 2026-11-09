/**
 * Pure builder that turns the stored hop rows of ONE MeshCore trace into a
 * "run": a requester-first round trip in the same shape the Traceroute Explorer
 * and the v1 API use for a Meshtastic traceroute (#6276).
 *
 * What the rows hold: for path hashes H[0..N-1], row i is "H[i] heard its
 * predecessor" (the predecessor of H[0] is the local radio) and row N is "the
 * local radio heard H[N-1]". Every completed trace is therefore a loop
 * local -> H0 .. H(N-1) -> local. The target contact is not stored, so the
 * split into an outbound and a return leg is STRUCTURAL and never guesses a
 * node's identity:
 *
 *  - the caller knows the target and it is one of the hops: split there;
 *  - else an odd palindrome (auto-return to a repeater or room) splits at the
 *    middle hop;
 *  - else (a one-way trace) the whole path is outbound.
 *
 * A companion target does not forward traces, so it is not on the wire. A
 * known target missing from the hop list is reported as `toKey` with
 * `reachedTarget = false` and the real turnaround hop in `turnaroundKey`.
 *
 * Keys: a resolved hop is `mc:<pk>`, an unresolved or ambiguous hop is
 * `mch:<hash>` (its candidate count stays in `hops`). The local radio is
 * `mc:<localPk>`, or `src:<sourceId>` when its key is unknown.
 *
 * Shared by the server (Explorer route, v1 API) and the client types.
 */
import type { MeshCoreHopSnrRow } from '../db/repositories/meshcoreHopSnr.js';
import { nodeNumFromPubkey } from './meshcoreNodeNum.js';

/** Meshtastic broadcast / "unknown" node number; the strip renders it as Unknown. */
export const UNRESOLVED_HOP_NUM = 4294967295;
/** Meshtastic's "no SNR" value (INT8_MIN, i.e. -32 dB at dB*4). */
export const NO_SNR_Q = -128;

const FULL_KEY_RE = /^[0-9a-fA-F]{64}$/;

export interface MeshCoreRunHop {
  /** `mc:<pk>` when resolved, else `mch:<hash>`. */
  key: string;
  hash: string | null;
  /** Contacts that matched the hash: 1 = resolved, 0 = unknown, >1 = ambiguous. */
  candidates: number;
}

export interface MeshCoreTraceRun {
  sourceId: string;
  traceTag: number;
  authCode: number;
  timestamp: number;
  hashBytes: number;
  fromKey: string;
  toKey: string;
  turnaroundKey: string;
  reachedTarget: boolean;
  /** `[local, H0 .. Hs]`. */
  forwardKeys: string[];
  /** dB*4, one per link of `forwardKeys` (`-128` where a row is missing). */
  forwardSnrQ: number[];
  /** `[Hs .. H(N-1), local]`, or null when the return link was not recorded. */
  backKeys: string[] | null;
  backSnrQ: number[] | null;
  hops: MeshCoreRunHop[];
  /** True when the local radio sent the trace (a row says so). */
  initiated: boolean;
  /** Meshtastic-shape fields (synthetic numbers; display only). */
  fromNodeNum: number;
  toNodeNum: number;
  /** JSON number[]: the nodes between `fromNodeNum` and `toNodeNum`. */
  route: string;
  routeBack: string | null;
  snrTowards: string;
  snrBack: string | null;
}

export interface BuildMeshCoreTraceRunOptions {
  localPublicKey: string | null;
  targetPublicKey?: string | null;
}

const lower = (k: string | null | undefined): string | null => (k ? k.toLowerCase() : null);

/** Synthetic display number for a run key; unresolved hashes get the "unknown" number. */
export function keyToSyntheticNum(key: string): number {
  if (key.startsWith('mc:')) {
    const pk = key.slice(3);
    return FULL_KEY_RE.test(pk) ? nodeNumFromPubkey(pk) : UNRESOLVED_HOP_NUM;
  }
  return UNRESOLVED_HOP_NUM;
}

function hopKey(publicKey: string | null | undefined, hash: string | null | undefined): string {
  const pk = lower(publicKey);
  if (pk) return `mc:${pk}`;
  return `mch:${(hash ?? '').toLowerCase()}`;
}

/** Build one run from the hop rows of one trace (any order). Null when there is nothing to show. */
export function buildMeshCoreTraceRun(
  rows: readonly MeshCoreHopSnrRow[],
  opts: BuildMeshCoreTraceRunOptions,
): MeshCoreTraceRun | null {
  if (rows.length === 0) return null;
  const sorted = [...rows].sort((a, b) => a.hopIndex - b.hopIndex);
  const first = sorted[0];
  const n = (first.hopCount ?? 0) - 1;
  if (!Number.isInteger(n) || n < 1) return null;

  const initiated = sorted.some((r) => r.initiated);
  const localPk = lower(opts.localPublicKey) ?? (initiated ? lower(first.senderPublicKey) : null);
  const localKey = localPk ? `mc:${localPk}` : `src:${first.sourceId}`;

  const byIndex = new Map<number, MeshCoreHopSnrRow>();
  for (const r of sorted) if (!byIndex.has(r.hopIndex)) byIndex.set(r.hopIndex, r);

  const hops: MeshCoreRunHop[] = [];
  for (let i = 0; i < n; i++) {
    const r = byIndex.get(i);
    const hash = r?.receiverHash ?? null;
    hops.push({
      key: hopKey(r?.receiverPublicKey, hash),
      hash,
      candidates: r?.receiverCandidates ?? 0,
    });
  }
  const snrAt = (i: number): number => byIndex.get(i)?.snrQuarterDb ?? NO_SNR_Q;
  const hasReturn = byIndex.has(n);

  // Split index s: the last hop of the outbound leg.
  const target = lower(opts.targetPublicKey);
  const targetKey = target ? `mc:${target}` : null;
  const targetIdx = targetKey ? hops.findIndex((h) => h.key === targetKey) : -1;
  const isPalindrome =
    n % 2 === 1 &&
    hops.every((h, i) => h.hash !== null && h.hash === hops[n - 1 - i].hash);
  const s = targetIdx >= 0 ? targetIdx : isPalindrome ? (n - 1) / 2 : n - 1;

  const turnaroundKey = hops[s].key;
  const reachedTarget = !targetKey || targetIdx >= 0;
  const toKey = targetKey && !reachedTarget ? targetKey : turnaroundKey;

  const forwardKeys = [localKey, ...hops.slice(0, s + 1).map((h) => h.key)];
  const forwardSnrQ: number[] = [];
  for (let i = 0; i <= s; i++) forwardSnrQ.push(snrAt(i));

  let backKeys: string[] | null = null;
  let backSnrQ: number[] | null = null;
  if (hasReturn) {
    backKeys = [...hops.slice(s).map((h) => h.key), localKey];
    backSnrQ = [];
    for (let i = s + 1; i <= n; i++) backSnrQ.push(snrAt(i));
  }

  // Meshtastic-shape fields. `route` is what lies between `from` and `to`;
  // when the target is not on the wire the turnaround hop is a middle node, so
  // the link to the target has no SNR and is padded with the "no SNR" value.
  const num = keyToSyntheticNum;
  const routeKeys = forwardKeys.slice(1);
  const routeNums = routeKeys.map(num);
  let snrTowards = [...forwardSnrQ];
  let route: number[];
  if (reachedTarget) {
    route = routeNums.slice(0, -1);
  } else {
    route = routeNums;
    snrTowards = [...snrTowards, NO_SNR_Q];
  }
  let routeBack: number[] | null = null;
  let snrBack: number[] | null = null;
  if (backKeys && backSnrQ) {
    const mid = backKeys.slice(reachedTarget ? 1 : 0, -1).map(num);
    routeBack = mid;
    snrBack = reachedTarget ? [...backSnrQ] : [NO_SNR_Q, ...backSnrQ];
  }

  return {
    sourceId: first.sourceId,
    traceTag: first.traceTag,
    authCode: first.authCode,
    timestamp: first.timestamp,
    hashBytes: first.hashBytes,
    fromKey: localKey,
    toKey,
    turnaroundKey,
    reachedTarget,
    forwardKeys,
    forwardSnrQ,
    backKeys,
    backSnrQ,
    hops,
    initiated,
    fromNodeNum: num(localKey),
    toNodeNum: num(toKey),
    route: JSON.stringify(route),
    routeBack: routeBack ? JSON.stringify(routeBack) : null,
    snrTowards: JSON.stringify(snrTowards),
    snrBack: snrBack ? JSON.stringify(snrBack) : null,
  };
}
