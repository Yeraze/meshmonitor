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
import {
  buildPositionFilter, loadNodesBySource,
  buildMeshCorePositionFilter, loadMeshCoreNodesBySource,
} from '../utils/positionVisibility.js';
import { parseSenderParam } from '../utils/coverageSenderParam.js';
import {
  clampCoverageRetentionDays, COVERAGE_MQTT_ENABLED_SETTING, isCoverageMqttFlagOn,
  isMeshCoreReceptionRow, isMeshCorePubKeyId,
} from '../../utils/coverage.js';
import { parseReceiverFilter, type CoverageReceiverFilterEntry } from '../../utils/coverageReceiverFilter.js';
import { sourceManagerRegistry } from '../sourceManagerRegistry.js';
import { isMqttConnectionStatusManager, isMeshCoreMqttManager, isMeshCoreManager } from '../sourceManagerTypes.js';
import type { DbNode } from '../../db/types.js';
import type { DbMeshCoreNode } from '../../db/repositories/meshcore.js';
import type {
  CoverageProtocol,
  CoverageReceiverKind,
  CoverageHopsMode,
  CoverageReceptionDto,
  CoverageReceiverDto,
  CoverageSenderDto,
  CoverageMqttSourceStatusDto,
  CoveragePage,
} from '../../types/coverage.js';
import coverageSurveyRoutes from './coverageSurveyRoutes.js';

const router = Router();
router.use(optionalAuth());

// Saved surveys (#5277 Coverage Report epic, Phase 4b WP2) — mounted here
// (not on apiRouter directly) so it inherits this router's optionalAuth()
// for GET /surveys (anonymous → [], others gated by sender visibility) while
// its write routes layer their own requireAuth() on top. Final path:
// `/api/analysis/coverage/surveys`.
router.use('/surveys', coverageSurveyRoutes);

// Mirrors CoverageReceptionsRepository's own clamp (src/db/repositories/
// coverageReceptions.ts's DEFAULT_PAGE_SIZE/MAX_PAGE_SIZE, not exported) —
// used only for the early "no permitted sources" response, where the repo is
// never called so its internal clamp never runs. Keep both pairs in sync by
// hand if either changes.
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

/**
 * MQTT / MeshCore Observer gateway-recording status for the caller's
 * permitted sources (#5277 P2 §2.7 + P3 §2.5, user decisions Q4/U1).
 * Typed-predicate discovery only — never a `source.type` string gate — and
 * a per-source settings read, never the bare `coverage_mqtt_enabled` key
 * (#5080). Reads the settings table directly rather than importing
 * `coverageMqttSettings.ts`'s TTL cache, so this response never shows a
 * stale cached flag.
 *
 * `isMeshCoreMqttManager` widens discovery to MeshCore Observer
 * (`meshcore_mqtt`) sources alongside P2's MQTT broker/bridge sources — a
 * device-backed `meshcore` source (`isMeshCoreManager`) never matches
 * either predicate and never appears here.
 */
async function loadMqttSourceStatuses(
  sourceIds: string[],
  sourceNameById: Map<string, string>,
): Promise<CoverageMqttSourceStatusDto[]> {
  if (sourceIds.length === 0) return [];

  const permitted = new Set(sourceIds);
  const candidates = sourceManagerRegistry
    .getAllManagers()
    .filter((m) => isMqttConnectionStatusManager(m) || isMeshCoreMqttManager(m))
    .filter((m) => permitted.has(m.sourceId));

  if (candidates.length === 0) return [];

  const mqttSourceIds = candidates.map((m) => m.sourceId);
  const protocolById = new Map<string, CoverageProtocol>(
    candidates.map((m) => [m.sourceId, isMeshCoreMqttManager(m) ? 'meshcore' : 'meshtastic']),
  );
  const flags = await databaseService.settings.getSettingForSources(mqttSourceIds, COVERAGE_MQTT_ENABLED_SETTING);

  return mqttSourceIds.map((id) => ({
    sourceId: id,
    sourceName: sourceNameById.get(id) ?? id,
    recordingEnabled: isCoverageMqttFlagOn(flags.get(id) ?? null),
    protocol: protocolById.get(id) ?? 'meshtastic',
  }));
}

