/**
 * Split-long-message limits for automated senders on every protocol
 * (#6316 MeshCore, #6330 Meshtastic). Fixed by the maintainer: at most 3
 * parts, 10 s apart, and a 5-minute floor for timers that split. Shared by the
 * server and the client so the airtime warning cannot drift from the real
 * behaviour.
 */
export const SPLIT_MAX_PARTS = 3;
export const SPLIT_PART_GAP_MS = 10_000;
/** Shortest timer interval (minutes) allowed when a timer splits long messages. */
export const SPLIT_TIMER_MIN_INTERVAL_MINUTES = 5;
/** Most channels one MeshCore Timer Trigger may send to (4.17.3 review M5). */
export const MESHCORE_TIMER_MAX_CHANNELS = 4;
/** Gap between channels within one MeshCore timer fire (4.17.3 review M5). */
export const MESHCORE_TIMER_CHANNEL_GAP_MS = 10_000;

/**
 * Meshtastic text cap in UTF-8 bytes. Same value as the server's
 * `MAX_MESSAGE_BYTES` (`src/server/constants/meshtastic.ts`); kept here so the
 * client can show it.
 */
export const MESHTASTIC_MAX_TEXT_BYTES = 200;
