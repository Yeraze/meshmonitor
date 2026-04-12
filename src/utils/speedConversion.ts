/**
 * Convert ground speed from m/s (Meshtastic protobuf uint32) to display units.
 * Returns { speed, unit } where speed is rounded to 1 decimal place.
 */
export function convertSpeed(metersPerSecond: number, distanceUnit: string): { speed: number; unit: string } {
  const speedKmh = metersPerSecond * 3.6;
  const speed = distanceUnit === 'mi' ? speedKmh * 0.621371 : speedKmh;
  const unit = distanceUnit === 'mi' ? 'mph' : 'km/h';
  return { speed: parseFloat(speed.toFixed(1)), unit };
}
