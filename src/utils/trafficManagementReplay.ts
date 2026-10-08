/**
 * Traffic Management replay (#5670): a PURE what-if for two firmware rules,
 * position dedup and rate limit, run over packets the local node already let
 * through. No I/O here; the route feeds it rows and settings.
 *
 * What it answers: "of the packets in the log, which would the node have
 * dropped with these tighter settings?" It does NOT answer "what does the node
 * drop today" (a dropped packet returns STOP before RoutingModule, so it is
 * neither relayed nor handed to the client, and never reaches the log), and it
 * does not describe any other node.
 *
 * The rules mirror meshtastic/firmware `src/modules/TrafficManagementModule.cpp`
 * at {@link TMM_MIRROR_FIRMWARE_VERSION}:
 *   - `handleReceived`     rule order, exemptions, which packets each rule sees
 *   - `shouldDropPosition` dedup (fingerprint, 6 min ticks, role caps)
 *   - `isRateLimited`      rate limit (5 min ticks, fixed window, cap 60)
 *   - `runOnce`            the 60 s sweep and its tick TTLs
 * plus `truncateCoordinate` / `getPositionPrecisionForChannel`
 * (`src/mesh/PositionPrecision.cpp`), `Channels::isWellKnownChannel`
 * (`src/mesh/Channels.cpp`) and the defaults in `src/mesh/Default.h`.
 * Those functions are byte-identical in v2.8.0.47db0e3, v2.8.0.7239fe8,
 * v2.8.1.8e6a88d and develop@015d5b1 (2026-10-08).
 */

/**
 * The firmware tag this mirror was written against. Shown in the UI. Change it
 * only after re-reading the functions listed above at the new tag; a test pins
 * the value so the change is deliberate.
 */
export const TMM_MIRROR_FIRMWARE_VERSION = 'v2.8.1.8e6a88d';

// --- Firmware constants -----------------------------------------------------
/** `kPosTimeTickMs` (TrafficManagementModule.h): 6 min per dedup tick. */
export const POS_TICK_MS = 360_000;
/** `kRateTimeTickMs`: 5 min per rate-limit tick. */
export const RATE_TICK_MS = 300_000;
/** `kMaintenanceIntervalMs`: the cache sweep in `runOnce`. */
export const SWEEP_INTERVAL_MS = 60_000;
/** `default_traffic_mgmt_position_precision_bits` (Default.h). */
export const DEFAULT_DEDUP_PRECISION_BITS = 19;
/** `MAX_POSITION_PRECISION_PUBLIC_KEY` (PositionPrecision.h). */
export const PUBLIC_CHANNEL_MAX_PRECISION_BITS = 15;
/** `default_traffic_mgmt_tracker_position_min_interval_secs`. */
export const TRACKER_DEDUP_CAP_SECS = 60 * 60;
/** `default_traffic_mgmt_lost_and_found_position_min_interval_secs`. */
export const LOST_AND_FOUND_DEDUP_CAP_SECS = 15 * 60;
/** `isRateLimited`: "Threshold capped at 60". */
export const RATE_THRESHOLD_CAP = 60;
/** `isRateLimited`: the 6-bit counter saturates at 63. */
const RATE_COUNT_SATURATION = 63;
const RATE_MAX_WINDOW_TICKS = 15;
const POS_MAX_WINDOW_TICKS = 255;
const UINT32_MAX = 0xffffffff;

const PORT_POSITION = 3;
const PORT_ROUTING = 5;
const PORT_ADMIN = 6;
const ROLE_TRACKER = 5;
const ROLE_LOST_AND_FOUND = 9;
const ROLE_TAK_TRACKER = 10;

/**
 * Modem preset display names (`DisplayFormatters::getModemPresetDisplayName`,
 * long form). A channel named like one of these, with a PSK of at most one
 * byte, is "well known" to the firmware.
 */
export const WELL_KNOWN_CHANNEL_NAMES: readonly string[] = [
  'ShortTurbo', 'ShortSlow', 'ShortFast', 'MediumSlow', 'MediumFast', 'MediumTurbo',
  'LongSlow', 'LongFast', 'LongTurbo', 'LongMod', 'LiteFast', 'LiteSlow',
  'NarrowFast', 'NarrowSlow', 'TinyFast', 'TinySlow',
];

/**
 * `Channels::isWellKnownChannel`: a PSK of at most one byte (none, or one of
 * the public default-key indexes) AND a name equal to a modem preset's display
 * name. An empty name reads as the current preset's name when the radio uses a
 * preset (`Channels::getName`), and as "Custom" when it does not.
 *
 * MeshMonitor stores an unnamed secondary channel as `Channel <index>`; that
 * placeholder is treated as the empty name it stands for.
 */
export function isWellKnownChannel(channel: {
  index: number;
  name: string | null | undefined;
  pskByteLength: number;
  usePreset: boolean;
}): boolean {
  if (channel.pskByteLength > 1) return false;
  const name = channel.name ?? '';
  if (name === '' || name === `Channel ${channel.index}`) return channel.usePreset;
  return WELL_KNOWN_CHANNEL_NAMES.includes(name);
}

