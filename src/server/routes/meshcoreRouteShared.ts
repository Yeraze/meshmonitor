/**
 * MeshCore API Routes — shared plumbing
 *
 * Cross-cutting helpers, validation, and the router-level guard used by
 * every MeshCore route sub-router (device/contacts/config/messaging/
 * admin/automation/packets). Extracted verbatim from the former
 * monolithic `meshcoreRoutes.ts` (epic #3962 Task 4.3) so each sub-router
 * can import exactly the symbols it needs.
 *
 * Authentication:
 * - Read-only endpoints use optionalAuth() (status, nodes, contacts, messages)
 * - Write operations require authentication (connect, disconnect, send, config)
 */

import { Request, Response, NextFunction } from 'express';
import { MeshCoreManager } from '../meshcoreManager.js';
import { sourceManagerRegistry } from '../sourceManagerRegistry.js';
import { isMeshCoreManager } from '../sourceManagerTypes.js';
import databaseService from '../../services/database.js';
import { logger } from '../../utils/logger.js';
import { fail } from '../utils/apiResponse.js';
import { TX_DISABLED_CODE, isTxDisabledError } from '../errors/txDisabledError.js';
import { MESHCORE_RECEIVE_ONLY_MESSAGE } from '../constants/meshcoreTx.js';

/**
 * Resolve the manager for a request. Mounted only under
 * `/api/sources/:id/meshcore/*`, so `req.params.id` is always present —
 * the legacy un-nested mount and its registry fallback were removed in
 * slice 3 along with the global `meshcore` permission resource.
 *
 * Presence + existence of the manager is enforced by the router-level
 * guard below, so the assertion here is safe.
 */
export function managerFor(_req: Request, res: Response): MeshCoreManager {
  // Return the manager cached in res.locals by the router-level guard.
  // This eliminates the TOCTOU window of a second getManager() call after the
  // guard has already verified existence + type.
  return res.locals.meshcoreManager as MeshCoreManager;
}

/**
 * Router-level guard: every request must carry an `:id` and that source
 * must have a registered manager. This lets every handler call
 * `managerFor` without null-checking at each call-site.
 */
export function meshcoreRouteGuard(req: Request, res: Response, next: NextFunction) {
  const sourceId = (req.params as { id?: string }).id;
  if (!sourceId) {
    return res.status(404).json({
      success: false,
      error: 'MeshCore routes must be mounted under /api/sources/:id/meshcore',
    });
  }
  const _guardMgr = sourceManagerRegistry.getManager(sourceId);
  if (!_guardMgr || !isMeshCoreManager(_guardMgr)) {
    return res.status(404).json({
      success: false,
      error: `No MeshCore manager for source ${sourceId}`,
    });
  }
  // Cache the narrowed manager so managerFor() can avoid a second registry lookup.
  res.locals.meshcoreManager = _guardMgr as MeshCoreManager;
  next();
}

/**
 * Router middleware: reject a request on a receive-only MeshCore source with
 * 409 TX_DISABLED (#4547). MUST be placed AFTER requirePermission(...) so a
 * 403 still wins over a 409 for an unauthorized caller, and after
 * meshcoreRouteGuard so res.locals.meshcoreManager is populated.
 *
 * Fails CLOSED: if `res.locals.meshcoreManager` is missing — meaning
 * meshcoreRouteGuard was skipped, or ran against a source whose manager
 * vanished between the guard and here — this cannot verify the source is
 * safe to transmit on, so it refuses the request rather than letting it
 * through. Mirrors meshcoreRouteGuard's own "no manager for source" 404
 * shape so callers see one consistent error for an unresolvable manager.
 */
export function requireMeshcoreTx() {
  return (req: Request, res: Response, next: NextFunction) => {
    const mgr = res.locals.meshcoreManager as MeshCoreManager | undefined;
    if (!mgr) {
      const sourceId = (req.params as { id?: string }).id;
      return res.status(404).json({
        success: false,
        error: `No MeshCore manager for source ${sourceId}`,
      });
    }
    if (mgr.isReceiveOnly()) {
      return fail(res, 409, TX_DISABLED_CODE, MESHCORE_RECEIVE_ONLY_MESSAGE);
    }
    next();
  };
}

