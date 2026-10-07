/**
 * Permission gates for routes that take an OPTIONAL `sourceId` and gate on a
 * per-source resource (`nodes`, `settings`, `messages`, ...).
 *
 * `requirePermission(resource, action)` without a source passes when the user
 * holds the permission on ANY source. A handler that then acts on the
 * `sourceId` in the request lets a user with rights on source A read or change
 * source B by naming B. `requireDeviceSourcePermission()` (#5655) closed that
 * for the device-config routes; this file does the same for routes whose
 * source is not always a Meshtastic device and whose "no sourceId" case is not
 * always "the primary".
 *
 * `requireSourcePermission()` resolves the source ONCE, checks the permission
 * on that source, and hands the handler the same value through
 * `getSourceTarget(req)`. Handlers must not re-read `sourceId` from the
 * request.
 *
 *   1. Read `sourceId` from the query and the body. A non-string is a 400. If
 *      both carry one and they differ, 400 `SOURCE_ID_CONFLICT`: the request
 *      must name one source.
 *   2. None named: apply the route's `whenOmitted` rule (below).
 *   3. Check the permission on the resolved source. With the `permitted` and
 *      `first-permitted` rules and no source named, the check is "holds it on
 *      some source"; the handler is then limited to the sources it holds it on.
 *   4. A named source that does not exist is a 404 `SOURCE_NOT_FOUND`. This
 *      runs after the permission check, so a caller without the permission
 *      learns nothing about which ids exist.
 *   5. `device: 'meshtastic'` routes drive a radio: a named source with no
 *      Meshtastic device of its own is refused, the same way #5655 does it.
 *
 * `whenOmitted` rules:
 *
 *   - `'primary'`: the primary Meshtastic source. The permission is checked on
 *     it. For routes that act on one radio or one source's rows.
 *   - `'permitted'`: every source the caller holds the permission on. Admins
 *     get `'all'`. The handler reads or writes only `target.sourceIds`; a
 *     source the caller lacks the permission on is never touched or shown.
 *   - `'first-permitted'`: the caller's first enabled source with the
 *     permission (the legacy `resolveRequestSourceId` behaviour), 400
 *     `MISSING_SOURCE_ID` when there is none.
 *   - `'required'`: 400 `MISSING_SOURCE_ID`.
 */
import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { requirePermission, hasPermission } from '../auth/authMiddleware.js';
import type { MeshtasticManager } from '../meshtasticManager.js';
import type { ResourceType, PermissionAction } from '../../types/permission.js';
import type { User } from '../../types/auth.js';
import databaseService from '../../services/database.js';
import { sourceManagerRegistry } from '../sourceManagerRegistry.js';
import { fail } from './apiResponse.js';
import { resolveOwnMeshtasticManager } from './resolveSourceManager.js';
import { refuseNonMeshtasticSource } from './requireMeshtasticDeviceSource.js';
import { resolveDefaultSourceForUser } from './sourceResolver.js';
import { loadSourcePermissions } from './sourcePermissions.js';

export { loadSourcePermissions } from './sourcePermissions.js';
export type { SourcePermissions } from './sourcePermissions.js';

export type OmittedSourceRule = 'primary' | 'permitted' | 'first-permitted' | 'required';

export interface SourceScopeOptions {
  /** What the route does when the request names no source. */
  whenOmitted: OmittedSourceRule;
  /** `'meshtastic'`: the route drives a Meshtastic radio, so a named source
   *  must have one of its own. `'any'` (default): the route serves every
   *  source type (MQTT, MeshCore, ...). */
  device?: 'meshtastic' | 'any';
  /** Names the operation in the "no Meshtastic device" refusal. */
  what?: string;
}

export interface SourceTarget {
  /** The one source the request resolved to. Null only under the `permitted`
   *  rule when none was named. */
  sourceId: string | null;
  /** True when the request named the source. */
  named: boolean;
  /** Every source the handler may act on: `[sourceId]` when one resolved,
   *  else the caller's permitted set (`'all'` for an admin). */
  sourceIds: 'all' | string[];
  /** The resolved source's own Meshtastic manager, or null when it has none
   *  (MQTT, MeshCore, disconnected) or no single source resolved. Never
   *  another source's manager. */
  manager: MeshtasticManager | null;
}