// --- Replay policy (ours, not firmware) --------------------------------------
/**
 * The node's tick clocks run on uptime, so MeshMonitor cannot know where a
 * tick boundary fell. Both clocks repeat together every lcm(6, 5) = 30 min, so
 * the replay tries boot offsets across that span, one every 30 s.
 */
export const PHASE_PERIOD_MS = 1_800_000;
export const PHASE_STEP_MS = 30_000;
/** Sweep offsets tried inside one 60 s sweep interval (short windows only). */
export const SWEEP_PHASE_STEPS = 4;
/**
 * Rate limit needs this many full windows of history. With fewer, one window
 * edge moved by the unknown phase swings the answer more than the setting does.
 */
export const MIN_RATE_LIMIT_WINDOWS = 6;
/** Senders named in a breakdown; the rest fold into "other". */
export const TOP_SENDERS = 10;

// --- Types ------------------------------------------------------------------
export interface ReplaySettings {
  positionMinIntervalSecs: number;
  rateLimitWindowSecs: number;
  rateLimitMaxPackets: number;
}

export interface ReplayPacket {
  /** When MeshMonitor logged it, ms. Rows must be in ascending order. */
  timestampMs: number;
  from: number;
  to: number | null;
  /** Local channel index; null reads as 0 (the proto default). */
  channel: number | null;
  portnum: number;
  /**
   * True only when the NODE decoded the packet. An encrypted row, or one
   * MeshMonitor decrypted itself (`decrypted_by = 'server'`), was undecoded on
   * the node: `handleReceived` returns before either rule, so neither counts it.
   */
  decodedByNode: boolean;
  /** MeshMonitor decrypted it (reported, never simulated). */
  serverDecrypted?: boolean;
  /** Logged as our own transmission. */
  isTx?: boolean;
  /** POSITION rows only: the integer coordinates as received. */
  position?: { latitudeI: number; longitudeI: number } | null;
  /** The caller may not see this sender: count it, never name it. */
  senderHidden?: boolean;
  /** The caller may not see this packet's content: count it, never name its port. */
  portHidden?: boolean;
}

export interface ReplayChannel {
  /** `Channels::isWellKnownChannel`. Dedup runs on these channels only. */
  wellKnown: boolean;
  /** The channel's `position_precision` module setting; 0 or missing = unset. */
  positionPrecision: number;
}

export interface ReplayInput {
  loggingEnabled: boolean;
  packets: ReplayPacket[];
  /** True when the scan stopped at its row cap, so older rows were not read. */
  truncated: boolean;
  scanCap: number;
  /** What the node runs now. */
  current: ReplaySettings;
  /** What the form holds. */
  proposed: ReplaySettings;
  localNodeNum: number;
  channels: ReadonlyMap<number, ReplayChannel>;
  /** Device role per sender, as MeshMonitor last heard it. Missing = CLIENT. */
  senderRoles: ReadonlyMap<number, number>;
}

export type ReplayRefusalReason =
  | 'PACKET_LOG_DISABLED'
  | 'HISTORY_TOO_SHORT'
  | 'LOOSER_THAN_CURRENT';

export type ReplayCaveat =
  /** Always: traffic the node already drops is absent from the log. */
  | 'ALREADY_FILTERED_ABSENT'
  /** Always: the replay starts with an empty cache, which undercounts. */
  | 'EMPTY_CACHE_AT_START'
  /** Always: tick phase unknown, hence a range. */
  | 'TICK_PHASE_UNKNOWN'
  /** Always: reboots and cache eviction clear state; not modelled. */
  | 'CACHE_LOSS_NOT_MODELLED'
  /** Always: this node only, not the mesh. */
  | 'LOCAL_NODE_ONLY'
  /** Rate limit: the node also counts relayed direct messages we never see. */
  | 'RELAYED_UNICAST_INVISIBLE'
  /** A packet the node drops today could pass under the new setting. */
  | 'NET_CHANGE_MAY_BE_SMALLER'
  /** Dedup: role caps use the role MeshMonitor last heard. */
  | 'SENDER_ROLE_FROM_MESHMONITOR'
  /** Rows MeshMonitor decrypted were undecoded on the node and not counted. */
  | 'SERVER_DECRYPTED_NOT_COUNTED'
  /** The scan hit its cap; older history was not read. */
  | 'SCAN_TRUNCATED'
  /** The other rule could not be estimated and was held at the current value. */
  | 'OTHER_RULE_HELD_AT_CURRENT'
  /** The setting is short enough that the 60 s sweep resets it. */
  | 'SWEEP_RESETS_SHORT_WINDOW';