/**
 * Inline guard for handlers that transmit only on some inputs (e.g. POST /cli
 * with the `advert` verb). Returns true when it has already sent the 409.
 */
export function rejectIfReceiveOnly(req: Request, res: Response): boolean {
  if (managerFor(req, res).isReceiveOnly()) {
    fail(res, 409, TX_DISABLED_CODE, MESHCORE_RECEIVE_ONLY_MESSAGE);
    return true;
  }
  return false;
}

/**
 * Catch-block mapping: converts a TxDisabledError raised mid-request (the
 * flag flipped between the pre-check and the send) into 409 instead of 500.
 * Returns true when it has already sent the response.
 */
export function failIfTxDisabled(res: Response, error: unknown): boolean {
  if (isTxDisabledError(error)) {
    fail(res, 409, TX_DISABLED_CODE, MESHCORE_RECEIVE_ONLY_MESSAGE);
    return true;
  }
  return false;
}

/**
 * Input Validation Constants
 */
export const VALIDATION = {
  /** MeshCore public keys are 64-character hex strings (32 bytes) */
  PUBLIC_KEY_LENGTH: 64,
  /** Maximum message byte limits per context (UTF-8 byte count, not char count) */
  MAX_MESSAGE_BYTES_CHANNEL: 130,
  MAX_MESSAGE_BYTES_CHANNEL_SCOPED: 120,
  MAX_MESSAGE_BYTES_DM: 150,
  /** Legacy fallback — keep for safety ceiling in shared validation path */
  MAX_MESSAGE_LENGTH: 150,
  /** Maximum device name length */
  MAX_NAME_LENGTH: 32,
  /** Maximum message history limit */
  MAX_MESSAGE_LIMIT: 1000,
  /** Maximum pagination offset for message history (mirrors the Meshtastic
   *  /api/messages/channel offset cap) */
  MAX_MESSAGE_OFFSET: 50000,
  /** Radio frequency range (MHz) */
  FREQ_MIN: 137.0,
  FREQ_MAX: 1020.0,
  /** Bandwidth values (kHz) */
  VALID_BANDWIDTHS: [7.8, 10.4, 15.6, 20.8, 31.25, 41.7, 62.5, 125, 250, 500],
  /** Spreading factor range */
  SF_MIN: 5,
  SF_MAX: 12,
  /** Coding rate range (represents 4/5 through 4/8) */
  CR_MIN: 5,
  CR_MAX: 8,
  /** Valid baud rates */
  VALID_BAUD_RATES: [9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600],
  /** TCP port range */
  PORT_MIN: 1,
  PORT_MAX: 65535,
} as const;

/**
 * Destructive MeshCore CLI commands. Requests targeting any matching
 * command must carry `confirm: true` in the body or the /admin/cli route
 * rejects with DANGER_CONFIRM_REQUIRED. Keep in sync with the matching
 * pattern in CliConsoleBody.tsx so the client knows which commands to
 * route through its typed-name confirmation modal.
 *
 * The trailing `(?!\.)` excludes danger words used as the prefix of a
 * dotted config key (e.g. `get reboot.interval`, `set clkreboot.retries 3`)
 * — those are read/write config-path operations, not the standalone verb.
 */
export const DANGER_COMMAND_PATTERN = /\b(reboot|erase|clkreboot|factory)\b(?!\.)/i;

