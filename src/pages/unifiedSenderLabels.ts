/**
 * Sender-label formatting for the Unified Messages view (issue #4193).
 * Separate module (not exported from the page component) so react-refresh
 * only-export-components stays clean and the rules are unit-testable.
 */
import { formatSenderLabel } from '../utils/nodeHelpers';

export interface SenderLabelFields {
  fromNodeNum: number;
  fromNodeId: string;
  fromNodeLongName?: string;
  fromNodeShortName?: string;
}

// Per-message sender label: "Long Name (SHRT)" — same formatSenderLabel rules
// as the per-source Messages tab (#4196): no duplicate or empty parenthetical.
export function senderLabel(msg: SenderLabelFields): string {
  return formatSenderLabel(
    msg.fromNodeLongName,
    msg.fromNodeShortName,
    msg.fromNodeId || `!${msg.fromNodeNum.toString(16)}`,
  );
}

// Compact contexts (reply previews, reaction chips): short-name-first, single value.
export function shortSenderLabel(msg: SenderLabelFields): string {
  return msg.fromNodeShortName || msg.fromNodeLongName || msg.fromNodeId || `!${msg.fromNodeNum.toString(16)}`;
}
