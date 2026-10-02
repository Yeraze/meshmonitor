/**
 * Typed refusal from {@link MeshCoreManager.resendChannelMessage} (#5512).
 *
 * Each code maps to one HTTP status in the resend route, so the manager decides
 * WHY a resend is refused and the route only translates it.
 */
export type MeshCoreResendErrorCode =
  | 'MESSAGE_NOT_FOUND'
  | 'NOT_OWN_MESSAGE'
  | 'NOT_CHANNEL_MESSAGE'
  | 'RESEND_UNAVAILABLE'
  | 'ALREADY_HEARD'
  | 'RESEND_TOO_OLD'
  | 'RESEND_LIMIT'
  | 'RESEND_COOLDOWN'
  | 'AUTO_RETRY_PENDING'
  | 'SOURCE_NOT_CONNECTED'
  | 'SEND_FAILED';

/** HTTP status for each refusal code. */
export const MESHCORE_RESEND_ERROR_STATUS: Record<MeshCoreResendErrorCode, number> = {
  MESSAGE_NOT_FOUND: 404,
  NOT_OWN_MESSAGE: 400,
  NOT_CHANNEL_MESSAGE: 400,
  RESEND_UNAVAILABLE: 409,
  ALREADY_HEARD: 409,
  RESEND_TOO_OLD: 409,
  RESEND_LIMIT: 429,
  RESEND_COOLDOWN: 429,
  AUTO_RETRY_PENDING: 409,
  SOURCE_NOT_CONNECTED: 409,
  SEND_FAILED: 502,
};

export class MeshCoreResendError extends Error {
  /** Brand for cross-module-safe detection (see isMeshCoreResendError). */
  readonly isMeshCoreResendError = true as const;
  constructor(
    readonly code: MeshCoreResendErrorCode,
    message: string,
    /** Seconds until a retry can succeed (RESEND_COOLDOWN / AUTO_RETRY_PENDING). */
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = 'MeshCoreResendError';
  }
}

/** Structural check — survives module duplication / mocking (no instanceof). */
export function isMeshCoreResendError(e: unknown): e is MeshCoreResendError {
  return !!e && typeof e === 'object' && (e as { isMeshCoreResendError?: boolean }).isMeshCoreResendError === true;
}
