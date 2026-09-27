/**
 * Follow-the-channel remap after a MeshCore on-device channel reorder (#5379).
 *
 * The DB rewrite itself is one transaction in
 * `MeshCoreChannelRemapRepository.remapChannelSlots`. This service wraps it:
 * it completes the move list into a permutation, refreshes the PG/MySQL
 * settings cache for the rewritten keys, and lists automations that name a
 * moved slot by raw number.
 *
 * Automations are global (no sourceId) and a raw `channel: N` in a
 * `trigger.message` or legacy `action.sendMessage` matches that slot on EVERY
 * source, Meshtastic included. Rewriting it for one MeshCore source would
 * silently change what it does elsewhere, so they are reported for review
 * instead. Automations that pick channels by name (the current editor and the
 * MT<->MC bridge templates) resolve per source at run time and need nothing.
 */
import databaseService from '../../services/database.js';
import { logger } from '../../utils/logger.js';
import {
  MESHCORE_CHANNEL_INDEX_SETTING_KEYS,
  completeChannelMoves,
  type ChannelSlotMove,
  type ChannelSlotRemapCounts,
} from '../../db/repositories/meshcoreChannelRemap.js';

export interface AutomationChannelReview {
  id: string;
  name: string;
  /** Moved slot numbers this automation names directly. */
  slots: number[];
}

export interface ChannelRemapSummary extends ChannelSlotRemapCounts {
  /** The full permutation applied (moved channels plus orphan-slot pairs). */
  appliedMoves: ChannelSlotMove[];
  automationsToReview: AutomationChannelReview[];
}

/**
 * Automations whose graph names one of `slots` by raw channel number. Pure;
 * exported for tests.
 */
export function findAutomationsNamingSlots(
  automations: Array<{ id: string; name: string; config: string }>,
  slots: Set<number>,
): AutomationChannelReview[] {
  const out: AutomationChannelReview[] = [];
  for (const a of automations) {
    let graph: unknown;
    try { graph = JSON.parse(a.config); } catch { continue; }
    const nodes = (graph as { nodes?: unknown })?.nodes;
    if (!Array.isArray(nodes)) continue;
    const hit = new Set<number>();
    for (const node of nodes) {
      const type = (node as { type?: unknown })?.type;
      if (type !== 'trigger.message' && type !== 'action.sendMessage') continue;
      const params = ((node as { params?: unknown }).params ?? {}) as Record<string, unknown>;
      // A name-based pick (channels[] or channelName) wins over the number.
      const byName = (Array.isArray(params.channels) && params.channels.length > 0)
        || (typeof params.channelName === 'string' && params.channelName.length > 0);
      if (byName || params.channel == null || params.channel === '') continue;
      const n = Number(params.channel);
      if (Number.isInteger(n) && slots.has(n)) hit.add(n);
    }
    if (hit.size > 0) out.push({ id: a.id, name: a.name, slots: [...hit].sort((x, y) => x - y) });
  }
  return out;
}

export async function remapMeshCoreChannelReferences(
  sourceId: string,
  moves: ChannelSlotMove[],
): Promise<ChannelRemapSummary> {
  const appliedMoves = completeChannelMoves(moves);
  const counts = await databaseService.meshcoreChannelRemap.remapChannelSlots(sourceId, appliedMoves);

  if (counts.settingsUpdated.length > 0) {
    await databaseService.refreshCachedSettingsAsync(
      MESHCORE_CHANNEL_INDEX_SETTING_KEYS.map((k) => `source:${sourceId}:${k}`),
    );
  }

  let automationsToReview: AutomationChannelReview[] = [];
  try {
    const all = await databaseService.automations.listAutomations();
    automationsToReview = findAutomationsNamingSlots(all, new Set(appliedMoves.map((m) => m.from)));
  } catch (err) {
    logger.warn(`[MeshCore:${sourceId}] channel reorder: automation review scan failed: ${(err as Error).message}`);
  }

  return { ...counts, appliedMoves, automationsToReview };
}
