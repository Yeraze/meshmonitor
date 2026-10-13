/**
 * Fold MeshCore reaction rows into chips under their target (#5759).
 *
 * A reaction is stored as its own message row. This turns a list of rows into
 * the rows to draw plus the chips each drawn row carries. Pure: no I/O, no
 * clock, so the stream can call it in a memo.
 */
import type { MeshCoreMessage } from './hooks/useMeshCore';
import { foldReactionEmoji } from '../../utils/meshcoreReactionTarget';

export interface ReactionChip {
  emoji: string;
  count: number;
  reactors: string[];
  /** We reacted with this emoji. */
  mine: boolean;
  /** Our reaction is still on its way to the server. */
  pending: boolean;
}

/** The fields grouping reads; MeshCore stream rows and Unified adapters both fit. */
export interface ReactionGroupRow {
  id: string;
  fromPublicKey: string;
  fromName?: string | null;
  reactionEmoji?: string | null;
  reactionTargetId?: string | null;
  reactionPending?: boolean;
  filtered?: 'ignore' | 'block';
}

export interface ReactionGrouping<M extends ReactionGroupRow = MeshCoreMessage> {
  /** Rows to draw: everything but reactions that became a chip or are hidden. */
  rows: M[];
  /** Target id → chips, in first-seen order. */
  chipsByTarget: Map<string, ReactionChip[]>;
}

export interface ReactionGroupingOptions {
  /** Reaction id → target id, for reactions resolved after this list loaded. */
  resolutions?: Record<string, string>;
  selfPublicKey?: string;
  youLabel: string;
  nameForKey?: (key: string) => string | null;
}

/** Received DMs carry a 6-byte key prefix; compare reactors at that width. */
const REACTOR_KEY_HEX = 12;

export function isReactionRow(m: Pick<ReactionGroupRow, 'reactionEmoji'>): boolean {
  return !!m.reactionEmoji;
}

export function groupMeshCoreReactions<M extends ReactionGroupRow>(
  messages: M[],
  opts: ReactionGroupingOptions,
): ReactionGrouping<M> {
  const { resolutions, selfPublicKey, youLabel, nameForKey } = opts;
  if (!messages.some(isReactionRow)) return { rows: messages, chipsByTarget: new Map() };

  const present = new Set<string>();
  for (const m of messages) {
    if (!isReactionRow(m)) present.add(m.id);
  }

  const rows: M[] = [];
  const chipsByTarget = new Map<string, ReactionChip[]>();
  // `${targetId}\n${foldedEmoji}` → reactor identities already counted.
  const seen = new Map<string, Set<string>>();

  for (const m of messages) {
    if (!isReactionRow(m)) {
      rows.push(m);
      continue;
    }
    // A reaction from an ignored sender shows nowhere.
    if (m.filtered) continue;
    const targetId = resolutions?.[m.id] ?? m.reactionTargetId;
    if (!targetId) {
      rows.push(m);
      continue;
    }
    // Target on an older page, or purged: nothing to hang the chip on.
    if (!present.has(targetId)) continue;

    const emoji = m.reactionEmoji as string;
    const folded = foldReactionEmoji(emoji);
    const ours = !!selfPublicKey && m.fromPublicKey === selfPublicKey;
    const isChannel = m.fromPublicKey.startsWith('channel-');
    const identity = ours
      ? 'self'
      : isChannel
        ? `n:${m.fromName ?? ''}`
        : `k:${m.fromPublicKey.slice(0, REACTOR_KEY_HEX).toLowerCase()}`;
    const label = ours
      ? youLabel
      : m.fromName ?? nameForKey?.(m.fromPublicKey) ?? m.fromPublicKey.substring(0, 8);

    const seenKey = `${targetId}\n${folded}`;
    let reactors = seen.get(seenKey);
    if (!reactors) {
      reactors = new Set();
      seen.set(seenKey, reactors);
    }
    if (reactors.has(identity)) {
      // The real row after its optimistic copy: the chip is no longer pending.
      if (ours && !m.reactionPending) {
        const dup = chipsByTarget.get(targetId)?.find(c => foldReactionEmoji(c.emoji) === folded);
        if (dup) dup.pending = false;
      }
      continue;
    }
    reactors.add(identity);

    let chips = chipsByTarget.get(targetId);
    if (!chips) {
      chips = [];
      chipsByTarget.set(targetId, chips);
    }
    const isPending = ours && !!m.reactionPending;
    const chip = chips.find(c => foldReactionEmoji(c.emoji) === folded);
    if (chip) {
      chip.count += 1;
      chip.reactors.push(label);
      if (ours) {
        chip.mine = true;
        chip.pending = isPending;
      }
    } else {
      chips.push({ emoji, count: 1, reactors: [label], mine: ours, pending: isPending });
    }
  }
  return { rows, chipsByTarget };
}
