import type { Request, Response, NextFunction } from 'express';
import { fail } from './apiResponse.js';
import { sourceManagerRegistry } from '../sourceManagerRegistry.js';
import { isMeshtasticManager } from '../sourceManagerTypes.js';
import databaseService from '../../services/database.js';

/**
 * True when `sourceId` names a registered source whose manager is NOT a
 * MeshtasticManager (mqtt_broker, mqtt_bridge, meshcore, reticulum). For such
 * an id `resolveSourceManager()` hands back the primary Meshtastic TCP
 * manager, which is another source's device (#5367, #5375).
 */
export function isNonMeshtasticSource(sourceId: string | undefined | null): boolean {
  if (!sourceId) return false;
  const manager = sourceManagerRegistry.getManager(sourceId);
  return !!manager && !isMeshtasticManager(manager);
}

interface SourceRefusal {
  status: number;
  code: 'SOURCE_NOT_MESHTASTIC' | 'SOURCE_NOT_CONNECTED';
  message: string;
}

/**
 * Decide whether `sourceId` may use a Meshtastic-manager route, or why not.
 *
 * - No sourceId: allowed (legacy single-source path, the primary).
 * - Live Meshtastic manager: allowed.
 * - Live non-Meshtastic manager (mqtt_broker, mqtt_bridge, meshcore,
 *   reticulum): 400 SOURCE_NOT_MESHTASTIC.
 * - No live manager but a source row exists (a disabled MQTT source, a
 *   disconnected TCP source): refused as well, since resolveSourceManager()
 *   would hand back the PRIMARY radio for it (#5375). 409
 *   SOURCE_NOT_CONNECTED for a meshtastic_tcp row, 400 SOURCE_NOT_MESHTASTIC
 *   for any other type.
 * - No row at all: allowed, so the route's own 404/validation still runs.
 */
export async function checkMeshtasticDeviceSource(
  sourceId: string | undefined | null,
  what = 'device operations',
): Promise<SourceRefusal | null> {
  if (typeof sourceId !== 'string' || sourceId.length === 0) return null;
  const notMeshtastic = (): SourceRefusal => ({
    status: 400,
    code: 'SOURCE_NOT_MESHTASTIC',
    message: `Source "${sourceId}" has no local Meshtastic device; ${what} are not available for it.`,
  });
  const manager = sourceManagerRegistry.getManager(sourceId);
  if (manager) return isMeshtasticManager(manager) ? null : notMeshtastic();

  let row: { type?: string } | null;
  try {
    row = await databaseService.sources.getSource(sourceId);
  } catch {
    return null;
  }
  if (!row) return null;
  if (row.type === 'meshtastic_tcp') {
    return {
      status: 409,
      code: 'SOURCE_NOT_CONNECTED',
      message: `Source "${sourceId}" is not connected; ${what} are not available until it reconnects.`,
    };
  }
  return notMeshtastic();
}

/**
 * In-handler form of {@link requireMeshtasticDeviceSource}, for routes whose
 * sourceId comes from a path param or another place the middleware cannot
 * read. Sends the refusal from {@link checkMeshtasticDeviceSource} and
 * resolves true when the source is refused; resolves false (and sends
 * nothing) otherwise.
 *
 * `what` names the refused operation in the error message.
 */
export async function refuseNonMeshtasticSource(
  res: Response,
  sourceId: string | undefined | null,
  what = 'device operations',
): Promise<boolean> {
  const refusal = await checkMeshtasticDeviceSource(sourceId, what);
  if (!refusal) return false;
  fail(res, refusal.status, refusal.code, refusal.message);
  return true;
}

/**
 * Route guard for endpoints that read or change the local Meshtastic device
 * (identity, device config, security keys, reboot, remote admin) or transmit
 * through it (messages, mesh requests, channel pushes).
 *
 * `resolveSourceManager()` resolves a non-Meshtastic sourceId (an MQTT broker
 * or bridge, MeshCore, Reticulum) to the PRIMARY Meshtastic TCP manager. On a
 * device endpoint that means an MQTT broker source reads, and writes, a
 * different source's radio (#5367); on a send endpoint it transmits through a
 * radio the user did not pick (#5375). This guard refuses those ids up front
 * with 400 SOURCE_NOT_MESHTASTIC. Omitted sourceIds and Meshtastic sources
 * pass through unchanged.
 *
 * MeshCore and Reticulum sources have their own send/config routes
 * (`/api/sources/:id/meshcore/*`, `/api/sources/:id/reticulum/*`); this guard
 * only belongs on the Meshtastic-manager routes.
 *
 * Mount it AFTER the auth/permission middleware so an unauthorised caller
 * learns nothing about a source's type.
 */
export function requireMeshtasticDeviceSource(
  from: 'query' | 'body' | 'either' = 'either',
  what = 'device operations',
) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const fromQuery = req.query?.sourceId;
    const fromBody = req.body?.sourceId;
    const raw = from === 'query' ? fromQuery : from === 'body' ? fromBody : (fromQuery ?? fromBody);
    if (typeof raw === 'string' && (await refuseNonMeshtasticSource(res, raw, what))) return;
    next();
  };
}
