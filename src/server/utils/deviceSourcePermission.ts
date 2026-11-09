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
import { sourceManagerRegistry } from '../sourceManagerRegistry.js';
import { isMeshCoreManager, getPrimaryMeshtasticManager } from '../sourceManagerTypes.js';
import type { MeshCoreManager } from '../meshcoreManager.js';
import databaseService from '../../services/database.js';

/** Which device protocols a gate lets through (#6257 S3).
 *  `meshtastic` (default): Meshtastic TCP only, the behaviour of every older route.
 *  `config-capable`: Meshtastic TCP, or a connected MeshCore Companion.
 *  `stored`: any `meshtastic_tcp` or `meshcore` source in ANY connection state,
 *  with no manager bound. For routes that only touch stored files (device
 *  config backups: list, download, delete, summary, schedule settings). */
export type DeviceSourceAccept = 'meshtastic' | 'config-capable' | 'stored';

export interface DeviceSourceTarget {
  /** The source the permission was checked against and the handler acts on. */
  sourceId: string;
  /** That source's manager. */
  manager: MeshtasticManager;
  /** False when the request named no source and the primary was used. */
  named: boolean;
  protocol: 'meshtastic';
}

/** Target of a `config-capable` gate that resolved to a MeshCore Companion. */
export interface MeshCoreDeviceSourceTarget {
  sourceId: string;
  manager: MeshCoreManager;
  named: true;
  protocol: 'meshcore';
}

export type ConfigCapableTarget = DeviceSourceTarget | MeshCoreDeviceSourceTarget;

/** Target of a `stored` gate: a source row, no manager (#6285). */
export interface StoredBackupTarget {
  sourceId: string;
  protocol: 'meshtastic' | 'meshcore';
  /** False when the request named no source and the primary was used. */
  named: boolean;
}

/** What a `requireDeviceSourcePermission()` middleware enforces. Read by the
 *  route guard tests. */
export interface DeviceSourceGate {
  resource: ResourceType;
  action: PermissionAction;
  from: 'query' | 'body';
  /** Present only for a non-default gate (`config-capable`). */
  accept?: DeviceSourceAccept;
}

const TARGET = Symbol.for('meshmonitor.deviceSourceTarget');
const DEVICE_SOURCE_GATE = Symbol.for('meshmonitor.deviceSourceGate');

/** The gate a middleware function enforces, or undefined if it was not built
 *  by `requireDeviceSourcePermission()`. */
export function getDeviceSourceGate(handler: unknown): DeviceSourceGate | undefined {
  return (handler as { [DEVICE_SOURCE_GATE]?: DeviceSourceGate } | null | undefined)?.[DEVICE_SOURCE_GATE];
}

type TargetCarrier = { [TARGET]?: ConfigCapableTarget | StoredBackupTarget };

const isBlank = (value: unknown): boolean => value === undefined || value === null || value === '';

/**
 * The target resolved by `requireDeviceSourcePermission()` for this request.
 * Throws if the route was not mounted behind it: a handler that reached here
 * without a resolved target has no source its permission check covered.
 */
export function getDeviceSourceTarget(req: Request): DeviceSourceTarget {
  const target = getConfigCapableTarget(req);
  if (target.protocol !== 'meshtastic') {
    // Only a `config-capable` gate can resolve to MeshCore; its handler must
    // call getConfigCapableTarget() and branch. Failing loud beats handing a
    // MeshCore manager to Meshtastic-only code.
    throw new Error('getDeviceSourceTarget: target is a MeshCore source; use getConfigCapableTarget()');
  }
  return target;
}

/** Like {@link getDeviceSourceTarget}, for routes behind an
 *  `accept: 'config-capable'` gate: the target may be Meshtastic or MeshCore. */
export function getConfigCapableTarget(req: Request): ConfigCapableTarget {
  const target = (req as unknown as TargetCarrier)[TARGET];
  if (!target) {
    throw new Error('getDeviceSourceTarget: route is not behind requireDeviceSourcePermission()');
  }
  if (!('manager' in target)) {
    throw new Error('getConfigCapableTarget: route is behind a `stored` gate; use getStoredBackupTarget()');
  }
  return target;
}

/** The target of a route behind an `accept: 'stored'` gate. */
export function getStoredBackupTarget(req: Request): StoredBackupTarget {
  const target = (req as unknown as TargetCarrier)[TARGET];
  if (!target) {
    throw new Error('getStoredBackupTarget: route is not behind requireDeviceSourcePermission()');
  }
  if ('manager' in target) {
    throw new Error('getStoredBackupTarget: route is not behind a `stored` gate');
  }
  return target;
}