/**
 * Resolve the effective CLI reply-timeout (ms) for a MeshCore console command
 * (issue #4027).
 *
 * Priority:
 *  1. An explicit, in-range `timeoutMs` from the request body — a per-call
 *     override (1ms..60s), unchanged from the original behavior.
 *  2. The global `meshcoreCliTimeoutSeconds` setting, clamped to 1..60s, so an
 *     operator with a directly-reachable repeater can shorten the default wait
 *     and re-fire a command sooner instead of being blocked the full 15s.
 *  3. `undefined` — the manager then applies its built-in 15s default. Returning
 *     `undefined` (rather than a hard 15000) keeps the "no setting" path byte-for-
 *     byte identical to the pre-#4027 behavior.
 */
export async function resolveCliTimeoutMs(timeoutMs?: number): Promise<number | undefined> {
  if (typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) && timeoutMs > 0 && timeoutMs <= 60_000) {
    return timeoutMs;
  }
  const raw = await databaseService.settings.getSetting('meshcoreCliTimeoutSeconds');
  const seconds = raw == null ? NaN : parseInt(raw, 10);
  if (Number.isFinite(seconds) && seconds >= 1 && seconds <= 60) {
    return seconds * 1000;
  }
  return undefined;
}

/**
 * Validation helper functions
 */
export function isValidPublicKey(key: string | undefined): boolean {
  if (!key || typeof key !== 'string') return false;
  return /^[0-9a-fA-F]{64}$/.test(key);
}

/**
 * Fire-and-forget audit log helper for MeshCore admin / CLI routes.
 *
 * Matches the project's existing auditLogAsync usage: userId may be null
 * for anonymous, `action` is a verb naming the operation, `resource` is
 * one of the permission resources, and `details` is a JSON-serialized
 * object with whatever's relevant.
 *
 * **NEVER pass a password (or any decrypted credential) in `details`.**
 * The login routes call this only after stripping `password`,
 * `rememberPassword`, and the decrypted plaintext from the body.
 *
 * Errors from the audit write itself are swallowed — losing a single
 * audit row is preferable to failing the request the user cares about.
 */
export function auditMeshcoreEvent(
  req: Request,
  action: string,
  resource: 'remote_admin' | 'configuration' | 'messages',
  details: Record<string, unknown>,
): void {
  const userId = req.session?.userId ?? null;
  const ip = req.ip || req.socket?.remoteAddress || null;
  databaseService
    .auditLogAsync(userId, action, resource, JSON.stringify(details), ip)
    .catch((err) => logger.error('[API] audit write failed:', err));
}

/**
 * Enhance a raw `neighbors` CLI reply with resolved node names.
 * Replaces each `{8-char-prefix}:{secs}:{snr*4}` line with a
 * human-readable version showing the contact name, SNR in dB,
 * and last-heard time.
 */
export function enhanceNeighborsReply(reply: string, manager: ReturnType<typeof managerFor>): string {
  const trimmed = reply.trim();
  if (!trimmed || trimmed === '-none-' || /not supported/i.test(trimmed)) return reply;

  const lines = trimmed.split('\n');
  const enhanced: string[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const parts = line.split(':');
    if (parts.length < 3) { enhanced.push(line); continue; }

    const prefix = parts[0].toLowerCase();
    if (!/^[0-9a-f]{8}$/.test(prefix)) { enhanced.push(line); continue; }

    const secs = parseInt(parts[1], 10);
    const snrRaw = parseInt(parts[2], 10);
    if (Number.isNaN(secs) || Number.isNaN(snrRaw)) { enhanced.push(line); continue; }

    const contact = manager.resolveContactByPrefix(prefix);
    const name = contact?.advName ?? contact?.name ?? prefix;
    const snrDb = (snrRaw / 4).toFixed(1);
    const ago = secs < 60 ? `${secs}s` : secs < 3600 ? `${Math.floor(secs / 60)}m` : `${Math.floor(secs / 3600)}h${Math.floor((secs % 3600) / 60)}m`;
    enhanced.push(`${name}  SNR: ${snrDb} dB  heard: ${ago} ago`);
  }
  return enhanced.join('\n');
}

