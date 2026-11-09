/**
 * Security scanner thresholds shared by the Meshtastic and MeshCore scans, the
 * digest and the UI copy (#6281). One source of truth: change a value here and
 * every consumer follows.
 */

/** Packets from one node in the last hour above which it counts as excessive (spam). */
export const EXCESSIVE_PACKETS_PER_HOUR = 30;

/** Rate window, ms. Both protocols count packets over the last hour at scan time. */
export const EXCESSIVE_PACKETS_WINDOW_MS = 60 * 60 * 1000;

/**
 * Clock offset above which a node is flagged, in minutes. Configurable with the
 * `TIME_OFFSET_THRESHOLD_MINUTES` environment variable; default 30.
 */
export const TIME_OFFSET_THRESHOLD_MINUTES = (() => {
  const n = parseInt(process.env.TIME_OFFSET_THRESHOLD_MINUTES || '30', 10);
  return Number.isFinite(n) && n > 0 ? n : 30;
})();

/** {@link TIME_OFFSET_THRESHOLD_MINUTES} in ms. */
export const TIME_OFFSET_THRESHOLD_MS = TIME_OFFSET_THRESHOLD_MINUTES * 60 * 1000;
