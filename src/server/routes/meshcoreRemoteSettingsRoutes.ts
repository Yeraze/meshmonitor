/**
 * Remote structured settings for a Repeater / Room Server (#6256, P10).
 *
 * The same settings service and schema as the local Repeater form (P9), over
 * the remote-admin CLI (`meshcoreRemoteRepeaterTransport`). Every command is an
 * encrypted DM over RF with a DM reply, so these routes add the mesh limits
 * the maintainer chose (MESHCORE_PARITY_P10_SPEC.md):
 *
 *  - reads are per group and only on request; nothing reads on mount;
 *  - one structured operation in flight per (source, target);
 *  - 40 remote settings commands per 10 minutes per source (in memory);
 *  - at least 1 s between commands, `recordMeshTx()` after each one;
 *  - stop at the first timeout, the rest `NOT_SENT`; no retries, no auto login;
 *  - an active remembered admin session is required (DB check, zero RF).
 *
 * Gated on `remote_admin:write`, the same grant that mounts the remote console.
 */
import { Router, Request, Response } from 'express';
import { logger } from '../../utils/logger.js';
import { requireAuth, requirePermission } from '../auth/authMiddleware.js';
import { meshcoreDeviceLimiter } from '../middleware/rateLimiters.js';
import { extendRequestTimeout } from '../middleware/requestTimeout.js';
import { ok, fail } from '../utils/apiResponse.js';
import {
  managerFor,
  isValidPublicKey,
  auditMeshcoreEvent,
  resolveCliTimeoutMs,
  requireMeshcoreTx,
  failIfTxDisabled,
} from './meshcoreRouteShared.js';
import { MeshCoreDeviceType, type MeshCoreManager } from '../meshcoreManager.js';
import { recordMeshcoreCliHistory, cliRequester, cliErrorOutcome } from '../services/meshcoreCliHistoryService.js';
import { readRepeaterSettings, writeRepeaterSettings } from '../services/meshcoreRepeaterSettingsService.js';
import {
  createRemoteRepeaterTransport,
  RemoteTransportAbortedError,
} from '../services/meshcoreRemoteRepeaterTransport.js';
import {
  getRepeaterGates,
  getRepeaterSettingDef,
  settingsFor,
  validateRepeaterPatch,
  type RepeaterDeviceType,
  type RepeaterGates,
  type RepeaterSettingGroup,
  type RepeaterSettingKey,
} from '../../utils/meshcoreRepeaterSettings.js';

/** A full 15-key run at 15 s per command is under 4 minutes; leave headroom. */
const REMOTE_SETTINGS_REQUEST_TIMEOUT_MS = 300_000;
export const REMOTE_SETTINGS_BUDGET_MAX = 40;
export const REMOTE_SETTINGS_BUDGET_WINDOW_MS = 10 * 60_000;
const GROUPS: readonly RepeaterSettingGroup[] = ['identity', 'adverts', 'access'];

// Process-local state, like the source managers it guards.
/** (source:target) pairs with a structured operation running. */
const inFlight = new Set<string>();
/** Per-source send timestamps for the rolling command budget. */
const budget = new Map<string, number[]>();
/** Last `ver` reply per (source:target), so gates cost one command per target. */
const firmwareCache = new Map<string, string | null>();
/** Last advert.interval read per (source:target): the firmware zeroes 1–59 on any save. Lost on restart; the drift check then just skips. */
const advertIntervalCache = new Map<string, number>();
/** Both caches hold one entry per target someone has opened; cap them so a long uptime cannot grow them without bound. */
const CACHE_MAX_ENTRIES = 500;