// ── MeshCore privacy helpers (#5277 Phase 3 WP2 §2.5, Decision D10) ────────
//
// Every helper below branches on ROW DATA — the row's own `protocol` column
// (`isMeshCoreReceptionRow`) or, where a query doesn't select `protocol`
// (`getSenderSummary`), the row's own `senderId` format (`isMeshCorePubKeyId`,
// a 64-hex pubkey vs. Meshtastic's `!xxxxxxxx`). NEVER a `source.type` string
// gate — a source can carry rows of only one protocol today, but the gate
// must keep working unchanged if that ever stops being true.

/** Distinct sourceIds that actually have a MeshCore row among `rows` — avoids loading `meshcore_nodes` for sources with none (§2.5). */
function meshCoreSourceIdsFromReceptionRows(rows: Array<{ sourceId: string; protocol: string }>): string[] {
  const ids = new Set<string>();
  for (const r of rows) if (isMeshCoreReceptionRow(r)) ids.add(r.sourceId);
  return Array.from(ids);
}

/** Same as above, for `getSenderSummary` rows, which carry no `protocol` column. */
function meshCoreSourceIdsFromSenderRows(rows: Array<{ sourceId: string; senderId: string }>): string[] {
  const ids = new Set<string>();
  for (const r of rows) if (isMeshCorePubKeyId(r.senderId)) ids.add(r.sourceId);
  return Array.from(ids);
}

/**
 * Load MeshCore nodes for `mcSourceIds` only (empty list short-circuits —
 * `loadMeshCoreNodesBySource([])` would just return an empty map, but the
 * Promise.all callers below skip the DB round trip entirely).
 */
async function loadMeshCoreNodesIfAny(mcSourceIds: string[]): Promise<Map<string, DbMeshCoreNode[]>> {
  return mcSourceIds.length > 0 ? loadMeshCoreNodesBySource(mcSourceIds) : new Map();
}

/** First-match-wins node lookup across every source in the map for a pubkey — mirrors the fixCount merge's documented cross-source "upper bound" semantics for /senders, where the per-row sourceId is lost after merging. */
function findMeshCoreNodeAcrossSources(
  pubkey: string,
  mcNodesBySource: Map<string, DbMeshCoreNode[]>,
): DbMeshCoreNode | null {
  const key = pubkey.toLowerCase();
  for (const nodes of mcNodesBySource.values()) {
    const found = nodes.find((n) => n.publicKey.toLowerCase() === key);
    if (found) return found;
  }
  return null;
}

/**
 * Display name fallback for a device-backed MeshCore source's own receiver
 * row (`receiverKind: 'local'`). The companion's own public key never has a
 * `meshcore_nodes` row — a companion isn't in its own contact list — so the
 * `mcNode` lookup in the /receivers map below always misses for it, and the
 * report would otherwise show the raw pubkey prefix (e.g. "a8e56073…").
 *
 * Resolves the manager's live self name (the same `getLocalNode().name` the
 * MeshCore device routes / status bar read — narrowed via `isMeshCoreManager`,
 * never a `source.type` string gate per this file's rule), falling back to
 * the source's own name when the manager isn't registered or has no local
 * node yet (e.g. mid-reconnect).
 *
 * Position/privacy is untouched by this: the MeshCore visibility gate
 * (`mcFilter`) still independently nulls the coordinate pair for this row.
 * A name fallback to the source name is fine even when the gate fails —
 * the caller can already read the source, since it's in their permitted
 * `sourceIds`.
 */
