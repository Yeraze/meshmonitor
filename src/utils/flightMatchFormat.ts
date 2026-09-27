/**
 * Display text for an ADS-B flight match (#5374):
 * "UAL123 · B738 · N12345 · 450 kt 270°". Missing parts are left out; with
 * nothing else to show, the ICAO hex stands in.
 */
import type { FlightMatch } from '../types/flightMatch.js';

export function formatFlightMatchDetails(
  m: Pick<FlightMatch, 'hex' | 'callsign' | 'aircraftType' | 'registration' | 'gsKt' | 'trackDeg'>,
): string {
  const parts: string[] = [];
  if (m.callsign) parts.push(m.callsign);
  if (m.aircraftType) parts.push(m.aircraftType);
  if (m.registration) parts.push(m.registration);
  const motion: string[] = [];
  if (m.gsKt != null && Number.isFinite(m.gsKt)) motion.push(`${Math.round(m.gsKt)} kt`);
  if (m.trackDeg != null && Number.isFinite(m.trackDeg)) motion.push(`${Math.round(m.trackDeg)}°`);
  if (motion.length > 0) parts.push(motion.join(' '));
  if (parts.length === 0 && m.hex) parts.push(m.hex.toUpperCase());
  return parts.join(' · ');
}
