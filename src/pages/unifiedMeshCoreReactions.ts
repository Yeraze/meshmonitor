/**
 * Fold MeshCore reactions in the Unified feed into chips (#5763).
 *
 * The server tags each MeshCore entry with row refs, and each reaction with the
 * refs of the rows it targets. Refs resolve here, across every loaded page, so
 * a reaction on page 1 finds a target that loaded on page 2. Pure.
 */
import {
  groupMeshCoreReactions,
  type ReactionChip,
  type ReactionGroupRow,
} from '../components/MeshCore/meshcoreReactionGroups';

export interface UnifiedReactionFields {
  dedupKey: string;
  fromNodeId: string;
  fromNodeLongName?: string;
  reactionEmoji?: string | null;
  reactionTargetRefs?: string[];
  meshcoreRowRefs?: string[];
}

export interface UnifiedReactionGrouping<M> {
  rows: M[];
  /** Target dedupKey to chips. */
  chipsByTarget: Map<string, ReactionChip[]>;
}

/** A target id no row has: refs exist but none are loaded, so the reaction hides. */
const OFF_PAGE = '\u0000off-page';

export function groupUnifiedMeshCoreReactions<M extends UnifiedReactionFields>(
  messages: M[],
): UnifiedReactionGrouping<M> {
  if (!messages.some(m => !!m.reactionEmoji)) {
    return { rows: messages, chipsByTarget: new Map() };
  }

  const refToKey = new Map<string, string>();
  for (const m of messages) {
    for (const ref of m.meshcoreRowRefs ?? []) refToKey.set(ref, m.dedupKey);
  }

  const byKey = new Map<string, M>();
  const adapters: ReactionGroupRow[] = messages.map(m => {
    byKey.set(m.dedupKey, m);
    let targetId: string | null = null;
    if (m.reactionEmoji) {
      const refs = m.reactionTargetRefs ?? [];
      for (const ref of refs) {
        const hit = refToKey.get(ref);
        if (hit) {
          targetId = hit;
          break;
        }
      }
      if (!targetId && refs.length > 0) targetId = OFF_PAGE;
    }
    return {
      id: m.dedupKey,
      fromPublicKey: m.fromNodeId,
      fromName: m.fromNodeLongName ?? null,
      reactionEmoji: m.reactionEmoji,
      reactionTargetId: targetId,
    };
  });

  const grouped = groupMeshCoreReactions(adapters, { youLabel: '' });
  return {
    rows: grouped.rows.map(r => byKey.get(r.id) as M),
    chipsByTarget: grouped.chipsByTarget,
  };
}
