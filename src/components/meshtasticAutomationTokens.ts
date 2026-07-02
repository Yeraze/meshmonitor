import type { AutomationTokenInfo, AutomationTokenGroup } from './AutomationTokenReference';

/**
 * Single source of truth for the expansion tokens available across the
 * Meshtastic Automations page. Keep this in lockstep with the server:
 *   - global tokens → `MeshtasticManager.replaceAnnouncementTokens`
 *   - reply tokens  → `MeshtasticManager.replaceAcknowledgementTokens`
 *     (which also inherits every global token)
 * The server is authoritative for which placeholders actually expand.
 *
 * Tokens are split by availability context: the reply tokens (sender / signal
 * / route) only resolve when responding to a received message — Auto-Acknowledge
 * and Auto-Responder — and are meaningless in scheduled surfaces (Auto-Announce).
 */

/** Tokens that expand in every Meshtastic automation surface. */
export const MESHTASTIC_GLOBAL_TOKENS: AutomationTokenInfo[] = [
  { token: '{VERSION}', description: 'MeshMonitor version' },
  { token: '{DURATION}', description: 'MeshMonitor uptime' },
  { token: '{FEATURES}', description: 'Enabled feature summary' },
  { token: '{NODECOUNT}', description: 'Nodes seen recently' },
  { token: '{DIRECTCOUNT}', description: 'Nodes heard directly (0 hops)' },
  { token: '{TOTALNODES}', description: 'Total known nodes' },
  { token: '{ONLINENODES}', description: 'Nodes currently online' },
  { token: '{DATE}', description: 'Current date' },
  { token: '{TIME}', description: 'Current time' },
  { token: '{IP}', description: 'Server IP address' },
  { token: '{PORT}', description: 'Server port' },
];

/**
 * Tokens that only resolve when replying to a received message
 * (Auto-Acknowledge, Auto-Responder). Resolved against the sender / the
 * packet that triggered the reply.
 */
export const MESHTASTIC_REPLY_TOKENS: AutomationTokenInfo[] = [
  { token: '{NODE_ID}', description: 'Sender’s node ID (e.g. !a1b2c3d4)' },
  { token: '{LONG_NAME}', description: 'Sender’s long name' },
  { token: '{SHORT_NAME}', description: 'Sender’s short name' },
  { token: '{SNR}', description: 'Signal-to-noise ratio of the received packet' },
  { token: '{RSSI}', description: 'Received signal strength of the packet' },
  { token: '{HOPS}', description: 'Hops the message travelled' },
  { token: '{NUMBER_HOPS}', description: 'Same as {HOPS}' },
  { token: '{RABBIT_HOPS}', description: 'Hop count rendered as 🐇 emoji' },
  { token: '{LAST_HOP}', description: 'Last relay node before you' },
  { token: '{CHANNEL}', description: 'Channel the message arrived on' },
  { token: '{TRANSPORT}', description: 'How the message arrived (LoRa / MQTT)' },
];

/**
 * Build the grouped structure consumed by `<AutomationTokenReference />`.
 * Labels/notes are passed in so the caller can supply translated strings.
 */
export function buildMeshtasticTokenGroups(labels: {
  replyTitle: string;
  replyNote: string;
  globalTitle: string;
  globalNote: string;
}): AutomationTokenGroup[] {
  return [
    { title: labels.replyTitle, note: labels.replyNote, tokens: MESHTASTIC_REPLY_TOKENS },
    { title: labels.globalTitle, note: labels.globalNote, tokens: MESHTASTIC_GLOBAL_TOKENS },
  ];
}
