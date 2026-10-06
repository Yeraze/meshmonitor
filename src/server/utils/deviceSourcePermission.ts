/**
 * Permission gate for routes that read or change ONE source's Meshtastic
 * device: `/api/config/*`, `/api/device/*`, channel URL import/export, device
 * backup restore.
 *
 * These routes take an optional `sourceId` and fall back to the primary
 * Meshtastic source when it is omitted. `requirePermission(resource, action)`
 * on its own does not know which source that is, so for a per-source resource
 * it passes when the user holds the permission on ANY source. A user allowed
 * to write source A's configuration could then write source B's by naming B.
 *
 * `requireDeviceSourcePermission()` resolves the target ONCE, before the
 * permission check, and hands the same value to both the check and the
 * handler:
 *
 *   1. Read `sourceId` from the place the route declares (`query` or `body`).
 *      A value that is not a string, or a different `sourceId` in the other
 *      place, is a 400: the request must name one source, in one place.
 *   2. Resolve the manager. A named source resolves to its own manager; an
 *      omitted one resolves to the primary Meshtastic manager (or the
 *      unconfigured `fallbackManager` when none is registered).
 *   3. Check the permission against that source: the named id, or the primary
 *      manager's id when none was named.
 *   4. Refuse a named source that has no Meshtastic device (MQTT, MeshCore,
 *      Reticulum, a disconnected TCP source). This runs after the permission
 *      check so an unauthorised caller learns nothing about a source's type.
 *   5. Refuse a named source that resolved to some other source's manager
 *      (`resolveSourceManager()` hands back the primary for an id it does not
 *      know). The handler never acts on a source the check did not cover.
 *
 * Handlers read the result with `getDeviceSourceTarget(req)` and must use its
 * `manager` and `sourceId`. They must not call `resolveSourceManager()` again
 * or re-read `sourceId` from the request.
 */
import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { requirePermission } from '../auth/authMiddleware.js';
import type { MeshtasticManager } from '../meshtasticManager.js';
import type { ResourceType, PermissionAction } from '../../types/permission.js';
import { fail } from './apiResponse.js';
import { resolveSourceManager } from './resolveSourceManager.js';
import { refuseNonMeshtasticSource } from './requireMeshtasticDeviceSource.js';

export interface DeviceSourceTarget {
  /** The source the permission was checked against and the handler acts on. */
  sourceId: string;
  /** That source's manager. */
  manager: MeshtasticManager;
  /** False when the request named no source and the primary was used. */
  named: boolean;
}

/** What a `requireDeviceSourcePermission()` middleware enforces. Read by the
 *  route guard tests. */
export interface DeviceSourceGate {
  resource: ResourceType;
  action: PermissionAction;
  from: 'query' | 'body';
}

const TARGET = Symbol.for('meshmonitor.deviceSourceTarget');
const DEVICE_SOURCE_GATE = Symbol.for('meshmonitor.deviceSourceGate');

/** The gate a middleware function enforces, or undefined if it was not built
 *  by `requireDeviceSourcePermission()`. */
export function getDeviceSourceGate(handler: unknown): DeviceSourceGate | undefined {
  return (handler as { [DEVICE_SOURCE_GATE]?: DeviceSourceGate } | null | undefined)?.[DEVICE_SOURCE_GATE];
}

type TargetCarrier = { [TARGET]?: DeviceSourceTarget };

const isBlank = (value: unknown): boolean => value === undefined || value === null || value === '';

/**
 * The target resolved by `requireDeviceSourcePermission()` for this request.
 * Throws if the route was not mounted behind it: a handler that reached here
 * without a resolved target has no source its permission check covered.
 */
export function getDeviceSourceTarget(req: Request): DeviceSourceTarget {
  const target = (req as unknown as TargetCarrier)[TARGET];
  if (!target) {
    throw new Error('getDeviceSourceTarget: route is not behind requireDeviceSourcePermission()');
  }
  return target;
}

/**
 * Middleware: resolve the target source, check `resource:action` on it,
 * and bind its manager to the request. See the file header for the steps.
 *
 * @param from  Where this route's `sourceId` travels: `'query'` for GETs,
 *              `'body'` for mutations.
 * @param what  Names the operation in the "no Meshtastic device" refusal.
 */
export function requireDeviceSourcePermission(
  resource: ResourceType,
  action: PermissionAction,
  from: 'query' | 'body',
  what = 'device operations',
): RequestHandler {
  const resolveTarget: RequestHandler = (req: Request, res: Response, next: NextFunction): void => {
    const fromQuery = req.query?.sourceId;
    const fromBody = (req.body as { sourceId?: unknown } | undefined)?.sourceId;
    const raw = from === 'query' ? fromQuery : fromBody;
    const other = from === 'query' ? fromBody : fromQuery;

    if (!isBlank(raw) && typeof raw !== 'string') {
      fail(res, 400, 'BAD_REQUEST', 'Invalid sourceId');
      return;
    }
    const named = isBlank(raw) ? undefined : (raw as string);
    // The handler only ever sees `named`. A different id in the place this
    // route does not read would be silently ignored, so refuse it instead.
    if (!isBlank(other) && other !== named) {
      fail(res, 400, 'SOURCE_ID_CONFLICT', `sourceId must be sent once, in the request ${from}`);
      return;
    }

    const manager = resolveSourceManager(named);
    (req as unknown as TargetCarrier)[TARGET] = {
      sourceId: named ?? manager.sourceId,
      manager,
      named: named !== undefined,
    };
    next();
  };

  const checkPermission = requirePermission(resource, action, {
    sourceIdFrom: (req) => getDeviceSourceTarget(req).sourceId,
    requireSourceId: true,
  });

  const bindDevice: RequestHandler = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const target = getDeviceSourceTarget(req);
    if (target.named) {
      if (await refuseNonMeshtasticSource(res, target.sourceId, what)) return;
      if (target.manager.sourceId !== target.sourceId) {
        fail(res, 404, 'SOURCE_NOT_FOUND', `Source "${target.sourceId}" was not found.`);
        return;
      }
    }
    next();
  };

  // One handler, so a route cannot mount part of the chain. Each step either
  // answers the request or calls on to the next.
  const steps: RequestHandler[] = [resolveTarget, checkPermission, bindDevice];
  const gate: RequestHandler = (req, res, next) => {
    const run = (index: number): void => {
      if (index === steps.length) {
        next();
        return;
      }
      Promise.resolve(steps[index](req, res, (err?: unknown) => (err ? next(err) : run(index + 1)))).catch(next);
    };
    run(0);
  };
  (gate as unknown as { [DEVICE_SOURCE_GATE]: DeviceSourceGate })[DEVICE_SOURCE_GATE] = { resource, action, from };
  return gate;
}
