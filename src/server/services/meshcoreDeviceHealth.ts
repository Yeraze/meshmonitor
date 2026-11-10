/**
 * MeshCore device-health detection seam (#4558 follow-up).
 *
 * The Meshtastic device-health triggers detect a reboot at the telemetry-save
 * seam in `meshtasticManager.detectRebootFromUptime`. MeshCore has no single
 * telemetry-save method — uptime is written from TWO services (the local-node
 * poller and the remote-telemetry scheduler) — so this shared helper is called
 * from both. It mirrors the Meshtastic logic exactly: read the PRIOR stored
 * uptime for the node from the DB (a durable baseline, so a MeshMonitor restart
 * can never spuriously fire), compare via the same {@link isUptimeReboot} helper,
 * and on a genuine reset emit `node:rebooted` for the automation engine.
 *
 * MeshCore identity is a public key, not a Meshtastic node number, so the emit
 * carries `nodeNum: null` + the pubkey. Detection reads the DB only; it sends no
 * packets, so it costs zero airtime. Must run BEFORE the new uptime row is
 * inserted, so the "latest" it reads is genuinely the prior reading.
 */
import { dataEventEmitter } from './dataEventEmitter.js';
import { isUptimeReboot } from '../utils/rebootDetection.js';
import {
  isPoweredMv,
  detectPowerTransition,
  POWERED_BATTERY_LEVEL_THRESHOLD,
} from '../utils/poweredState.js';
import { nodeNumFromPubkey } from '../../utils/meshcoreNodeNum.js';
import { logger } from '../../utils/logger.js';

/** The one telemetry-repo method this helper needs. Optional so test/mock
 *  databases that don't wire it simply never fire a reboot (prior stays null).
 *  A minimal structural return type (just `value`) so both `DbTelemetry` type
 *  flavours in the tree — services/database vs db/types, which differ only in
 *  `unit`'s nullability — satisfy it. */
export interface RebootDetectionTelemetry {
  getLatestTelemetryForType?: (
    nodeId: string,
    telemetryType: string,
    sourceId?: string,
  ) => Promise<{ value: number } | null>;
}

/**
 * Detect a MeshCore node reboot from an incoming uptime reading and emit
 * `node:rebooted` when it is a genuine reset.
 *
 * @param telemetry  telemetry repository (uses `getLatestTelemetryForType`)
 * @param publicKey  the node's MeshCore public key (its `nodeId` in telemetry)
 * @param uptimeTelemetryType  the uptime metric name — `mc_uptime_secs` (local
 *   poller) or `mc_status_uptime_secs` (remote scheduler)
 * @param newUptimeSeconds  the uptime value about to be inserted
 * @param sourceId  the MeshCore source id (scopes the prior-uptime read)
 */