/**
 * Parse a comma-separated hex chain into a flat Uint8Array of hop bytes.
 *
 * Each token is exactly `hashBytes` bytes wide (`hashBytes * 2` hex chars):
 * "a3,7f,02" for the default 1-byte width, "a3f2,7f01" for 2-byte, etc.
 * Empty string parses to a zero-length array (zero-hop direct path).
 * Returns null on any malformed/wrong-width token so the route can 400.
 */
export function parseHexPathChain(input: string, hashBytes: 1 | 2 | 3 = 1): Uint8Array | null {
  const trimmed = input.trim();
  if (trimmed.length === 0) return new Uint8Array(0);
  const parts = trimmed.split(',');
  const out = new Uint8Array(parts.length * hashBytes);
  const tokenRe = new RegExp(`^[0-9a-fA-F]{${hashBytes * 2}}$`);
  for (let i = 0; i < parts.length; i++) {
    const tok = parts[i].trim();
    if (!tokenRe.test(tok)) return null;
    for (let j = 0; j < hashBytes; j++) {
      const n = parseInt(tok.slice(j * 2, j * 2 + 2), 16);
      if (!Number.isFinite(n) || n < 0 || n > 0xff) return null;
      out[i * hashBytes + j] = n;
    }
  }
  return out;
}

export function isValidMessage(text: string | undefined, maxBytes?: number): { valid: boolean; error?: string } {
  if (!text || typeof text !== 'string') {
    return { valid: false, error: 'Message text required' };
  }
  const limit = maxBytes ?? VALIDATION.MAX_MESSAGE_LENGTH;
  const byteLen = Buffer.byteLength(text, 'utf8');
  if (byteLen > limit) {
    return { valid: false, error: `Message exceeds maximum size of ${limit} bytes (${byteLen} bytes encoded)` };
  }
  return { valid: true };
}

export function isValidName(name: string | undefined): { valid: boolean; error?: string } {
  if (!name || typeof name !== 'string') {
    return { valid: false, error: 'Name required' };
  }
  if (name.length > VALIDATION.MAX_NAME_LENGTH) {
    return { valid: false, error: `Name exceeds maximum length of ${VALIDATION.MAX_NAME_LENGTH} characters` };
  }
  if (name.trim().length === 0) {
    return { valid: false, error: 'Name cannot be empty or whitespace only' };
  }
  return { valid: true };
}

export function isValidRadioParams(freq: number, bw: number, sf: number, cr: number): { valid: boolean; error?: string } {
  if (freq < VALIDATION.FREQ_MIN || freq > VALIDATION.FREQ_MAX) {
    return { valid: false, error: `Frequency must be between ${VALIDATION.FREQ_MIN} and ${VALIDATION.FREQ_MAX} MHz` };
  }
  if (!(VALIDATION.VALID_BANDWIDTHS as readonly number[]).includes(bw)) {
    return { valid: false, error: `Bandwidth must be one of: ${VALIDATION.VALID_BANDWIDTHS.join(', ')} kHz` };
  }
  if (sf < VALIDATION.SF_MIN || sf > VALIDATION.SF_MAX || !Number.isInteger(sf)) {
    return { valid: false, error: `Spreading factor must be an integer between ${VALIDATION.SF_MIN} and ${VALIDATION.SF_MAX}` };
  }
  if (cr < VALIDATION.CR_MIN || cr > VALIDATION.CR_MAX || !Number.isInteger(cr)) {
    return { valid: false, error: `Coding rate must be an integer between ${VALIDATION.CR_MIN} and ${VALIDATION.CR_MAX}` };
  }
  return { valid: true };
}

