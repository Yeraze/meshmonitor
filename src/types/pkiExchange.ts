/**
 * Reliable PKI exchange state for one node on one source (#5691), as returned
 * by `GET /api/sources/:id/nodes/:nodeNum/pki-exchange`. Mirrors
 * `PkiExchangeStateResponse` in `src/server/routes/pkiExchangeStateRoutes.ts`.
 */
export type PkiExchangeDisplayState = 'successful' | 'pending' | 'failed' | 'unknown';

export type PkiExchangeFailureReason =
  | 'timeout' | 'max_retransmit' | 'pki_unknown_pubkey' | 'no_channel' | 'radio_refused';

export interface PkiExchangeState {
  state: PkiExchangeDisplayState;
  stateChangedAt: number;
  lastSuccessAt: number | null;
  failingSince: number | null;
  lastFailureReason: PkiExchangeFailureReason | null;
  lastPrimedAt: number | null;
  nextPrimingAllowedAt: number | null;
  mode: 'off' | 'asNeeded';
}
