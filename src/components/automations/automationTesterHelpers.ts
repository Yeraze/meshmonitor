/**
 * Pure helpers for the automation Test panel (kept out of the component file so
 * the `.tsx` exports only a component — react-refresh/only-export-components).
 */
export type EventState = Record<string, string>;
export type FactState = Record<string, string>;

export function numOrUndef(v: string | undefined): number | undefined {
  if (v === undefined || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/** Read thresholdMeters from the compiled leftHome trigger (default 300). */
export function leftHomeThresholdFromConfig(config: unknown): number {
  const nodes = (config as { nodes?: Array<{ type?: string; params?: Record<string, unknown> }> } | null)?.nodes;
  const trigger = nodes?.find((n) => n.type === 'trigger.leftHome');
  const thr = Number(trigger?.params?.thresholdMeters ?? 300);
  return Number.isFinite(thr) && thr > 0 ? thr : 300;
}

/** Which leftHome dry-run input path is active given the Test panel fields. */
export function leftHomeInputMode(ev: EventState, facts: FactState): 'coordinates' | 'distance' | 'none' {
  const hasCoords =
    numOrUndef(facts.latitude) != null &&
    numOrUndef(facts.longitude) != null &&
    numOrUndef(ev.homeLat) != null &&
    numOrUndef(ev.homeLon) != null;
  if (hasCoords) return 'coordinates';
  if (numOrUndef(ev.distanceMeters) != null) return 'distance';
  return 'none';
}

export function leftHomeModeHint(ev: EventState, facts: FactState, automationThreshold: number): string {
  const mode = leftHomeInputMode(ev, facts);
  const thr = `Threshold: ${automationThreshold} m (from the automation — not editable here).`;
  if (mode === 'coordinates') {
    return `${thr} Using home + current coordinates to compute distance. The distance field is ignored while all four coords are set.`;
  }
  if (mode === 'distance') {
    return `${thr} Using the distance field (${ev.distanceMeters} m). Fill home lat/lon and current lat/lon to compute distance from coordinates instead (coordinates take precedence).`;
  }
  return `${thr} Set either (1) home lat/lon + current lat/lon, or (2) a distance in metres. Dry-run fires only when the node is on the watch list and distance > threshold.`;
}
