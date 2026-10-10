/**
 * Scheduled MeshCore trace paths (#5723): the `action.tracePathSchedule`
 * automation action. Shared by the server (validation, limits) and the builder.
 *
 * Each path has its own interval. The automation runs on any trigger (a
 * one-minute Schedule is the intended one); on each run only the paths that
 * are due are traced.
 *
 * Limits (maintainer decision, Mesh impact checklist): a path runs at most
 * every {@link TRACE_SCHEDULE_MIN_INTERVAL_MINUTES} minutes, and one source
 * sends at most {@link TRACE_SCHEDULE_MAX_PER_SOURCE_PER_HOUR} scheduled traces
 * in any rolling hour. Both are enforced at run time from persisted state.
 */

export const TRACE_SCHEDULE_MIN_INTERVAL_MINUTES = 10;
/** One week. */
export const TRACE_SCHEDULE_MAX_INTERVAL_MINUTES = 7 * 24 * 60;
export const TRACE_SCHEDULE_MAX_PER_SOURCE_PER_HOUR = 12;
export const TRACE_SCHEDULE_MAX_PATHS = 20;

/** Hop-hash width for the trace: follow the contact's cached path, or force 1 or 2 bytes. */
export type TraceHashBytes = 'auto' | 1 | 2;

export interface TracePathEntry {
  /** 64-hex public key of the contact to trace to. */
  publicKey: string;
  hashBytes: TraceHashBytes;
  intervalMinutes: number;
  /** Optional name, for the builder and the run log only. */
  label?: string;
}

const PUBLIC_KEY_RE = /^[0-9a-f]{64}$/i;

/** Normalise one stored path row, or return the reason it is invalid. */
export function parseTracePathEntry(raw: unknown): { value: TracePathEntry } | { error: string } {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const publicKey = typeof r.publicKey === 'string' ? r.publicKey.trim().toLowerCase() : '';
  if (!PUBLIC_KEY_RE.test(publicKey)) return { error: 'publicKey must be a 64-character hex contact key' };
  const hb = r.hashBytes;
  const hashBytes: TraceHashBytes | null =
    hb === undefined || hb === null || hb === '' || hb === 'auto' ? 'auto'
      : Number(hb) === 1 ? 1
        : Number(hb) === 2 ? 2
          : null;
  if (hashBytes === null) return { error: 'hashBytes must be "auto", 1 or 2' };
  const intervalMinutes = Number(r.intervalMinutes);
  if (!Number.isInteger(intervalMinutes)
    || intervalMinutes < TRACE_SCHEDULE_MIN_INTERVAL_MINUTES
    || intervalMinutes > TRACE_SCHEDULE_MAX_INTERVAL_MINUTES) {
    return { error: `intervalMinutes must be a whole number from ${TRACE_SCHEDULE_MIN_INTERVAL_MINUTES} to ${TRACE_SCHEDULE_MAX_INTERVAL_MINUTES}` };
  }
  const label = typeof r.label === 'string' && r.label.trim() ? r.label.trim().slice(0, 64) : undefined;
  return { value: { publicKey, hashBytes, intervalMinutes, ...(label ? { label } : {}) } };
}

/** Validate the `paths` param of an `action.tracePathSchedule` block. */
export function tracePathScheduleParamErrors(nodeId: string, params: Record<string, unknown>): string[] {
  const errors: string[] = [];
  const paths = params.paths;
  if (!Array.isArray(paths) || paths.length === 0) {
    return [`action.tracePathSchedule "${nodeId}" requires at least one path`];
  }
  if (paths.length > TRACE_SCHEDULE_MAX_PATHS) {
    errors.push(`action.tracePathSchedule "${nodeId}" allows at most ${TRACE_SCHEDULE_MAX_PATHS} paths`);
  }
  const seen = new Set<string>();
  paths.forEach((raw, i) => {
    const parsed = parseTracePathEntry(raw);
    if ('error' in parsed) {
      errors.push(`action.tracePathSchedule "${nodeId}" path ${i + 1}: ${parsed.error}`);
      return;
    }
    if (seen.has(parsed.value.publicKey)) {
      errors.push(`action.tracePathSchedule "${nodeId}" path ${i + 1}: this contact is listed twice`);
    }
    seen.add(parsed.value.publicKey);
  });
  return errors;
}
