/**
 * Script usage computation (issue #4942).
 *
 * Cross-references the scripts on disk against every trigger that can invoke a
 * script — Meshtastic auto-responders, timers, and geofences, plus the MeshCore
 * auto-responder and timer variants — so the Scripts inventory can show which
 * automations (if any) use each script and flag orphaned/unused scripts.
 *
 * Pure and side-effect free: the route reads the settings, this file just maps
 * parsed trigger arrays to usage references keyed by script filename.
 */

export type ScriptTriggerType = 'auto-responder' | 'timer' | 'geofence';
export type ScriptProtocol = 'meshtastic' | 'meshcore';

export interface ScriptUsageRef {
  /** Which kind of trigger references the script. */
  type: ScriptTriggerType;
  /** Which stack the trigger belongs to. */
  protocol: ScriptProtocol;
  /** Source that owns the trigger. */
  sourceId: string;
  sourceName?: string;
  /** The trigger's own id, when it has one. */
  triggerId?: string;
  /** Human-readable label: trigger pattern (auto-responder) or name (timer/geofence). */
  triggerName?: string;
  /** Whether the trigger itself is enabled. Auto-responders have no per-trigger
   *  flag, so they report `true` (the responder-level toggle governs them). */
  enabled: boolean;
}

/**
 * One source's already-parsed trigger arrays. The route parses the JSON; this
 * module never touches the database or JSON.parse so it stays trivially
 * testable.
 */
export interface SourceTriggers {
  sourceId: string;
  sourceName?: string;
  autoResponderTriggers?: unknown;
  timerTriggers?: unknown;
  geofenceTriggers?: unknown;
  meshcoreAutoResponderTriggers?: unknown;
  meshcoreTimerTriggers?: unknown;
}

/** Reduce a stored script path to its filename for robust matching. */
export const scriptKey = (p: string): string => {
  const parts = String(p).split(/[\\/]/);
  return parts[parts.length - 1] || String(p);
};

const asArray = (v: unknown): Record<string, unknown>[] =>
  Array.isArray(v) ? (v as Record<string, unknown>[]) : [];

const pushRef = (
  map: Map<string, ScriptUsageRef[]>,
  path: unknown,
  ref: ScriptUsageRef
): void => {
  if (typeof path !== 'string' || path.length === 0) return;
  const key = scriptKey(path);
  if (!key) return;
  const arr = map.get(key);
  if (arr) arr.push(ref);
  else map.set(key, [ref]);
};

/**
 * Build a map of `filename -> usage references` across every source's triggers.
 */
export function computeScriptUsage(
  sources: SourceTriggers[]
): Map<string, ScriptUsageRef[]> {
  const usage = new Map<string, ScriptUsageRef[]>();

  for (const src of sources) {
    const base = { sourceId: src.sourceId, sourceName: src.sourceName };

    // Auto-responders (Meshtastic + MeshCore): script path lives in `response`
    // when responseType === 'script'.
    const addAuto = (list: unknown, protocol: ScriptProtocol) => {
      for (const t of asArray(list)) {
        if (t.responseType === 'script') {
          pushRef(usage, t.response, {
            ...base,
            type: 'auto-responder',
            protocol,
            triggerId: typeof t.id === 'string' ? t.id : undefined,
            triggerName: Array.isArray(t.trigger)
              ? (t.trigger as unknown[]).join(', ')
              : typeof t.trigger === 'string'
                ? t.trigger
                : undefined,
            enabled: true,
          });
        }
      }
    };

    // Timers (Meshtastic + MeshCore): default responseType is 'script', so a
    // timer uses a script unless it explicitly opts into 'text'.
    const addTimer = (list: unknown, protocol: ScriptProtocol) => {
      for (const t of asArray(list)) {
        if (t.responseType !== 'text') {
          pushRef(usage, t.scriptPath, {
            ...base,
            type: 'timer',
            protocol,
            triggerId: typeof t.id === 'string' ? t.id : undefined,
            triggerName: typeof t.name === 'string' ? t.name : undefined,
            enabled: t.enabled !== false,
          });
        }
      }
    };

    addAuto(src.autoResponderTriggers, 'meshtastic');
    addTimer(src.timerTriggers, 'meshtastic');

    // Geofences (Meshtastic only): script path in `scriptPath` when
    // responseType === 'script'.
    for (const t of asArray(src.geofenceTriggers)) {
      if (t.responseType === 'script') {
        pushRef(usage, t.scriptPath, {
          ...base,
          type: 'geofence',
          protocol: 'meshtastic',
          triggerId: typeof t.id === 'string' ? t.id : undefined,
          triggerName: typeof t.name === 'string' ? t.name : undefined,
          enabled: t.enabled !== false,
        });
      }
    }

    addAuto(src.meshcoreAutoResponderTriggers, 'meshcore');
    addTimer(src.meshcoreTimerTriggers, 'meshcore');
  }

  return usage;
}
