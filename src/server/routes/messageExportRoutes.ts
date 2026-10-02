/**
 * GET /api/messages/export — filtered CSV export of stored messages (#5517).
 *
 * One file across every selected source, Meshtastic and MeshCore, oldest
 * first. One row per stored message: the same packet heard by two sources is
 * two rows, told apart by the `source` column (no cross-source dedup).
 *
 * Query parameters (all optional; repeat a key to pass several values):
 *   source=<id>          sources to include (default: every source)
 *   channel=<name>       channel names, matched case-insensitively per source
 *                        the way the unified Messages view matches them
 *                        (default: every readable channel)
 *   type=all|channels|dms
 *   include=<term>       keep messages containing ANY term (substring, case-insensitive)
 *   exclude=<term>       drop messages containing any term
 *   start=<ms> end=<ms>  inclusive UTC epoch-ms range on the message time
 *   sender=<id>          Meshtastic node id (!abcd1234) or MeshCore public key
 *                        prefix / channel sender name
 *   includeReactions=true
 *   tz=<IANA zone>       zone for the local_time column (default UTC)
 *
 * Permissions: the same rules as reading messages (see
 * `utils/messageSourceAccess.ts`). A source or channel the caller cannot read
 * is skipped, never an error, so a caller with no grants gets a header-only
 * file. Sends nothing to the mesh.
 */
import express, { type Request, type Response } from 'express';
import databaseService from '../../services/database.js';
import type { DbMessage } from '../../db/types.js';
import type { DbMeshCoreMessage } from '../../db/repositories/index.js';
import type { User } from '../../types/auth.js';
import { logger } from '../../utils/logger.js';
import { fail } from '../utils/apiResponse.js';
import { CHANNEL_DB_OFFSET } from '../constants/meshtastic.js';
import { isAnyMeshCoreSourceType } from '../../utils/nodeTypeCategory.js';
import { canonicalMessageTime } from '../utils/messageTime.js';
import { extractPacketIdFromRowId } from '../utils/messageRowId.js';
import {
  unifiedChannelDisplayName,
  loadSourcePresetNames,
  loadEnabledVirtualChannels,
} from '../utils/unifiedChannelNames.js';
import {
  resolveReadableMeshtasticChannels,
  resolveReadableMeshcoreScope,
  intersectChannels,
} from '../utils/messageSourceAccess.js';
import {
  CSV_BOM,
  MESSAGE_EXPORT_MAX_ROWS,
  formatLocalTime,
  isValidTimeZone,
  messageExportHeader,
  messageExportLine,
  truncationMarkerLine,
  type MessageExportRow,
} from '../utils/messageCsv.js';
import { messageExportLimiter } from '../middleware/rateLimiters.js';
import { extendRequestTimeout } from '../middleware/requestTimeout.js';

const router = express.Router();

/** Rows fetched per source per query (keyset page). */
const EXPORT_BATCH_SIZE = 1000;
/** Socket timeout for the download (#5494): a 100k-row file can take a while. */
const EXPORT_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_TERMS = 50;
const MAX_TERM_LENGTH = 200;

type ExportType = 'all' | 'channels' | 'dms';

export interface ExportCursor {
  time: number;
  id: string;
}

export interface ExportItem {
  time: number;
  id: string;
  row: MessageExportRow;
}

/** One source's rows, oldest first, fetched a page at a time. */
export interface ExportStream {
  /** Position of the source in the request, for a stable tie-break. */
  order: number;
  fetch(after: ExportCursor | undefined): Promise<ExportItem[]>;
}

/** A repeated (or single) query parameter as a trimmed, non-empty list. */
function listParam(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  const arr = Array.isArray(value) ? value : [value];
  return arr
    .filter((v): v is string => typeof v === 'string')
    .map((v) => v.trim())
    .filter((v) => v.length > 0);
}

function parseMs(value: unknown): number | undefined | null {
  if (value === undefined || value === '') return undefined;
  if (typeof value !== 'string' || !/^\d{1,16}$/.test(value)) return null;
  return Number(value);
}

function hopsFrom(hopStart: number | null | undefined, hopLimit: number | null | undefined): number | null {
  if (hopStart == null || hopLimit == null) return null;
  const hops = Number(hopStart) - Number(hopLimit);
  return hops >= 0 ? hops : null;
}

