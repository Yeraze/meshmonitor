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
import { PortNum, CHANNEL_DB_OFFSET } from '../constants/meshtastic.js';
import type { DbChannelDatabase } from '../../db/types.js';

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
 * Defensive validation (rowId comes from DB so trusted, but cheap to harden):
 *  - non-string or empty → null
 *  - unreasonably long (>256 chars) → null, guards against malformed input
 *  - trailing segment must be a non-negative finite integer within the
 *    Meshtastic packet id range (unsigned 32-bit)
 *
 * Returns `null` when the id cannot be parsed to a valid packet id.
 */
/**
 * Virtual channel read access.
 *
 * Virtual channels (MeshMonitor server-side PSKs stored in `channel_database`)
 * use a parallel permission table (`channel_database_permissions`) rather than
 * the generic `checkPermissionAsync` resource/action system used by physical
 * channels. Admins bypass the table; everyone else needs an explicit row with
 * `canRead = true`. The sentinel `'all'` avoids building a full-id set for
 * admins who can read every entry regardless.
 */
type ReadableVirtualIds = Set<number> | 'all';

async function getUserReadableVirtualChannelIds(
  user: { id: number } | undefined,
  isAdmin: boolean,
): Promise<ReadableVirtualIds> {
  if (isAdmin) return 'all';
  if (!user) return new Set();
  try {
    const perms = await databaseService.channelDatabase.getPermissionsForUserAsync(user.id);
    return new Set(
      perms
        .filter((p) => p.canRead)
        .map((p) => p.channelDatabaseId),
    );
  } catch (err) {
    logger.warn('Failed to load virtual channel permissions:', err);
    return new Set();
  }
}

function canReadVirtualChannel(vcId: number, readable: ReadableVirtualIds): boolean {
  return readable === 'all' || readable.has(vcId);
}

async function loadEnabledVirtualChannels(): Promise<DbChannelDatabase[]> {
  try {
    const all = await databaseService.channelDatabase.getAllAsync();
    return all.filter((vc) => vc.isEnabled);
  } catch (err) {
    logger.warn('Failed to load virtual channels:', err);
    return [];
  }
}

