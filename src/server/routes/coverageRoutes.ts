/**
 * Coverage Report API (#5277 Coverage Report epic, Phase 1 WP3).
 *
 * Mounted at `/api/analysis/coverage` (server.ts, before the general
 * `/analysis` router — see `analysisRoutes.ts` for the same "more specific
 * mount first" convention already used for `/analysis/mesh-issues`).
 *
 * Every handler:
 *  1. Resolves the requester's permitted source ids (`resolvePermittedSourceIds`,
 *     resource `'nodes'`, same gate `/positions` and `/coverage-grid` use)
 *     intersected with the optional `sources` query param.
 *  2. Validates its own query params, returning a SCREAMING_SNAKE `fail()`
 *     code on anything malformed.
 *  3. Short-circuits to an empty `ok()` payload once `sourceIds` is empty —
 *     `CoverageReceptionsRepository`'s methods already return the empty shape
 *     for an empty source list, so this is cheap either way, but skips the
 *     node-loading/visibility work entirely.
 *  4. Applies the SAME position visibility gate `/positions` enforces
 *     (`buildPositionFilter` from `positionVisibility.ts`, extracted from
 *     `analysisRoutes.ts` with no behaviour change — COVERAGE_P1_SPEC.md
 *     §2.6) to sender/receiver node numbers, nulling out receiver
 *     coordinates or dropping sender rows a non-admin can't see.
 *
 * `/receivers` (Decision D8) is derived from `coverage_receptions` alone via
 * `CoverageReceptionsRepository.getReceivers` — there is deliberately NO
 * `source.type` string gate. Whatever protocol/receiverKind combinations
 * exist in the table show up here, which is what keeps this endpoint correct
 * for P2 MQTT gateways and P3 MeshCore without a code change.
 *
 * The retention window (`sinceMs` for `/receivers`) is computed the same way
 * WP2's `coverageRetentionService.getRetentionDays()` will
 * (`clampCoverageRetentionDays` on the bare `coverage_retention_days`
 * setting) — read directly here rather than importing that service, which is
 * WP2's file and out of this work package's scope; the read path doesn't
 * depend on the setting being registered in `VALID_SETTINGS_KEYS` (that
 * allowlist only gates writes).
 */
import { Router, Request, Response } from 'express';
import databaseService from '../../services/database.js';
import { optionalAuth } from '../auth/authMiddleware.js';
import { logger } from '../../utils/logger.js';
import { ok, fail } from '../utils/apiResponse.js';
import { resolvePermittedSourceIds, parseSourcesParam } from '../utils/permittedSources.js';
import { buildPositionFilter, loadNodesBySource } from '../utils/positionVisibility.js';
import { parseGatewayNodeNum } from '../utils/okToMqtt.js';
import { clampCoverageRetentionDays, nodeNumToId } from '../../utils/coverage.js';
import type {
  CoverageProtocol,
  CoverageReceiverKind,
  CoverageHopsMode,
  CoverageReceptionDto,
  CoverageReceiverDto,
  CoverageSenderDto,
  CoveragePage,
} from '../../types/coverage.js';

const router = Router();
router.use(optionalAuth());

// Mirrors CoverageReceptionsRepository's own clamp (not exported) — used only
// for the early "no permitted sources" response, where the repo is never
// called so its internal clamp never runs.
const DEFAULT_PAGE_SIZE = 1000;
const MAX_PAGE_SIZE = 2000;
// getSenderSummary's own limit ceiling (§2.3) — also doubles as the
// truncation threshold: hitting exactly this many raw (pre-merge) rows means
// more senders may exist than were returned.
const SENDER_SUMMARY_LIMIT = 2000;

function clampRequestedPageSize(raw: unknown): number {
  const n = raw === undefined ? DEFAULT_PAGE_SIZE : Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_PAGE_SIZE;
  return Math.max(1, Math.min(Math.trunc(n), MAX_PAGE_SIZE));
}

/** Resolve the caller's permitted sources intersected with `?sources=`. */
async function resolveSourceIds(req: Request): Promise<string[]> {
  const permitted = await resolvePermittedSourceIds(req);
  const requested = parseSourcesParam(req.query.sources);
  return requested ? permitted.filter((id) => requested.includes(id)) : permitted;
}

