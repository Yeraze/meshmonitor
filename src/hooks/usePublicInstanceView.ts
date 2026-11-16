import { useContext } from 'react';
import { AuthContext } from '../contexts/authContextObject.js';

export interface PublicInstanceView {
  /** True for a signed-out viewer of an instance with public-instance mode on. */
  active: boolean;
  hideLongNames: boolean;
  hidePublicKeys: boolean;
  /** Times are floored to the hour. */
  coarseTime: boolean;
  hideMessageText: boolean;
}

const INACTIVE: PublicInstanceView = {
  active: false,
  hideLongNames: false,
  hidePublicKeys: false,
  coarseTime: false,
  hideMessageText: false,
};

/**
 * What the current viewer is not shown (#5156). Reads the context directly so
 * it is inactive, not an error, outside an AuthProvider.
 */
export function usePublicInstanceView(): PublicInstanceView {
  const status = useContext(AuthContext)?.authStatus;
  const cfg = status?.publicInstance;
  if (!status || status.authenticated !== false || !cfg?.enabled) return INACTIVE;
  return {
    active: true,
    hideLongNames: cfg.hideLongNames,
    hidePublicKeys: cfg.hidePublicKeys,
    coarseTime: cfg.roundTimestamps,
    hideMessageText: cfg.hideMessageText,
  };
}