function cacheSet<V>(cache: Map<string, V>, key: string, value: V): void {
  cache.delete(key);
  cache.set(key, value);
  if (cache.size > CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
}

/** Test hook: clear the in-memory budget, busy and firmware state. */
export function resetRemoteSettingsStateForTests(): void {
  inFlight.clear();
  budget.clear();
  firmwareCache.clear();
  advertIntervalCache.clear();
}

class BudgetExceededError extends Error {
  constructor() {
    super('Remote settings budget used up');
    this.name = 'BudgetExceededError';
  }
}

/**
 * The live, pruned send list for a source. `beforeSend` pushes onto the returned
 * array, which is the one stored in the map. Preflight refuses a run that would
 * exceed the cap; `beforeSend` re-checks per command as the hard stop.
 */
function budgetUsed(sourceId: string, now = Date.now()): number[] {
  const kept = (budget.get(sourceId) ?? []).filter((t) => now - t < REMOTE_SETTINGS_BUDGET_WINDOW_MS);
  budget.set(sourceId, kept);
  return kept;
}

function budgetRetryAfterSeconds(sourceId: string, now = Date.now()): number {
  const used = budgetUsed(sourceId, now);
  if (used.length === 0) return 0;
  return Math.max(1, Math.ceil((used[0] + REMOTE_SETTINGS_BUDGET_WINDOW_MS - now) / 1000));
}

function deviceTypeOf(advType: unknown): RepeaterDeviceType | null {
  if (advType === MeshCoreDeviceType.REPEATER) return 'repeater';
  if (advType === MeshCoreDeviceType.ROOM_SERVER) return 'room';
  return null;
}

interface Target {
  sourceId: string;
  publicKey: string;
  manager: MeshCoreManager;
  deviceType: RepeaterDeviceType;
  name: string | null;
  cacheKey: string;
}

/** Resolve the target contact; null means a response was already sent. */
function resolveTarget(req: Request, res: Response): Target | null {
  const sourceId = req.params.id as string;
  const publicKey = String(req.params.publicKey ?? '').toLowerCase();
  if (!isValidPublicKey(publicKey)) {
    fail(res, 400, 'INVALID_PUBLIC_KEY', 'Invalid public key format (expected 64-character hex string)');
    return null;
  }
  const manager = managerFor(req, res);
  // A disconnected source has no meaningful device type; preflight answers SOURCE_NOT_CONNECTED.
  const status = manager.getConnectionStatus();
  if (status.connected && status.deviceType !== MeshCoreDeviceType.COMPANION) {
    fail(res, 400, 'COMPANION_REQUIRED', 'Remote settings need a Companion source');
    return null;
  }
  const contact = manager.getContact(publicKey);
  if (!contact) {
    fail(res, 404, 'CONTACT_NOT_FOUND', 'That node is not in this source\'s contacts');
    return null;
  }
  const deviceType = deviceTypeOf(contact.advType);
  if (!deviceType) {
    fail(res, 409, 'NOT_REMOTE_ADMIN_TARGET', 'Remote settings are only for Repeaters and Room Servers');
    return null;
  }
  return {
    sourceId,
    publicKey,
    manager,
    deviceType,
    name: contact.advName ?? contact.name ?? null,
    cacheKey: `${sourceId}:${publicKey}`,
  };
}

/** Connection, admin session, busy and budget checks; null = go, else the sent response. */
async function preflight(res: Response, target: Target, plannedSends: number): Promise<Response | null> {
  if (!target.manager.getConnectionStatus().connected) {
    return fail(res, 409, 'SOURCE_NOT_CONNECTED', 'Connect this source to reach the remote node');
  }
  const session = await target.manager.getAdminSession(target.publicKey);
  if (!session.active) {
    return fail(res, 409, 'ADMIN_SESSION_REQUIRED', 'Log in to this node as admin first (remote settings never log in on their own)');
  }
  if (inFlight.has(target.cacheKey)) {
    return fail(res, 409, 'REMOTE_SETTINGS_BUSY', 'Another settings read or save is still running on this node');
  }
  const used = budgetUsed(target.sourceId).length;
  if (used + plannedSends > REMOTE_SETTINGS_BUDGET_MAX) {
    return fail(res, 429, 'REMOTE_SETTINGS_BUDGET',
      `This needs ${plannedSends} radio commands but only ${Math.max(0, REMOTE_SETTINGS_BUDGET_MAX - used)} of ${REMOTE_SETTINGS_BUDGET_MAX} per 10 minutes are left`,
      { retryAfterSeconds: budgetRetryAfterSeconds(target.sourceId) });
  }
  return null;
}

interface RunContext {
  transport: ReturnType<typeof createRemoteRepeaterTransport>;
  sent: () => number;
  abort: AbortController;
}

async function openRun(req: Request, res: Response, target: Target, opts: { historyForSets: boolean }): Promise<RunContext> {
  const abort = new AbortController();
  // A client that goes away (or Cancel in the UI) stops the run before the next send.
  res.on('close', () => {
    if (!res.writableFinished) abort.abort();
  });
  const timeoutMs = await resolveCliTimeoutMs();
  let sent = 0;
  const requester = cliRequester(req);
  const transport = createRemoteRepeaterTransport(target.manager, target.publicKey, {
    timeoutMs,
    signal: abort.signal,
    beforeSend: () => {
      const used = budgetUsed(target.sourceId);
      if (used.length >= REMOTE_SETTINGS_BUDGET_MAX) throw new BudgetExceededError();
      used.push(Date.now());
      sent += 1;
    },
    afterSend: (cmd, outcome) => {
      if (!opts.historyForSets || !/^set\s|^password\s/i.test(cmd)) return;
      // One redacted history row per remote `set` (the service never sends secrets in clear here: the redactor masks them).
      void recordMeshcoreCliHistory({
        sourceId: target.sourceId,
        targetKind: 'remote',
        targetPublicKey: target.publicKey,
        targetName: target.name,
        origin: 'user',
        ...requester,
        command: cmd,
        outcome: outcome.error ? cliErrorOutcome(outcome.error) : 'ok',
        reply: outcome.reply ?? null,
        error: outcome.error ?? null,
        elapsedMs: outcome.elapsedMs ?? null,
      });
    },
  });
  return { transport, sent: () => sent, abort };
}

/** `ver` once per target per process; returns the gates (open when unknown). */
async function firmwareFor(target: Target, run: RunContext | null): Promise<{ ver: string | null; gates: RepeaterGates }> {
  if (firmwareCache.has(target.cacheKey) || !run) {
    const ver = firmwareCache.get(target.cacheKey) ?? null;
    return { ver, gates: getRepeaterGates(ver) };
  }
  let ver: string | null;
  try {
    const reply = (await run.transport.run('ver')).trim().replace(/^>\s?/, '');
    ver = reply.length > 0 ? reply : null;
  } catch (err) {
    if (err instanceof RemoteTransportAbortedError || err instanceof BudgetExceededError) throw err;
    ver = null;
  }
  cacheSet(firmwareCache, target.cacheKey, ver);
  return { ver, gates: getRepeaterGates(ver) };
}

function readKeysFor(deviceType: RepeaterDeviceType, groups: readonly RepeaterSettingGroup[]): RepeaterSettingKey[] {
  return settingsFor({ mode: 'remote', deviceType, groups })
    .filter((d) => d.getVerb !== null)
    .map((d) => d.key);
}

function parseGroups(body: unknown): RepeaterSettingGroup[] | null {
  const groups = (body as { groups?: unknown } | undefined)?.groups;
  if (!Array.isArray(groups) || groups.length === 0) return null;
  const out: RepeaterSettingGroup[] = [];
  for (const g of groups) {
    if (typeof g !== 'string' || !GROUPS.includes(g as RepeaterSettingGroup)) return null;
    if (!out.includes(g as RepeaterSettingGroup)) out.push(g as RepeaterSettingGroup);
  }
  return out;
}

function handleRunError(req: Request, res: Response, err: unknown, action: string): Response | void {
  if (failIfTxDisabled(res, err)) return;
  if (err instanceof RemoteTransportAbortedError) {
    return fail(res, 409, 'REMOTE_SETTINGS_CANCELLED', 'Cancelled');
  }
  if (err instanceof BudgetExceededError) {
    return fail(res, 429, 'REMOTE_SETTINGS_BUDGET', 'The remote settings budget ran out', {
      retryAfterSeconds: budgetRetryAfterSeconds(req.params.id as string),
    });
  }
  logger.error(`[API] Remote settings ${action} failed:`, err);
  return fail(res, 500, 'REMOTE_SETTINGS_FAILED', `Remote settings ${action} failed`);
}

const router = Router({ mergeParams: true });

const gates = [
  extendRequestTimeout(REMOTE_SETTINGS_REQUEST_TIMEOUT_MS),
  meshcoreDeviceLimiter,
  requireAuth(),
  requirePermission('remote_admin', 'write', { sourceIdFrom: 'params.id' }),
  requireMeshcoreTx(),
];

/**
 * POST /api/sources/:id/meshcore/admin/settings/:publicKey/read
 * Body: { groups: ('identity'|'adverts'|'access')[] }
 *
 * Reads only the requested groups' keys (plus `ver` once per target). Each key
 * is one DM out and one DM reply. Response `data`: `{ values, guestPasswordSet,
 * errors, firmware, deviceType, gates, sent, stoppedAt? }`.
 */
router.post('/admin/settings/:publicKey/read', ...gates, async (req: Request, res: Response) => {
  const groups = parseGroups(req.body);
  if (!groups) {
    return fail(res, 400, 'VALIDATION', 'groups must be a non-empty list of identity, adverts or access', { field: 'groups' });
  }
  let target: Target | null;
  try {
    target = resolveTarget(req, res);
    if (!target) return;
    const keys = readKeysFor(target.deviceType, groups);
    const planned = keys.length + (firmwareCache.has(target.cacheKey) ? 0 : 1);
    const refused = await preflight(res, target, planned);
    if (refused) return refused;
    inFlight.add(target.cacheKey);
    try {
      const run = await openRun(req, res, target, { historyForSets: false });
      const { ver, gates: fw } = await firmwareFor(target, run);
      const read = await readRepeaterSettings(run.transport, fw, { keys, deviceType: target.deviceType });
      if (typeof read.values.advertInterval === 'number') {
        cacheSet(advertIntervalCache, target.cacheKey, read.values.advertInterval);
      }
      auditMeshcoreEvent(req, 'meshcore_remote_settings_read', 'remote_admin', {
        sourceId: target.sourceId,
        publicKey: target.publicKey,
        groups,
        sent: run.sent(),
        stoppedAt: read.stoppedAt ?? null,
      });
      return ok(res, {
        values: read.values,
        guestPasswordSet: read.guestPasswordSet,
        errors: read.errors,
        firmware: ver,
        deviceType: target.deviceType,
        gates: fw,
        sent: run.sent(),
        ...(read.stoppedAt ? { stoppedAt: read.stoppedAt } : {}),
      });
    } finally {
      inFlight.delete(target.cacheKey);
    }
  } catch (err) {
    return handleRunError(req, res, err, 'read');
  }
});

/**
 * PATCH /api/sources/:id/meshcore/admin/settings/:publicKey
 * Body: partial settings patch (only the keys to change).
 *
 * Validated against the remote schema for the target's device type first
 * (400 VALIDATION with `field`). Then each key is `set` once, and only the
 * sent keys are read back. Response `data`: `{ ok, results, values,
 * guestPasswordSet, drifted, sent }`; a key the run never reached is
 * `{ ok: false, code: 'NOT_SENT' }`.
 */
router.patch('/admin/settings/:publicKey', ...gates, async (req: Request, res: Response) => {
  const body = req.body as Record<string, unknown> | undefined;
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length === 0) {
    return fail(res, 400, 'VALIDATION', 'Send at least one setting to change');
  }
  let target: Target | null;
  try {
    target = resolveTarget(req, res);
    if (!target) return;
    // Validate BEFORE any connection or session check, against the known firmware (open gates when unknown).
    const { gates: knownGates } = await firmwareFor(target, null);
    const validation = validateRepeaterPatch(body, knownGates, { mode: 'remote', deviceType: target.deviceType });
    if (!validation.ok) {
      const first = validation.errors[0];
      return fail(res, 400, 'VALIDATION', first.message, { field: first.field, errors: validation.errors });
    }
    const patchKeys = Object.keys(validation.values);
    // Each key: one set + one readback get; plus the advert.interval drift check.
    const planned = patchKeys.length * 2 + 1;
    const refused = await preflight(res, target, planned);
    if (refused) return refused;
    inFlight.add(target.cacheKey);
    try {
      const run = await openRun(req, res, target, { historyForSets: true });
      const cachedAdvert = advertIntervalCache.get(target.cacheKey);
      const current = typeof cachedAdvert === 'number' && cachedAdvert >= 1 && cachedAdvert <= 59
        ? { advertInterval: cachedAdvert }
        : {};
      const result = await writeRepeaterSettings(run.transport, knownGates, current, body, {
        readback: 'sent',
        deviceType: target.deviceType,
      });
      if (typeof result.read.values.advertInterval === 'number') {
        cacheSet(advertIntervalCache, target.cacheKey, result.read.values.advertInterval);
      }
      const changed: Record<string, unknown> = {};
      for (const [key, r] of Object.entries(result.results)) {
        if (!r?.changed) continue;
        changed[key] = getRepeaterSettingDef(key)?.secret
          ? '[changed]'
          : validation.values[key as keyof typeof validation.values];
      }
      auditMeshcoreEvent(req, 'meshcore_remote_settings_update', 'remote_admin', {
        sourceId: target.sourceId,
        publicKey: target.publicKey,
        changed,
        failed: Object.entries(result.results).filter(([, r]) => r && !r.ok).map(([k]) => k),
        sent: run.sent(),
      });
      return ok(res, {
        ok: result.ok,
        results: result.results,
        values: result.read.values,
        guestPasswordSet: result.read.guestPasswordSet,
        drifted: result.drifted,
        sent: run.sent(),
      });
    } finally {
      inFlight.delete(target.cacheKey);
    }
  } catch (err) {
    return handleRunError(req, res, err, 'save');
  }
});

export default router;
