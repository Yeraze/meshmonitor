import type { Request, Response, NextFunction } from 'express';
import { fail } from './apiResponse.js';
import { sourceManagerRegistry } from '../sourceManagerRegistry.js';
import { isMeshtasticManager } from '../sourceManagerTypes.js';

/**
 * True when `sourceId` names a registered source whose manager is NOT a
 * MeshtasticManager (mqtt_broker, mqtt_bridge, meshcore, reticulum). For such
 * an id `resolveSourceManager()` hands back the primary Meshtastic TCP
 * manager, which is another source's device (#5367).
 */
function isNonMeshtasticSource(sourceId: string | undefined | null): boolean {
  if (!sourceId) return false;
  const manager = sourceManagerRegistry.getManager(sourceId);
  return !!manager && !isMeshtasticManager(manager);
}

/**
 * Route guard for endpoints that read or change the local Meshtastic device
 * (identity, device config, security keys, reboot, remote admin).
 *
 * `resolveSourceManager()` resolves a non-Meshtastic sourceId (an MQTT broker
 * or bridge, MeshCore, Reticulum) to the PRIMARY Meshtastic TCP manager. On a
 * device endpoint that means an MQTT broker source reads, and writes, a
 * different source's radio (#5367). This guard refuses those ids up front with
 * 400 SOURCE_NOT_MESHTASTIC. Omitted sourceIds and Meshtastic sources pass
 * through unchanged.
 *
 * Mount it AFTER the auth/permission middleware so an unauthorised caller
 * learns nothing about a source's type.
 */
export function requireMeshtasticDeviceSource(from: 'query' | 'body' | 'either' = 'either') {
  return (req: Request, res: Response, next: NextFunction): void => {
    const fromQuery = req.query?.sourceId;
    const fromBody = req.body?.sourceId;
    const raw = from === 'query' ? fromQuery : from === 'body' ? fromBody : (fromQuery ?? fromBody);
    if (typeof raw === 'string' && isNonMeshtasticSource(raw)) {
      fail(
        res,
        400,
        'SOURCE_NOT_MESHTASTIC',
        `Source "${raw}" has no local Meshtastic device; device operations are not available for it.`,
      );
      return;
    }
    next();
  };
}
