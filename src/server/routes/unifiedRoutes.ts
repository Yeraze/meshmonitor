/**
 * Unified Routes
 *
 * Cross-source endpoints for the unified views. Returns merged data from all
 * sources the authenticated user has read access to, tagged with sourceId and
 * sourceName so the frontend can group and color-code entries.
 */
import { Router, Request, Response } from 'express';
import databaseService from '../../services/database.js';
import { optionalAuth } from '../auth/authMiddleware.js';
import { logger } from '../../utils/logger.js';

const router = Router();

// All unified routes allow optional auth (some data may be public)
router.use(optionalAuth());

/**
 * Resolve a channel's display name for unified views.
 *
 * Meshtastic channel conventions:
 *  - Channel 0 is always the PRIMARY channel. Its name is often blank because
 *    the Meshtastic client shows the modem preset instead; we label it
 *    "Primary" so it surfaces in the unified channel picker.
 *  - Channels with `role === 0` are DISABLED — skip entirely.
 *  - Any other channel with a blank name is a disabled/unused slot — skip.
 *
 * Returns `null` when the channel should be omitted from the unified list.
 */
const PRIMARY_CHANNEL_NAME = 'Primary';
function unifiedChannelDisplayName(c: {
  id: number;
  name?: string | null;
  role?: number | null;
}): string | null {
  if (c.role === 0) return null; // DISABLED
  const name = (c.name ?? '').trim();
  if (name) return name;
  if (c.id === 0) return PRIMARY_CHANNEL_NAME;
  return null;
}

/**
 * Extract the Meshtastic packet id from a stored message row id.
 *
 * Message rows are keyed as `${sourceId}_${fromNodeNum}_${meshPacket.id}` so
 * that the same mesh packet received by multiple sources does NOT collide on
 * the primary key. The trailing numeric segment is the packet id set by the
 * originating node — identical across every receiver. This is the ONLY
 * reliable cross-source dedup key for received text messages because the
 * `requestId` column is only populated for Virtual Node ACK tracking, not for
 * ordinary received text.
 *
 * Returns `null` when the id does not end in a numeric segment (defensive —
 * should not happen for rows inserted by the current ingestion path).
 */
function extractPacketIdFromRowId(rowId: string): number | null {
  const parts = rowId.split('_');
  if (parts.length < 2) return null;
  const last = parts[parts.length - 1];
  const n = Number.parseInt(last, 10);
  return Number.isFinite(n) ? n : null;
}

/**
 * GET /api/unified/channels
 *
 * Returns a de-duplicated list of channel names across every source the user
 * has `messages:read` permission for. Each entry includes the list of sources
 * that host a channel with that name (and what number it lives on per source),
 * so the frontend can render a single "Primary" entry even when sources use
 * different channel slots for it.
 *
 * Response shape:
 * ```
 * [
 *   { name: "Primary", sources: [{ sourceId, sourceName, channelNumber }] },
 *   { name: "LongFast", sources: [...] }
 * ]
 * ```
 */
router.get('/channels', async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const isAdmin = user?.isAdmin ?? false;

    const sources = await databaseService.sources.getAllSources();

    type ChannelSourceRef = { sourceId: string; sourceName: string; channelNumber: number };
    const byName = new Map<string, ChannelSourceRef[]>();

    await Promise.all(
      sources.map(async (source) => {
        const canRead = isAdmin || (user
          ? await databaseService.checkPermissionAsync(user.id, 'messages', 'read', source.id)
          : false);
        if (!canRead) return;

        try {
          const chans = await databaseService.channels.getAllChannels(source.id);
          for (const c of chans) {
            const name = unifiedChannelDisplayName(c as any);
            if (!name) continue; // disabled or unused slot
            const list = byName.get(name) ?? [];
            list.push({
              sourceId: source.id,
              sourceName: source.name,
              channelNumber: (c as any).id,
            });
            byName.set(name, list);
          }
        } catch (err) {
          logger.warn(`Failed to load channels for source ${source.id}:`, err);
        }
      })
    );

    const result = Array.from(byName.entries())
      .map(([name, srcs]) => ({ name, sources: srcs }))
      .sort((a, b) => a.name.localeCompare(b.name));

    res.json(result);
  } catch (error) {
    logger.error('Error fetching unified channels:', error);
    res.status(500).json({ error: 'Failed to fetch unified channels' });
  }
});

