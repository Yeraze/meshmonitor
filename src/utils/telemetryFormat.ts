/**
 * Telemetry value/unit display helpers shared across the telemetry table,
 * charts, gauges and numeric widgets.
 *
 * Two concerns live here:
 *   1. Auto-scaling SI-prefixed measurements (current, power) so small
 *      values read naturally — e.g. 0.45 A → 450 mA, 0.012 W → 12 mW,
 *      2500 W → 2.5 kW. See issue #3261: MeshCore stores current in A and
 *      power in W, but real-world mesh values sit well below 1, making the
 *      raw "0.01 A" readout useless.
 *   2. Human-readable durations (uptime in seconds → "3d 4h").
 *
 * The scaling is magnitude-driven and family-based: a value's unit decides
 * which prefix ladder it belongs to, and a representative magnitude picks
 * the largest prefix that keeps the displayed number >= 1.
 */

export interface UnitScale {
  /** Multiply a value (in the input unit) by this to get the display value. */
  factor: number;
  /** The display unit string (may differ from the input unit). */
  unit: string;
}

// Each scalable unit maps to a base unit and its size expressed in that base.
const UNIT_FAMILIES: Record<string, { base: string; toBase: number }> = {
  mA: { base: 'A', toBase: 1e-3 },
  A: { base: 'A', toBase: 1 },
  mW: { base: 'W', toBase: 1e-3 },
  W: { base: 'W', toBase: 1 },
  kW: { base: 'W', toBase: 1e3 },
};

// Prefix ladders per base unit, smallest → largest. `mult` is the value of
// one display unit expressed in the base unit (display = baseValue / mult).
const PREFIX_LADDERS: Record<string, Array<{ unit: string; mult: number }>> = {
  A: [
    { unit: 'mA', mult: 1e-3 },
    { unit: 'A', mult: 1 },
  ],
  W: [
    { unit: 'mW', mult: 1e-3 },
    { unit: 'W', mult: 1 },
    { unit: 'kW', mult: 1e3 },
  ],
};

/**
 * Pick the most readable prefix for a measurement.
 *
 * @param unit              the unit the stored value is expressed in
 * @param representativeAbs a magnitude (in the *input* unit) used to choose
 *                          the prefix — typically `Math.abs(value)` for a
 *                          single reading, or the series max for a chart so
 *                          every point shares one scale.
 * @returns a factor + display unit. Non-scalable units return `{factor: 1}`
 *          with the unit unchanged.
 */
export function unitScale(unit: string, representativeAbs: number): UnitScale {
  const family = UNIT_FAMILIES[unit];
  if (!family || !Number.isFinite(representativeAbs)) {
    return { factor: 1, unit };
  }
  const ladder = PREFIX_LADDERS[family.base];
  if (!ladder) return { factor: 1, unit };

  // Representative magnitude expressed in the base unit.
  const baseAbs = Math.abs(representativeAbs) * family.toBase;

  // Largest prefix whose unit-size still keeps the display number >= 1.
  let chosen = ladder[0];
  for (const step of ladder) {
    if (baseAbs >= step.mult) chosen = step;
  }

  // display = baseValue / chosen.mult = (inputValue * toBase) / chosen.mult
  return { factor: family.toBase / chosen.mult, unit: chosen.unit };
}

/** Scale a single measurement to its most readable prefix. */
export function scaleMeasurement(value: number, unit: string): { value: number; unit: string } {
  const s = unitScale(unit, Math.abs(value));
  return { value: value * s.factor, unit: s.unit };
}

// Telemetry types whose value is an uptime/duration expressed in seconds.
// MeshCore poller/remote-status rows use the `*_uptime_secs` suffix; the
// Meshtastic/host/paxcounter rows use the explicit names below.
const UPTIME_TYPES = new Set(['uptimeSeconds', 'hostUptimeSeconds', 'paxcounterUptime']);

/** True when a telemetry type's value is an uptime expressed in seconds. */
export function isUptimeType(type: string): boolean {
  return UPTIME_TYPES.has(type) || /uptime_secs$/i.test(type);
}

/** Human-readable duration from a number of seconds (e.g. "3d 4h", "12m"). */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds)) return String(seconds);
  const s = Math.max(0, Math.floor(seconds));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}
