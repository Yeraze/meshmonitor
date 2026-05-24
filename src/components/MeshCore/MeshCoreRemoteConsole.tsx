/**
 * MeshCoreRemoteConsole
 *
 * Interactive remote-administration console for a single MeshCore contact
 * (Repeater or Room Server). Mounted by MeshCoreContactDetailPanel when
 * the user has `remote_admin:write` on the source.
 *
 * Responsibilities owned here (vs. CliConsoleBody, the shared primitive):
 *  - Login modal (manual login + "remember password" checkbox).
 *  - Capability fetch — disables remember when SESSION_SECRET is auto-
 *    generated.
 *  - Auto-login on mount when a non-rotated stored credential exists.
 *  - KEY_ROTATED banner + "Forget stored password" action.
 *  - Stats panel mounting (only once logged in).
 *
 * Wire model: see meshcoreCredentialStore + POST /admin/login-with-saved
 * for the security invariant that the saved plaintext password never
 * leaves the server process.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { MeshCoreActions } from './hooks/useMeshCore';
import { MeshCoreRemoteStatsPanel } from './MeshCoreRemoteStatsPanel';
import { CliConsoleBody, type ActionCommand, type CliConsoleBodyHandle } from './CliConsoleBody';
import './MeshCoreRemoteConsole.css';

/**
 * Quick-action catalog for remote Repeater / Room Server contacts.
 * Clicking a button pre-fills the command input — it does NOT auto-send,
 * so the user can edit before pressing Send and danger commands route
 * through the typed-name confirmation modal naturally.
 */
const REMOTE_ACTION_CATALOG: ActionCommand[] = [
  { key: 'ver',       labelKey: 'meshcore.remoteConsole.action.ver',       defaultLabel: 'Version',  command: 'ver' },
  { key: 'stats',     labelKey: 'meshcore.remoteConsole.action.stats',     defaultLabel: 'Stats',    command: 'stats' },
  { key: 'neighbors', labelKey: 'meshcore.remoteConsole.action.neighbors', defaultLabel: 'Neighbors', command: 'neighbors' },
  { key: 'clock',     labelKey: 'meshcore.remoteConsole.action.clock',     defaultLabel: 'Clock',    command: 'clock' },
  { key: 'clock_sync', labelKey: 'meshcore.remoteConsole.action.clock_sync', defaultLabel: 'Sync clock', command: 'clock sync' },
  { key: 'advert',    labelKey: 'meshcore.remoteConsole.action.advert',    defaultLabel: 'Send advert', command: 'advert' },
  { key: 'reboot',    labelKey: 'meshcore.remoteConsole.action.reboot',    defaultLabel: 'Reboot',   command: 'reboot', danger: true },
];

interface CapabilitySnapshot {
  canRemember: boolean;
  reason?: string;
  rotatedCount: number;
  rotated: Array<{ publicKey: string; name: string | null }>;
  stored: Array<{ publicKey: string; name: string | null }>;
}

interface MeshCoreRemoteConsoleProps {
  /** Full 64-char hex public key of the target contact. */
  publicKey: string;
  /** Display name (for log lines and the danger-confirm modal). */
  contactName: string;
  actions: Pick<
    MeshCoreActions,
    | 'loginRemote'
    | 'loginRemoteWithSaved'
    | 'sendCliCommand'
    | 'getRemoteAdminCapability'
    | 'forgetRemoteCredential'
    | 'getRemoteStatus'
  >;
}