/**
 * GET /api/unified/messages?channel=<name>&before=<ms>&limit=<N>
 *
 * Returns messages from every source the user has `messages:read` permission
 * for, merged into one stream and **de-duplicated across sources**.
 *
 * The same mesh packet received by multiple sources collapses into a single
 * entry whose `receptions[]` array records how each source heard it (hop
 * count, SNR, RSSI, rxTime). This lets the frontend compare reception quality
 * across the fleet while still rendering one bubble per message.
 *
 * Query params:
 *   ?channel=<name>   Filter by channel NAME (not number — sources may place
 *                     the same name on different slots). If omitted, returns
 *                     messages from all channels across all sources (legacy).
 *   ?before=<ms>      Cursor: only include messages whose canonical time
 *                     (COALESCE(rxTime, timestamp)) is strictly less than
 *                     this. Used for infinite-scroll pagination.
 *   ?limit=<N>        Max de-duplicated messages to return (default 100,
 *                     cap 500).
 *
 * Response item shape:
 *   {
 *     dedupKey, packetId, requestId, fromNodeNum, fromNodeId,
 *     fromNodeLongName, fromNodeShortName,
 *     toNodeNum, toNodeId,
 *     channel, channelName,
 *     text, emoji, replyId,
 *     timestamp,        // canonical (earliest rxTime seen)
 *     receptions: [{ sourceId, sourceName, hopStart, hopLimit,
 *                    rxSnr, rxRssi, rxTime, timestamp }]
 *   }
 */
router.get('/messages', async (req: Request, res: Response) => {
  try {
    const channelName = ((req.query.channel as string) || '').trim();
    const beforeRaw = req.query.before as string | undefined;
    const before = beforeRaw ? parseInt(beforeRaw, 10) : undefined;
    const limit = Math.min(parseInt((req.query.limit as string) || '100', 10), 500);
    const user = (req as any).user;
    const isAdmin = user?.isAdmin ?? false;

    const sources = await databaseService.sources.getAllSources();

    type Reception = {
      sourceId: string;
      sourceName: string;
      hopStart: number | null;
      hopLimit: number | null;
      rxSnr: number | null;
      rxRssi: number | null;
      rxTime: number | null;
      timestamp: number;
    };
    type Merged = {
      dedupKey: string;
      packetId: number | null;
      requestId: number | null;
      fromNodeNum: number;
      fromNodeId: string;
      fromNodeLongName?: string;
      fromNodeShortName?: string;
      toNodeNum: number;
      toNodeId: string;
      channel: number;
      channelName: string;
      text: string;
      emoji: number | null;
      replyId: number | null;
      timestamp: number;
      receptions: Reception[];
    };

    const merged = new Map<string, Merged>();

    // Fetch 2x limit per source so dedup can't starve the result set when
    // multiple sources all heard the same packet.
    const fetchLimit = limit * 2;

    await Promise.all(
      sources.map(async (source) => {
        const canRead = isAdmin || (user
          ? await databaseService.checkPermissionAsync(user.id, 'messages', 'read', source.id)
          : false);
        if (!canRead) return;

        // Resolve channel name → channel number for THIS source.
        // Uses the same display-name rules as GET /channels so that the
        // unnamed Primary (channel 0) can be selected from the dropdown.
        let channelNumber: number | undefined;
        if (channelName) {
          try {
            const chans = await databaseService.channels.getAllChannels(source.id);
            const match = chans.find((c) => unifiedChannelDisplayName(c as any) === channelName);
            if (!match) return; // source has no matching channel → skip
            channelNumber = (match as any).id;
          } catch (err) {
            logger.warn(`Failed to resolve channel '${channelName}' for source ${source.id}:`, err);
            return;
          }
        }

        // Fetch messages.
        let msgs: Awaited<ReturnType<typeof databaseService.messages.getMessages>>;
        if (channelNumber !== undefined) {
          msgs = await databaseService.messages.getMessagesBeforeInChannel(
            channelNumber,
            before,
            fetchLimit,
            source.id
          );
        } else {
          // Legacy: no channel filter. Cursor-less offset fetch.
          msgs = await databaseService.messages.getMessages(fetchLimit, 0, source.id);
          if (before !== undefined) {
            msgs = msgs.filter((m) => (m.rxTime ?? m.timestamp) < before);
          }
        }

        // Build node-name lookup for this source so we can resolve sender
        // display names server-side (avoids needing a second /nodes call).
        let nodeMap = new Map<number, { longName?: string; shortName?: string }>();
        try {
          const nodes = await databaseService.nodes.getAllNodes(source.id);
          for (const n of nodes) {
            nodeMap.set(Number(n.nodeNum), {
              longName: n.longName ?? undefined,
              shortName: n.shortName ?? undefined,
            });
          }
        } catch (err) {
          logger.warn(`Failed to load nodes for source ${source.id}:`, err);
        }

        for (const m of msgs) {
          const canonical = (m.rxTime ?? m.timestamp) as number;
          const reqId = (m.requestId ?? null) as number | null;
          const fromNum = Number(m.fromNodeNum);
          // Dedup key priority:
          //   1. Mesh packet id (extracted from the row id) — the only field
          //      that is identical across sources for the same mesh packet.
          //   2. requestId — populated for Virtual Node ACK tracking.
          //   3. Text + 1s window — last-resort fallback, single-source only.
          const packetId = extractPacketIdFromRowId(String((m as any).id ?? ''));
          const dedupKey = packetId != null
            ? `${fromNum}:p${packetId}`
            : reqId != null
              ? `${fromNum}:r${reqId}`
              : `${fromNum}:${m.text ?? ''}:${Math.floor(canonical / 1000)}`;

          const reception: Reception = {
            sourceId: source.id,
            sourceName: source.name,
            hopStart: m.hopStart ?? null,
            hopLimit: m.hopLimit ?? null,
            rxSnr: m.rxSnr ?? null,
            rxRssi: m.rxRssi ?? null,
            rxTime: m.rxTime ?? null,
            timestamp: m.timestamp,
          };

          const existing = merged.get(dedupKey);
          if (existing) {
            existing.receptions.push(reception);
            // Canonical = earliest heard
            if (canonical < existing.timestamp) existing.timestamp = canonical;
          } else {
            const sender = nodeMap.get(fromNum);
            merged.set(dedupKey, {
              dedupKey,
              packetId,
              requestId: reqId,
              fromNodeNum: fromNum,
              fromNodeId: m.fromNodeId,
              fromNodeLongName: sender?.longName,
              fromNodeShortName: sender?.shortName,
              toNodeNum: Number(m.toNodeNum),
              toNodeId: m.toNodeId,
              channel: m.channel,
              channelName,
              text: m.text ?? '',
              emoji: m.emoji ?? null,
              replyId: m.replyId ?? null,
              timestamp: canonical,
              receptions: [reception],
            });
          }
        }
      })
    );

    // Sort receptions within each merged entry so the frontend modal renders
    // them in a stable order (earliest-heard first).
    for (const m of merged.values()) {
      m.receptions.sort((a, b) => a.timestamp - b.timestamp);
    }

    const allMerged = Array.from(merged.values());
    allMerged.sort((a, b) => b.timestamp - a.timestamp);

    res.json(allMerged.slice(0, limit));
  } catch (error) {
    logger.error('Error fetching unified messages:', error);
    res.status(500).json({ error: 'Failed to fetch unified messages' });
  }
});

