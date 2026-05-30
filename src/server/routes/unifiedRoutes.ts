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
import { PortNum, CHANNEL_DB_OFFSET, modemPresetChannelName } from '../constants/meshtastic.js';
import type { DbChannelDatabase } from '../../db/types.js';

const router = Router();

// All unified routes allow optional auth (some data may be public)
router.use(optionalAuth());

/**
 * Resolve a channel's display name for unified views.
 *
 * Meshtastic channel conventions:
 *  - Channel 0 is always the PRIMARY channel. Its name is often blank because
 *    the firmware derives the on-wire channel name from the modem preset at
 *    runtime — `MEDIUM_FAST` → "MediumFast" — and uses that derived name for
 *    both the channel hash and the `ServiceEnvelope.channelId` it publishes
 *    to MQTT. When we have the source's preset on hand (via
 *    `lora.preset.<sourceId>` in the settings table), use the preset's
 *    pascal-case label so the TCP-side empty-name channel groups with
 *    MQTT-side rows that carry the same label. Falls back to "Primary" only
 *    when no preset is known.
 *  - Channels with `role === 0` are DISABLED — skip entirely.
 *  - Any other channel with a blank name is a disabled/unused slot — skip.
 *
 * Returns `null` when the channel should be omitted from the unified list.
 */
const PRIMARY_CHANNEL_NAME = 'Primary';
function unifiedChannelDisplayName(
  c: { id: number; name?: string | null; role?: number | null },
  presetName?: string | null,
): string | null {
  if (c.role === 0) return null; // DISABLED
  const name = (c.name ?? '').trim();
  if (name) return name;
  if (c.id === 0) return presetName ?? PRIMARY_CHANNEL_NAME;
  return null;
}

/**
 * Load the modem-preset-derived channel name for each source the caller can
 * see. Returns a Map<sourceId, presetName | null>. Sources without a stored
 * `lora.preset.<sourceId>` setting (e.g. MQTT bridges/brokers, MeshCore
 * sources, or TCP sources we've never received config from) map to null.
 *
 * Heavy callers fetch this once up front and pass per-source slices into
 * `unifiedChannelDisplayName` so we don't hit the settings table on every
 * channel row.
 */
