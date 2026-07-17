/**
 * Global "discard invalid GPS positions" ingest gate.
 *
 * Backs the `discardInvalidPositions` Map setting. When enabled (the default and
 * historical behavior) a Null Island (0, 0) fix — including a precision-obscured
 * one — is discarded on ingest across every source (Meshtastic TCP, MQTT,
 * MeshCore). Disabling it lets those (0, 0) reports through so operators can see
 * which nodes are transmitting them. Non-finite / out-of-range junk is always
 * discarded regardless (see {@link shouldDiscardPosition}).
 *
 * The value is cached in this module rather than read from the DB per packet:
 * the setting is GLOBAL (not per-source) and changes rarely, but the gate runs
 * on every position packet across three ingest sites — one of which
 * (`src/db/repositories/meshcore.ts`) is a low-level repository with no settings
 * access. A single module-level flag, seeded at startup and refreshed by the
 * settings-save callback, gives all three sites a zero-DB read.
 */

// Default ON = discard invalid positions = the behavior before this setting existed.
let discardInvalidPositions = true;

/** Current value of the global discard-invalid-positions gate. */
export function getDiscardInvalidPositions(): boolean {
  return discardInvalidPositions;
}

/** Update the cached gate (called at startup and from the settings-save callback). */
export function setDiscardInvalidPositions(enabled: boolean): void {
  discardInvalidPositions = enabled;
}

/**
 * Parse the stored setting value into a boolean with a default-ON policy:
 * an absent value, `'1'`, or `'true'` → `true`; only an explicit `'0'` / `'false'`
 * → `false`. Mirrors the frontend parse in SettingsContext.
 */
export function parseDiscardInvalidPositions(raw: string | null | undefined): boolean {
  return !(raw === '0' || raw === 'false');
}

/**
 * Reset the cached flag to its factory default (`true`). Exported for test
 * isolation only — a suite that flips the flag must restore it in teardown so it
 * cannot bleed into other tests (the flag is a process-global module singleton).
 */
export function __resetDiscardInvalidPositionsForTest(): void {
  discardInvalidPositions = true;
}