export function isValidConnectionParams(params: {
  connectionType?: string;
  tcpPort?: number;
  baudRate?: number;
}): { valid: boolean; error?: string } {
  const { connectionType, tcpPort, baudRate } = params;

  if (connectionType && !['serial', 'tcp'].includes(connectionType)) {
    return { valid: false, error: 'Connection type must be "serial" or "tcp"' };
  }
  if (tcpPort !== undefined) {
    if (!Number.isInteger(tcpPort) || tcpPort < VALIDATION.PORT_MIN || tcpPort > VALIDATION.PORT_MAX) {
      return { valid: false, error: `TCP port must be between ${VALIDATION.PORT_MIN} and ${VALIDATION.PORT_MAX}` };
    }
  }
  if (baudRate !== undefined && !(VALIDATION.VALID_BAUD_RATES as readonly number[]).includes(baudRate)) {
    return { valid: false, error: `Baud rate must be one of: ${VALIDATION.VALID_BAUD_RATES.join(', ')}` };
  }
  return { valid: true };
}

/**
 * Per-channel permission support for MeshCore channels (#4491 follow-up).
 *
 * MeshCore's channel routes originally gated on the global `messages`
 * resource, while the channel *list* (`/api/channels/all`) gates on
 * `channel_${idx}` like Meshtastic does. Granting a user "Public: Read" on a
 * MeshCore source therefore made the channel appear with no messages in it —
 * the list check passed and the message check did not.
 *
 * These helpers let the message routes honour `channel_${idx}` the way
 * Meshtastic's `/api/messages/channel/:channel` does.
 */

/**
 * RBAC resource for a channel slot, or null when the index has none.
 * Only slots 0-7 exist as resources; MeshCore can carry higher indices, and
 * those stay on the `messages` resource because there is nothing finer to
 * check them against.
 */
export function channelResourceFor(idx: number): import('../../types/permission.js').ResourceType | null {
  return Number.isInteger(idx) && idx >= 0 && idx <= 7
    ? (`channel_${idx}` as import('../../types/permission.js').ResourceType)
    : null;
}

/**
 * True when `userId` may read/write MeshCore channel `idx` on `sourceId`.
 *
 * The check is deliberately a UNION of the per-channel resource and the legacy
 * `messages` resource. Requiring `channel_${idx}` alone would be the tidier
 * model, but it would silently revoke access from every existing install where
 * a user has `messages` and no per-channel grant. Additive means the reported
 * bug is fixed without anyone losing access they have today.
 */
export async function canAccessMeshcoreChannel(
  userId: number,
  idx: number,
  action: 'read' | 'write',
  sourceId?: string,
): Promise<boolean> {
  const resource = channelResourceFor(idx);
  if (resource && await databaseService.checkPermissionAsync(userId, resource, action, sourceId)) {
    return true;
  }
  return databaseService.checkPermissionAsync(userId, 'messages', action, sourceId);
}

/**
 * Gate a `/messages/channel/:idx` route on that channel's permission.
 *
 * Must be mounted AFTER `optionalAuth()` (reads) or `requireAuth()` (writes) —
 * both attach `req.user`, with `optionalAuth` falling back to the anonymous
 * user, which is the case this whole helper exists to make work.
 */
export function requireMeshcoreChannelAccess(action: 'read' | 'write') {
  return async (req: Request, res: Response, next: NextFunction) => {
    const idx = parseInt(req.params.idx, 10);
    if (!Number.isInteger(idx) || idx < 0) {
      return res.status(400).json({ success: false, error: 'idx must be a non-negative integer' });
    }

    const user = (req as Request & { user?: { id: number; isAdmin?: boolean } }).user;
    if (!user) {
      return res.status(401).json({ error: 'Authentication required', code: 'UNAUTHORIZED' });
    }
    if (user.isAdmin) return next();

    const sourceId = typeof req.params.id === 'string' && req.params.id.length > 0
      ? req.params.id
      : undefined;

    if (await canAccessMeshcoreChannel(user.id, idx, action, sourceId)) {
      return next();
    }

    return res.status(403).json({
      error: 'Insufficient permissions',
      code: 'FORBIDDEN',
      // Name the per-channel resource when one exists — that is the grant the
      // operator actually needs to make, and reporting `messages` here is what
      // made this confusing to debug in the first place.
      required: { resource: channelResourceFor(idx) ?? 'messages', action },
    });
  };
}
