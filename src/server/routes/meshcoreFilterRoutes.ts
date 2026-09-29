/**
 * MeshCore Ignore / Block routes (#5408, MESHCORE_IGNORE_BLOCK_SPEC.md "API").
 *
 *   GET/POST        /api/sources/:id/meshcore/ignored-nodes
 *   DELETE          /api/sources/:id/meshcore/ignored-nodes/:publicKey
 *   GET/POST        /api/sources/:id/meshcore/message-filters
 *   PUT/DELETE      /api/sources/:id/meshcore/message-filters/:filterId
 *
 * Per-source. Node entries use the `nodes` resource, text rules the
 * `messages` resource (read to list, write to change). Every write goes
 * through `meshcoreMessageFilter` so its cache is rebuilt and open views are
 * told to reload.
 *
 * Mounted on the data side of the barrel (behind `anyMeshCoreRouteGuard`), so
 * a MeshCore MQTT ingest source can keep lists too.
 */
import { Router, type Request, type Response } from 'express';
import { optionalAuth, requireAuth, requirePermission } from '../auth/authMiddleware.js';
import databaseService from '../../services/database.js';
import { logger } from '../../utils/logger.js';
import { ok, fail } from '../utils/apiResponse.js';
import {
  meshcoreMessageFilter,
  validateFilterPattern,
  type MeshCoreFilterMode,
  type MeshCoreFilterMatchType,
  type MeshCoreFilterFields,
} from '../services/meshcoreMessageFilter.js';
import type { MeshCoreMessageFilterInput } from '../../db/repositories/index.js';

const router = Router({ mergeParams: true });

const PUBLIC_KEY_RE = /^[0-9a-f]{64}$/i;
const MODES: readonly MeshCoreFilterMode[] = ['ignore', 'block'];
const MATCH_TYPES: readonly MeshCoreFilterMatchType[] = ['exact', 'wildcard', 'regex'];
const FIELDS: readonly MeshCoreFilterFields[] = ['name', 'body', 'both'];

function sourceIdOf(req: Request): string {
  return String((req.params as { id?: string }).id ?? '');
}

function userIdOf(req: Request): number | null {
  const id = (req as Request & { user?: { id?: number } }).user?.id;
  return typeof id === 'number' ? id : null;
}

function isOneOf<T extends string>(list: readonly T[], v: unknown): v is T {
  return typeof v === 'string' && (list as readonly string[]).includes(v);
}

// ============ Ignored nodes ============

router.get(
  '/ignored-nodes',
  optionalAuth(),
  requirePermission('nodes', 'read', { sourceIdFrom: 'params.id' }),
  async (req: Request, res: Response) => {
    try {
      const nodes = await meshcoreMessageFilter.listIgnoredNodes(sourceIdOf(req));
      return ok(res, nodes);
    } catch (error) {
      logger.error('[API] MeshCore ignored-nodes list failed:', error);
      return fail(res, 500, 'INTERNAL_ERROR', 'Failed to list ignored nodes');
    }
  },
);

router.post(
  '/ignored-nodes',
  requireAuth(),
  requirePermission('nodes', 'write', { sourceIdFrom: 'params.id' }),
  async (req: Request, res: Response) => {
    try {
      const sourceId = sourceIdOf(req);
      const { publicKey, mode, name } = (req.body ?? {}) as Record<string, unknown>;
      if (typeof publicKey !== 'string' || !PUBLIC_KEY_RE.test(publicKey)) {
        return fail(res, 400, 'INVALID_PUBLIC_KEY', 'publicKey must be 64 hex characters');
      }
      if (!isOneOf(MODES, mode)) {
        return fail(res, 400, 'INVALID_MODE', "mode must be 'ignore' or 'block'");
      }
      if (name !== undefined && name !== null && (typeof name !== 'string' || name.length > 255)) {
        return fail(res, 400, 'INVALID_NAME', 'name must be a string of at most 255 characters');
      }
      const key = publicKey.toLowerCase();
      let snapshot = typeof name === 'string' && name.trim() ? name.trim() : null;
      if (!snapshot) {
        const node = await databaseService.meshcore.getNodeByPublicKeyAndSource(key, sourceId);
        snapshot = node?.name?.trim() || null;
      }
      const row = await meshcoreMessageFilter.setIgnoredNode({
        sourceId,
        publicKey: key,
        name: snapshot,
        mode,
        createdBy: userIdOf(req),
      });
      return ok(res, row);
    } catch (error) {
      logger.error('[API] MeshCore ignored-nodes add failed:', error);
      return fail(res, 500, 'INTERNAL_ERROR', 'Failed to save ignored node');
    }
  },
);

router.delete(
  '/ignored-nodes/:publicKey',
  requireAuth(),
  requirePermission('nodes', 'write', { sourceIdFrom: 'params.id' }),
  async (req: Request, res: Response) => {
    try {
      const { publicKey } = req.params as { publicKey: string };
      if (!PUBLIC_KEY_RE.test(publicKey)) {
        return fail(res, 400, 'INVALID_PUBLIC_KEY', 'publicKey must be 64 hex characters');
      }
      const removed = await meshcoreMessageFilter.removeIgnoredNode(sourceIdOf(req), publicKey);
      if (!removed) return fail(res, 404, 'NOT_FOUND', 'Node is not on the ignore/block list');
      return ok(res);
    } catch (error) {
      logger.error('[API] MeshCore ignored-nodes remove failed:', error);
      return fail(res, 500, 'INTERNAL_ERROR', 'Failed to remove ignored node');
    }
  },
);