export interface EffectiveWindow {
  enabled: boolean;
  /** How the firmware treats the value, in ms (ticks, or the 60 s sweep). */
  effectiveMs: number;
  ticks: number;
  /** The sweep TTL is zero ticks, so state dies at every 60 s sweep. */
  sweepReset: boolean;
}

export interface EffectiveRateLimit extends EffectiveWindow {
  /** `min(maxPackets, 60)`. */
  threshold: number;
}

export interface BreakdownRow<K> {
  /** null = "other": senders or ports the caller may not see, plus the tail. */
  key: K | null;
  min: number;
  max: number;
}

interface RuleCommon {
  historySpanMs: number;
  requiredSpanMs: number;
}

export type RuleOutcome =
  | (RuleCommon & {
      status: 'estimate';
      /** Logged packets the proposed setting would drop and the current one does not. */
      droppedMin: number;
      droppedMax: number;
      /** Packets the rule looked at. */
      consideredPackets: number;
      /** `lower_bound`: real drops are likely higher. `logged_only`: see caveats. */
      bound: 'lower_bound' | 'logged_only';
      caveats: ReplayCaveat[];
      bySender: BreakdownRow<number>[];
      byPortnum: BreakdownRow<number>[];
    })
  | (RuleCommon & { status: 'cannot_estimate'; reason: ReplayRefusalReason })
  /** The proposed value acts exactly like the current one. Not an estimate. */
  | (RuleCommon & { status: 'unchanged' });

export interface ReplayResult {
  firmwareVersion: string;
  loggingEnabled: boolean;
  rowsScanned: number;
  truncated: boolean;
  scanCap: number;
  historyStartMs: number | null;
  historyEndMs: number | null;
  historySpanMs: number;
  phasesSampled: number;
  minRateLimitWindows: number;
  skipped: {
    ownPackets: number;
    addressedToNode: number;
    encrypted: number;
    serverDecrypted: number;
  };
  current: ReplaySettings;
  proposed: ReplaySettings;
  effective: {
    current: { positionDedup: EffectiveWindow; rateLimit: EffectiveRateLimit };
    proposed: { positionDedup: EffectiveWindow; rateLimit: EffectiveRateLimit };
  };
  positionDedup: RuleOutcome;
  rateLimit: RuleOutcome;
}

/** What `GET /api/packets/traffic-management/replay` returns. */
export interface TrafficReplayResponse extends ReplayResult {
  sourceId: string;
  /** Names for the senders the result names (all of them visible to the caller). */
  senders: Record<string, { nodeId: string; shortName: string | null; longName: string | null }>;
}

// --- Firmware arithmetic ----------------------------------------------------
/** `secsToMs`: saturates at UINT32_MAX. */
function secsToMs(secs: number): number {
  const ms = Math.max(0, Math.floor(secs)) * 1000;
  return ms > UINT32_MAX ? UINT32_MAX : ms;
}

/** A uint32 multiply as the firmware does it (wraps). */
function mulU32(value: number, factor: number): number {
  return (value * factor) % 0x1_0000_0000;
}

/** `truncateCoordinate` (PositionPrecision.cpp): mask, then move to the cell centre. */
export function truncateCoordinate(coordinate: number, precision: number): number {
  if (precision === 0 || precision >= 32) return coordinate | 0;
  const bits = coordinate >>> 0;
  const masked = (bits & ((UINT32_MAX << (32 - precision)) >>> 0)) >>> 0;
  return (masked + 2 ** (31 - precision)) | 0;
}

/** `sanitizePositionPrecision`: 1..32, else the 19-bit default. */
function sanitizePrecision(precision: number): number {
  return precision > 0 && precision <= 32 ? precision : DEFAULT_DEDUP_PRECISION_BITS;
}

/**
 * `computePositionFingerprint`: the low 4 significant bits of each truncated
 * coordinate, `(lat << 4) | lon`; a computed 0 becomes 0xFF (0 means "unseen").
 */
export function positionFingerprint(latitudeI: number, longitudeI: number, precision: number): number {
  const p = sanitizePrecision(precision);
  const lat = truncateCoordinate(latitudeI, p);
  const lon = truncateCoordinate(longitudeI, p);
  const bitsToTake = p < 4 ? p : 4;
  const shift = 32 - p;
  const mask = (1 << bitsToTake) - 1;
  const latBits = ((lat >>> 0) >>> shift) & mask;
  const lonBits = ((lon >>> 0) >>> shift) & mask;
  const fingerprint = ((latBits << 4) | lonBits) & 0xff;
  return fingerprint === 0 ? 0xff : fingerprint;
}

/**
 * The precision `shouldDropPosition` uses on a well-known channel: the
 * channel's own `position_precision`, capped at 15 bits because every
 * well-known channel uses a public key (`getPositionPrecisionForChannel`), or
 * the 19-bit module default when the channel has none set.
 */
export function dedupPrecisionForChannel(channel: ReplayChannel | undefined): number {
  const configured = channel?.positionPrecision ?? 0;
  if (!(configured > 0)) return DEFAULT_DEDUP_PRECISION_BITS;
  return sanitizePrecision(Math.min(configured, PUBLIC_CHANNEL_MAX_PRECISION_BITS));
}