/**
 * `now - retentionDays * 1 day`, in ms. Mirrors WP2's
 * `coverageRetentionService.getRetentionDays()` (§2.7) without importing that
 * (out-of-scope) file.
 */
async function getRetentionWindowStart(): Promise<{ sinceMs: number; retentionDays: number }> {
  const retentionDays = clampCoverageRetentionDays(
    await databaseService.getSettingAsync('coverage_retention_days'),
  );
  return { sinceMs: Date.now() - retentionDays * 86_400_000, retentionDays };
}

/** `undefined` = param absent (use `fallback`); `null` = present but unparseable. */
function parseTimeParam(raw: unknown, fallback: number): number | null {
  if (raw === undefined) return fallback;
  if (typeof raw !== 'string' || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/**
 * `sender` query param: a `!xxxxxxxx` id or a decimal node number, normalised
 * to `!xxxxxxxx` (the form `coverage_receptions.senderId` stores). Returns
 * `null` on anything unparseable.
 */
function parseSenderParam(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  const trimmed = raw.trim();
  if (trimmed.startsWith('!')) {
    const nodeNum = parseGatewayNodeNum(trimmed);
    return nodeNum === null ? null : nodeNumToId(nodeNum);
  }
  if (!/^\d+$/.test(trimmed)) return null;
  const nodeNum = Number(trimmed);
  if (!Number.isFinite(nodeNum) || nodeNum > 0xffffffff) return null;
  return nodeNumToId(nodeNum >>> 0);
}

/**
 * Validity check mirroring `CoverageReceptionsRepository`'s private
 * `decodeCursor` — duplicated (not imported; it isn't exported) so a
 * malformed cursor fails loudly here (`INVALID_CURSOR`, 400) instead of the
 * repo's own lenient "unparseable cursor = start from page 1" fallback.
 */
function isValidCursorString(raw: string): boolean {
  try {
    const decoded = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    return (
      typeof decoded?.ts === 'number' &&
      typeof decoded?.id === 'number' &&
      Number.isFinite(decoded.ts) &&
      Number.isFinite(decoded.id)
    );
  } catch {
    return false;
  }
}

// ── GET /receivers ──────────────────────────────────────────────────────────

router.get('/receivers', async (req: Request, res: Response) => {
  try {
    const sourceIds = await resolveSourceIds(req);
    const { sinceMs, retentionDays } = await getRetentionWindowStart();

    if (sourceIds.length === 0) {
      return ok(res, { receivers: [] as CoverageReceiverDto[], retentionDays });
    }

    const [rows, nodesBySource, allSources] = await Promise.all([
      databaseService.coverageReceptions.getReceivers({ sourceIds, sinceMs }),
      loadNodesBySource(sourceIds),
      databaseService.sources.getAllSources(),
    ]);

    const posFilter = await buildPositionFilter(req.user, sourceIds, nodesBySource);
    const sourceNameById = new Map(allSources.map((s) => [s.id, s.name] as const));

    const receivers: CoverageReceiverDto[] = rows.map((r) => {
      const node = r.receiverNodeNum != null
        ? nodesBySource.get(r.sourceId)?.find((n) => n.nodeNum === r.receiverNodeNum) ?? null
        : null;

      // Current position (override-aware), falling back to the latest
      // reception snapshot when the node has no usable position.
      let latitude: number | null = null;
      let longitude: number | null = null;
      if (node) {
        if (node.positionOverrideEnabled) {
          latitude = node.latitudeOverride ?? null;
          longitude = node.longitudeOverride ?? null;
        } else {
          latitude = node.latitude ?? null;
          longitude = node.longitude ?? null;
        }
      }
      if (latitude == null || longitude == null) {
        latitude = r.receiverLatitude;
        longitude = r.receiverLongitude;
      }

      // Visibility nulling (§2.9.1): only when receiverNodeNum is known — a
      // receiver with no nodeNum keeps its snapshot in P1.
      if (r.receiverNodeNum != null && !posFilter({ sourceId: r.sourceId, nodeNum: r.receiverNodeNum })) {
        latitude = null;
        longitude = null;
      }

      return {
        sourceId: r.sourceId,
        sourceName: sourceNameById.get(r.sourceId) ?? r.sourceId,
        protocol: r.protocol as CoverageProtocol,
        receiverKind: r.receiverKind as CoverageReceiverKind,
        receiverId: r.receiverId,
        receiverNodeNum: r.receiverNodeNum,
        longName: node?.longName ?? null,
        shortName: node?.shortName ?? null,
        latitude,
        longitude,
        lastReceivedAt: r.lastReceivedAt,
      };
    });

    ok(res, { receivers, retentionDays });
  } catch (error) {
    logger.error('Error in GET /api/analysis/coverage/receivers:', error);
    fail(res, 500, 'INTERNAL_ERROR', 'Failed to fetch coverage receivers');
  }
});

// ── GET /senders ─────────────────────────────────────────────────────────────

interface MergedSender {
  senderId: string;
  senderNodeNum: number | null;
  fixCount: number;
  lastReceivedAt: number;
}

router.get('/senders', async (req: Request, res: Response) => {
  try {
    const sourceIds = await resolveSourceIds(req);

    const nowMs = Date.now();
    const sinceMs = parseTimeParam(req.query.since, nowMs - 24 * 3600_000);
    const untilMs = parseTimeParam(req.query.until, nowMs);
    if (sinceMs === null || untilMs === null) {
      return fail(res, 400, 'INVALID_TIME_RANGE', 'since/until must be numeric unix-ms timestamps');
    }
    if (untilMs < sinceMs) {
      return fail(res, 400, 'INVALID_TIME_RANGE', 'until must not be before since');
    }

    if (sourceIds.length === 0) {
      return ok(res, { senders: [] as CoverageSenderDto[], truncated: false });
    }

    const [rows, nodesBySource] = await Promise.all([
      databaseService.coverageReceptions.getSenderSummary({
        sourceIds, sinceMs, untilMs, limit: SENDER_SUMMARY_LIMIT,
      }),
      loadNodesBySource(sourceIds),
    ]);

    const posFilter = await buildPositionFilter(req.user, sourceIds, nodesBySource);

    // Merge by senderId across sources: sum fixCount (an upper bound —
    // documented in the repo/spec), max lastReceivedAt. A group whose
    // (sourceId, senderNodeNum) fails the visibility gate is dropped
    // entirely (never merged in); a null senderNodeNum can't be gated and is
    // always kept, mirroring the receiver-with-no-nodeNum carve-out above.
    const merged = new Map<string, MergedSender>();
    for (const row of rows) {
      if (row.senderNodeNum != null && !posFilter({ sourceId: row.sourceId, nodeNum: row.senderNodeNum })) {
        continue;
      }
      const existing = merged.get(row.senderId);
      if (existing) {
        existing.fixCount += row.fixCount;
        if (row.lastReceivedAt > existing.lastReceivedAt) existing.lastReceivedAt = row.lastReceivedAt;
        if (existing.senderNodeNum == null) existing.senderNodeNum = row.senderNodeNum;
      } else {
        merged.set(row.senderId, {
          senderId: row.senderId,
          senderNodeNum: row.senderNodeNum,
          fixCount: row.fixCount,
          lastReceivedAt: row.lastReceivedAt,
        });
      }
    }

    const wantedNums = Array.from(merged.values())
      .map((m) => m.senderNodeNum)
      .filter((n): n is number => n != null);
    const names = await databaseService.nodes.getNodeNamesByNums(wantedNums, sourceIds);

    const senders: CoverageSenderDto[] = Array.from(merged.values())
      .map((m) => {
        const nm = m.senderNodeNum != null ? names.get(m.senderNodeNum) : undefined;
        return {
          senderId: m.senderId,
          senderNodeNum: m.senderNodeNum,
          longName: nm?.longName ?? null,
          shortName: nm?.shortName ?? null,
          fixCount: m.fixCount,
          lastReceivedAt: m.lastReceivedAt,
        };
      })
      .sort((a, b) => b.lastReceivedAt - a.lastReceivedAt);

    ok(res, { senders, truncated: rows.length >= SENDER_SUMMARY_LIMIT });
  } catch (error) {
    logger.error('Error in GET /api/analysis/coverage/senders:', error);
    fail(res, 500, 'INTERNAL_ERROR', 'Failed to fetch coverage senders');
  }
});

// ── GET /receptions ──────────────────────────────────────────────────────────

router.get('/receptions', async (req: Request, res: Response) => {
  try {
    const sourceIds = await resolveSourceIds(req);

    const nowMs = Date.now();
    const sinceMs = parseTimeParam(req.query.since, nowMs - 24 * 3600_000);
    const untilMs = parseTimeParam(req.query.until, nowMs);
    if (sinceMs === null || untilMs === null) {
      return fail(res, 400, 'INVALID_TIME_RANGE', 'since/until must be numeric unix-ms timestamps');
    }
    if (untilMs < sinceMs) {
      return fail(res, 400, 'INVALID_TIME_RANGE', 'until must not be before since');
    }

    let hops: number | undefined;
    if (req.query.hops !== undefined) {
      const n = Number(req.query.hops);
      if (!Number.isInteger(n) || n < 0 || n > 7) {
        return fail(res, 400, 'INVALID_HOPS', 'hops must be an integer between 0 and 7');
      }
      hops = n;
    }

    let hopsMode: CoverageHopsMode = 'exact';
    if (req.query.hopsMode !== undefined) {
      if (req.query.hopsMode !== 'exact' && req.query.hopsMode !== 'max') {
        return fail(res, 400, 'INVALID_HOPS_MODE', "hopsMode must be 'exact' or 'max'");
      }
      hopsMode = req.query.hopsMode;
    }

    let senderId: string | undefined;
    if (req.query.sender !== undefined) {
      const parsed = parseSenderParam(req.query.sender);
      if (parsed === null) {
        return fail(res, 400, 'INVALID_SENDER', 'sender must be a !hex node id or a decimal node number');
      }
      senderId = parsed;
    }

    let cursor: string | undefined;
    if (typeof req.query.cursor === 'string' && req.query.cursor.length > 0) {
      if (!isValidCursorString(req.query.cursor)) {
        return fail(res, 400, 'INVALID_CURSOR', 'cursor is malformed');
      }
      cursor = req.query.cursor;
    }

    const receiverIds = parseSourcesParam(req.query.receivers) ?? undefined;
    const pageSize = clampRequestedPageSize(req.query.pageSize);

    if (sourceIds.length === 0) {
      const empty: CoveragePage<CoverageReceptionDto> = {
        items: [], pageSize, hasMore: false, nextCursor: null,
      };
      return ok(res, empty);
    }

    const [page, nodesBySource] = await Promise.all([
      databaseService.coverageReceptions.getReceptions({
        sourceIds, sinceMs, untilMs, receiverIds, senderId, hops, hopsMode, pageSize, cursor,
      }),
      loadNodesBySource(sourceIds),
    ]);

    const posFilter = await buildPositionFilter(req.user, sourceIds, nodesBySource);

    // Post-filter on the sender's visibility, same gate as /positions
    // (§2.9.3) — a page can come back shorter than pageSize; the client
    // keeps paging on hasMore. Receiver coordinates are nulled (not
    // filtered) using the same predicate against receiverNodeNum.
    const items: CoverageReceptionDto[] = page.items
      .filter((row) => row.senderNodeNum == null || posFilter({ sourceId: row.sourceId, nodeNum: row.senderNodeNum }))
      .map((row) => {
        const receiverVisible = row.receiverNodeNum == null
          || posFilter({ sourceId: row.sourceId, nodeNum: row.receiverNodeNum });
        return {
          ...row,
          protocol: row.protocol as CoverageProtocol,
          receiverKind: row.receiverKind as CoverageReceiverKind,
          receiverLatitude: receiverVisible ? row.receiverLatitude : null,
          receiverLongitude: receiverVisible ? row.receiverLongitude : null,
        };
      });

    const result: CoveragePage<CoverageReceptionDto> = {
      items, pageSize: page.pageSize, hasMore: page.hasMore, nextCursor: page.nextCursor,
    };
    ok(res, result);
  } catch (error) {
    logger.error('Error in GET /api/analysis/coverage/receptions:', error);
    fail(res, 500, 'INTERNAL_ERROR', 'Failed to fetch coverage receptions');
  }
});

export default router;
