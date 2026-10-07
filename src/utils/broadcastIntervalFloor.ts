/**
 * MeshMonitor's floors for the two broadcast intervals a node keeps in its
 * config, and the one rule every save path applies to them.
 *
 * A node reports 0 for an interval it has never been given: 0 is the
 * firmware's "use my default" sentinel (meshtastic/firmware
 * `Default::getConfiguredOrDefaultMs`). A save must send that 0 back as 0.
 * Raising it to the floor, as the save handlers once did, made a
 * default-config node broadcast its position every 32 seconds the first time
 * anyone saved an unrelated field in the same section.
 *
 * Any other value under the floor is still refused. The frontend save
 * handlers and the server routes both read the floors from here so they
 * cannot drift apart.
 */

/** Lowest non-zero `position.position_broadcast_secs` MeshMonitor will send (#5055). */
export const POSITION_BROADCAST_FLOOR_SECS = 32;

/** Lowest non-zero `device.node_info_broadcast_secs` MeshMonitor will send. */
export const NODE_INFO_BROADCAST_FLOOR_SECS = 3600;

/**
 * The interval a save sends: 0 stays 0 (the node keeps its firmware default),
 * anything else is raised to the floor.
 */
export function floorKeepingZero(value: number, floor: number): number {
  return value === 0 ? 0 : Math.max(floor, value);
}

/**
 * True when a submitted interval must be refused: present, and not 0, and
 * either not a whole number of seconds or under the floor. `undefined` and
 * `null` mean "field not sent" and pass.
 */
export function isIntervalBelowFloor(value: unknown, floor: number): boolean {
  if (value === undefined || value === null) return false;
  const n = typeof value === 'number' ? value : Number(value);
  if (n === 0) return false;
  return !Number.isInteger(n) || n < floor;
}
