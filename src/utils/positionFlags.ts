/**
 * Position flags bit-mask utilities
 * 
 * Meshtastic uses a bit-mask to encode which optional fields to include in POSITION messages.
 * Each flag represents a different field that can be included.
 * 
 * Reference: protobufs/meshtastic/config.proto - PositionConfig.PositionFlags
 */

export enum PositionFlag {
  UNSET = 0x0000,
  ALTITUDE = 0x0001,
  ALTITUDE_MSL = 0x0002,
  GEOIDAL_SEPARATION = 0x0004,
  DOP = 0x0008,
  HVDOP = 0x0010,
  SATINVIEW = 0x0020,
  SEQ_NO = 0x0040,
  TIMESTAMP = 0x0080,
  HEADING = 0x0100,
  SPEED = 0x0200,
}

export interface PositionFlagsState {
  altitude: boolean;
  altitudeMsl: boolean;
  geoidalSeparation: boolean;
  dop: boolean;
  hvdop: boolean;
  satinview: boolean;
  seqNo: boolean;
  timestamp: boolean;
  heading: boolean;
  speed: boolean;
}

/**
 * Encode position flags state into a bit-mask
 * @param flags - Object with boolean values for each flag
 * @returns Bit-mask value (number)
 */
export function encodePositionFlags(flags: PositionFlagsState): number {
  let mask = 0;
  if (flags.altitude) mask |= PositionFlag.ALTITUDE;
  if (flags.altitudeMsl) mask |= PositionFlag.ALTITUDE_MSL;
  if (flags.geoidalSeparation) mask |= PositionFlag.GEOIDAL_SEPARATION;
  if (flags.dop) mask |= PositionFlag.DOP;
  if (flags.hvdop) mask |= PositionFlag.HVDOP;
  if (flags.satinview) mask |= PositionFlag.SATINVIEW;
  if (flags.seqNo) mask |= PositionFlag.SEQ_NO;
  if (flags.timestamp) mask |= PositionFlag.TIMESTAMP;
  if (flags.heading) mask |= PositionFlag.HEADING;
  if (flags.speed) mask |= PositionFlag.SPEED;
  return mask;
}

/**
 * Decode position flags bit-mask into state object
 * @param mask - Bit-mask value (number)
 * @returns Object with boolean values for each flag
 */
export function decodePositionFlags(mask: number): PositionFlagsState {
  return {
    altitude: (mask & PositionFlag.ALTITUDE) !== 0,
    altitudeMsl: (mask & PositionFlag.ALTITUDE_MSL) !== 0,
    geoidalSeparation: (mask & PositionFlag.GEOIDAL_SEPARATION) !== 0,
    dop: (mask & PositionFlag.DOP) !== 0,
    hvdop: (mask & PositionFlag.HVDOP) !== 0,
    satinview: (mask & PositionFlag.SATINVIEW) !== 0,
    seqNo: (mask & PositionFlag.SEQ_NO) !== 0,
    timestamp: (mask & PositionFlag.TIMESTAMP) !== 0,
    heading: (mask & PositionFlag.HEADING) !== 0,
    speed: (mask & PositionFlag.SPEED) !== 0,
  };
}

