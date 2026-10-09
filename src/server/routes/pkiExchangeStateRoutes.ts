/**
 * Reliable PKI exchange state for one node (#5691).
 *
 * Mounted at `/api/sources/:id/nodes/:nodeNum/pki-exchange` via
 * `sourceRoutes.ts`. `GET` returns whether MeshMonitor's last PKI-encrypted
 * exchange with the node on this source got an answer, and when a priming
 * NodeInfo last went to it — or `null` when there is nothing recorded.
 * Read-only. Gated by `nodes:read` on the path's source.
 */
import { Router, Request, Response } from 'express';
import databaseService from '../../services/database.js';
import { requirePermission } from '../auth/authMiddleware.js';
import { logger } from '../../utils/logger.js';
import { ok, fail } from '../utils/apiResponse.js';
import {
  PKI_EXCHANGE_TIMEOUT_MS,
  PRIMING_MIN_INTERVAL_MS,
  resolveReliablePkiMode,
  type ReliablePkiMode,
} from '../services/reliablePki.js';
import type { PkiExchangeStateRow, PkiFailureReason } from '../../db/repositories/pkiExchangeState.js';

const router = Router({ mergeParams: true });

export interface PkiExchangeStateResponse {
  /**
   * The stored state, except a `pending` row older than the exchange deadline
   * reads `unknown`: its answer was never recorded (e.g. MeshMonitor restarted
   * while it was in flight).
   */
  state: 'successful' | 'pending' | 'failed' | 'unknown';
  stateChangedAt: number;
  lastSuccessAt: number | null;
  failingSince: number | null;
  lastFailureReason: PkiFailureReason | null;
  lastPrimedAt: number | null;
  /** Earliest time another priming NodeInfo may go to this node, or null if one may go now. */
  nextPrimingAllowedAt: number | null;
  mode: ReliablePkiMode;
}

export function toPkiExchangeStateResponse(
  row: PkiExchangeStateRow, mode: ReliablePkiMode, now: number,
): PkiExchangeStateResponse {
  const stale = row.state === 'pending' && now - row.stateChangedAt > PKI_EXCHANGE_TIMEOUT_MS;
  const nextAt = row.lastPrimedAt != null ? row.lastPrimedAt + PRIMING_MIN_INTERVAL_MS : null;
  return {
    state: stale ? 'unknown' : row.state,
    stateChangedAt: row.stateChangedAt,
    lastSuccessAt: row.lastSuccessAt,
    failingSince: row.failingSince,
    lastFailureReason: row.lastFailureReason,
    lastPrimedAt: row.lastPrimedAt,
    nextPrimingAllowedAt: nextAt != null && nextAt > now ? nextAt : null,
    mode,
  };
}

function parseNodeNum(raw: unknown): number | null {
  if (typeof raw !== 'string' || !/^\d{1,10}$/.test(raw)) return null;
  const n = Number(raw);
  return n <= 0xffffffff ? n : null;
}

router.get('/', requirePermission('nodes', 'read', { sourceIdFrom: 'params.id' }), async (req: Request, res: Response) => {
  const sourceId = req.params.id;
  const nodeNum = parseNodeNum(req.params.nodeNum);
  if (nodeNum === null) return fail(res, 400, 'INVALID_NODE_NUM', 'nodeNum must be an unsigned 32-bit integer');

  try {
    const row = await databaseService.pkiExchangeState.getState(sourceId, nodeNum);
    if (!row) return ok(res, null);
    const mode = await resolveReliablePkiMode(databaseService.settings, sourceId);
    return ok(res, toPkiExchangeStateResponse(row, mode, Date.now()));
  } catch (error) {
    logger.error('Error fetching PKI exchange state:', error);
    return fail(res, 500, 'INTERNAL_ERROR', 'Failed to fetch PKI exchange state');
  }
});

export default router;