const MAX_ROW_ID_LENGTH = 256;
const MAX_PACKET_ID = 0xffffffff; // unsigned 32-bit
export function extractPacketIdFromRowId(rowId: unknown): number | null {
  if (typeof rowId !== 'string' || rowId.length === 0 || rowId.length > MAX_ROW_ID_LENGTH) {
    return null;
  }
  const parts = rowId.split('_');
  if (parts.length < 2) return null;
  const last = parts[parts.length - 1];
  // Reject anything that isn't pure digits — Number.parseInt would otherwise
  // accept things like "12abc" → 12.
  if (!/^\d+$/.test(last)) return null;
  const n = Number.parseInt(last, 10);
  if (!Number.isFinite(n) || n < 0 || n > MAX_PACKET_ID) return null;
  return n;
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

    // Virtual channels and their permissions are global (not per-source), so
    // load them once up front rather than per source in the loop below.
    const [sources, virtualChannels, readableVirtualIds] = await Promise.all([
      databaseService.sources.getAllSources(),
      loadEnabledVirtualChannels(),
      getUserReadableVirtualChannelIds(user, isAdmin),
    ]);

    type ChannelSourceRef = { sourceId: string; sourceName: string; channelNumber: number };
    const byName = new Map<string, ChannelSourceRef[]>();

    await Promise.all(
      sources.map(async (source) => {
        // Check messages:read once per source (covers DMs and acts as "broad
        // read" grant). Per-channel read is checked individually below.
        const canReadMessages = isAdmin || (user
          ? await databaseService.checkPermissionAsync(user.id, 'messages', 'read', source.id)
          : false);

        try {
          const chans = await databaseService.channels.getAllChannels(source.id);
          for (const c of chans) {
            const name = unifiedChannelDisplayName(c as any);
            if (!name) continue; // disabled or unused slot
            const channelNum = (c as any).id as number;
            const canReadChannel = canReadMessages || (user
              ? await databaseService.checkPermissionAsync(
                  user.id,
                  `channel_${channelNum}`,
                  'read',
                  source.id,
                )
              : false);
            if (!canReadChannel) continue;
            const list = byName.get(name) ?? [];
            list.push({
              sourceId: source.id,
              sourceName: source.name,
              channelNumber: channelNum,
            });
            byName.set(name, list);
          }
        } catch (err) {
          logger.warn(`Failed to load channels for source ${source.id}:`, err);
        }

        // Virtual channels belong to exactly one source (creator) and are
        // surfaced to the unified picker under a synthetic channel number
        // `CHANNEL_DB_OFFSET + vcId` — the same encoding used for the stored
        // message rows (see meshtasticManager.ts dual-insert path). If a
        // virtual channel shares a name with a physical slot on the same
        // source, both entries collapse into the same `byName` group so the
        // picker shows one option; the `/messages` endpoint will union both
        // channel numbers when fetching.
        for (const vc of virtualChannels) {
          if (vc.sourceId !== source.id) continue;
          if (vc.id == null) continue;
          if (!canReadVirtualChannel(vc.id, readableVirtualIds)) continue;
          const name = (vc.name ?? '').trim();
          if (!name) continue;
          const list = byName.get(name) ?? [];
          list.push({
            sourceId: source.id,
            sourceName: source.name,
            channelNumber: CHANNEL_DB_OFFSET + vc.id,
          });
          byName.set(name, list);
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

    const [sources, virtualChannels, readableVirtualIds] = await Promise.all([
      databaseService.sources.getAllSources(),
      loadEnabledVirtualChannels(),
      getUserReadableVirtualChannelIds(user, isAdmin),
    ]);

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
        const canReadMessages = isAdmin || (user
          ? await databaseService.checkPermissionAsync(user.id, 'messages', 'read', source.id)
          : false);

        // Resolve channel name → channel number AND build node-name map in
        // parallel. Both are independent reads against this source's DB slice
        // and used only inside this per-source block, so we can fan them out
        // instead of running them back-to-back.
        const nodeMap = new Map<number, { longName?: string; shortName?: string }>();
        // Channel numbers on THIS source to fetch messages from. For a named
        // channel request this is the physical slot AND/OR any virtual channel
        // on this source sharing that name. For the legacy "no filter" path
        // it stays undefined and we fall back to `allowedChannelsOnSource`.
        let channelNumbers: number[] | undefined;
        // Channels on this source the user can read. Populated only when
        // needed (no channelName → we have to filter per channel). Includes
        // synthetic virtual channel numbers (CHANNEL_DB_OFFSET + vcId).
        let allowedChannelsOnSource: Set<number> | null = null;

        const [chansResult, nodesResult] = await Promise.allSettled([
          channelName
            ? databaseService.channels.getAllChannels(source.id)
            : Promise.resolve(null),
          databaseService.nodes.getAllNodes(source.id),
        ]);

        // Virtual channels scoped to THIS source that the user can read.
        // Shared between the named-channel and legacy paths below.
        const vcsOnSource = virtualChannels.filter(
          (vc) => vc.sourceId === source.id && vc.id != null &&
            canReadVirtualChannel(vc.id, readableVirtualIds),
        );

        if (channelName) {
          if (chansResult.status === 'rejected') {
            logger.warn(
              `Failed to resolve channel '${channelName}' for source ${source.id}:`,
              chansResult.reason
            );
            return;
          }
          const chans = chansResult.value;
          const resolved: number[] = [];

          // Physical slot match.
          const match = chans?.find(
            (c) => unifiedChannelDisplayName(c as any) === channelName
          );
          if (match) {
            const physNum = (match as any).id as number;
            const canReadChannel = canReadMessages || (user
              ? await databaseService.checkPermissionAsync(
                  user.id,
                  `channel_${physNum}`,
                  'read',
                  source.id,
                )
              : false);
            if (canReadChannel) resolved.push(physNum);
          }

          // Virtual channel matches on this source. Same name → same group:
          // we union the stored channel numbers (physical slot and synthetic
          // CHANNEL_DB_OFFSET+vcId) so the unified stream includes both.
          for (const vc of vcsOnSource) {
            if ((vc.name ?? '').trim() === channelName && vc.id != null) {
              resolved.push(CHANNEL_DB_OFFSET + vc.id);
            }
          }

          if (resolved.length === 0) return; // source has no matching readable channel
          channelNumbers = resolved;
        } else {
          // No channel filter: build the set of channels on this source the
          // user can actually read. Skip the source entirely if empty.
          allowedChannelsOnSource = new Set<number>();
          for (let n = 0; n <= 7; n++) {
            const allow = canReadMessages || (user
              ? await databaseService.checkPermissionAsync(
                  user.id,
                  `channel_${n}`,
                  'read',
                  source.id,
                )
              : false);
            if (allow) allowedChannelsOnSource.add(n);
          }
          // Virtual channels the user can read on this source.
          for (const vc of vcsOnSource) {
            if (vc.id != null) {
              allowedChannelsOnSource.add(CHANNEL_DB_OFFSET + vc.id);
            }
          }
          if (allowedChannelsOnSource.size === 0 && !canReadMessages) return;
        }

        if (nodesResult.status === 'fulfilled') {
          for (const n of nodesResult.value) {
            nodeMap.set(Number(n.nodeNum), {
              longName: n.longName ?? undefined,
              shortName: n.shortName ?? undefined,
            });
          }
        } else {
          logger.warn(`Failed to load nodes for source ${source.id}:`, nodesResult.reason);
        }

        // Fetch messages. Kept sequential after the channel lookup because the
        // query depends on `channelNumbers`.
        let msgs: Awaited<ReturnType<typeof databaseService.messages.getMessages>>;
        if (channelNumbers !== undefined && channelNumbers.length > 0) {
          // Named channel: may map to a physical slot, a virtual slot, or
          // both on this source. Fan out the per-channel queries and merge —
          // packet-id dedup later collapses any overlap for the rare case
          // where a packet somehow lands in both.
          const perChannel = await Promise.all(
            channelNumbers.map((cn) =>
              databaseService.messages.getMessagesBeforeInChannel(
                cn,
                before,
                fetchLimit,
                source.id,
              ),
            ),
          );
          msgs = perChannel.flat();
        } else {
          // Legacy: no channel filter. Cursor-less offset fetch.
          // Exclude traceroute responses — the UI filters them out of message
          // lists, so they'd only waste slots in the capped window and evict
          // real DMs (issue #2741).
          msgs = await databaseService.messages.getMessages(fetchLimit, 0, source.id, [PortNum.TRACEROUTE_APP]);
          if (before !== undefined) {
            msgs = msgs.filter((m) => (m.rxTime ?? m.timestamp) < before);
          }
          // Filter to channels the user can read on this source. DMs (no
          // channel or explicitly -1) require the broader messages:read grant.
          if (allowedChannelsOnSource) {
            msgs = msgs.filter((m) => {
              const ch = (m as any).channel;
              if (ch == null || ch === -1) return canReadMessages;
              return allowedChannelsOnSource!.has(ch);
            });
          }
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
            // Upgrade sender display names if a later source knows the node
            // and the first-seen entry didn't. Common when one source's
            // nodes.getAllNodes failed or simply hasn't learned the sender yet.
            if (!existing.fromNodeLongName || !existing.fromNodeShortName) {
              const sender = nodeMap.get(fromNum);
              if (sender?.longName && !existing.fromNodeLongName) {
                existing.fromNodeLongName = sender.longName;
              }
              if (sender?.shortName && !existing.fromNodeShortName) {
                existing.fromNodeShortName = sender.shortName;
              }
            }
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

        // Fan out per-node telemetry lookups in parallel rather than awaiting
        // each one sequentially. On a multi-source deployment the sequential
        // form was the dominant cost of /api/unified/telemetry — O(sources *
        // nodes) serial round trips through Drizzle.
        const perNodeLatest = await Promise.all(
          nodes.map((node) =>
            databaseService.telemetry
              .getLatestTelemetryByNode(node.nodeId)
              .then((latest) => ({ node, latest }))
              .catch((err) => {
                logger.warn(
                  `Failed to load telemetry for node ${node.nodeId} (source ${source.id}):`,
                  err
                );
                return { node, latest: [] as Array<{ timestamp: number }> };
              })
          )
        );

        for (const { node, latest } of perNodeLatest) {
          for (const t of latest as any[]) {
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
 * GET /api/unified/status
 *
 * Returns the deduped node count and aggregate connection state across every
 * source the authenticated user can read. The dashboard sidebar polls this so
 * the Unified card displays a stable count regardless of which individual
 * source is currently selected (issue #2805). Previously the sidebar fell
 * back to a raw sum of per-source counts when Unified wasn't selected, which
 * over-counted nodes shared between sources and made the value drift as the
 * user switched between sources.
 */
router.get('/status', async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const isAdmin = user?.isAdmin ?? false;
    const sources = await databaseService.sources.getAllSources();

    // `connected` reflects whether *any* source is currently up. It is not
    // permission-scoped — same approach as /api/unified/sources-status, since
    // connection state is operational signal, not user-scoped data. This also
    // ensures the Unified card shows the correct connection dot for
    // unauthenticated viewers.
    const { sourceManagerRegistry } = await import('../sourceManagerRegistry.js');
    const anyConnected = sources.some((source) => {
      const manager = sourceManagerRegistry.getManager(source.id);
      return manager?.getStatus().connected === true;
    });

    // nodeCount stays permission-scoped so an unauthenticated viewer can't
    // infer the size of sources they aren't allowed to read.
    const allowedIds: string[] = [];
    for (const source of sources) {
      const canRead = isAdmin || (user
        ? await databaseService.checkPermissionAsync(user.id, 'nodes', 'read', source.id)
        : false);
      if (canRead) allowedIds.push(source.id);
    }
    const nodeCount = await databaseService.nodes.getDistinctNodeCount(allowedIds);

    res.json({ nodeCount, connected: anyConnected });
  } catch (error) {
    logger.error('Error fetching unified status:', error);
    res.status(500).json({ error: 'Failed to fetch unified status' });
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
