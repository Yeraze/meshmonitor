/**
 * "Silent on 2.8+" detection (issue #5033).
 *
 * Meshtastic 2.8 made position and telemetry broadcast **opt-in** rather than
 * always-on (firmware #10929). A node upgraded to 2.8 without opting back in
 * keeps talking on the mesh (NodeInfo, text, routing) but stops emitting
 * position fixes and device telemetry. From MeshMonitor's side the node looks
 * half-dead — the map marker freezes and the telemetry graphs go flat — and
 * users reasonably blame MeshMonitor instead of the firmware change.
 *
 * This module derives an informational notice at RENDER TIME from data the
 * node list already carries. It is DISPLAY ONLY:
 *   - it never sends a packet, never probes the node, never requests telemetry;
 *   - it never emits an event, so it cannot reach the Apprise / desktop / MQTT
 *     notification fan-out.
 * See the "Mesh impact checklist" in CLAUDE.md.
 *
 * ---------------------------------------------------------------------------
 * POLICY CONSTANTS — these are deliberate product decisions, not tuning knobs.
 * They are intentionally NOT user-facing settings (issue #5033 did not ask for
 * one). Change them here, in one place, if the defaults prove wrong in the
 * field.
 * ---------------------------------------------------------------------------
 */

import { isFirmwareAtLeast } from './firmwareVersion.js';

/**
 * How long position / telemetry must have been absent before we say anything.
 *
 * 24 hours. Chosen conservatively: the pre-2.8 defaults were a position
 * broadcast every ~15 minutes and device telemetry every ~30 minutes, so 24h
 * is roughly 48-96 missed intervals. Nothing short of a real configuration
 * change (or a genuinely dead sensor) produces a gap that long on a node we
 * are still hearing from. A shorter window would fire on ordinary LoRa packet
 * loss and on nodes that sleep.
 */
export const FIRMWARE_28_SILENCE_THRESHOLD_MS = 24 * 60 * 60 * 1000;

/**
 * How recently we must have heard *anything* from the node for the notice to
 * apply.
 *
 * 6 hours. The point of the notice is "this node is alive but has stopped
 * sending position/telemetry". A node we have not heard from at all is simply
 * offline — a different problem, and telling its owner to check their
 * broadcast config would be wrong. 6h comfortably clears the 3h default
 * `node_info_broadcast_secs` with room for one missed beacon, while still
 * being short enough that a node which dropped off the mesh yesterday does not
 * get blamed for a config it may not have.
 */
export const FIRMWARE_28_ACTIVE_WINDOW_MS = 6 * 60 * 60 * 1000;

/** The firmware release that made broadcast opt-in. */
export const FIRMWARE_28_MAJOR = 2;
export const FIRMWARE_28_MINOR = 8;

/**
 * Official documentation for turning position / telemetry broadcast back on.
 * Both URLs and both anchors were verified to return HTTP 200 before being
 * hardcoded (issue #5033). There is no single page covering both.
 *
 * NOTE the position link points at the **channels** page, not
 * `/docs/configuration/radio/position/`. Firmware #10929 gates position on the
 * per-channel `module_settings.position_precision` (defaulted to 0, and
 * migrated to 0 on public / default-PSK channels), NOT on
 * `position_broadcast_secs`. Linking the position config page would send users
 * hunting for a setting that was never the gate.
 */
export const FIRMWARE_28_POSITION_DOC_URL =
  'https://meshtastic.org/docs/configuration/radio/channels/#position-precision';
export const FIRMWARE_28_TELEMETRY_DOC_URL =
  'https://meshtastic.org/docs/configuration/module/telemetry/#settings';

/** Everything the check needs. All fields optional — missing data means "no notice". */
export interface Firmware28SilenceInput {
  /** Firmware version string, e.g. "2.8.0.abcdef". Unknown => no notice. */
  firmwareVersion?: string | null;
  /** Unix **seconds** of the last packet of any kind from this node. */
  lastHeard?: number | null;
  /** Epoch **milliseconds** of the last position fix received. */
  positionTimestamp?: number | null;
  /** Epoch **milliseconds** of the last device-metrics telemetry received. */
  telemetryTimestamp?: number | null;
  /** A manually-pinned position is not evidence about broadcast config. */
  positionIsOverride?: boolean;
  /** A trilaterated estimate is MeshMonitor's own guess, not a broadcast. */
  positionIsEstimated?: boolean;
}

export interface Firmware28SilenceNotice {
  /** Node previously reported position and has now been quiet past the threshold. */
  positionSilent: boolean;
  /** Node previously reported device telemetry and has now been quiet past the threshold. */
  telemetrySilent: boolean;
  /** ms since the last position fix, when `positionSilent`. */
  positionSilentForMs: number | null;
  /** ms since the last telemetry sample, when `telemetrySilent`. */
  telemetrySilentForMs: number | null;
}

/**
 * Returns a notice when a node running firmware >= 2.8 is still being heard on
 * the mesh but has stopped sending position and/or device telemetry.
 * Returns `null` when there is nothing to say.
 */
export function evaluateFirmware28Silence(
  input: Firmware28SilenceInput,
  nowMs: number = Date.now(),
): Firmware28SilenceNotice | null {
  // Fail open on an unknown / unparseable / pre-2.8 firmware version. A false
  // "your node is misconfigured" is worse than no notice at all.
  if (!isFirmwareAtLeast(input.firmwareVersion, FIRMWARE_28_MAJOR, FIRMWARE_28_MINOR)) {
    return null;
  }

  // The node has to still be alive, otherwise this is just an offline node.
  const lastHeardMs =
    typeof input.lastHeard === 'number' && Number.isFinite(input.lastHeard)
      ? input.lastHeard * 1000
      : null;
  if (lastHeardMs === null || nowMs - lastHeardMs > FIRMWARE_28_ACTIVE_WINDOW_MS) {
    return null;
  }

  // Position: only meaningful when the node actually broadcast one at some
  // point, and when what we're showing is that broadcast rather than an
  // override or one of our own trilaterated estimates.
  let positionSilentForMs: number | null = null;
  const positionIsDeviceReported = !input.positionIsOverride && !input.positionIsEstimated;
  if (
    positionIsDeviceReported &&
    typeof input.positionTimestamp === 'number' &&
    Number.isFinite(input.positionTimestamp)
  ) {
    const age = nowMs - input.positionTimestamp;
    if (age >= FIRMWARE_28_SILENCE_THRESHOLD_MS) positionSilentForMs = age;
  }

  // Telemetry: same "it used to send this" requirement.
  let telemetrySilentForMs: number | null = null;
  if (typeof input.telemetryTimestamp === 'number' && Number.isFinite(input.telemetryTimestamp)) {
    const age = nowMs - input.telemetryTimestamp;
    if (age >= FIRMWARE_28_SILENCE_THRESHOLD_MS) telemetrySilentForMs = age;
  }

  if (positionSilentForMs === null && telemetrySilentForMs === null) return null;

  return {
    positionSilent: positionSilentForMs !== null,
    telemetrySilent: telemetrySilentForMs !== null,
    positionSilentForMs,
    telemetrySilentForMs,
  };
}
