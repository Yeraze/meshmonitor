/**
 * MeshCore targets share the MeshCore device limiter for backup create and
 * restore (#6285); Meshtastic targets keep their existing behaviour.
 * Mount it AFTER the `requireDeviceSourcePermission(..., 'config-capable')`
 * gate, which resolves the target.
 */
import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { meshcoreDeviceLimiter } from './rateLimiters.js';
import { getConfigCapableTarget } from '../utils/deviceSourcePermission.js';

export const backupTargetLimiter: RequestHandler = (req: Request, res: Response, next: NextFunction) => {
  if (getConfigCapableTarget(req).protocol === 'meshcore') {
    meshcoreDeviceLimiter(req, res, next);
    return;
  }
  next();
};
