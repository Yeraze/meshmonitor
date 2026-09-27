/**
 * ADS-B flight match for a likely-aircraft node (#5374), as
 * `GET /api/sources/:id/nodes/:nodeNum/flight-match` returns it.
 */
export type FlightMatchStatus = 'possible' | 'matched';

export interface FlightMatch {
  nodeNum: number;
  status: FlightMatchStatus;
  feed: string;
  hex: string;
  callsign: string | null;
  aircraftType: string | null;
  registration: string | null;
  gsKt: number | null;
  trackDeg: number | null;
  altM: number | null;
  distanceKm: number | null;
  matchedAt: number | null;
  /** e.g. "adsb.lol". */
  feedName: string;
  /** The aircraft on the feed's map. */
  flightUrl: string | null;
  /** e.g. "Data: adsb.lol". */
  attribution: string;
}
