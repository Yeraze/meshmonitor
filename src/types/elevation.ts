/**
 * Client mirror of the Phase-1 elevation backend's response payload
 * (Terrain Link Profile epic #4111). Kept in sync with
 * `src/server/services/elevationService.ts`'s `ProfileSample`/`ProfileResult`
 * but defined independently since the frontend never imports server code.
 */

/** One elevation sample from `POST /api/elevation/profile`. */
export interface ElevationSample {
  distance: number;
  lat: number;
  lng: number;
  elevation: number | null;
}

/** Full profile payload returned (post-envelope-unwrap) by the elevation route. */
export interface ElevationProfile {
  distanceMeters: number;
  provider: string;
  samples: ElevationSample[];
}

/** Mirror of elevationService `TestResult` for the settings Test button (#4111 P3). */
export interface ElevationTestResult {
  success: boolean;
  detectedType: string;
  sampleElevation: number | null;
  latencyMs: number;
  httpStatus?: number;
  error?: string;
}

/**
 * Client mirror of `sourceRoutes.ts`'s server-side `SourceRadioSummary`
 * (#4111 P3 WP-1) — the public, non-secret per-source radio field on
 * `GET /api/sources`. Center frequency / region is inherently public RF
 * information (broadcast over the air), so this is safe on the anonymous
 * sources list.
 */
export interface SourceRadioSummary {
  frequencyMhz: number | null;
  /** Meshtastic only. */
  regionName?: string;
  /** Meshtastic only — drives RX-sensitivity auto-seed. */
  modemPreset?: number;
}