/** MeshCore channel index of a row, or null for a direct message. */
function meshcoreChannelIndex(m: DbMeshCoreMessage): number | null {
  const probe = (key: string | null | undefined): number | null => {
    if (!key || !key.startsWith('channel-')) return null;
    const n = parseInt(key.slice('channel-'.length), 10);
    return Number.isFinite(n) && n >= 0 ? n : null;
  };
  const idx = probe(m.fromPublicKey) ?? probe(m.toPublicKey);
  if (idx !== null) return idx;
  // Legacy outbound channel-0 rows: real sender, no recipient.
  return m.toPublicKey == null ? 0 : null;
}

interface ExportFilters {
  channelNames: Set<string> | undefined;
  type: ExportType;
  includeTerms: string[];
  excludeTerms: string[];
  startMs: number | undefined;
  endMs: number | undefined;
  sender: string | undefined;
  includeReactions: boolean;
  tz: string;
}

async function buildMeshtasticStream(
  user: User | null | undefined,
  source: { id: string; name: string },
  order: number,
  filters: ExportFilters,
  presetName: string | null,
  virtualNames: Map<number, string>,
): Promise<ExportStream | null> {
  const readable = await resolveReadableMeshtasticChannels(user, source.id);

  const chans = (await databaseService.channels.getAllChannels(source.id).catch(() => [])) ?? [];
  const nameByNum = new Map<number, string>(virtualNames);
  for (const c of chans) {
    const nm = unifiedChannelDisplayName(c as { id: number; name?: string | null; role?: number | null }, presetName);
    if (nm) nameByNum.set((c as { id: number }).id, nm);
  }

  let requested: number[] | undefined;
  if (filters.channelNames) {
    requested = [-1];
    for (const [num, nm] of nameByNum) {
      if (filters.channelNames.has(nm.toLowerCase())) requested.push(num);
    }
  }
  const channels = intersectChannels(readable, requested);
  if (channels !== 'all' && channels.length === 0) return null;

  const nodeNames = new Map<number, string>();
  try {
    for (const n of await databaseService.nodes.getAllNodes(source.id)) {
      const nm = n.longName || n.shortName;
      if (nm) nodeNames.set(Number(n.nodeNum), nm);
    }
  } catch (err) {
    logger.warn(`Message export: failed to load node names for source ${source.id}:`, err);
  }

  const toItem = (m: DbMessage): ExportItem => {
    const time = canonicalMessageTime({ rxTime: m.rxTime ?? null, timestamp: Number(m.timestamp) });
    const ch = Number(m.channel);
    const isDm = ch === -1;
    return {
      time,
      id: m.id,
      row: {
        timestamp_utc: new Date(time).toISOString(),
        local_time: formatLocalTime(time, filters.tz),
        network: 'Meshtastic',
        source: source.name,
        channel: isDm ? 'DM' : (nameByNum.get(ch) ?? (ch >= CHANNEL_DB_OFFSET ? `Virtual ${ch - CHANNEL_DB_OFFSET}` : `Channel ${ch}`)),
        sender_name: nodeNames.get(Number(m.fromNodeNum)) ?? '',
        sender_id: m.fromNodeId,
        destination: isDm ? m.toNodeId : 'broadcast',
        message: m.text,
        message_id: extractPacketIdFromRowId(m.id),
        rssi: m.rxRssi ?? null,
        snr: m.rxSnr ?? null,
        hops: hopsFrom(m.hopStart, m.hopLimit),
      },
    };
  };

  return {
    order,
    fetch: async (after) => {
      const rows = await databaseService.messages.getMessagesForExport({
        sourceId: source.id,
        channels,
        includeTerms: filters.includeTerms,
        excludeTerms: filters.excludeTerms,
        startMs: filters.startMs,
        endMs: filters.endMs,
        type: filters.type,
        fromNodeId: filters.sender,
        includeReactions: filters.includeReactions,
        after,
        limit: EXPORT_BATCH_SIZE,
      });
      return rows.map(toItem);
    },
  };
}

