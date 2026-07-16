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
