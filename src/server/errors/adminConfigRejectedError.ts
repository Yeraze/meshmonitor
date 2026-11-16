/**
 * The node refused a local admin config write (#6439).
 *
 * A node built without a module (MESHTASTIC_EXCLUDE_MQTT, say) answers the
 * admin set with a Routing error such as BAD_REQUEST. A success is silent.
 */
export class AdminConfigRejectedError extends Error {
  /** Brand for cross-module-safe detection (see isAdminConfigRejectedError). */
  readonly isAdminConfigRejectedError = true as const;
  constructor(
    readonly configType: string,
    /** Routing error code the node replied with. */
    readonly errorCode: number,
    /** Routing error name, for logs. */
    readonly errorName: string,
  ) {
    super(`The node refused the ${configType} config (${errorName})`);
    this.name = 'AdminConfigRejectedError';
  }
}

/** Structural check: survives module duplication and mocking (no instanceof). */
export function isAdminConfigRejectedError(e: unknown): e is AdminConfigRejectedError {
  return !!e && typeof e === 'object'
    && (e as { isAdminConfigRejectedError?: boolean }).isAdminConfigRejectedError === true;
}
