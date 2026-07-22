import type { AutomationTokenInfo, AutomationTokenGroup } from '../AutomationTokenReference';

/**
 * Single source of truth for the expansion tokens available across the
 * MeshCore Automations page. Keep this in lockstep with the server:
 *   - global tokens  → `src/server/utils/meshcoreAnnounceTokens.ts`
 *   - reply tokens   → `MeshCoreManager.replaceAutoAckTokens`
 * The server is authoritative for which placeholders actually expand.
 *
 * Tokens are split by availability context because the reply tokens
 * (sender / signal / route) only resolve when responding to a received
 * message — Auto-Acknowledge and Auto-Responder — and are meaningless in
 * scheduled surfaces (Auto-Announce, Timer Triggers).
 */

/** Tokens that expand in every MeshCore automation surface. */
export const MESHCORE_GLOBAL_TOKENS: AutomationTokenInfo[] = [
  { token: '{VERSION}', description: 'MeshMonitor version' },
  { token: '{DURATION}', description: 'MeshMonitor uptime' },
  { token: '{CONTACTCOUNT}', description: 'Total known contacts' },
  { token: '{COMPANIONCOUNT}', description: 'Number of companion contacts' },
  { token: '{REPEATERCOUNT}', description: 'Number of repeater contacts' },
  { token: '{ROOMCOUNT}', description: 'Number of room-server contacts' },
  { token: '{NODE_NAME}', description: 'Sender’s name in replies; this node’s name in Auto-Announce / Timer Triggers' },
  { token: '{NODE_ID}', description: 'Sender’s ID in replies; this node’s ID in Auto-Announce / Timer Triggers' },
];

/**
 * Tokens that only resolve when replying to a received message
 * (Auto-Acknowledge, Auto-Responder). Resolved against the sender / the
 * packet that triggered the reply.
 */
export const MESHCORE_REPLY_TOKENS: AutomationTokenInfo[] = [
  { token: '{LONG_NAME}', description: 'Sender’s long name' },
  { token: '{SHORT_NAME}', description: 'Sender’s short name' },
  { token: '{DATE}', description: 'Date the message was received' },
  { token: '{TIME}', description: 'Time the message was received' },
  { token: '{SNR}', description: 'Signal-to-noise ratio of the received packet' },
  { token: '{HOPS}', description: 'Hop count the message travelled' },
  { token: '{NUMBER_HOPS}', description: 'Same as {HOPS}' },
  { token: '{ROUTE}', description: 'Relay-hash chain the message took (e.g. a3→7f)' },
  { token: '{ROUTE_NAMES}', description: 'Relay chain resolved to repeater names where known (e.g. Hilltop→7f)' },
  { token: '{HASH_SIZE}', description: 'Per-hop path-hash width in bytes (1–3), as set by the sender' },
  { token: '{SCOPE}', description: 'Region/scope the message was sent with' },
];

/**
 * Flat list of the global token strings, used by surfaces that render
 * insert-token buttons (Auto-Announce). Only the global set is offered there
 * because reply tokens do not expand in scheduled messages.
 */
export const MESHCORE_AUTOMATION_TOKENS: string[] = MESHCORE_GLOBAL_TOKENS.map((t) => t.token);

/**
 * Build the grouped structure consumed by `<AutomationTokenReference />`.
 * Labels/notes are passed in so the caller can supply translated strings.
 */
export function buildMeshCoreTokenGroups(labels: {
  replyTitle: string;
  replyNote: string;
  globalTitle: string;
  globalNote: string;
}): AutomationTokenGroup[] {
  return [
    { title: labels.replyTitle, note: labels.replyNote, tokens: MESHCORE_REPLY_TOKENS },
    { title: labels.globalTitle, note: labels.globalNote, tokens: MESHCORE_GLOBAL_TOKENS },
  ];
}