/** What a `requireSourcePermission()` middleware enforces. Read by the route
 *  guard tests. */
export interface SourceScopedGate {
  resource: ResourceType;
  action: PermissionAction;
  whenOmitted: OmittedSourceRule;
  device: 'meshtastic' | 'any';
}

/** What a `requireSourcePairPermission()` middleware enforces. */
export interface SourcePairGate {
  resource: ResourceType;
  readFrom: string;
  writeTo: string;
}

const TARGET = Symbol.for('meshmonitor.sourceScopedTarget');
const PAIR = Symbol.for('meshmonitor.sourcePairTarget');
const SOURCE_SCOPED_GATE = Symbol.for('meshmonitor.sourceScopedGate');
const SOURCE_PAIR_GATE = Symbol.for('meshmonitor.sourcePairGate');

type Carrier = { [TARGET]?: SourceTarget; [PAIR]?: SourcePairTarget };

const isBlank = (value: unknown): boolean => value === undefined || value === null || value === '';

/** The gate a middleware function enforces, or undefined if it was not built
 *  by `requireSourcePermission()`. */
export function getSourceScopedGate(handler: unknown): SourceScopedGate | undefined {
  return (handler as { [SOURCE_SCOPED_GATE]?: SourceScopedGate } | null | undefined)?.[SOURCE_SCOPED_GATE];
}

/** The gate a middleware function enforces, or undefined if it was not built
 *  by `requireSourcePairPermission()`. */
export function getSourcePairGate(handler: unknown): SourcePairGate | undefined {
  return (handler as { [SOURCE_PAIR_GATE]?: SourcePairGate } | null | undefined)?.[SOURCE_PAIR_GATE];
}

/**
 * The target resolved by `requireSourcePermission()` for this request. Throws
 * if the route is not behind it: such a handler has no source its permission
 * check covered.
 */
export function getSourceTarget(req: Request): SourceTarget {
  const target = (req as unknown as Carrier)[TARGET];
  if (!target) {
    throw new Error('getSourceTarget: route is not behind requireSourcePermission()');
  }
  return target;
}

/** `getSourceTarget()` for a `device: 'meshtastic'` route, where the gate has
 *  already proved one source and its own manager. */
export function getDeviceTarget(req: Request): { sourceId: string; manager: MeshtasticManager } {
  const target = getSourceTarget(req);
  if (target.sourceId === null || target.manager === null) {
    throw new Error('getDeviceTarget: route is not gated with device: "meshtastic"');
  }
  return { sourceId: target.sourceId, manager: target.manager };
}

/**
 * The sources `user` holds `resource:action` on. `'all'` for an admin, who is
 * not limited to the rows in the sources table. Two queries whatever the
 * number of sources: the source list and the user's grants.
 */
export async function listPermittedSourceIds(
  user: User | null | undefined,
  resource: ResourceType,
  action: PermissionAction,
): Promise<'all' | string[]> {
  if (!user) return [];
  if (user.isAdmin) return 'all';
  const [sources, permissions] = await Promise.all([
    databaseService.sources.getAllSources(),
    loadSourcePermissions(user),
  ]);
  return sources.filter((source) => permissions.can(resource, action, source.id)).map((source) => source.id);
}

/** True when `sourceId` is a row in the sources table or a registered manager. */
export async function sourceExists(sourceId: string): Promise<boolean> {
  if (sourceManagerRegistry.getManager(sourceId)) return true;
  return (await databaseService.sources.getSource(sourceId)) !== null;
}

type ReadSourceId = { ok: true; sourceId: string | undefined } | { ok: false };

/**
 * Read the one `sourceId` a request names, from the query or the body. Sends
 * the 400 and returns `{ ok: false }` for a non-string value or two different
 * values.
 */