type RoleClass = 0 | 1 | 2; // 0 = no cap, 1 = tracker, 2 = lost and found

function roleClass(role: number | undefined): RoleClass {
  if (role === ROLE_LOST_AND_FOUND) return 2;
  if (role === ROLE_TRACKER || role === ROLE_TAK_TRACKER) return 1;
  return 0;
}

/**
 * How the firmware treats a dedup interval for a sender of the given role.
 *
 * `shouldDropPosition`: `windowTicks = clamp(intervalMs / 6 min, 1, 255)`, so an
 * interval under 12 min is one tick. Trackers are capped at 1 h and
 * lost-and-found nodes at 15 min (a cap, never a floor). `runOnce` expires the
 * entry after `min(255, 4 * intervalMs / 6 min)` ticks, taken from the
 * UNCAPPED setting; for an interval under 90 s that TTL is zero ticks and the
 * 60 s sweep clears the entry every time it runs.
 */
export function effectivePositionDedup(intervalSecs: number, role?: number): EffectiveWindow {
  const configuredMs = secsToMs(intervalSecs);
  if (configuredMs === 0) return { enabled: false, effectiveMs: 0, ticks: 0, sweepReset: false };
  let ms = configuredMs;
  const cls = roleClass(role);
  if (cls === 2) ms = Math.min(ms, LOST_AND_FOUND_DEDUP_CAP_SECS * 1000);
  else if (cls === 1) ms = Math.min(ms, TRACKER_DEDUP_CAP_SECS * 1000);
  let ticks = Math.min(POS_MAX_WINDOW_TICKS, Math.max(1, Math.floor(ms / POS_TICK_MS)));
  const ttlTicks = Math.min(255, Math.floor(mulU32(configuredMs, 4) / POS_TICK_MS));
  if (ttlTicks === 0) return { enabled: true, effectiveMs: SWEEP_INTERVAL_MS, ticks: 1, sweepReset: true };
  ticks = Math.min(ticks, ttlTicks);
  return { enabled: true, effectiveMs: ticks * POS_TICK_MS, ticks, sweepReset: false };
}

/**
 * How the firmware treats a rate limit.
 *
 * `isRateLimited`: `windowTicks = clamp(windowMs / 5 min, 1, 15)`, so any window
 * under 10 min is one tick and nothing above 75 min counts; the threshold is
 * capped at 60. `runOnce` expires the counter after `min(15, 2 * windowMs /
 * 5 min)` ticks; for a window under 150 s that TTL is zero ticks and the 60 s
 * sweep zeroes the counter every time it runs.
 */
export function effectiveRateLimit(windowSecs: number, maxPackets: number): EffectiveRateLimit {
  const windowMs = secsToMs(windowSecs);
  const max = Math.max(0, Math.floor(maxPackets));
  if (windowMs === 0 || max === 0) {
    return { enabled: false, effectiveMs: 0, ticks: 0, sweepReset: false, threshold: 0 };
  }
  const threshold = Math.min(max, RATE_THRESHOLD_CAP);
  let ticks = Math.max(1, Math.min(RATE_MAX_WINDOW_TICKS, Math.floor(windowMs / RATE_TICK_MS)));
  const ttlTicks = Math.min(15, Math.floor(mulU32(windowMs, 2) / RATE_TICK_MS));
  if (ttlTicks === 0) {
    return { enabled: true, effectiveMs: SWEEP_INTERVAL_MS, ticks: 1, sweepReset: true, threshold };
  }
  ticks = Math.min(ticks, ttlTicks);
  return { enabled: true, effectiveMs: ticks * RATE_TICK_MS, ticks, sweepReset: false, threshold };
}

type Change = 'unchanged' | 'tighter' | 'looser';

function compareDedup(current: EffectiveWindow, proposed: EffectiveWindow): Change {
  if (!current.enabled && !proposed.enabled) return 'unchanged';
  if (current.enabled && !proposed.enabled) return 'looser';
  if (!current.enabled) return 'tighter';
  if (proposed.effectiveMs < current.effectiveMs) return 'looser';
  return proposed.effectiveMs === current.effectiveMs ? 'unchanged' : 'tighter';
}

function compareRate(current: EffectiveRateLimit, proposed: EffectiveRateLimit): Change {
  if (!current.enabled && !proposed.enabled) return 'unchanged';
  if (current.enabled && !proposed.enabled) return 'looser';
  if (!current.enabled) return 'tighter';
  // A higher threshold or a shorter window lets more through: either one makes
  // the change (at least partly) looser, and censored data cannot show that.
  if (proposed.threshold > current.threshold || proposed.effectiveMs < current.effectiveMs) return 'looser';
  return proposed.threshold === current.threshold && proposed.effectiveMs === current.effectiveMs
    ? 'unchanged'
    : 'tighter';
}

