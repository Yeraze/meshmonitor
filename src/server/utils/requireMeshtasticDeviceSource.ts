import type { Request, Response, NextFunction } from 'express';
import { fail } from './apiResponse.js';
import { sourceManagerRegistry } from '../sourceManagerRegistry.js';
import { isMeshtasticManager } from '../sourceManagerTypes.js';

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

/**
 * In-handler form of {@link requireMeshtasticDeviceSource}, for routes whose
 * sourceId comes from a path param or another place the middleware cannot
 * read. Sends 400 SOURCE_NOT_MESHTASTIC and returns true when `sourceId` is a
 * non-Meshtastic source; returns false (and sends nothing) otherwise.
 *
 * `what` names the refused operation in the error message.
 */
export function refuseNonMeshtasticSource(
  res: Response,
  sourceId: string | undefined | null,
  what = 'device operations',
): boolean {
  if (typeof sourceId !== 'string' || !isNonMeshtasticSource(sourceId)) return false;
  fail(
    res,
    400,
    'SOURCE_NOT_MESHTASTIC',
    `Source "${sourceId}" has no local Meshtastic device; ${what} are not available for it.`,
  );
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
  return (req: Request, res: Response, next: NextFunction): void => {
    const fromQuery = req.query?.sourceId;
    const fromBody = req.body?.sourceId;
    const raw = from === 'query' ? fromQuery : from === 'body' ? fromBody : (fromQuery ?? fromBody);
    if (typeof raw === 'string' && refuseNonMeshtasticSource(res, raw, what)) return;
    next();
  };
}
