export const TX_DISABLED_CODE = 'TX_DISABLED' as const;

export class TxDisabledError extends Error {
  /** Brand for cross-module-safe detection (see isTxDisabledError). */
  readonly isTxDisabledError = true as const;
  readonly code = TX_DISABLED_CODE;
  constructor(message = 'Transmit is disabled on this source’s radio') {
    super(message);
    this.name = 'TxDisabledError';
  }
}

/** Structural check — survives module duplication / mocking (does not rely on instanceof). */
export function isTxDisabledError(e: unknown): e is TxDisabledError {
  return !!e && typeof e === 'object' && (e as { isTxDisabledError?: boolean }).isTxDisabledError === true;
}
