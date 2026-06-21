/**
 * Pivot position-related telemetry rows (one row per metric) into per-fix
 * position objects grouped by timestamp.
 *
 * Position fixes are stored as separate telemetry rows per metric
 * (`latitude`, `longitude`, `altitude`, `ground_speed`, `ground_track`) that
 * share a single packet timestamp. The position handler also stamps per-fix
 * receive metadata (SNR + hop info, issue #3492) onto the lat/lon rows. This
 * helper re-assembles those rows into the shape the map history tooltip
 * consumes, surfacing SNR/hops so a directly-heard fix can show
 * "Heard directly (0 hops)" + SNR (issue #3590).
 */

/** Firmware sentinel meaning "no SNR measurement available". */
export const NO_SNR_SENTINEL = -128;

/** Minimal telemetry row shape this pivot needs. */
export interface PivotTelemetryRow {
  telemetryType: string;
  timestamp: number;
  value: number;
  rxSnr?: number | null;
  hopStart?: number | null;
  hopLimit?: number | null;
}

export interface PivotedPosition {
  timestamp: number;
  latitude: number;
  longitude: number;
  altitude?: number;
  groundSpeed?: number;
  groundTrack?: number;
  snr?: number;
  hopStart?: number;
  hopLimit?: number;
}

interface Accumulator {
  lat?: number;
  lon?: number;
  alt?: number;
  groundSpeed?: number;
  groundTrack?: number;
  snr?: number;
  hopStart?: number;
  hopLimit?: number;
}

/**
 * Group telemetry rows by timestamp, returning complete (lat+lon present)
 * fixes sorted oldest-first. SNR/hop metadata is surfaced when present; a
 * -128 SNR (firmware "no measurement" sentinel) is treated as absent so it
 * does not leak into the tooltip. A legitimate 0 dB SNR — common for a node
 * heard directly — is preserved (issue #3590).
 */
export function pivotPositionHistory(rows: PivotTelemetryRow[]): PivotedPosition[] {
  const byTimestamp = new Map<number, Accumulator>();

  for (const t of rows) {
    let pos = byTimestamp.get(t.timestamp);
    if (!pos) {
      pos = {};
      byTimestamp.set(t.timestamp, pos);
    }

    switch (t.telemetryType) {
      case 'latitude':
        pos.lat = t.value;
        break;
      case 'longitude':
        pos.lon = t.value;
        break;
      case 'altitude':
        pos.alt = t.value;
        break;
      case 'ground_speed':
        pos.groundSpeed = t.value;
        break;
      case 'ground_track':
        pos.groundTrack = t.value;
        break;
    }

    // SNR/hop metadata is stamped on the lat & lon rows (identical copies).
    // Take the first valid value seen for this fix.
    if (pos.snr === undefined && t.rxSnr != null && t.rxSnr !== NO_SNR_SENTINEL) {
      pos.snr = t.rxSnr;
    }
    if (pos.hopStart === undefined && t.hopStart != null) {
      pos.hopStart = t.hopStart;
    }
    if (pos.hopLimit === undefined && t.hopLimit != null) {
      pos.hopLimit = t.hopLimit;
    }
  }

  const positions: PivotedPosition[] = [];
  for (const [timestamp, pos] of byTimestamp.entries()) {
    if (pos.lat === undefined || pos.lon === undefined) continue;
    positions.push({
      timestamp,
      latitude: pos.lat,
      longitude: pos.lon,
      altitude: pos.alt,
      groundSpeed: pos.groundSpeed,
      groundTrack: pos.groundTrack,
      ...(pos.snr !== undefined && { snr: pos.snr }),
      ...(pos.hopStart !== undefined && { hopStart: pos.hopStart }),
      ...(pos.hopLimit !== undefined && { hopLimit: pos.hopLimit }),
    });
  }

  positions.sort((a, b) => a.timestamp - b.timestamp);
  return positions;
}
