/**
 * Per-node timezone (#6523).
 *
 * A node's zone is, in order: its Timezone Override, else the IANA zone at its
 * effective position (looked up offline, on read — never stored, so a moved
 * node re-derives on its own), else the server's zone. A viewer who fails the
 * node's map position gate gets the server zone, override included: both
 * the derived zone and a hand-set one give away the node's rough location.
 */
import tzLookup from '@photostructure/tz-lookup';
import { resolveVisibleNode } from './nodeVisiblePosition.js';
import type { SourcePermissions } from './sourcePermissions.js';
import type { User } from '../../types/auth.js';

export type NodeTimezoneSource = 'override' | 'position' | 'server';

export interface NodeTimezone {
  timeZone: string;
  source: NodeTimezoneSource;
}

/** Longest zone name we store (VARCHAR(64) on MySQL). */
const MAX_ZONE_LENGTH = 64;

/**
 * The canonical spelling of `value` if this runtime knows it as a time zone,
 * else null. Built from `Intl.DateTimeFormat` rather than
 * `Intl.supportedValuesOf`, which can omit `UTC` and the legacy aliases.
 */
export function normalizeTimeZone(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const tz = value.trim();
  if (!tz || tz.length > MAX_ZONE_LENGTH) return null;
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: tz }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
}

/** The container's zone: `TZ` if set and valid, else what the runtime reports, else UTC. */
export function serverTimeZone(): string {
  return normalizeTimeZone(process.env.TZ) ?? normalizeTimeZone(Intl.DateTimeFormat().resolvedOptions().timeZone) ?? 'UTC';
}

/** The IANA zone at a position, or null when the lookup fails or the runtime lacks it. */
export function timeZoneAt(latitude: number, longitude: number): string | null {
  try {
    return normalizeTimeZone(tzLookup(latitude, longitude));
  } catch {
    return null;
  }
}

/** Resolve one node's display zone for one viewer. Never throws for a missing node. */
export async function resolveNodeTimezone(
  user: User | null | undefined,
  sourceId: string,
  nodeId: string,
  permissions?: SourcePermissions,
): Promise<NodeTimezone> {
  const node = await resolveVisibleNode(user, sourceId, nodeId, permissions);
  if (node) {
    const override = normalizeTimeZone(node.timezoneOverride);
    if (override) return { timeZone: override, source: 'override' };
    if (node.position) {
      const zone = timeZoneAt(node.position.latitude, node.position.longitude);
      if (zone) return { timeZone: zone, source: 'position' };
    }
  }
  return { timeZone: serverTimeZone(), source: 'server' };
}
