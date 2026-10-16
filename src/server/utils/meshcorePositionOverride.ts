/**
 * MeshCore contact location override (#5842) — read-side precedence.
 *
 * The override lives in its own `meshcore_nodes` columns (migration 206), next
 * to the advert `latitude`/`longitude` that ingest keeps writing. Every
 * surface that serves a MeshCore contact's position runs its rows through
 * here, so the rule lives in one place and matches Meshtastic's
 * (`enhanceNodeForClient` / `getEffectiveDbNodePosition`):
 *
 *  - An enabled override with both coordinates wins over the advert position.
 *    The row gets `positionIsOverride: true` (which also makes the #5363
 *    sign-flip correction leave it alone) and the override fields.
 *  - A PRIVATE override is applied only for a caller holding
 *    `nodes_private:read` on the row's source. Anyone else sees the advert
 *    position, with the override fields removed, the same fallback Meshtastic
 *    uses.
 *  - Raw override columns that came along on a DB row are always removed
 *    first, so a row never carries override data the rule did not grant.
 *
 * Callers still apply the `nodes:viewOnMap` mask after this
 * (`maskContactPositionsForViewOnMap` / `stripPositions`, which strips the
 * override fields too).
 */
import { hasPermission } from '../auth/authMiddleware.js';
import databaseService from '../../services/database.js';
import type { User } from '../../types/auth.js';
import type { MeshCorePositionOverride } from '../../db/repositories/meshcore.js';
import { logger } from '../../utils/logger.js';

export type { MeshCorePositionOverride };

/** Fields a row carries once an override has been applied to it. */
export interface MeshCoreOverrideFields {
  positionIsOverride?: boolean;
  positionOverrideEnabled?: boolean;
  latitudeOverride?: number;
  longitudeOverride?: number;
  altitudeOverride?: number;
  positionOverrideIsPrivate?: boolean;
}

const RAW_OVERRIDE_KEYS = [
  'positionIsOverride',
  'positionOverrideEnabled',
  'latitudeOverride',
  'longitudeOverride',
  'altitudeOverride',
  'positionOverrideIsPrivate',
] as const;

/** Sign-flip output that describes the advert fix, not the override. */
const SIGN_FLIP_KEYS = ['positionSignFlipCorrected', 'reportedLatitude', 'reportedLongitude'] as const;

type PositionedRow = {
  publicKey?: string;
  latitude?: number | null;
  longitude?: number | null;
  altitude?: number | null;
};

/**
 * Apply one override to one row. Pure. `ov` is the row's override (or
 * undefined); `canViewPrivate` is the caller's `nodes_private:read` on the
 * row's source.
 */
export function applyMeshCorePositionOverride<T extends PositionedRow>(
  row: T,
  ov: MeshCorePositionOverride | undefined,
  canViewPrivate: boolean,
): T & MeshCoreOverrideFields {
  const carriesRaw = RAW_OVERRIDE_KEYS.some((k) => k in row);
  const usable = !!ov && ov.enabled && ov.latitude != null && ov.longitude != null
    && (!ov.isPrivate || canViewPrivate);
  if (!usable) {
    if (!carriesRaw) return row;
    const out = { ...row } as Record<string, unknown>;
    for (const k of RAW_OVERRIDE_KEYS) delete out[k];
    return out as T & MeshCoreOverrideFields;
  }
  const out = { ...row } as Record<string, unknown>;
  for (const k of SIGN_FLIP_KEYS) delete out[k];
  out.latitude = ov!.latitude;
  out.longitude = ov!.longitude;
  if (ov!.altitude != null) out.altitude = ov!.altitude;
  out.positionIsOverride = true;
  out.positionOverrideEnabled = true;
  out.latitudeOverride = ov!.latitude;
  out.longitudeOverride = ov!.longitude;
  if (ov!.altitude != null) out.altitudeOverride = ov!.altitude;
  else delete out.altitudeOverride;
  out.positionOverrideIsPrivate = ov!.isPrivate;
  return out as T & MeshCoreOverrideFields;
}

/** Apply a source's overrides (keyed by lowercased public key) to its rows. Pure. */
export function applyMeshCorePositionOverrides<T extends PositionedRow>(
  rows: T[],
  overrides: Map<string, MeshCorePositionOverride>,
  canViewPrivate: boolean,
): Array<T & MeshCoreOverrideFields> {
  return rows.map((r) => applyMeshCorePositionOverride(
    r,
    r.publicKey ? overrides.get(r.publicKey.toLowerCase()) : undefined,
    canViewPrivate,
  ));
}

/**
 * Load a source's enabled overrides. A read failure is logged and reads as
 * "no overrides", so a position surface never fails because of this.
 */
export async function loadMeshCorePositionOverrides(sourceId: string): Promise<Map<string, MeshCorePositionOverride>> {
  try {
    return await databaseService.meshcore.getPositionOverridesBySource(sourceId);
  } catch (err) {
    logger.warn(`[MeshCore:${sourceId}] position override read failed: ${(err as Error).message}`);
    return new Map();
  }
}

/**
 * Apply `sourceId`'s overrides to `rows` for `user`: loads the overrides and
 * the caller's `nodes_private:read` on that source, then applies them.
 */
export async function applyMeshCorePositionOverridesForViewer<T extends PositionedRow>(
  rows: T[],
  user: User | null | undefined,
  sourceId: string,
): Promise<Array<T & MeshCoreOverrideFields>> {
  const overrides = await loadMeshCorePositionOverrides(sourceId);
  if (overrides.size === 0) return applyMeshCorePositionOverrides(rows, overrides, false);
  const canViewPrivate = user ? await hasPermission(user, 'nodes_private', 'read', sourceId) : false;
  return applyMeshCorePositionOverrides(rows, overrides, canViewPrivate);
}