/** The target's source id, whatever kind of gate resolved it. */
function targetSourceId(req: Request): string {
  const target = (req as unknown as TargetCarrier)[TARGET];
  if (!target) throw new Error('requireDeviceSourcePermission: no target resolved');
  return target.sourceId;
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
  options: { accept?: DeviceSourceAccept } = {},
): RequestHandler {
  const accept: DeviceSourceAccept = options.accept ?? 'meshtastic';
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

    if (accept === 'stored') {
      // No manager: the handler works on stored files. Omitted -> the primary
      // Meshtastic source (the legacy single-source behaviour).
      const sourceId = named ?? getPrimaryMeshtasticManager(sourceManagerRegistry)?.sourceId;
      if (!sourceId) {
        fail(res, 404, 'SOURCE_NOT_FOUND', 'No source was named and no primary Meshtastic source is configured.');
        return;
      }
      (req as unknown as TargetCarrier)[TARGET] = { sourceId, protocol: 'meshtastic', named: named !== undefined };
      next();
      return;
    }

    // A config-capable gate lets a named MeshCore source keep its OWN manager
    // (resolveSourceManager would hand back the primary Meshtastic radio).
    if (accept === 'config-capable' && named !== undefined) {
      const own = sourceManagerRegistry.getManager(named);
      if (own && isMeshCoreManager(own)) {
        (req as unknown as TargetCarrier)[TARGET] = { sourceId: named, manager: own, named: true, protocol: 'meshcore' };
        next();
        return;
      }
    }

    const manager = resolveSourceManager(named);
    (req as unknown as TargetCarrier)[TARGET] = {
      sourceId: named ?? manager.sourceId,
      manager,
      named: named !== undefined,
      protocol: 'meshtastic',
    };
    next();
  };

  const checkPermission = requirePermission(resource, action, {
    sourceIdFrom: (req) => targetSourceId(req),
    requireSourceId: true,
  });

  const bindStored: RequestHandler = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const target = (req as unknown as TargetCarrier)[TARGET] as StoredBackupTarget;
    const row = await databaseService.sources.getSource(target.sourceId).catch(() => null);
    if (!row) {
      fail(res, 404, 'SOURCE_NOT_FOUND', `Source "${target.sourceId}" was not found.`);
      return;
    }
    if (row.type !== 'meshtastic_tcp' && row.type !== 'meshcore') {
      fail(res, 400, 'SOURCE_NOT_BACKUP_CAPABLE', `Source "${target.sourceId}" has no device configuration to back up.`);
      return;
    }
    target.protocol = row.type === 'meshcore' ? 'meshcore' : 'meshtastic';
    next();
  };

  const bindDevice: RequestHandler = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (accept === 'stored') {
      await bindStored(req, res, next);
      return;
    }
    const target = getConfigCapableTarget(req);
    if (target.protocol === 'meshcore') {
      // Must be a live Companion: a Repeater (or a disconnected source) has
      // no channel table to read or write.
      const status = target.manager.getConnectionStatus();
      if (!status.connected) {
        fail(res, 409, 'SOURCE_NOT_CONNECTED', `Source "${target.sourceId}" is not connected; ${what} are not available until it reconnects.`);
        return;
      }
      // Lazy: the manager module is large and only a MeshCore request needs the enum.
      const { MeshCoreDeviceType } = await import('../meshcoreManager.js');
      if (status.deviceType !== MeshCoreDeviceType.COMPANION) {
        fail(res, 400, 'SOURCE_NOT_COMPANION', `Source "${target.sourceId}" is not a MeshCore Companion; ${what} are not available for it.`);
        return;
      }
      next();
      return;
    }
    if (target.named) {
      if (accept === 'config-capable' && !sourceManagerRegistry.getManager(target.sourceId)) {
        // A MeshCore source with no registered manager: report it as
        // not connected rather than as the wrong protocol.
        const row = await databaseService.sources.getSource(target.sourceId).catch(() => null);
        if (row?.type === 'meshcore') {
          fail(res, 409, 'SOURCE_NOT_CONNECTED', `Source "${target.sourceId}" is not connected; ${what} are not available until it reconnects.`);
          return;
        }
      }
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
  (gate as unknown as { [DEVICE_SOURCE_GATE]: DeviceSourceGate })[DEVICE_SOURCE_GATE] = {
    resource, action, from, ...(accept === 'meshtastic' ? {} : { accept }),
  };
  return gate;
}