// --- The replay -------------------------------------------------------------
interface Prepared {
  n: number;
  ts: Float64Array;
  sender: Int32Array; // dense state index
  /** 0 = position with a fingerprint, 1 = other counted port, 2 = ROUTING/ADMIN. */
  kind: Uint8Array;
  fp: Uint8Array;
  role: Uint8Array;
  senderKey: Int32Array; // breakdown key index; 0 = other
  portKey: Int32Array; // breakdown key index; 0 = other
  /** Index of each prepared packet in the input list. */
  origin: Int32Array;
  senderCount: number;
  senderKeys: Array<number | null>;
  portKeys: Array<number | null>;
}

interface RuleSet {
  dedup: [EffectiveWindow, EffectiveWindow, EffectiveWindow]; // by role class
  rate: EffectiveRateLimit;
}

function ruleSet(settings: ReplaySettings): RuleSet {
  return {
    dedup: [
      effectivePositionDedup(settings.positionMinIntervalSecs),
      effectivePositionDedup(settings.positionMinIntervalSecs, ROLE_TRACKER),
      effectivePositionDedup(settings.positionMinIntervalSecs, ROLE_LOST_AND_FOUND),
    ],
    rate: effectiveRateLimit(settings.rateLimitWindowSecs, settings.rateLimitMaxPackets),
  };
}

/**
 * One pass of `handleReceived` over the prepared packets for one boot offset.
 * Writes 0 (passed), 1 (dedup drop) or 2 (rate-limit drop) per packet.
 *
 * Order matters and matches the firmware: dedup first; a position it drops
 * returns STOP and never reaches the limiter. A position that passes dedup is
 * stamped even if the limiter then drops it.
 */
function runPass(p: Prepared, rules: RuleSet, bootOffsetMs: number, sweepOffsetMs: number, verdict: Uint8Array): void {
  const posFp = new Uint8Array(p.senderCount);
  const posTick = new Float64Array(p.senderCount);
  const posSweep = new Float64Array(p.senderCount);
  const rateCount = new Uint8Array(p.senderCount);
  const rateTick = new Float64Array(p.senderCount);
  const rateSweep = new Float64Array(p.senderCount);
  const dedupOn = rules.dedup[0].enabled;
  const dedupSweepReset = rules.dedup[0].sweepReset;
  const rate = rules.rate;

  for (let i = 0; i < p.n; i++) {
    const s = p.sender[i];
    const uptime = p.ts[i] - bootOffsetMs;
    const sweepEpoch = Math.floor((uptime - sweepOffsetMs) / SWEEP_INTERVAL_MS);
    verdict[i] = 0;

    if (dedupOn && p.kind[i] === 0) {
      const nowTick = Math.floor(uptime / POS_TICK_MS);
      const windowTicks = rules.dedup[p.role[i]].ticks;
      const hasState = posFp[s] !== 0 && (!dedupSweepReset || posSweep[s] === sweepEpoch);
      const drop = hasState && posFp[s] === p.fp[i] && nowTick - posTick[s] < windowTicks;
      if (drop) {
        verdict[i] = 1;
        continue; // STOP: the limiter never sees it
      }
      // "Stamp only what we let through."
      posFp[s] = p.fp[i];
      posTick[s] = nowTick;
      posSweep[s] = sweepEpoch;
    }

    if (rate.enabled && p.kind[i] !== 2) {
      const nowTick = Math.floor(uptime / RATE_TICK_MS);
      const expired =
        rateCount[s] === 0 ||
        (rate.sweepReset && rateSweep[s] !== sweepEpoch) ||
        nowTick - rateTick[s] >= rate.ticks;
      if (expired) {
        rateTick[s] = nowTick;
        rateSweep[s] = sweepEpoch;
        rateCount[s] = 1;
      } else {
        if (rateCount[s] < RATE_COUNT_SATURATION) rateCount[s]++;
        if (rateCount[s] > rate.threshold) verdict[i] = 2;
      }
    }
  }
}

function emptySkipped(): ReplayResult['skipped'] {
  return { ownPackets: 0, addressedToNode: 0, encrypted: 0, serverDecrypted: 0 };
}

