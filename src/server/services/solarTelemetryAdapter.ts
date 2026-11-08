/**
 * Maps MeshCore telemetry onto the Meshtastic solar analysis (#6260 P5).
 *
 * `identifySolarNodes` keys on `nodeNum` and understands the Meshtastic type
 * names `voltage` and `chNVoltage` (any non-`voltage` type ending in
 * `Voltage` counts as an INA channel). MeshCore telemetry rows use `mc_*`
 * types and carry the pubkey in `nodeId`, so this adapter renames the types
 * and keys each row on the synthetic `nodeNumFromPubkey(nodeId)`.
 *
 * That synthetic number has ~1 in 2^31 odds of colliding with a Meshtastic
 * nodeNum. The collision is accepted; solar overrides key on it the same way
 * telemetry does.
 *
 * Pure: no database access.
 */
import { nodeNumFromPubkey } from '../../utils/meshcoreNodeNum.js';
import type { NodeNameLookup, SolarTelemetryRow } from './solarAnalysis.js';

/** Highest MeshCore multi-channel index (matches the dashboard's channel list). */
const MAX_CHANNEL = 8;

/** Raw MeshCore telemetry types the solar analysis can use. */
export const MESHCORE_SOLAR_TYPES: readonly string[] = [
  'mc_battery_volts',
  'mc_status_battery_volts',
  ...Array.from({ length: MAX_CHANNEL }, (_, i) => `mc_voltage_ch${i + 1}`),
  ...Array.from({ length: MAX_CHANNEL }, (_, i) => `mc_battery_volts_ch${i + 1}`),
];

const SOLAR_TYPE_SET = new Set(MESHCORE_SOLAR_TYPES);

/**
 * Map a MeshCore telemetry type to the Meshtastic name the solar analysis
 * reads, or null when the type is not solar-relevant.
 */
export function normalizeSolarType(type: string): string | null {
  if (!SOLAR_TYPE_SET.has(type)) return null;
  if (type === 'mc_battery_volts' || type === 'mc_status_battery_volts') return 'voltage';
  let m = /^mc_voltage_ch(\d+)$/.exec(type);
  if (m) return `ch${m[1]}Voltage`;
  m = /^mc_battery_volts_ch(\d+)$/.exec(type);
  if (m) return `ch${m[1]}BatteryVoltage`;
  return null;
}

/** A MeshCore telemetry row as stored (`nodeId` = public key). */
export interface MeshCoreTelemetryInput {
  nodeId: string;
  telemetryType: string;
  timestamp: number;
  value: number | null;
}

/** Convert stored MeshCore telemetry rows to solar-analysis rows. */
export function meshCoreSolarRows(rows: readonly MeshCoreTelemetryInput[]): SolarTelemetryRow[] {
  const out: SolarTelemetryRow[] = [];
  for (const r of rows) {
    if (typeof r.value !== 'number' || !Number.isFinite(r.value)) continue;
    const telemetryType = normalizeSolarType(r.telemetryType);
    if (!telemetryType) continue;
    const nodeNum = nodeNumFromPubkey(r.nodeId);
    if (!nodeNum) continue;
    out.push({ nodeNum, telemetryType, timestamp: Number(r.timestamp), value: r.value });
  }
  return out;
}

/** A MeshCore node row, reduced to what name lookup and overrides need. */
export interface MeshCoreNodeInput {
  sourceId: string;
  publicKey: string;
  name?: string | null;
}

/**
 * Name lookups for MeshCore nodes, keyed on the synthetic nodeNum. Meshtastic
 * names win on a collision: `existing` entries are never replaced.
 */
export function meshCoreNameLookups(
  nodes: readonly MeshCoreNodeInput[],
  existing: readonly NodeNameLookup[] = [],
): NodeNameLookup[] {
  // Only a NAMED entry blocks: a nameless row would otherwise hide the MeshCore name.
  const taken = new Set(existing.filter((n) => n.longName || n.shortName).map((n) => n.nodeNum));
  const out: NodeNameLookup[] = [];
  for (const n of nodes) {
    const nodeNum = nodeNumFromPubkey(n.publicKey);
    if (!nodeNum || taken.has(nodeNum)) continue;
    taken.add(nodeNum);
    out.push({ nodeNum, longName: n.name ?? null, shortName: null });
  }
  return out;
}