async function buildMeshcoreStream(
  user: User | null | undefined,
  source: { id: string; name: string },
  order: number,
  filters: ExportFilters,
  presetName: string | null,
): Promise<ExportStream | null> {
  const readable = await resolveReadableMeshcoreScope(user, source.id);

  const chans = (await databaseService.channels.getAllChannels(source.id).catch(() => [])) ?? [];
  const nameByIdx = new Map<number, string>();
  for (const c of chans) {
    const nm = unifiedChannelDisplayName(c as { id: number; name?: string | null; role?: number | null }, presetName);
    if (nm) nameByIdx.set((c as { id: number }).id, nm);
  }

  let requested: number[] | undefined;
  if (filters.channelNames) {
    requested = [];
    for (const [idx, nm] of nameByIdx) {
      if (filters.channelNames.has(nm.toLowerCase())) requested.push(idx);
    }
  }
  const channels = filters.type === 'dms' ? [] : intersectChannels(readable.channels, requested);
  const includeDms = readable.includeDms && filters.type !== 'channels';
  if (channels !== 'all' && channels.length === 0 && !includeDms) return null;

  const nodeNames = new Map<string, string>();
  try {
    for (const n of await databaseService.meshcore.getNodesBySource(source.id)) {
      if (n.name) nodeNames.set(n.publicKey, n.name);
    }
  } catch (err) {
    logger.warn(`Message export: failed to load MeshCore names for source ${source.id}:`, err);
  }

  const toItem = (m: DbMeshCoreMessage): ExportItem => {
    const time = Number(m.timestamp);
    const idx = meshcoreChannelIndex(m);
    const fromIsChannelKey = m.fromPublicKey.startsWith('channel-');
    return {
      time,
      id: m.id,
      row: {
        timestamp_utc: new Date(time).toISOString(),
        local_time: formatLocalTime(time, filters.tz),
        network: 'MeshCore',
        source: source.name,
        channel: idx === null ? 'DM' : (nameByIdx.get(idx) ?? `Channel ${idx}`),
        sender_name: m.fromName || nodeNames.get(m.fromPublicKey) || '',
        sender_id: fromIsChannelKey ? '' : m.fromPublicKey,
        destination: idx === null ? (m.toPublicKey ?? '') : 'broadcast',
        message: m.text,
        message_id: null,
        rssi: m.rssi ?? null,
        snr: m.snr ?? null,
        hops: m.hopCount ?? null,
      },
    };
  };

  return {
    order,
    fetch: async (after) => {
      const rows = await databaseService.meshcore.getMessagesForExport({
        sourceId: source.id,
        channels,
        includeDms,
        includeTerms: filters.includeTerms,
        excludeTerms: filters.excludeTerms,
        startMs: filters.startMs,
        endMs: filters.endMs,
        sender: filters.sender,
        after,
        limit: EXPORT_BATCH_SIZE,
      });
      return rows.map(toItem);
    },
  };
}

/**
 * Merge per-source streams into one oldest-first sequence. Each stream is
 * already sorted by (time, id), so this keeps one page per source in memory.
 */
export async function* mergeStreams(
  streams: ExportStream[],
  batchSize: number = EXPORT_BATCH_SIZE,
): AsyncGenerator<ExportItem> {
  const heads = await Promise.all(
    streams.map(async (s) => {
      const buf = await s.fetch(undefined);
      return { s, buf, pos: 0 };
    }),
  );
  while (true) {
    let best: (typeof heads)[number] | null = null;
    for (const h of heads) {
      if (h.pos >= h.buf.length) continue;
      if (!best) {
        best = h;
        continue;
      }
      const a = h.buf[h.pos];
      const b = best.buf[best.pos];
      if (a.time < b.time || (a.time === b.time && (h.s.order < best.s.order || (h.s.order === best.s.order && a.id < b.id)))) {
        best = h;
      }
    }
    if (!best) return;
    const item = best.buf[best.pos++];
    yield item;
    if (best.pos >= best.buf.length && best.buf.length === batchSize) {
      best.buf = await best.s.fetch({ time: item.time, id: item.id });
      best.pos = 0;
    }
  }
}