/**
 * GET /api/unified/telemetry?hours=24
 *
 * Returns the latest telemetry reading per node per type across all accessible
 * sources, sorted by timestamp descending. Each entry includes `sourceId` and
 * `sourceName`. Useful for a cross-source "fleet overview" dashboard.
 *
 * ?hours=N  → only include readings from the past N hours (default 24)
 */
router.get('/telemetry', async (req: Request, res: Response) => {
  try {
    const hours = Math.min(parseInt(req.query.hours as string || '24', 10), 168);
    // Telemetry timestamps are stored in milliseconds (see meshtasticManager.ts
    // `Store in milliseconds (Unix timestamp in ms)`), so the cutoff must also
    // be in ms. Previously the cutoff was computed in seconds, so the `hours`
    // filter was effectively a no-op (ms values always exceed the s cutoff).
    const cutoff = Date.now() - hours * 3600 * 1000;
    const user = (req as any).user;
    const isAdmin = user?.isAdmin ?? false;

    const sources = await databaseService.sources.getAllSources();

    const sourceResults = await Promise.allSettled(
      sources.map(async (source) => {
        const canRead = isAdmin || (user
          ? await databaseService.checkPermissionAsync(user.id, 'telemetry', 'read', source.id)
          : false);
        if (!canRead) return [];

        const nodes = await databaseService.nodes.getAllNodes(source.id);
        const entries: Array<Record<string, unknown>> = [];

        for (const node of nodes) {
          const latest = await databaseService.telemetry.getLatestTelemetryByNode(node.nodeId);
          for (const t of latest) {
            if (t.timestamp >= cutoff) {
              entries.push({
                ...t,
                sourceId: source.id,
                sourceName: source.name,
                nodeLongName: node.longName,
                nodeShortName: node.shortName,
              });
            }
          }
        }
        return entries;
      })
    );

    const allEntries: Array<Record<string, unknown>> = [];
    for (const result of sourceResults) {
      if (result.status === 'fulfilled') allEntries.push(...result.value);
    }

    allEntries.sort((a, b) => ((b.timestamp as number) ?? 0) - ((a.timestamp as number) ?? 0));

    res.json(allEntries);
  } catch (error) {
    logger.error('Error fetching unified telemetry:', error);
    res.status(500).json({ error: 'Failed to fetch unified telemetry' });
  }
});

/**
 * GET /api/unified/sources-status
 *
 * Returns connection status for all sources the user can access.
 * Used by the source list page to show live status without polling each source.
 */
router.get('/sources-status', async (_req: Request, res: Response) => {
  try {
    const { sourceManagerRegistry } = await import('../sourceManagerRegistry.js');
    const sources = await databaseService.sources.getAllSources();

    const statuses = await Promise.allSettled(
      sources.map(async (source) => {
        const manager = sourceManagerRegistry.getManager(source.id);
        if (!manager) {
          return { sourceId: source.id, connected: false };
        }
        const status = manager.getStatus();
        return { sourceId: source.id, connected: status.connected };
      })
    );

    const result: Record<string, unknown> = {};
    statuses.forEach((s, i) => {
      if (s.status === 'fulfilled') {
        result[sources[i].id] = s.value;
      }
    });

    res.json(result);
  } catch (error) {
    logger.error('Error fetching unified sources status:', error);
    res.status(500).json({ error: 'Failed to fetch sources status' });
  }
});

export default router;
