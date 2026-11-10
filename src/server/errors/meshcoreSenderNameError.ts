/**
 * Typed refusal from a MeshCore sender-name override send (#6282). The manager
 * decides WHY the send is refused; the routes only translate it to HTTP.
 */
export type MeshCoreSenderNameErrorCode =
  | 'FIRMWARE_UNSUPPORTED'
  | 'CLIENT_REPEAT_ON'
  | 'CHANNEL_KEY_UNAVAILABLE'
  | 'TEXT_TOO_LONG'
  | 'TABLE_FULL'
  | 'ILLEGAL_ARG'
  | 'SOURCE_NOT_CONNECTED'
  | 'SEND_FAILED';

export const MESHCORE_SENDER_NAME_ERROR_STATUS: Record<MeshCoreSenderNameErrorCode, number> = {
  FIRMWARE_UNSUPPORTED: 422,
  CLIENT_REPEAT_ON: 409,
  CHANNEL_KEY_UNAVAILABLE: 409,
  TEXT_TOO_LONG: 400,
  TABLE_FULL: 503,
  ILLEGAL_ARG: 502,
  SOURCE_NOT_CONNECTED: 409,
  SEND_FAILED: 502,
};

export class MeshCoreSenderNameError extends Error {
  /** Brand for cross-module-safe detection (see isMeshCoreSenderNameError). */
  readonly isMeshCoreSenderNameError = true as const;
  constructor(readonly code: MeshCoreSenderNameErrorCode, message: string) {
    super(message);
    this.name = 'MeshCoreSenderNameError';
  }
}

/** Structural check: survives module duplication and mocking (no instanceof). */
export function isMeshCoreSenderNameError(err: unknown): err is MeshCoreSenderNameError {
  return !!err && typeof err === 'object' && (err as { isMeshCoreSenderNameError?: unknown }).isMeshCoreSenderNameError === true;
}