function prepare(input: ReplayInput, skipped: ReplayResult['skipped']): Prepared {
  const rows = input.packets;
  const ts: number[] = [];
  const sender: number[] = [];
  const kind: number[] = [];
  const fp: number[] = [];
  const role: number[] = [];
  const senderKey: number[] = [];
  const portKey: number[] = [];
  const origin: number[] = [];
  const senderIndex = new Map<number, number>();
  const senderKeyIndex = new Map<number, number>();
  const portKeyIndex = new Map<number, number>();
  const senderKeys: Array<number | null> = [null];
  const portKeys: Array<number | null> = [null];

  for (let index = 0; index < rows.length; index++) {
    const row = rows[index];
    // handleReceived: `!isFromUs(&mp) && !isToUs(&mp)` guards both rules.
    if (row.isTx || row.from === input.localNodeNum) {
      skipped.ownPackets++;
      continue;
    }
    if (row.to !== null && row.to === input.localNodeNum) {
      skipped.addressedToNode++;
      continue;
    }
    // handleReceived: a packet the node could not decode returns CONTINUE
    // before either rule (only the unknown-packet rule looks at it).
    if (!row.decodedByNode) {
      if (row.serverDecrypted) skipped.serverDecrypted++;
      else skipped.encrypted++;
      continue;
    }

    let s = senderIndex.get(row.from);
    if (s === undefined) {
      s = senderIndex.size;
      senderIndex.set(row.from, s);
    }

    let k = 1;
    let fingerprint = 0;
    if (row.portnum === PORT_ROUTING || row.portnum === PORT_ADMIN) {
      k = 2;
    } else if (row.portnum === PORT_POSITION && row.position) {
      // Dedup needs a well-known channel and both coordinates present.
      const channel = input.channels.get(row.channel ?? 0);
      if (channel?.wellKnown) {
        k = 0;
        fingerprint = positionFingerprint(
          row.position.latitudeI,
          row.position.longitudeI,
          dedupPrecisionForChannel(channel),
        );
      }
    }

    let sk = 0;
    if (!row.senderHidden) {
      sk = senderKeyIndex.get(row.from) ?? 0;
      if (sk === 0) {
        sk = senderKeys.length;
        senderKeys.push(row.from);
        senderKeyIndex.set(row.from, sk);
      }
    }
    let pk = 0;
    if (!row.portHidden) {
      pk = portKeyIndex.get(row.portnum) ?? 0;
      if (pk === 0) {
        pk = portKeys.length;
        portKeys.push(row.portnum);
        portKeyIndex.set(row.portnum, pk);
      }
    }

    ts.push(row.timestampMs);
    sender.push(s);
    kind.push(k);
    fp.push(fingerprint);
    role.push(roleClass(input.senderRoles.get(row.from)));
    senderKey.push(sk);
    portKey.push(pk);
    origin.push(index);
  }

  return {
    n: ts.length,
    ts: Float64Array.from(ts),
    sender: Int32Array.from(sender),
    kind: Uint8Array.from(kind),
    fp: Uint8Array.from(fp),
    role: Uint8Array.from(role),
    senderKey: Int32Array.from(senderKey),
    portKey: Int32Array.from(portKey),
    origin: Int32Array.from(origin),
    senderCount: senderIndex.size,
    senderKeys,
    portKeys,
  };
}

export type PacketVerdict = 'exempt' | 'pass' | 'dedup' | 'rate';

/**
 * Run the two rules once, at ONE known boot offset, and say what happened to
 * each packet. The node's real offset is unknown, so the estimate never uses a
 * single pass; this exists so the tests can pin the tick arithmetic.
 * `exempt` = neither rule looked at the packet.
 */
export function replayOnce(
  input: Pick<ReplayInput, 'packets' | 'localNodeNum' | 'channels' | 'senderRoles'>,
  settings: ReplaySettings,
  bootOffsetMs = 0,
  sweepOffsetMs = 0,
): PacketVerdict[] {
  const full: ReplayInput = {
    ...input,
    loggingEnabled: true,
    truncated: false,
    scanCap: input.packets.length,
    current: settings,
    proposed: settings,
  };
  const prepared = prepare(full, emptySkipped());
  const verdict = new Uint8Array(prepared.n);
  runPass(prepared, ruleSet(settings), bootOffsetMs, sweepOffsetMs, verdict);
  const out: PacketVerdict[] = input.packets.map(() => 'exempt');
  for (let i = 0; i < prepared.n; i++) {
    out[prepared.origin[i]] = verdict[i] === 1 ? 'dedup' : verdict[i] === 2 ? 'rate' : 'pass';
  }
  return out;
}

interface Tally {
  totals: number[];
  bySender: Int32Array[];
  byPort: Int32Array[];
}

function newTally(): Tally {
  return { totals: [], bySender: [], byPort: [] };
}

function breakdown<K>(perPhase: Int32Array[], keys: Array<K | null>, totals: number[], limit: number): BreakdownRow<K>[] {
  const phases = perPhase.length;
  const ranked: Array<{ index: number; min: number; max: number }> = [];
  for (let k = 1; k < keys.length; k++) {
    let min = Infinity;
    let max = 0;
    for (let ph = 0; ph < phases; ph++) {
      const v = perPhase[ph][k];
      if (v < min) min = v;
      if (v > max) max = v;
    }
    if (max > 0) ranked.push({ index: k, min, max });
  }
  ranked.sort((a, b) => b.max - a.max || b.min - a.min || a.index - b.index);
  const named = ranked.slice(0, limit);
  const rows: BreakdownRow<K>[] = named.map((r) => ({ key: keys[r.index] as K, min: r.min, max: r.max }));

  // "other" = hidden keys plus the tail, summed per phase so its range is real.
  let otherMin = Infinity;
  let otherMax = 0;
  for (let ph = 0; ph < phases; ph++) {
    let namedSum = 0;
    for (const r of named) namedSum += perPhase[ph][r.index];
    const other = totals[ph] - namedSum;
    if (other < otherMin) otherMin = other;
    if (other > otherMax) otherMax = other;
  }
  if (otherMax > 0) rows.push({ key: null, min: otherMin, max: otherMax });
  return rows;
}

