import type { DeviceInfo } from '../types/device.js';
import { nodeIdFromNum, type MentionCandidate } from './mentions.js';

/**
 * Turn the node list into `@` autocomplete rows (#5276).
 *
 * Ordered by last heard, newest first, because a bare `@` shows the head of
 * this list and the node you want is nearly always one you just heard from.
 * The local node is dropped: mentioning yourself spends airtime to tell you
 * something you already know.
 */
export function mentionCandidatesFromNodes(
  nodes: readonly DeviceInfo[] | undefined,
  selfNodeId?: string | null,
): MentionCandidate[] {
  if (!nodes || nodes.length === 0) return [];
  const self = selfNodeId?.toLowerCase();

  return nodes
    .map(node => {
      const id = (node.user?.id || nodeIdFromNum(node.nodeNum)).toLowerCase();
      return {
        id,
        longName: node.user?.longName?.trim() || '',
        shortName: node.user?.shortName?.trim() || '',
        lastHeard: node.lastHeard ?? 0,
      };
    })
    .filter(c => c.id !== self)
    .sort((a, b) => b.lastHeard - a.lastHeard)
    .map(({ id, longName, shortName }) => ({ id, longName, shortName }));
}
