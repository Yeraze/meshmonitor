/**
 * The passkey-only switch (#5841, spec §8). Turning password sign-in off
 * runs a fresh passkey prompt (D6), asks the only admin to type DISABLE
 * (D3), then shows the recovery codes once (D2). Turning it back on needs
 * only the session.
 */
import React, { useCallback, useContext, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useToast } from './ToastContainer';
import { UiIcon } from './icons';
import { logger } from '../utils/logger';
import { ApiError } from '../services/api';
import { AuthContext } from '../contexts/AuthContext';
import {
  LAST_ADMIN_CONFIRM,
  getPasswordLoginState,
  isPasskeyCancel,
  runStepUp,
  turnOffPasswordLogin,
  turnOnPasswordLogin,
  type PasswordLoginState,
} from '../services/passkeyClient';
import type { AuthenticationResponseJSON } from '@simplewebauthn/browser';
import RecoveryCodesDialog from './RecoveryCodesDialog';
import styles from './PasskeyManagement.module.css';

interface PasswordLoginControlProps {
  /** How many passkeys the user has; off needs at least one. */
  passkeyCount: number;
  /** False when the browser cannot run a passkey prompt. */
  supported: boolean;
}

type Step = 'idle' | 'explain' | 'confirm';

const PasswordLoginControl: React.FC<PasswordLoginControlProps> = ({ passkeyCount, supported }) => {
  const { t } = useTranslation();
  const { showToast } = useToast();
  // Optional: lets the user menu drop "Change Password" once the switch flips.
  const auth = useContext(AuthContext);

  const [state, setState] = useState<PasswordLoginState | null>(null);
  const [step, setStep] = useState<Step>('idle');
  const [busy, setBusy] = useState(false);
  const [assertion, setAssertion] = useState<AuthenticationResponseJSON | null>(null);
  const [typed, setTyped] = useState('');
  const [codes, setCodes] = useState<string[] | null>(null);

  const load = useCallback(async () => {
    try {
      setState(await getPasswordLoginState());
    } catch (err) {
      logger.error('Failed to load password sign-in state:', err);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const reset = () => {
    setStep('idle');
    setAssertion(null);
    setTyped('');
  };

  const showError = (err: unknown) => {
    const code = err instanceof ApiError ? err.code : undefined;
    const key =
      code === 'STEP_UP_FAILED' ? 'passkey_only.step_up_failed'
      : code === 'PASSKEY_CHALLENGE_EXPIRED' ? 'passkey_only.expired'
      : code === 'NO_PASSKEYS' ? 'passkey_only.need_passkey'
      : 'passkey_only.turn_off_failed';
    showToast(t(key), 'error');
  };

  const finishOff = async (signed: AuthenticationResponseJSON, confirm?: string) => {
    const result = await turnOffPasswordLogin(signed, confirm);
    if ('requireConfirm' in result) {
      setAssertion(signed);
      setStep('confirm');
      return;
    }
    if (result.disabled) {
      reset();
      setCodes(result.recoveryCodes);
    }
  };

  const handleContinue = async () => {
    setBusy(true);
    try {
      const signed = await runStepUp();
      await finishOff(signed);
    } catch (err) {
      if (!isPasskeyCancel(err)) {
        logger.error('Turning off password sign-in failed:', err);
        showError(err);
        reset();
      }
    } finally {
      setBusy(false);
    }
  };

  const handleConfirm = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!assertion || typed !== LAST_ADMIN_CONFIRM) return;
    setBusy(true);
    try {
      await finishOff(assertion, LAST_ADMIN_CONFIRM);
    } catch (err) {
      logger.error('Turning off password sign-in failed:', err);
      showError(err);
      reset();
    } finally {
      setBusy(false);
    }
  };

  const handleTurnOn = async () => {
    setBusy(true);
    try {
      await turnOnPasswordLogin();
      showToast(t('passkey_only.turned_on'), 'success');
      await load();
      void auth?.refreshAuth();
    } catch (err) {
      logger.error('Turning on password sign-in failed:', err);
      showToast(t('passkey_only.turn_on_failed'), 'error');
    } finally {
      setBusy(false);
    }
  };

  const handleCodesClosed = () => {
    setCodes(null);
    showToast(t('passkey_only.turned_off'), 'success');
    void load();
    void auth?.refreshAuth();
  };

  if (!state) return null;

  return (
    <div className={styles.switchBox} data-testid="password-login-control">
      <h4 className={styles.subheading}>
        <UiIcon name="security" size={16} />
        {t('passkey_only.title')}
      </h4>

      {state.disabled ? (
        <>
          <p className={styles.description}>
            {t('passkey_only.is_off', { count: state.recoveryCodesLeft })}
          </p>
          <button type="button" className="button" onClick={handleTurnOn} disabled={busy}>
            {t('passkey_only.turn_on')}
          </button>
        </>
      ) : step === 'idle' ? (
        <>
          <p className={styles.description}>{t('passkey_only.is_on')}</p>
          {passkeyCount === 0 && <p className={styles.muted}>{t('passkey_only.need_passkey')}</p>}
          <button
            type="button"
            className="button"
            onClick={() => setStep('explain')}
            disabled={busy || passkeyCount === 0 || !supported}
          >
            {t('passkey_only.turn_off')}
          </button>
        </>
      ) : step === 'explain' ? (
        <>
          <ul className={styles.explainList}>
            <li>{t('passkey_only.explain_password')}</li>
            <li>{t('passkey_only.explain_prompt')}</li>
            <li>{t('passkey_only.explain_codes')}</li>
          </ul>
          <div className={styles.actions}>
            <button type="button" className={`button ${styles.danger}`} onClick={handleContinue} disabled={busy}>
              {busy ? t('passkey.signing_in') : t('passkey_only.continue')}
            </button>
            <button type="button" className="button" onClick={reset} disabled={busy}>
              {t('common.cancel')}
            </button>
          </div>
        </>
      ) : (
        <form className={styles.warning} onSubmit={handleConfirm}>
          <p className={styles.warningText}>
            <UiIcon name="alert" size={16} />
            {t('passkey_only.last_admin_warning')}
          </p>
          <label className={styles.confirmLabel}>
            {t('passkey_only.last_admin_type', { word: LAST_ADMIN_CONFIRM })}
            <input
              type="text"
              value={typed}
              onChange={e => setTyped(e.target.value)}
              autoComplete="off"
              autoCapitalize="characters"
              disabled={busy}
              autoFocus
            />
          </label>
          <div className={styles.actions}>
            <button
              type="submit"
              className={`button ${styles.danger}`}
              disabled={busy || typed !== LAST_ADMIN_CONFIRM}
            >
              {t('passkey_only.confirm_off')}
            </button>
            <button type="button" className="button" onClick={reset} disabled={busy}>
              {t('common.cancel')}
            </button>
          </div>
        </form>
      )}

      {codes && (
        <RecoveryCodesDialog
          codes={codes}
          username={auth?.authStatus?.user?.username ?? ''}
          onClose={handleCodesClosed}
        />
      )}
    </div>
  );
};

export default PasswordLoginControl;