// ============ Message filters ============

/**
 * Validate a full or partial rule body. Returns the parsed fields or an error.
 * With `partial`, absent fields stay absent.
 */
function parseRuleBody(
  body: Record<string, unknown>,
  partial: boolean,
): { value: Partial<MeshCoreMessageFilterInput> } | { code: string; message: string } {
  const out: Partial<MeshCoreMessageFilterInput> = {};
  const need = (k: string) => !partial || body[k] !== undefined;

  if (need('mode')) {
    if (!isOneOf(MODES, body.mode)) return { code: 'INVALID_MODE', message: "mode must be 'ignore' or 'block'" };
    out.mode = body.mode;
  }
  if (need('matchType')) {
    if (!isOneOf(MATCH_TYPES, body.matchType)) {
      return { code: 'INVALID_MATCH_TYPE', message: "matchType must be 'exact', 'wildcard' or 'regex'" };
    }
    out.matchType = body.matchType;
  }
  if (need('pattern')) {
    if (typeof body.pattern !== 'string') return { code: 'INVALID_PATTERN', message: 'pattern must be a string' };
    out.pattern = body.pattern;
  }
  if (body.fields !== undefined || !partial) {
    const fields = body.fields ?? 'both';
    if (!isOneOf(FIELDS, fields)) return { code: 'INVALID_FIELDS', message: "fields must be 'name', 'body' or 'both'" };
    out.fields = fields;
  }
  if (body.caseSensitive !== undefined || !partial) {
    const v = body.caseSensitive ?? false;
    if (typeof v !== 'boolean') return { code: 'INVALID_CASE_SENSITIVE', message: 'caseSensitive must be a boolean' };
    out.caseSensitive = v;
  }
  if (body.enabled !== undefined || !partial) {
    const v = body.enabled ?? true;
    if (typeof v !== 'boolean') return { code: 'INVALID_ENABLED', message: 'enabled must be a boolean' };
    out.enabled = v;
  }
  return { value: out };
}

router.get(
  '/message-filters',
  optionalAuth(),
  requirePermission('messages', 'read', { sourceIdFrom: 'params.id' }),
  async (req: Request, res: Response) => {
    try {
      const rules = await meshcoreMessageFilter.listRules(sourceIdOf(req));
      return ok(res, rules);
    } catch (error) {
      logger.error('[API] MeshCore message-filters list failed:', error);
      return fail(res, 500, 'INTERNAL_ERROR', 'Failed to list message filters');
    }
  },
);

router.post(
  '/message-filters',
  requireAuth(),
  requirePermission('messages', 'write', { sourceIdFrom: 'params.id' }),
  async (req: Request, res: Response) => {
    try {
      const parsed = parseRuleBody((req.body ?? {}) as Record<string, unknown>, false);
      if ('code' in parsed) return fail(res, 400, parsed.code, parsed.message);
      const input = parsed.value as MeshCoreMessageFilterInput;
      const patternError = validateFilterPattern(input.matchType, input.pattern);
      if (patternError) return fail(res, 400, 'INVALID_PATTERN', patternError);
      const row = await meshcoreMessageFilter.createRule(sourceIdOf(req), input, userIdOf(req));
      return ok(res, row);
    } catch (error) {
      logger.error('[API] MeshCore message-filters create failed:', error);
      return fail(res, 500, 'INTERNAL_ERROR', 'Failed to create message filter');
    }
  },
);

router.put(
  '/message-filters/:filterId',
  requireAuth(),
  requirePermission('messages', 'write', { sourceIdFrom: 'params.id' }),
  async (req: Request, res: Response) => {
    try {
      const sourceId = sourceIdOf(req);
      const { filterId } = req.params as { filterId: string };
      const parsed = parseRuleBody((req.body ?? {}) as Record<string, unknown>, true);
      if ('code' in parsed) return fail(res, 400, parsed.code, parsed.message);
      const existing = (await meshcoreMessageFilter.listRules(sourceId)).find((r) => r.id === filterId);
      if (!existing) return fail(res, 404, 'NOT_FOUND', 'Message filter not found');
      const merged = { ...existing, ...parsed.value };
      const patternError = validateFilterPattern(merged.matchType, merged.pattern);
      if (patternError) return fail(res, 400, 'INVALID_PATTERN', patternError);
      const row = await meshcoreMessageFilter.updateRule(sourceId, filterId, parsed.value);
      if (!row) return fail(res, 404, 'NOT_FOUND', 'Message filter not found');
      return ok(res, row);
    } catch (error) {
      logger.error('[API] MeshCore message-filters update failed:', error);
      return fail(res, 500, 'INTERNAL_ERROR', 'Failed to update message filter');
    }
  },
);

router.delete(
  '/message-filters/:filterId',
  requireAuth(),
  requirePermission('messages', 'write', { sourceIdFrom: 'params.id' }),
  async (req: Request, res: Response) => {
    try {
      const { filterId } = req.params as { filterId: string };
      const removed = await meshcoreMessageFilter.deleteRule(sourceIdOf(req), filterId);
      if (!removed) return fail(res, 404, 'NOT_FOUND', 'Message filter not found');
      return ok(res);
    } catch (error) {
      logger.error('[API] MeshCore message-filters delete failed:', error);
      return fail(res, 500, 'INTERNAL_ERROR', 'Failed to delete message filter');
    }
  },
);

export default router;
