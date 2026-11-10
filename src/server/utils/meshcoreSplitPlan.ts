/**
 * Plan how one automated MeshCore text goes on air (#6316): fit it to the byte
 * cap for its destination, split into marked parts when split is on, otherwise
 * truncate. Pure; no IO. The split itself is shared with Meshtastic (#6330).
 */
import { planAutomatedTextParts, type AutomatedTextPlan } from './automatedTextSplit.js';
import { meshcoreMessageByteCap } from '../../utils/meshcoreMessageLimits.js';

export type MeshCoreTextPlan = AutomatedTextPlan;

export function planMeshCoreTextParts(
  text: string,
  opts: { isDm: boolean; nodeName?: string | null; split: boolean },
): MeshCoreTextPlan {
  const maxBytes = meshcoreMessageByteCap({ isDm: opts.isDm, nodeName: opts.nodeName });
  return planAutomatedTextParts(text, { maxBytes, split: opts.split });
}
