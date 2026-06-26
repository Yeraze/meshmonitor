/**
 * Convert a Meshtastic ground_speed value to the user's display unit.
 *
 * The value is already in km/h: the firmware writes `ground_speed` from
 * TinyGPS++ `reader.speed.kmph()` (see GPS::lookForLocation in the Meshtastic
 * firmware), so it is kilometers/hour on the wire — despite the mesh.proto
 * comment claiming "m/s". We previously multiplied by 3.6 as if it were m/s,
 * inflating every speed by ~3.6× (a wire value of 90 showed as 324 km/h). See
 * issue #3797.
 *
 * Returns { speed, unit } where speed is rounded to 1 decimal place. For
 * imperial, applies only the km/h→mph factor.
 */
export function convertSpeed(kilometersPerHour: number, distanceUnit: string): { speed: number; unit: string } {
  const speed = distanceUnit === 'mi' ? kilometersPerHour * 0.621371 : kilometersPerHour;
  const unit = distanceUnit === 'mi' ? 'mph' : 'km/h';
  return { speed: parseFloat(speed.toFixed(1)), unit };
}