export async function detectMeshCoreReboot(
  telemetry: RebootDetectionTelemetry,
  publicKey: string,
  uptimeTelemetryType: string,
  newUptimeSeconds: number,
  sourceId: string,
): Promise<void> {
  try {
    if (!telemetry.getLatestTelemetryForType) return;
    if (!Number.isFinite(newUptimeSeconds)) return;
    const prior = await telemetry.getLatestTelemetryForType(publicKey, uptimeTelemetryType, sourceId);
    const priorUptime = prior ? Number(prior.value) : null;
    if (!isUptimeReboot(priorUptime, newUptimeSeconds)) return;
    logger.info(
      `🔁 MeshCore node ${publicKey.substring(0, 12)}… reboot detected: ` +
        `uptime ${priorUptime}s → ${newUptimeSeconds}s (source ${sourceId})`,
    );
    dataEventEmitter.emitNodeRebooted(
      { nodeNum: null, publicKey, previousUptimeSeconds: priorUptime as number, uptimeSeconds: newUptimeSeconds },
      sourceId,
    );
  } catch (e) {
    logger.warn(
      `MeshCore reboot detection failed for ${publicKey.substring(0, 12)}…: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

/** The one telemetry-repo method the power-change helper needs. Same structural
 *  shape as {@link RebootDetectionTelemetry} (a minimal `{ value }` return so
 *  both `DbTelemetry` type flavours satisfy it), kept as a distinct name so the
 *  battery seam reads clearly. Optional so mock DBs that don't wire it simply
 *  never fire (prior stays null). */
export interface PowerChangeDetectionTelemetry {
  getLatestTelemetryForType?: (
    nodeId: string,
    telemetryType: string,
    sourceId?: string,
  ) => Promise<{ value: number } | null>;
}

/**
 * Detect a MeshCore node external-power transition from an incoming battery
 * voltage reading and emit `node:powerChanged` when the powered-state flips.
 *
 * EXPERIMENTAL / HEURISTIC. Unlike Meshtastic (where the firmware overloads
 * `battery_level > 100` as an explicit "powered" flag), MeshCore reports only
 * raw battery voltage. A full or charging Li-ion cell reads ~4.2 V, which is
 * indistinguishable from wall/USB power, so this can misfire — a battery topping
 * up to full looks like "power restored", a battery falling off float looks like
 * "power lost". See {@link MESHCORE_POWERED_MV_THRESHOLD} for the full caveat.
 *
 * Mirrors {@link detectMeshCoreReboot}: reads the node's PRIOR battery voltage
 * from the DB (a durable baseline, so a MeshMonitor restart can never spuriously
 * fire), derives prior/next powered-states via {@link isPoweredMv}, and emits on
 * a genuine transition with `nodeNum: null` + the pubkey. DB read only — no
 * packet, zero airtime. Must run BEFORE the new battery row is inserted so the
 * "latest" it reads is genuinely the prior reading.
 *
 * The prior is read from `batteryTelemetryType`, whose value is multiplied by
 * `priorValueToMvScale` to normalise to millivolts, because the two callers
 * store battery under different metrics/units: the local poller writes
 * `mc_battery_mv` (mV, scale 1); the remote scheduler writes
 * `mc_status_battery_volts` (V, scale 1000).
 *
 * @param telemetry  telemetry repository (uses `getLatestTelemetryForType`)
 * @param publicKey  the node's MeshCore public key (its `nodeId` in telemetry)
 * @param batteryTelemetryType  the battery metric name to read the prior from
 * @param priorValueToMvScale  factor to convert the stored prior value to mV
 *   (1 for `mc_battery_mv`, 1000 for `mc_status_battery_volts`)
 * @param newBatteryMv  the incoming battery voltage, in millivolts
 * @param sourceId  the MeshCore source id (scopes the prior-battery read)
 */
export async function detectMeshCorePowerChange(
  telemetry: PowerChangeDetectionTelemetry,
  publicKey: string,
  batteryTelemetryType: string,
  priorValueToMvScale: number,
  newBatteryMv: number | null,
  sourceId: string,
): Promise<void> {
  try {
    if (!telemetry.getLatestTelemetryForType) return;
    if (newBatteryMv == null || !Number.isFinite(newBatteryMv)) return;
    const prior = await telemetry.getLatestTelemetryForType(publicKey, batteryTelemetryType, sourceId);
    const priorBatteryMv = prior ? Number(prior.value) * priorValueToMvScale : null;

    // Reuse detectPowerTransition — its null-prior guard IS the restart-safety
    // mechanism (no baseline ⇒ no transition). It classifies via the Meshtastic
    // isPowered(>100) rule, so map each MeshCore powered-state (from isPoweredMv)
    // to a sentinel level that rule agrees with: powered → above the threshold,
    // on-battery → 0.
    const poweredLevel = (p: boolean) => (p ? POWERED_BATTERY_LEVEL_THRESHOLD + 1 : 0);
    const priorLevel = priorBatteryMv == null ? null : poweredLevel(isPoweredMv(priorBatteryMv));
    const direction = detectPowerTransition(priorLevel, poweredLevel(isPoweredMv(newBatteryMv)));
    if (direction === null) return;

    const previousPowered = isPoweredMv(priorBatteryMv);
    const powered = isPoweredMv(newBatteryMv);
    logger.info(
      `🔌 MeshCore node ${publicKey.substring(0, 12)}… power ${direction} (HEURISTIC): ` +
        `battery ${priorBatteryMv}mV → ${newBatteryMv}mV ` +
        `(powered ${previousPowered} → ${powered}, source ${sourceId})`,
    );
    dataEventEmitter.emitNodePowerChanged(
      { nodeNum: null, publicKey, previousPowered, powered, batteryLevel: newBatteryMv },
      sourceId,
    );
  } catch (e) {
    logger.warn(
      `MeshCore power-change detection failed for ${publicKey.substring(0, 12)}…: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

/** The telemetry type that stores clock offsets (server time minus node time, in seconds). */
export const CLOCK_OFFSET_TELEMETRY_TYPE = 'mc_rtc_drift_secs';

/** Stored clock samples per key and source: at most one an hour from adverts. */
export const CLOCK_SAMPLE_MIN_INTERVAL_MS = 60 * 60 * 1000;

/** Telemetry methods {@link detectClockOffset} needs. Optional so mock DBs that
 *  lack them simply record nothing. */
export interface ClockOffsetTelemetry {
  getTelemetryByNode?: (
    nodeId: string,
    limit?: number,
    sinceTimestamp?: number,
    beforeTimestamp?: number,
    offset?: number,
    telemetryType?: string,
    sourceId?: string,
  ) => Promise<Array<{ value: number; timestamp: number }>>;
  insertTelemetry?: (
    row: {
      nodeId: string;
      nodeNum: number;
      telemetryType: string;
      value: number;
      unit?: string;
      timestamp: number;
      createdAt: number;
    },
    sourceId?: string,
  ) => Promise<boolean>;
}

/** Last stored advert sample per `sourceId:publicKey`. Limits storage only, so
 *  it does not need to survive a restart (the alert history is in telemetry). */
const lastAdvertSampleAt = new Map<string, number>();
const CLOCK_THROTTLE_MAX_KEYS = 5000;

/** Test hook: forget the storage throttle. */
export function resetClockOffsetThrottleForTests(): void {
  lastAdvertSampleAt.clear();
}

/**
 * Record one passive clock sample for a MeshCore node and emit
 * `node:clockOffset` for `trigger.clockOutOfSync` (#6273).
 *
 * `offsetSeconds` is receipt time minus the node's own time (positive = the node
 * is behind). The callers must pass only samples that are safe to trust: a
 * Repeater advert whose signature verified, an advert the Companion firmware
 * accepted, or the attached device's own clock.
 *
 * - `advert` samples: dropped when the sender time is not newer than the newest
 *   stored sample's (a replay, or a duplicate copy a flood makes), and stored at
 *   most once an hour per node. The row is inserted here.
 * - `device` samples: read from the attached device itself, so no replay or
 *   throttle rule applies, and the CALLER stores the row (the telemetry poller
 *   writes it in its own batch, as it always did). This only reads the prior
 *   samples and emits, so it must run before that batch is inserted.
 *
 * Reads and writes the DB only; it sends no packets.
 *
 * @returns true when a sample was accepted
 */
export async function detectClockOffset(
  telemetry: ClockOffsetTelemetry,
  publicKey: string,
  offsetSeconds: number,
  sampleSource: 'advert' | 'device',
  senderSec: number,
  sourceId: string,
  receivedAtMs: number = Date.now(),
): Promise<boolean> {
  try {
    if (!telemetry?.getTelemetryByNode) return false;
    if (!Number.isFinite(offsetSeconds) || !Number.isFinite(senderSec)) return false;
    const key = `${sourceId}:${publicKey}`;
    if (sampleSource === 'advert') {
      // A zero stamp cannot be told from a repeat, so it is never sampled.
      if (!(senderSec > 0)) return false;
      const last = lastAdvertSampleAt.get(key);
      if (last !== undefined && receivedAtMs - last < CLOCK_SAMPLE_MIN_INTERVAL_MS) return false;
    }

    const stored = await telemetry.getTelemetryByNode(
      publicKey, 3, undefined, undefined, 0, CLOCK_OFFSET_TELEMETRY_TYPE, sourceId,
    );
    // Newest first. A row's sender time is its receipt second minus its offset.
    const sorted = [...stored].sort((a, b) => Number(b.timestamp) - Number(a.timestamp));
    if (sampleSource === 'advert' && sorted.length > 0) {
      const newest = sorted[0];
      const newestSender = Math.floor(Number(newest.timestamp) / 1000) - Number(newest.value);
      if (senderSec <= newestSender) return false;
    }

    const previousOffsets = sorted.slice(0, 2).map((r) => Number(r.value));
    if (sampleSource === 'advert') {
      if (!telemetry.insertTelemetry) return false;
      await telemetry.insertTelemetry(
        {
          nodeId: publicKey,
          nodeNum: nodeNumFromPubkey(publicKey),
          telemetryType: CLOCK_OFFSET_TELEMETRY_TYPE,
          value: offsetSeconds,
          unit: 's',
          timestamp: receivedAtMs,
          createdAt: receivedAtMs,
        },
        sourceId,
      );
      if (lastAdvertSampleAt.size >= CLOCK_THROTTLE_MAX_KEYS) lastAdvertSampleAt.clear();
      lastAdvertSampleAt.set(key, receivedAtMs);
    }

    dataEventEmitter.emitNodeClockOffset({ publicKey, offsetSeconds, previousOffsets, sampleSource }, sourceId);
    return true;
  } catch (e) {
    logger.warn(
      `MeshCore clock offset sampling failed for ${publicKey.substring(0, 12)}…: ${e instanceof Error ? e.message : String(e)}`,
    );
    return false;
  }
}