export const MeshCoreRemoteConsole: React.FC<MeshCoreRemoteConsoleProps> = ({
  publicKey,
  contactName,
  actions,
}) => {
  const { t } = useTranslation();
  const [capability, setCapability] = useState<CapabilitySnapshot | null>(null);
  const [loggedIn, setLoggedIn] = useState(false);
  const [showLogin, setShowLogin] = useState(false);
  const [loginPassword, setLoginPassword] = useState('');
  const [rememberPassword, setRememberPassword] = useState(false);
  const [loginBusy, setLoginBusy] = useState(false);
  const [loginError, setLoginError] = useState<string | null>(null);

  // Imperative handle into the body — used to push "Logged in" info
  // lines into the transcript without lifting transcript state.
  const bodyRef = useRef<CliConsoleBodyHandle | null>(null);

  // Reset auth state when the targeted contact changes — a stale "logged
  // in" badge against the wrong contact would be actively misleading.
  useEffect(() => {
    setLoggedIn(false);
    setShowLogin(false);
    setLoginPassword('');
    setRememberPassword(false);
    setLoginError(null);
  }, [publicKey]);

  const refreshCapability = useCallback(async () => {
    const cap = await actions.getRemoteAdminCapability();
    setCapability(cap);
    return cap;
  }, [actions]);

  // On mount (and on contact change): fetch capability, and if this
  // contact has a non-rotated stored credential, silently attempt
  // auto-login. The plaintext password stays server-side throughout.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const cap = await refreshCapability();
      if (cancelled || !cap) return;
      const target = publicKey.toLowerCase();
      const isStored = cap.stored?.some((s) => s.publicKey.toLowerCase() === target);
      const isRotated = cap.rotated?.some((r) => r.publicKey.toLowerCase() === target);
      if (!isStored || isRotated) return;
      const result = await actions.loginRemoteWithSaved(publicKey);
      if (cancelled) return;
      if (result.success) {
        setLoggedIn(true);
        bodyRef.current?.appendInfo(
          t('meshcore.remoteConsole.auto_login_success', 'Logged in with saved password'),
        );
      } else if (result.code === 'CREDENTIAL_KEY_ROTATED') {
        void refreshCapability();
      }
      // NO_STORED_CREDENTIAL / STORED_CREDENTIAL_REJECTED → silently fall
      // through to the manual login modal.
    })();
    return () => {
      cancelled = true;
    };
  }, [publicKey, actions, refreshCapability, t]);

  const handleLogin = useCallback(async () => {
    setLoginBusy(true);
    setLoginError(null);
    const result = await actions.loginRemote(publicKey, loginPassword, rememberPassword);
    setLoginBusy(false);
    if (!result.success) {
      setLoginError(
        result.code === 'CREDENTIAL_PERSISTENCE_DISABLED'
          ? result.reason || result.error || t('meshcore.remoteConsole.persistence_disabled', 'Saving credentials is disabled')
          : result.error || t('meshcore.remoteConsole.login_failed', 'Login failed'),
      );
      return;
    }
    setLoggedIn(true);
    setShowLogin(false);
    setLoginPassword('');
    bodyRef.current?.appendInfo(
      result.persisted
        ? t('meshcore.remoteConsole.login_success_persisted', 'Logged in — password saved on this server')
        : t('meshcore.remoteConsole.login_success', 'Logged in'),
    );
    void refreshCapability();
  }, [actions, loginPassword, publicKey, refreshCapability, rememberPassword, t]);

  const handleForgetCredential = useCallback(async () => {
    const ok = await actions.forgetRemoteCredential(publicKey);
    bodyRef.current?.appendInfo(
      ok
        ? t('meshcore.remoteConsole.credential_forgotten', 'Stored password forgotten')
        : t('meshcore.remoteConsole.credential_forget_failed', 'Failed to forget stored password'),
    );
    void refreshCapability();
  }, [actions, publicKey, refreshCapability, t]);

  const isRotatedForThisContact =
    capability?.rotated.some((r) => r.publicKey.toLowerCase() === publicKey.toLowerCase()) ?? false;

  const runCommand = useCallback(
    (text: string, opts?: { confirm?: boolean }) => actions.sendCliCommand(publicKey, text, opts),
    [actions, publicKey],
  );

  return (
    <section className="meshcore-remote-console" aria-label={t('meshcore.remoteConsole.title', 'Remote administration')}>
      <header className="mrc-header">
        <h3 className="mrc-title">
          {t('meshcore.remoteConsole.title', 'Remote administration')}
        </h3>
        <div className="mrc-status">
          {loggedIn ? (
            <span className="mrc-status-chip mrc-status-ok">
              {t('meshcore.remoteConsole.session_active', 'Session active')}
            </span>
          ) : (
            <span className="mrc-status-chip mrc-status-idle">
              {t('meshcore.remoteConsole.not_logged_in', 'Not logged in')}
            </span>
          )}
        </div>
      </header>

      {isRotatedForThisContact && (
        <div className="mrc-banner mrc-banner-warn" role="status">
          <strong>{t('meshcore.remoteConsole.rotated_banner_title', 'Saved password unreadable')}</strong>
          <p>
            {t(
              'meshcore.remoteConsole.rotated_banner_body',
              'The saved password for this node was encrypted with a previous SESSION_SECRET and can no longer be decrypted. Re-enter the password to continue, or forget the stored copy.',
            )}
          </p>
          <button type="button" className="mrc-link-btn" onClick={handleForgetCredential}>
            {t('meshcore.remoteConsole.forget_credential', 'Forget stored password')}
          </button>
        </div>
      )}

      {capability && !capability.canRemember && (
        <div className="mrc-banner mrc-banner-info" role="status">
          {t('meshcore.remoteConsole.persistence_disabled_hint', 'Saving passwords is disabled. ')}
          <span className="mrc-muted">{capability.reason}</span>
        </div>
      )}

      <div className="mrc-actions">
        {!loggedIn ? (
          <button type="button" className="mrc-btn-primary" onClick={() => setShowLogin(true)}>
            {t('meshcore.remoteConsole.login_button', 'Log in to {{name}}', { name: contactName })}
          </button>
        ) : (
          <button type="button" className="mrc-btn-secondary" onClick={handleForgetCredential}>
            {t('meshcore.remoteConsole.forget_credential', 'Forget stored password')}
          </button>
        )}
      </div>

      {loggedIn && (
        <MeshCoreRemoteStatsPanel
          publicKey={publicKey}
          fetchStatus={actions.getRemoteStatus}
        />
      )}

      <CliConsoleBody
        ref={bodyRef}
        targetId={publicKey}
        targetName={contactName}
        runCommand={runCommand}
        actionCatalog={loggedIn ? REMOTE_ACTION_CATALOG : []}
        disabled={!loggedIn}
      />

      {showLogin && (
        <div
          className="mrc-modal-backdrop"
          role="dialog"
          aria-modal="true"
          aria-labelledby="mrc-login-title"
          onClick={() => !loginBusy && setShowLogin(false)}
        >
          <div className="mrc-modal" onClick={(e) => e.stopPropagation()}>
            <h4 id="mrc-login-title">
              {t('meshcore.remoteConsole.login_modal_title', 'Log in to {{name}}', { name: contactName })}
            </h4>
            <label className="mrc-modal-label">
              {t('meshcore.remoteConsole.password_label', 'Password')}
              <input
                type="password"
                value={loginPassword}
                onChange={(e) => setLoginPassword(e.target.value)}
                autoFocus
                disabled={loginBusy}
                className="mrc-input"
              />
            </label>
            <p className="mrc-modal-hint">
              {t(
                'meshcore.remoteConsole.password_hint',
                'Leave blank for guest access. Admin commands require the node’s configured admin password.',
              )}
            </p>
            <label
              className={`mrc-modal-checkbox${capability && !capability.canRemember ? ' mrc-disabled' : ''}`}
              title={capability && !capability.canRemember ? capability.reason : undefined}
            >
              <input
                type="checkbox"
                checked={rememberPassword}
                disabled={!capability?.canRemember || loginBusy}
                onChange={(e) => setRememberPassword(e.target.checked)}
              />
              {t('meshcore.remoteConsole.remember_password', 'Remember this password on the server')}
            </label>
            {loginError && <div className="mrc-modal-error">{loginError}</div>}
            <div className="mrc-modal-actions">
              <button
                type="button"
                className="mrc-btn-secondary"
                onClick={() => setShowLogin(false)}
                disabled={loginBusy}
              >
                {t('meshcore.remoteConsole.cancel', 'Cancel')}
              </button>
              <button
                type="button"
                className="mrc-btn-primary"
                onClick={() => void handleLogin()}
                disabled={loginBusy}
              >
                {loginBusy
                  ? t('meshcore.remoteConsole.logging_in', 'Logging in…')
                  : t('meshcore.remoteConsole.login_confirm', 'Log in')}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
};
