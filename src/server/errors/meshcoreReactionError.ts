/**
 * Typed refusal from {@link MeshCoreManager.sendReaction} (#5762).
 *
 * The manager decides WHY a reaction is refused; the route maps the code to an
 * HTTP status and automation maps it to a recorded skip or a failed step.
 */
export type MeshCoreReactionErrorCode =
  | 'INVALID_EMOJI'
  | 'MESSAGE_NOT_FOUND'
  | 'REACTIONS_OUTBOUND_DISABLED'
  | 'SOURCE_NOT_CONNECTED'
  | 'TARGET_IS_REACTION'
  | 'TARGET_IS_ROOM_POST'
  | 'TARGET_NO_HASH'
  | 'TARGET_NOT_REACTABLE'
  | 'DUPLICATE_REACTION'
  | 'MESSAGE_TOO_LONG'
  | 'SEND_FAILED';

/** HTTP status for each refusal code. */
export const MESHCORE_REACTION_ERROR_STATUS: Record<MeshCoreReactionErrorCode, number> = {
  INVALID_EMOJI: 400,
  MESSAGE_NOT_FOUND: 404,
  REACTIONS_OUTBOUND_DISABLED: 409,
  SOURCE_NOT_CONNECTED: 409,
  TARGET_IS_REACTION: 409,
  TARGET_IS_ROOM_POST: 409,
  TARGET_NO_HASH: 409,
  TARGET_NOT_REACTABLE: 409,
  DUPLICATE_REACTION: 409,
  MESSAGE_TOO_LONG: 400,
  SEND_FAILED: 502,
};

export class MeshCoreReactionError extends Error {
  /** Brand for cross-module-safe detection (see isMeshCoreReactionError). */
  readonly isMeshCoreReactionError = true as const;
  constructor(
    readonly code: MeshCoreReactionErrorCode,
    message: string,
    /** Id of the reaction row already sent (DUPLICATE_REACTION). */
    readonly existingId?: string,
  ) {
    super(message);
    this.name = 'MeshCoreReactionError';
  }
}

/** Structural check: survives module duplication and mocking (no instanceof). */
export function isMeshCoreReactionError(e: unknown): e is MeshCoreReactionError {
  return !!e && typeof e === 'object' && (e as { isMeshCoreReactionError?: boolean }).isMeshCoreReactionError === true;
}

/** Codes an automation records as a skip (everything except SEND_FAILED and SOURCE_NOT_CONNECTED). */
export const MESHCORE_REACTION_SKIP_CODES: ReadonlySet<MeshCoreReactionErrorCode> = new Set<MeshCoreReactionErrorCode>([
  'INVALID_EMOJI',
  'MESSAGE_NOT_FOUND',
  'REACTIONS_OUTBOUND_DISABLED',
  'TARGET_IS_REACTION',
  'TARGET_IS_ROOM_POST',
  'TARGET_NO_HASH',
  'TARGET_NOT_REACTABLE',
  'DUPLICATE_REACTION',
  'MESSAGE_TOO_LONG',
]);
