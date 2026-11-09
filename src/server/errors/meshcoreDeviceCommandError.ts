/**
 * Typed refusal from the MeshCore Companion device commands (P8a #6257):
 * BLE PIN, multi-ACKs, factory reset. The manager decides WHY; the route maps
 * the code to an HTTP status.
 */
export type MeshCoreDeviceCommandErrorCode =
  | 'SOURCE_NOT_CONNECTED'
  | 'FIRMWARE_UNSUPPORTED'
  | 'MULTI_ACKS_UNSUPPORTED'
  | 'INVALID_PIN'
  | 'COMMAND_FAILED';

export const MESHCORE_DEVICE_COMMAND_ERROR_STATUS: Record<MeshCoreDeviceCommandErrorCode, number> = {
  SOURCE_NOT_CONNECTED: 409,
  FIRMWARE_UNSUPPORTED: 409,
  MULTI_ACKS_UNSUPPORTED: 409,
  INVALID_PIN: 400,
  COMMAND_FAILED: 502,
};

export class MeshCoreDeviceCommandError extends Error {
  readonly isMeshCoreDeviceCommandError = true as const;
  constructor(
    readonly code: MeshCoreDeviceCommandErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'MeshCoreDeviceCommandError';
  }
}

/** Structural check: survives module duplication and mocking (no instanceof). */
export function isMeshCoreDeviceCommandError(e: unknown): e is MeshCoreDeviceCommandError {
  return !!e && typeof e === 'object'
    && (e as { isMeshCoreDeviceCommandError?: boolean }).isMeshCoreDeviceCommandError === true;
}
