/**
 * Errors from the read-back that follows a verified module-config write (#5745).
 *
 * After `set_module_config`, DeviceAdminService asks the node for the same
 * module and compares. The firmware reports no error when it drops a write, so
 * the read-back is the only proof the node took it.
 */

/** The node answered, and its value is not the one we sent. */
export class ModuleConfigNotAppliedError extends Error {
  /** Brand for cross-module-safe detection (see isModuleConfigNotAppliedError). */
  readonly isModuleConfigNotAppliedError = true as const;
  constructor(
    readonly moduleType: string,
    /** The module section the node returned. */
    readonly nodeConfig: Record<string, unknown>,
  ) {
    super(`The node did not apply the ${moduleType} config`);
    this.name = 'ModuleConfigNotAppliedError';
  }
}

/** The node did not answer the read-back in time, or the link dropped. */
export class ModuleConfigUnverifiedError extends Error {
  /** Brand for cross-module-safe detection (see isModuleConfigUnverifiedError). */
  readonly isModuleConfigUnverifiedError = true as const;
  constructor(readonly moduleType: string) {
    super(`The node did not confirm the ${moduleType} config`);
    this.name = 'ModuleConfigUnverifiedError';
  }
}

/** Structural check: survives module duplication and mocking (no instanceof). */
export function isModuleConfigNotAppliedError(e: unknown): e is ModuleConfigNotAppliedError {
  return !!e && typeof e === 'object'
    && (e as { isModuleConfigNotAppliedError?: boolean }).isModuleConfigNotAppliedError === true;
}

/** Structural check: survives module duplication and mocking (no instanceof). */
export function isModuleConfigUnverifiedError(e: unknown): e is ModuleConfigUnverifiedError {
  return !!e && typeof e === 'object'
    && (e as { isModuleConfigUnverifiedError?: boolean }).isModuleConfigUnverifiedError === true;
}