function sortedByTime(packets: ReplayPacket[]): ReplayPacket[] {
  for (let i = 1; i < packets.length; i++) {
    if (packets[i].timestampMs < packets[i - 1].timestampMs) {
      return [...packets].sort((a, b) => a.timestampMs - b.timestampMs);
    }
  }
  return packets;
}

/**
 * Replay the log against the proposed settings.
 *
 * For each sampled boot offset it runs the firmware rules twice, once with the
 * node's current settings and once with the proposed ones, and counts a packet
 * only when the proposed run drops it and the current run does not. The answer
 * for a rule is the smallest and largest count over all offsets.
 *
 * A rule is estimated only when its proposed value is tighter than the current
 * one. Otherwise the outcome says why not, and the proposed run holds that rule
 * at the current value.
 */
export function simulateTrafficReplay(rawInput: ReplayInput): ReplayResult {
  const input: ReplayInput = { ...rawInput, packets: sortedByTime(rawInput.packets) };
  const rows = input.packets;
  const currentRules = ruleSet(input.current);
  const proposedRules = ruleSet(input.proposed);
  const historyStartMs = rows.length > 0 ? rows[0].timestampMs : null;
  const historyEndMs = rows.length > 0 ? rows[rows.length - 1].timestampMs : null;
  const historySpanMs = historyStartMs !== null && historyEndMs !== null ? historyEndMs - historyStartMs : 0;

  const dedupRequired = proposedRules.dedup[0].effectiveMs;
  const rateRequired = proposedRules.rate.effectiveMs * MIN_RATE_LIMIT_WINDOWS;
  const dedupCommon: RuleCommon = { historySpanMs, requiredSpanMs: dedupRequired };
  const rateCommon: RuleCommon = { historySpanMs, requiredSpanMs: rateRequired };

  const decide = (change: Change, common: RuleCommon): RuleOutcome | null => {
    if (!input.loggingEnabled) return { ...common, status: 'cannot_estimate', reason: 'PACKET_LOG_DISABLED' };
    if (change === 'unchanged') return { ...common, status: 'unchanged' };
    if (change === 'looser') return { ...common, status: 'cannot_estimate', reason: 'LOOSER_THAN_CURRENT' };
    if (rows.length === 0 || historySpanMs < common.requiredSpanMs) {
      return { ...common, status: 'cannot_estimate', reason: 'HISTORY_TOO_SHORT' };
    }
    return null; // estimate it
  };

  const dedupDecision = decide(compareDedup(currentRules.dedup[0], proposedRules.dedup[0]), dedupCommon);
  const rateDecision = decide(compareRate(currentRules.rate, proposedRules.rate), rateCommon);

  const skipped = emptySkipped();
  const base: Omit<ReplayResult, 'positionDedup' | 'rateLimit' | 'phasesSampled'> = {
    firmwareVersion: TMM_MIRROR_FIRMWARE_VERSION,
    loggingEnabled: input.loggingEnabled,
    rowsScanned: rows.length,
    truncated: input.truncated,
    scanCap: input.scanCap,
    historyStartMs,
    historyEndMs,
    historySpanMs,
    minRateLimitWindows: MIN_RATE_LIMIT_WINDOWS,
    skipped,
    current: input.current,
    proposed: input.proposed,
    effective: {
      current: { positionDedup: currentRules.dedup[0], rateLimit: currentRules.rate },
      proposed: { positionDedup: proposedRules.dedup[0], rateLimit: proposedRules.rate },
    },
  };

  const prepared = prepare(input, skipped);

  if (dedupDecision && rateDecision) {
    return { ...base, phasesSampled: 0, positionDedup: dedupDecision, rateLimit: rateDecision };
  }

  // The proposed run uses the proposed value only for a rule being estimated
  // (or one that acts the same anyway); a refused rule stays at the current value.
  const useProposedDedup = dedupDecision === null || dedupDecision.status === 'unchanged';
  const useProposedRate = rateDecision === null || rateDecision.status === 'unchanged';
  const runRules: RuleSet = {
    dedup: useProposedDedup ? proposedRules.dedup : currentRules.dedup,
    rate: useProposedRate ? proposedRules.rate : currentRules.rate,
  };
  const baselineActive = currentRules.dedup[0].enabled || currentRules.rate.enabled;
  const anySweepReset =
    runRules.dedup[0].sweepReset || runRules.rate.sweepReset ||
    currentRules.dedup[0].sweepReset || currentRules.rate.sweepReset;
  const sweepSteps = anySweepReset ? SWEEP_PHASE_STEPS : 1;

  const dedupTally = newTally();
  const rateTally = newTally();
  const verdictNew = new Uint8Array(prepared.n);
  const verdictNow = new Uint8Array(prepared.n);
  let phases = 0;

  for (let boot = 0; boot < PHASE_PERIOD_MS; boot += PHASE_STEP_MS) {
    for (let step = 0; step < sweepSteps; step++) {
      const sweepOffset = (step * SWEEP_INTERVAL_MS) / sweepSteps;
      runPass(prepared, runRules, boot, sweepOffset, verdictNew);
      if (baselineActive) runPass(prepared, currentRules, boot, sweepOffset, verdictNow);

      const dedupSenders = new Int32Array(prepared.senderKeys.length);
      const dedupPorts = new Int32Array(prepared.portKeys.length);
      const rateSenders = new Int32Array(prepared.senderKeys.length);
      const ratePorts = new Int32Array(prepared.portKeys.length);
      let dedupTotal = 0;
      let rateTotal = 0;
      for (let i = 0; i < prepared.n; i++) {
        const v = verdictNew[i];
        if (v === 0 || verdictNow[i] !== 0) continue; // only what tightening adds
        if (v === 1) {
          dedupTotal++;
          dedupSenders[prepared.senderKey[i]]++;
          dedupPorts[prepared.portKey[i]]++;
        } else {
          rateTotal++;
          rateSenders[prepared.senderKey[i]]++;
          ratePorts[prepared.portKey[i]]++;
        }
      }
      dedupTally.totals.push(dedupTotal);
      dedupTally.bySender.push(dedupSenders);
      dedupTally.byPort.push(dedupPorts);
      rateTally.totals.push(rateTotal);
      rateTally.bySender.push(rateSenders);
      rateTally.byPort.push(ratePorts);
      phases++;
    }
  }

  let dedupConsidered = 0;
  let rateConsidered = 0;
  for (let i = 0; i < prepared.n; i++) {
    if (prepared.kind[i] === 0) dedupConsidered++;
    if (prepared.kind[i] !== 2) rateConsidered++;
  }

  const sharedCaveats: ReplayCaveat[] = [
    'ALREADY_FILTERED_ABSENT',
    'EMPTY_CACHE_AT_START',
    'TICK_PHASE_UNKNOWN',
    'CACHE_LOSS_NOT_MODELLED',
    'LOCAL_NODE_ONLY',
  ];
  if (input.truncated) sharedCaveats.push('SCAN_TRUNCATED');
  if (skipped.serverDecrypted > 0) sharedCaveats.push('SERVER_DECRYPTED_NOT_COUNTED');

  const estimate = (
    tally: Tally,
    common: RuleCommon,
    considered: number,
    bound: 'lower_bound' | 'logged_only',
    extra: ReplayCaveat[],
  ): RuleOutcome => ({
    ...common,
    status: 'estimate',
    droppedMin: Math.min(...tally.totals),
    droppedMax: Math.max(...tally.totals),
    consideredPackets: considered,
    bound,
    caveats: [...sharedCaveats, ...extra],
    bySender: breakdown<number>(tally.bySender, prepared.senderKeys, tally.totals, TOP_SENDERS),
    byPortnum: breakdown<number>(tally.byPort, prepared.portKeys, tally.totals, TOP_SENDERS),
  });

  const refused = (o: RuleOutcome | null): boolean => o !== null && o.status === 'cannot_estimate';

  const dedupExtra: ReplayCaveat[] = ['NET_CHANGE_MAY_BE_SMALLER', 'SENDER_ROLE_FROM_MESHMONITOR'];
  if (proposedRules.dedup[0].sweepReset) dedupExtra.push('SWEEP_RESETS_SHORT_WINDOW');
  if (refused(rateDecision)) dedupExtra.push('OTHER_RULE_HELD_AT_CURRENT');

  const rateExtra: ReplayCaveat[] = ['RELAYED_UNICAST_INVISIBLE'];
  // With the limiter already on, a different window moves every window edge,
  // so a packet the node drops today (and we cannot see) might pass instead.
  if (currentRules.rate.enabled && proposedRules.rate.effectiveMs !== currentRules.rate.effectiveMs) {
    rateExtra.push('NET_CHANGE_MAY_BE_SMALLER');
  }
  if (proposedRules.rate.sweepReset) rateExtra.push('SWEEP_RESETS_SHORT_WINDOW');
  if (refused(dedupDecision)) rateExtra.push('OTHER_RULE_HELD_AT_CURRENT');

  return {
    ...base,
    phasesSampled: phases,
    positionDedup: dedupDecision ?? estimate(dedupTally, dedupCommon, dedupConsidered, 'logged_only', dedupExtra),
    rateLimit: rateDecision ?? estimate(rateTally, rateCommon, rateConsidered, 'lower_bound', rateExtra),
  };
}
