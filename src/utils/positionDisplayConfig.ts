/**
 * Browser-side mirror of the global `discardInvalidPositions` Map setting, used
 * by the map DISPLAY filters (issue #4157 — the render half of the #4158 toggle).
 *
 * The setting is global and changes rarely, but the Null Island filter runs in
 * many render paths and in pure position utils (`resolveNodeLatLng` has 7
 * callers; `mergeNodeRecords`/`getNodeLatLng` are plain functions) that can't
 * read React context. Threading the flag through every signature would be very
 * invasive, so — mirroring the server's `positionIngestConfig` — SettingsContext
 * keeps this module in sync (synchronously in its setter + on server load) and
 * each display site reads it via {@link getDiscardInvalidPositions}.
 *
 * Default `true` = discard (the historical behavior). When the user turns the
 * setting off, Null Island (0,0) markers RENDER instead of being hidden, so
 * RF-only operators can spot misconfigured/spoofed nodes. Out-of-range / NaN
 * junk is still hidden regardless (see `shouldDiscardPosition`).
 */
let discardInvalidPositions = true;

/** Current value of the display-side Null Island discard toggle. */
export function getDiscardInvalidPositions(): boolean {
  return discardInvalidPositions;
}

/** Sync the cached toggle (called by SettingsContext on set + server load). */
export function setDiscardInvalidPositionsDisplay(enabled: boolean): void {
  discardInvalidPositions = enabled;
}