router.get(
  '/export',
  messageExportLimiter,
  extendRequestTimeout(EXPORT_TIMEOUT_MS),
  async (req: Request, res: Response) => {
    const user = (req as Request & { user?: User }).user;

    // ── Validate ──────────────────────────────────────────────────────────
    const typeRaw = typeof req.query.type === 'string' && req.query.type !== '' ? req.query.type : 'all';
    if (typeRaw !== 'all' && typeRaw !== 'channels' && typeRaw !== 'dms') {
      return fail(res, 400, 'INVALID_INPUT', 'type must be all, channels or dms');
    }
    const startMs = parseMs(req.query.start);
    const endMs = parseMs(req.query.end);
    if (startMs === null || endMs === null) {
      return fail(res, 400, 'INVALID_TIME_RANGE', 'start and end must be UTC epoch milliseconds');
    }
    if (startMs !== undefined && endMs !== undefined && startMs > endMs) {
      return fail(res, 400, 'INVALID_TIME_RANGE', 'start must not be after end');
    }
    const tz = typeof req.query.tz === 'string' && req.query.tz !== '' ? req.query.tz : 'UTC';
    if (!isValidTimeZone(tz)) {
      return fail(res, 400, 'INVALID_INPUT', `Unknown time zone: ${tz}`);
    }
    const includeTerms = listParam(req.query.include) ?? [];
    const excludeTerms = listParam(req.query.exclude) ?? [];
    if (includeTerms.length + excludeTerms.length > MAX_TERMS) {
      return fail(res, 400, 'INVALID_INPUT', `At most ${MAX_TERMS} keywords`);
    }
    if ([...includeTerms, ...excludeTerms].some((t) => t.length > MAX_TERM_LENGTH)) {
      return fail(res, 400, 'INVALID_INPUT', `Keywords are limited to ${MAX_TERM_LENGTH} characters`);
    }
    const channelList = listParam(req.query.channel);
    const sourceList = listParam(req.query.source);
    const sender = typeof req.query.sender === 'string' && req.query.sender.trim() !== ''
      ? req.query.sender.trim()
      : undefined;

    const filters: ExportFilters = {
      channelNames: channelList ? new Set(channelList.map((c) => c.toLowerCase())) : undefined,
      type: typeRaw,
      includeTerms,
      excludeTerms,
      startMs,
      endMs,
      sender,
      includeReactions: req.query.includeReactions === 'true',
      tz,
    };

    let streams: ExportStream[];
    try {
      const allSources = await databaseService.sources.getAllSources();
      const targets = sourceList ? allSources.filter((s) => sourceList.includes(s.id)) : allSources;
      const [presets, virtualChannels] = await Promise.all([
        loadSourcePresetNames(targets.map((s) => s.id)),
        loadEnabledVirtualChannels(),
      ]);
      const virtualNames = new Map<number, string>();
      for (const vc of virtualChannels) {
        if (vc.id != null && vc.name) virtualNames.set(CHANNEL_DB_OFFSET + vc.id, vc.name);
      }
      const built = await Promise.all(
        targets.map((source, order) =>
          isAnyMeshCoreSourceType(source.type)
            ? buildMeshcoreStream(user, source, order, filters, presets.get(source.id) ?? null)
            : buildMeshtasticStream(user, source, order, filters, presets.get(source.id) ?? null, virtualNames),
        ),
      );
      streams = built.filter((s): s is ExportStream => s !== null);
    } catch (error) {
      logger.error('Message export: failed to prepare:', error);
      return fail(res, 500, 'INTERNAL_ERROR', 'Failed to prepare message export');
    }

    // ── Stream ────────────────────────────────────────────────────────────
    let aborted = false;
    res.on('close', () => {
      if (!res.writableFinished) aborted = true;
    });
    const write = (chunk: string): Promise<void> => {
      if (res.write(chunk)) return Promise.resolve();
      return new Promise((resolve) => {
        const done = () => {
          res.off('drain', done);
          res.off('close', done);
          resolve();
        };
        res.on('drain', done);
        res.on('close', done);
      });
    };

    const stamp = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="meshmonitor-messages-${stamp}.csv"`);
    res.setHeader('Cache-Control', 'no-store');

    let written = 0;
    try {
      await write(CSV_BOM + messageExportHeader());
      let chunk = '';
      for await (const item of mergeStreams(streams)) {
        if (aborted) break;
        if (written >= MESSAGE_EXPORT_MAX_ROWS) {
          chunk += truncationMarkerLine(MESSAGE_EXPORT_MAX_ROWS);
          break;
        }
        chunk += messageExportLine(item.row);
        written++;
        if (written % 500 === 0) {
          await write(chunk);
          chunk = '';
        }
      }
      if (chunk && !aborted) await write(chunk);
      res.end();
      logger.debug(`📥 Exported ${written} messages from ${streams.length} source(s)`);
    } catch (error) {
      logger.error('Message export: failed while streaming:', error);
      // Headers (and probably rows) are already out; all we can do is cut the
      // file short so the client sees a failed download rather than a hang.
      res.destroy(error instanceof Error ? error : undefined);
    }
  },
);

export default router;