function meshCoreLocalReceiverFallbackName(sourceId: string, sourceNameById: Map<string, string>): string {
  const manager = sourceManagerRegistry.getManager(sourceId);
  const selfName = manager && isMeshCoreManager(manager) ? manager.getLocalNode()?.name ?? null : null;
  return selfName || sourceNameById.get(sourceId) || sourceId;
}

router.get('/receivers', async (req: Request, res: Response) => {
  try {
    const sourceIds = await resolveSourceIds(req);
    const { sinceMs: defaultSinceMs, retentionDays } = await getRetentionWindowStart();

    // Optional `since`/`until` (#5277 P4b WP2, spec §2b.5): a survey older
    // than the retention window has rows only inside the survey's own
    // window, so the retention-window default would otherwise miss its
    // receivers entirely. Absent params keep the P1-P3 behaviour (retention
    // window through now). Same numeric-unix-ms validation as
    // `/senders`/`/receptions` below.
    const nowMs = Date.now();
    const sinceMs = parseTimeParam(req.query.since, defaultSinceMs);
    const untilMs = parseTimeParam(req.query.until, nowMs);
    if (sinceMs === null || untilMs === null) {
      return fail(res, 400, 'INVALID_TIME_RANGE', 'since/until must be numeric unix-ms timestamps');
    }
    if (untilMs < sinceMs) {
      return fail(res, 400, 'INVALID_TIME_RANGE', 'until must not be before since');
    }

    if (sourceIds.length === 0) {
      return ok(res, {
        receivers: [] as CoverageReceiverDto[],
        retentionDays,
        mqttSources: [] as CoverageMqttSourceStatusDto[],
      });
    }

    const [rows, nodesBySource, allSources] = await Promise.all([
      // WP1 dependency (spec §2b.4/§2b.5, not yet merged into this
      // worktree): `GetCoverageReceiversArgs` needs an optional `untilMs`
      // field added so an old survey's window is honoured instead of
      // defaulting to "through now". Until that lands, this is an excess
      // property and `tsc` will flag it — expected, see PR body.
      databaseService.coverageReceptions.getReceivers({ sourceIds, sinceMs, untilMs }),
      loadNodesBySource(sourceIds),
      databaseService.sources.getAllSources(),
    ]);

    const mcSourceIds = meshCoreSourceIdsFromReceptionRows(rows);
    const [posFilter, mcNodesBySource] = await Promise.all([
      buildPositionFilter(req.user, sourceIds, nodesBySource),
      loadMeshCoreNodesIfAny(mcSourceIds),
    ]);
    const mcFilter = mcSourceIds.length > 0
      ? await buildMeshCorePositionFilter(req.user, mcSourceIds, mcNodesBySource)
      : null;
    const sourceNameById = new Map(allSources.map((s) => [s.id, s.name] as const));

    // Build the (sourceId -> nodeNum -> node) map once rather than an O(receivers × nodes)
    // `.find()` per receiver (§2.7 — the node lists can be large once MQTT gateway nodes are in play).
    const nodesByNumBySource = new Map<string, Map<number, DbNode>>();
    for (const [sourceId, nodeList] of nodesBySource) {
      const byNum = new Map<number, DbNode>();
      for (const n of nodeList) byNum.set(n.nodeNum, n);
      nodesByNumBySource.set(sourceId, byNum);
    }

    // (sourceId:lowercasePubKey -> DbMeshCoreNode), for the MeshCore branch below.
    const mcNodeByKey = new Map<string, DbMeshCoreNode>();
    for (const [sourceId, nodeList] of mcNodesBySource) {
      for (const n of nodeList) mcNodeByKey.set(`${sourceId}:${n.publicKey.toLowerCase()}`, n);
    }

    const receivers: CoverageReceiverDto[] = rows.map((r) => {
      if (isMeshCoreReceptionRow(r)) {
        // MeshCore branch (§2.5 D10): name and current position come from
        // `meshcore_nodes` (no override concept there), else the latest
        // reception snapshot. `mcFilter` folds presence (#4163-equivalent —
        // no `meshcore_nodes` row means no marker anywhere, admins included)
        // and, for non-admins, per-source `nodes:viewOnMap` into one check;
        // failing it nulls the coordinate pair, same asymmetry as the
        // Meshtastic branch below (name is never nulled by the gate).
        const mcNode = mcNodeByKey.get(`${r.sourceId}:${r.receiverId.toLowerCase()}`) ?? null;
        let latitude: number | null = mcNode?.latitude ?? null;
        let longitude: number | null = mcNode?.longitude ?? null;
        if (latitude == null || longitude == null) {
          latitude = r.receiverLatitude;
          longitude = r.receiverLongitude;
        }
        if (!mcFilter || !mcFilter({ sourceId: r.sourceId, publicKey: r.receiverId })) {
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
          longName: mcNode?.name
            ?? (r.receiverKind === 'local' ? meshCoreLocalReceiverFallbackName(r.sourceId, sourceNameById) : null),
          shortName: null,
          latitude,
          longitude,
          lastReceivedAt: r.lastReceivedAt,
          receptionCount: r.receptionCount,
        };
      }

      const node = r.receiverNodeNum != null
        ? nodesByNumBySource.get(r.sourceId)?.get(r.receiverNodeNum) ?? null
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
        receptionCount: r.receptionCount,
      };
    });

    const mqttSources = await loadMqttSourceStatuses(sourceIds, sourceNameById);

    ok(res, { receivers, retentionDays, mqttSources });
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

    // `getSenderSummary` rows carry no `protocol` column (§2.4: repository
    // unchanged), so MeshCore rows are identified by `senderId`'s own shape
    // (`isMeshCorePubKeyId` — a 64-hex pubkey), not a source-type gate.
    const mcSourceIds = meshCoreSourceIdsFromSenderRows(rows);
    const [posFilter, mcNodesBySource] = await Promise.all([
      buildPositionFilter(req.user, sourceIds, nodesBySource),
      loadMeshCoreNodesIfAny(mcSourceIds),
    ]);
    const mcFilter = mcSourceIds.length > 0
      ? await buildMeshCorePositionFilter(req.user, mcSourceIds, mcNodesBySource)
      : null;

    // Merge by senderId across sources: sum fixCount (an upper bound —
    // documented in the repo/spec), max lastReceivedAt.
    //
    // A Meshtastic group whose (sourceId, senderNodeNum) fails the
    // visibility gate is dropped entirely (never merged in); a null
    // senderNodeNum can't be gated and is always kept — this carve-out is
    // Meshtastic-only. Every MeshCore row has a null senderNodeNum (§2.5:
    // this was the P1 privacy gap — "null senderNodeNum always kept" would
    // otherwise let every MeshCore sender bypass viewOnMap), so MeshCore
    // rows are gated on `(sourceId, senderId)` via `mcFilter` instead, and a
    // failure drops the row before it's ever merged in, for admins too.
    const merged = new Map<string, MergedSender>();
    for (const row of rows) {
      if (isMeshCorePubKeyId(row.senderId)) {
        if (!mcFilter || !mcFilter({ sourceId: row.sourceId, publicKey: row.senderId })) continue;
      } else if (row.senderNodeNum != null && !posFilter({ sourceId: row.sourceId, nodeNum: row.senderNodeNum })) {
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
        if (isMeshCorePubKeyId(m.senderId)) {
          // MeshCore branch (§2.5): name from `meshcore_nodes`, no
          // per-node number to key off — first-match-wins across the
          // sources that passed the gate above (see helper docstring).
          const mcNode = findMeshCoreNodeAcrossSources(m.senderId, mcNodesBySource);
          return {
            senderId: m.senderId,
            senderNodeNum: null,
            longName: mcNode?.name ?? null,
            shortName: null,
            fixCount: m.fixCount,
            lastReceivedAt: m.lastReceivedAt,
          };
        }
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
      // 0-63: widened from Meshtastic's 0-7 to also fit MeshCore flood-advert
      // hop counts (§0.2's flood_max_advert=8 forward cap, `flood.max`
      // default 64) — Meshtastic rows never report hopsAway above 7 anyway.
      if (!Number.isInteger(n) || n < 0 || n > 63) {
        return fail(res, 400, 'INVALID_HOPS', 'hops must be an integer between 0 and 63');
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
        return fail(res, 400, 'INVALID_SENDER', 'sender must be a !hex node id, a decimal node number, or a 64-hex MeshCore public key');
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

    // Source-scoped receiver filter (#5277 P2 §2.5), replacing P1's flat CSV
    // `receivers=<id>,<id>` — which matched an id on EVERY source. A blank
    // param is treated as "no filter"; anything non-blank that doesn't parse
    // is a 400, not a silent fallback to "every receiver".
    let receiverFilter: CoverageReceiverFilterEntry[] | undefined;
    if (req.query.receivers !== undefined) {
      if (typeof req.query.receivers !== 'string') {
        return fail(res, 400, 'INVALID_RECEIVERS', 'receivers must be a single string value');
      }
      if (req.query.receivers.trim() !== '') {
        const parsed = parseReceiverFilter(req.query.receivers);
        if (parsed === null) {
          return fail(res, 400, 'INVALID_RECEIVERS', 'receivers is malformed');
        }
        receiverFilter = parsed;
      }
    }

    const pageSize = clampRequestedPageSize(req.query.pageSize);

    if (sourceIds.length === 0) {
      const empty: CoveragePage<CoverageReceptionDto> = {
        items: [], pageSize, hasMore: false, nextCursor: null,
      };
      return ok(res, empty);
    }

    const [page, nodesBySource] = await Promise.all([
      databaseService.coverageReceptions.getReceptions({
        sourceIds, sinceMs, untilMs, receiverFilter, senderId, hops, hopsMode, pageSize, cursor,
      }),
      loadNodesBySource(sourceIds),
    ]);

    const mcSourceIds = meshCoreSourceIdsFromReceptionRows(page.items);
    const [posFilter, mcNodesBySource] = await Promise.all([
      buildPositionFilter(req.user, sourceIds, nodesBySource),
      loadMeshCoreNodesIfAny(mcSourceIds),
    ]);
    const mcFilter = mcSourceIds.length > 0
      ? await buildMeshCorePositionFilter(req.user, mcSourceIds, mcNodesBySource)
      : null;

    // Post-filter on the sender's visibility, same gate as /positions
    // (§2.9.3) — a page can come back shorter than pageSize; the client
    // keeps paging on hasMore. Receiver coordinates are nulled (not
    // filtered) using the same predicate against receiverNodeNum.
    //
    // MeshCore rows (§2.5 D10) branch on `isMeshCoreReceptionRow` and gate on
    // `(sourceId, senderId/receiverId)` via `mcFilter` instead: a MeshCore
    // row's `senderNodeNum` is always null, so the Meshtastic
    // "null nodeNum is always kept" carve-out must never apply to it — that
    // was the P1 privacy gap this work package closes. A sender that fails
    // the gate drops the whole row (for admins too); a receiver that fails
    // it only nulls the coordinate pair, mirroring the Meshtastic branch.
    const items: CoverageReceptionDto[] = page.items
      .filter((row) => {
        if (isMeshCoreReceptionRow(row)) {
          return !!mcFilter && mcFilter({ sourceId: row.sourceId, publicKey: row.senderId });
        }
        return row.senderNodeNum == null || posFilter({ sourceId: row.sourceId, nodeNum: row.senderNodeNum });
      })
      .map((row) => {
        const receiverVisible = isMeshCoreReceptionRow(row)
          ? !!mcFilter && mcFilter({ sourceId: row.sourceId, publicKey: row.receiverId })
          : row.receiverNodeNum == null || posFilter({ sourceId: row.sourceId, nodeNum: row.receiverNodeNum });
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
