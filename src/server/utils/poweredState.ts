/**
 * Powered-state derivation for Device Health (#4558 Phase C).
 *
 * Meshtastic's `DeviceMetrics.battery_level` overloads a percentage field to
 * ALSO signal external power: the firmware convention is that a value ABOVE 100
 * (in practice 101) means "powered" — running on USB / wall power, or a charging
 * pack with no distinguishable battery percentage. Values 0–100 are a genuine
 * battery charge at that percent.
 *
 * So a node's power source flips between "on battery" and "powered" purely as a
 * function of whether its latest battery_level reading crossed the 100 mark. We
 * detect that transition at the telemetry-save seam by comparing each new
 * reading against the node's PRIOR stored batteryLevel (read from the DB, so a
 * MeshMonitor restart can never spuriously fire — the baseline is the durable
 * row, not in-memory state; CLAUDE.md mesh-impact checklist §3). Detection reads
 * the DB only and sends no packets, so it costs zero airtime.
 *
 * CAVEAT (documented in the trigger help text too): 101 CONFLATES "USB / no
 * battery" with "charging". It is a powered-state signal, not a clean "on wall
 * power vs. on battery" flag — a node that is charging its own battery also
 * reports > 100.
 */

/** The firmware threshold: battery_level strictly ABOVE this means "powered". */
export const POWERED_BATTERY_LEVEL_THRESHOLD = 100;

/**
 * True when `batteryLevel` represents a powered node (external / USB, or charging
 * with no distinguishable battery) — i.e. a finite value above the firmware's
 * 100 threshold. A missing / non-finite reading is treated as NOT powered (we
 * have no evidence of external power), and never as a transition on its own —
 * transitions are gated by {@link detectPowerTransition}'s null-prior guard.
 */
export function isPowered(batteryLevel: number | null | undefined): boolean {
  if (batteryLevel == null || !Number.isFinite(batteryLevel)) return false;
  return batteryLevel > POWERED_BATTERY_LEVEL_THRESHOLD;
}

/**
 * Classify the power transition between a node's prior and new batteryLevel
 * readings:
 *  - `'lost'`     — was powered, now on battery (external power lost);
 *  - `'restored'` — was on battery, now powered (external power restored);
 *  - `null`       — no transition (both states equal), OR there is no prior
 *                   reading to compare against (first-ever reading for a node),
 *                   OR the new reading is non-finite.
 *
 * The null-prior guard is the restart-safety mechanism: with no baseline there
 * is no transition to detect, so the first reading after a MeshMonitor restart
 * (or the first reading ever) never fires.
 */
export function detectPowerTransition(
  priorBatteryLevel: number | null | undefined,
  newBatteryLevel: number | null | undefined,
): 'lost' | 'restored' | null {
  // First-ever reading (no durable prior): nothing to transition FROM.
  if (priorBatteryLevel == null || !Number.isFinite(priorBatteryLevel)) return null;
  // A non-finite new reading is not a usable state to transition TO.
  if (newBatteryLevel == null || !Number.isFinite(newBatteryLevel)) return null;
  const wasPowered = isPowered(priorBatteryLevel);
  const nowPowered = isPowered(newBatteryLevel);
  if (wasPowered === nowPowered) return null;
  return nowPowered ? 'restored' : 'lost';
}

/**
 * MeshCore powered-voltage threshold, in millivolts (#4558 MeshCore parity).
 *
 * HEURISTIC — READ THIS BEFORE RELYING ON IT. MeshCore firmware exposes NO
 * "on external power" flag the way Meshtastic overloads `battery_level > 100`.
 * All we have is the raw battery voltage. A single-cell Li-ion battery that is
 * full OR actively charging sits at ~4.2 V, which is INDISTINGUISHABLE from a
 * node wired to wall/USB power. So we treat ">= 4200 mV" as "powered" and infer
 * lost/restored transitions from voltage crossing that line.
 *
 * The consequence: false transitions are EXPECTED. A battery that charges up to
 * full looks like "external power restored"; one that drops off the charger's
 * float looks like "external power lost". This is why the trigger help text and
 * the catalog label this MeshCore path experimental.
 */
export const MESHCORE_POWERED_MV_THRESHOLD = 4200;

/**
 * True when a MeshCore battery voltage reading (millivolts) is at/above the
 * powered threshold — see {@link MESHCORE_POWERED_MV_THRESHOLD} for the heavy
 * caveat that this cannot actually distinguish wall power from a full/charging
 * battery. A missing / non-finite reading is treated as NOT powered (no evidence
 * of external power), and never as a transition on its own — transitions are
 * gated by {@link detectPowerTransition}'s null-prior guard.
 */
export function isPoweredMv(batteryMv: number | null | undefined): boolean {
  if (batteryMv == null || !Number.isFinite(batteryMv)) return false;
  return batteryMv >= MESHCORE_POWERED_MV_THRESHOLD;
}