export function readRequestSourceId(req: Request, res: Response): ReadSourceId {
  const fromQuery = req.query?.sourceId;
  const fromBody = (req.body as { sourceId?: unknown } | undefined)?.sourceId;
  for (const raw of [fromQuery, fromBody]) {
    if (!isBlank(raw) && typeof raw !== 'string') {
      fail(res, 400, 'BAD_REQUEST', 'Invalid sourceId');
      return { ok: false };
    }
  }
  const query = isBlank(fromQuery) ? undefined : (fromQuery as string);
  const body = isBlank(fromBody) ? undefined : (fromBody as string);
  if (query !== undefined && body !== undefined && query !== body) {
    fail(res, 400, 'SOURCE_ID_CONFLICT', 'The query and the body name different sources; send sourceId once');
    return { ok: false };
  }
  return { ok: true, sourceId: query ?? body };
}

/** Run `steps` in order as one middleware, so a route cannot mount part of
 *  the chain. Each step answers the request or calls on to the next. */
function chain(steps: RequestHandler[]): RequestHandler {
  return (req, res, next) => {
    const run = (index: number): void => {
      if (index === steps.length) {
        next();
        return;
      }
      Promise.resolve(steps[index](req, res, (err?: unknown) => (err ? next(err) : run(index + 1)))).catch(next);
    };
    run(0);
  };
}

/**
 * Middleware: resolve the request's source, check `resource:action` on it,
 * and bind the result to the request. See the file header for the steps.
 */
export function requireSourcePermission(
  resource: ResourceType,
  action: PermissionAction,
  options: SourceScopeOptions,
): RequestHandler {
  const device = options.device ?? 'any';
  const { whenOmitted } = options;
  if (device === 'meshtastic' && whenOmitted !== 'primary' && whenOmitted !== 'required') {
    throw new Error('requireSourcePermission: a device route resolves to one source (primary or required)');
  }

  const resolveTarget: RequestHandler = (req: Request, res: Response, next: NextFunction): void => {
    const read = readRequestSourceId(req, res);
    if (!read.ok) return;
    const named = read.sourceId;

    let target: SourceTarget;
    if (named !== undefined) {
      target = { sourceId: named, named: true, sourceIds: [named], manager: resolveOwnMeshtasticManager(named) };
    } else if (whenOmitted === 'primary') {
      // Primary Meshtastic manager, or the unconfigured fallback when none is
      // registered. Never null for an omitted id.
      const manager = resolveOwnMeshtasticManager(undefined);
      const sourceId = manager?.sourceId ?? null;
      target = { sourceId, named: false, sourceIds: sourceId ? [sourceId] : [], manager };
    } else {
      // 'permitted' / 'first-permitted' are filled in after the user is known;
      // 'required' is refused by the permission step.
      target = { sourceId: null, named: false, sourceIds: [], manager: null };
    }
    (req as unknown as Carrier)[TARGET] = target;
    next();
  };

  const checkPermission = requirePermission(resource, action, {
    sourceIdFrom: (req) => getSourceTarget(req).sourceId ?? undefined,
    requireSourceId: whenOmitted === 'required' || whenOmitted === 'primary',
  });

  const bindTarget: RequestHandler = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const target = getSourceTarget(req);

    if (target.named) {
      const sourceId = target.sourceId as string;
      if (device === 'meshtastic') {
        if (await refuseNonMeshtasticSource(res, sourceId, options.what)) return;
        if (!target.manager || target.manager.sourceId !== sourceId) {
          fail(res, 404, 'SOURCE_NOT_FOUND', `Source "${sourceId}" was not found.`);
          return;
        }
      } else if (!(await sourceExists(sourceId))) {
        fail(res, 404, 'SOURCE_NOT_FOUND', `Source "${sourceId}" was not found.`);
        return;
      }
      next();
      return;
    }

    if (whenOmitted === 'permitted') {
      target.sourceIds = await listPermittedSourceIds(req.user, resource, action);
    } else if (whenOmitted === 'first-permitted') {
      const user = req.user;
      const first = user
        ? await resolveDefaultSourceForUser(user.id, Boolean(user.isAdmin), resource, action)
        : null;
      if (!first) {
        fail(res, 400, 'MISSING_SOURCE_ID', 'No permitted source', {
          details: `Provide a sourceId, or ensure your account has ${resource}:${action} on at least one enabled source`,
        });
        return;
      }
      target.sourceId = first.id;
      target.sourceIds = [first.id];
      target.manager = resolveOwnMeshtasticManager(first.id);
    }
    next();
  };

  const gate = chain([resolveTarget, checkPermission, bindTarget]);
  const info: SourceScopedGate = { resource, action, whenOmitted, device };
  (gate as unknown as { [SOURCE_SCOPED_GATE]: SourceScopedGate })[SOURCE_SCOPED_GATE] = info;
  return gate;
}

