/**
 * Plan how one automated MeshCore text goes on air (#6316): fit it to the byte
 * cap for its destination, split into marked parts when split is on, otherwise
 * truncate. Pure; no IO.
 */
import { splitUtf8Message } from './splitUtf8Message.js';
import { meshcoreMessageByteCap, MESHCORE_SPLIT_MAX_PARTS } from '../../utils/meshcoreMessageLimits.js';

export interface MeshCoreTextPlan {
  parts: string[];
  truncated: boolean;
  maxBytes: number;
}

export function planMeshCoreTextParts(
  text: string,
  opts: { isDm: boolean; nodeName?: string | null; split: boolean },
): MeshCoreTextPlan {
  const maxBytes = meshcoreMessageByteCap({ isDm: opts.isDm, nodeName: opts.nodeName });
  const { parts, truncated } = splitUtf8Message(text, {
    maxBytes,
    maxParts: opts.split ? MESHCORE_SPLIT_MAX_PARTS : 1,
  });
  return { parts, truncated, maxBytes };
}