async function loadSourcePresetNames(sourceIds: string[]): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  await Promise.all(
    sourceIds.map(async (sid) => {
      try {
        const raw = await databaseService.settings.getSetting(`lora.preset.${sid}`);
        if (raw === null || raw === undefined) {
          out.set(sid, null);
          return;
        }
        const n = Number(raw);
        out.set(sid, Number.isFinite(n) ? modemPresetChannelName(n) : null);
      } catch {
        out.set(sid, null);
      }
    }),
  );
  return out;
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
 * **Contract for every code path that inserts into `messages`:** this exact
 * format (underscores, fromNum middle, packetId last) is load-bearing.
 * Diverge from it — different separator, different field order, hyphens,
 * anything — and this parser returns null. The `/messages` dedup then falls
 * back to a `${fromNum}:${text}:${floor(timestamp/1000)}` heuristic. TCP and
 * MQTT receptions of the same packet arrive seconds apart, miss the 1s
 * window, and the user sees the same message N times in the unified view —
 * once per receiving source. See `src/server/mqttIngestion.ts` for examples
 * of MQTT-side ingest matching this format.
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
    // Modem preset per source — used as the fallback display name for
    // empty-named slot 0 so TCP and MQTT-side rows for the same logical
    // channel collapse to one picker entry.
    const sourcePresets = await loadSourcePresetNames(sources.map((s) => s.id));

    type ChannelSourceRef = { sourceId: string; sourceName: string; channelNumber: number };
    // Group case-insensitively so cross-device casing drift (e.g. one source
    // stores "primary", another stores "" → "Primary") doesn't split the
    // unified picker into two entries that each show only half the messages.
    // Key is `name.toLowerCase()`; we keep the first-seen casing for display
    // but upgrade to a non-synthesized casing when one shows up later, so a
    // device-set name wins over the synthetic `Primary` fallback.
    const byName = new Map<string, { displayName: string; sources: ChannelSourceRef[] }>();
    const upsert = (name: string, ref: ChannelSourceRef) => {
      const key = name.toLowerCase();
      const entry = byName.get(key);
      if (entry) {
        entry.sources.push(ref);
        // Prefer a device-stored casing over the synthetic "Primary" fallback;
        // otherwise keep first-seen.
        if (entry.displayName === PRIMARY_CHANNEL_NAME && name !== PRIMARY_CHANNEL_NAME) {
          entry.displayName = name;
        }
      } else {
        byName.set(key, { displayName: name, sources: [ref] });
      }
    };

    await Promise.all(
      sources.map(async (source) => {
        // Check messages:read once per source (covers DMs and acts as "broad
        // read" grant). Per-channel read is checked individually below.
        const canReadMessages = isAdmin || (user
          ? await databaseService.checkPermissionAsync(user.id, 'messages', 'read', source.id)
          : false);

        try {
          const chans = await databaseService.channels.getAllChannels(source.id);
          const presetName = sourcePresets.get(source.id) ?? null;
          for (const c of chans) {
            const name = unifiedChannelDisplayName(c as any, presetName);
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
            upsert(name, {
              sourceId: source.id,
              sourceName: source.name,
              channelNumber: channelNum,
            });
          }
        } catch (err) {
          logger.warn(`Failed to load channels for source ${source.id}:`, err);
        }

        // Virtual channels are global — every channel-database entry decrypts
        // packets from every source — so each virtual channel is surfaced
        // under every source at the synthetic channel number
        // `CHANNEL_DB_OFFSET + vcId` (same encoding used for stored message
        // rows; see meshtasticManager.ts dual-insert path). If a virtual
        // channel shares a name with a physical slot on the same source, both
        // entries collapse into the same `byName` group so the picker shows
        // one option; the `/messages` endpoint will union both channel
        // numbers when fetching.
        for (const vc of virtualChannels) {
          if (vc.id == null) continue;
          if (!canReadVirtualChannel(vc.id, readableVirtualIds)) continue;
          const name = (vc.name ?? '').trim();
          if (!name) continue;
          upsert(name, {
            sourceId: source.id,
            sourceName: source.name,
            channelNumber: CHANNEL_DB_OFFSET + vc.id,
          });
        }
      })
    );

    const result = Array.from(byName.values())
      .map(({ displayName, sources: srcs }) => ({ name: displayName, sources: srcs }))
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
 *   ?before=<ms>      Cursor: only include messages whose server DB arrival
 *                     time (createdAt) is strictly less than this. Used for
 *                     infinite-scroll pagination. Switched from device
 *                     rxTime/timestamp to createdAt in issue #3122 so
 *                     future-skewed device clocks can't pin old messages
 *                     at the visible "newest" slot.
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
 *     timestamp,        // canonical device time (earliest rxTime seen) — for display
 *     createdAt,        // earliest server DB arrival time across receptions — for ordering/cursor
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
    // Modem preset per source — pass into the channel-name resolver so a
    // picker entry like "MediumFast" matches an empty-named slot 0 on a TCP
    // source whose preset derives that label.
    const sourcePresets = await loadSourcePresetNames(sources.map((s) => s.id));

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
      createdAt: number;
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

        // Virtual channels are global — every enabled channel-database entry
        // can decrypt packets on this source — so every readable virtual
        // channel is in scope. Shared between the named-channel and legacy
        // paths below.
        const vcsOnSource = virtualChannels.filter(
          (vc) => vc.id != null &&
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

          // Match channel name case-insensitively. The unified picker groups
          // names case-insensitively (see `/channels` upsert helper), so the
          // resolver here must too — otherwise a source whose stored name
          // differs only in casing (e.g. "primary" vs "Primary") returns zero
          // messages even though the picker showed a single entry.
          const channelNameLower = channelName.toLowerCase();

          // Physical slot matches. MQTT bridges/brokers can have multiple
          // slots on a single source with the same channel name (different
          // upstream gateways place "LongFast" at different slots) — collect
          // ALL matches, not just the first. The preset hint lets empty-named
          // slot 0 on a TCP source match a picker entry like "MediumFast".
          const presetName = sourcePresets.get(source.id) ?? null;
          const physMatches = (chans ?? []).filter(
            (c) => (unifiedChannelDisplayName(c as any, presetName) ?? '').toLowerCase() === channelNameLower
          );
          for (const match of physMatches) {
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
            if ((vc.name ?? '').trim().toLowerCase() === channelNameLower && vc.id != null) {
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
            // Cursor is createdAt (server arrival time) to match the channel
            // path and resist future-skewed device clocks (#3122).
            msgs = msgs.filter((m) => m.createdAt < before);
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
          // Treat rxTime <= 0 as missing, not as a real device time. MQTT
          // gateway packets can carry rxTime === 0 (unset receive time); a
          // plain `rxTime ?? timestamp` would pick 0 (nullish coalescing only
          // falls through on null/undefined) and render Unix epoch (Dec 1969).
          const rxTime = typeof m.rxTime === 'number' && m.rxTime > 0 ? m.rxTime : null;
          const canonical = (rxTime ?? m.timestamp) as number;
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
            rxTime,
            timestamp: m.timestamp,
          };

          const existing = merged.get(dedupKey);
          if (existing) {
            existing.receptions.push(reception);
            // Canonical = earliest heard
            if (canonical < existing.timestamp) existing.timestamp = canonical;
            // createdAt = earliest DB arrival across all receptions (#3122)
            if (m.createdAt < existing.createdAt) existing.createdAt = m.createdAt;
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
            // Upgrade tapback metadata if a later source has it and the
            // first-seen entry didn't. The per-source `Promise.all` ingest
            // order is non-deterministic, so a row from a source that lost
            // emoji/replyId (e.g. a stale insert) could otherwise win the
            // race and make a tapback render as a full inline message.
            // Once set, prefer the populated value: any source with the
            // metadata is correct because the underlying mesh packet is
            // identical across receivers.
            if ((existing.emoji == null || existing.emoji === 0) && m.emoji != null && m.emoji > 0) {
              existing.emoji = m.emoji;
            }
            if (existing.replyId == null && m.replyId != null && m.replyId > 0) {
              existing.replyId = m.replyId;
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
              createdAt: m.createdAt,
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
    // Sort newest-first by server DB arrival time (createdAt) rather than the
    // canonical device timestamp so a packet with a future-skewed device clock
    // can't pin itself to the top of the feed (#3122).
    allMerged.sort((a, b) => b.createdAt - a.createdAt);

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
              .getLatestTelemetryByNode(node.nodeId, source.id)
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
    // Distinct counts across permitted sources. `activeNodeCount` mirrors the
    // per-source endpoint (issue #2883) using the same 2h window so the
    // Unified card and individual source cards line up.
    const [nodeCount, activeNodeCount] = await Promise.all([
      databaseService.nodes.getDistinctNodeCount(allowedIds),
      databaseService.nodes.getDistinctActiveNodeCount(allowedIds),
    ]);

    res.json({ nodeCount, activeNodeCount, connected: anyConnected });
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
