/**
 * Shared passkey sign-in logic for LoginPage and LoginModal (#5841).
 */
import { useEffect, useRef } from 'react';
import type { TFunction } from 'i18next';
import { ApiError } from '../services/api';
import {
  cancelPasskeyCeremony,
  isPasskeyCancel,
  passkeyAutofillSupported,
} from '../services/passkeyClient';
import { logger } from '../utils/logger';

/**
 * The message to show for a failed passkey sign-in, or null when the user
 * simply closed the browser's prompt.
 */
export function passkeyLoginErrorMessage(err: unknown, t: TFunction): string | null {
  if (isPasskeyCancel(err)) return null;
  if (err instanceof ApiError && err.status === 429) {
    const minutes = err.retryAfterSeconds ? Math.max(1, Math.ceil(err.retryAfterSeconds / 60)) : null;
    return minutes !== null ? t('auth.rate_limited', { minutes }) : t('auth.rate_limited_generic');
  }
  if (err instanceof ApiError && err.status === 403 && err.code?.startsWith('CSRF_')) {
    return t('auth.session_expired');
  }
  return t('passkey.login_failed');
}

/**
 * Conditional UI: while `enabled`, let the browser offer saved passkeys in the
 * username field's autofill list (the field needs `autocomplete="username
 * webauthn"`). Does nothing where the browser lacks support. The wait stops
 * when `enabled` turns false or the component unmounts.
 */
export function usePasskeyAutofill(
  enabled: boolean,
  loginWithPasskey: (opts?: { autofill?: boolean }) => Promise<void>,
  onError: (err: unknown) => void,
): void {
  const loginRef = useRef(loginWithPasskey);
  const errorRef = useRef(onError);
  loginRef.current = loginWithPasskey;
  errorRef.current = onError;

  useEffect(() => {
    if (!enabled) return;
    let stopped = false;
    void (async () => {
      if (!(await passkeyAutofillSupported()) || stopped) return;
      try {
        await loginRef.current({ autofill: true });
      } catch (err) {
        if (stopped || isPasskeyCancel(err)) return;
        logger.debug('Passkey autofill sign-in failed:', err);
        errorRef.current(err);
      }
    })();
    return () => {
      stopped = true;
      void cancelPasskeyCeremony();
    };
  }, [enabled]);
}