export interface SourcePairTarget {
  /** Source read from. The caller holds `resource:read` on it. */
  fromSourceId: string;
  /** Source written to. The caller holds `resource:write` on it. */
  toSourceId: string;
}

/** The pair resolved by `requireSourcePairPermission()` for this request. */
export function getSourcePairTarget(req: Request): SourcePairTarget {
  const pair = (req as unknown as Carrier)[PAIR];
  if (!pair) {
    throw new Error('getSourcePairTarget: route is not behind requireSourcePairPermission()');
  }
  return pair;
}

/**
 * Middleware for a route that reads one source and writes another (copy
 * NodeInfo). The body names both. The caller needs `resource:read` on the
 * source read from AND `resource:write` on the source written to; either one
 * missing is the same 403, so the reply does not say which. Unknown ids are a
 * 404 after both checks pass.
 */
export function requireSourcePairPermission(
  resource: ResourceType,
  fields: { readFrom: string; writeTo: string },
): RequestHandler {
  const resolvePair: RequestHandler = (req: Request, res: Response, next: NextFunction): void => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const from = body[fields.readFrom];
    const to = body[fields.writeTo];
    if (isBlank(from) || isBlank(to)) {
      fail(res, 400, 'MISSING_SOURCE_ID', `${fields.readFrom} and ${fields.writeTo} are required`);
      return;
    }
    if (typeof from !== 'string' || typeof to !== 'string') {
      fail(res, 400, 'BAD_REQUEST', `${fields.readFrom} and ${fields.writeTo} must be strings`);
      return;
    }
    (req as unknown as Carrier)[PAIR] = { fromSourceId: from, toSourceId: to };
    next();
  };

  const checkWrite = requirePermission(resource, 'write', {
    sourceIdFrom: (req) => getSourcePairTarget(req).toSourceId,
    requireSourceId: true,
  });

  const checkReadAndBind: RequestHandler = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const pair = getSourcePairTarget(req);
    const user = req.user;
    if (!user || !(await hasPermission(user, resource, 'read', pair.fromSourceId))) {
      // Same body as requirePermission's refusal, so the two cannot be told apart.
      res.status(403).json({
        error: 'Insufficient permissions',
        code: 'FORBIDDEN',
        required: { resource, action: 'write' },
      });
      return;
    }
    for (const sourceId of [pair.fromSourceId, pair.toSourceId]) {
      if (!(await sourceExists(sourceId))) {
        fail(res, 404, 'SOURCE_NOT_FOUND', `Source "${sourceId}" was not found.`);
        return;
      }
    }
    next();
  };

  const gate = chain([resolvePair, checkWrite, checkReadAndBind]);
  const info: SourcePairGate = { resource, readFrom: fields.readFrom, writeTo: fields.writeTo };
  (gate as unknown as { [SOURCE_PAIR_GATE]: SourcePairGate })[SOURCE_PAIR_GATE] = info;
  return gate;
}

/**
 * Read one page of rows from several sources as if they were one list, newest
 * first. Used where a route used to read every source in one query and a
 * non-admin must now see only the sources they hold the permission on.
 *
 * Each source is asked for the first `offset + limit` rows; the merge is then
 * sorted and sliced, so paging matches a single query over the same sources.
 */
export async function readNewestAcrossSources<T>(
  sourceIds: string[],
  fetch: (sourceId: string, limit: number) => Promise<T[]>,
  sortKey: (row: T) => number,
  limit: number,
  offset = 0,
): Promise<T[]> {
  const pages = await Promise.all(sourceIds.map((sourceId) => fetch(sourceId, offset + limit)));
  return pages
    .flat()
    .sort((a, b) => sortKey(b) - sortKey(a))
    .slice(offset, offset + limit);
}
