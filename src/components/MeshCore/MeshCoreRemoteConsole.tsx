/**
 * MeshCoreRemoteConsole
 *
 * Interactive remote-administration console for a single MeshCore contact
 * (Repeater or Room Server). Renders inside MeshCoreContactDetailPanel
 * when the selected contact's advType warrants it.
 *
 * Wire model — see docs/internal/dev-notes/ARCHITECTURE_LESSONS.md and the
 * meshcoreCredentialStore service for the full design. In short:
 *   - "Login" sends CMD_SEND_LOGIN with the user-supplied password. The
 *     server may also persist that password (AES-256-GCM, see
 *     MeshCoreCredentialStore) when `rememberPassword=true` and
 *     SESSION_SECRET is explicitly configured.
 *   - "Send" issues a CLI command as an encrypted DM with txtType=CliData
 *     and shows the single-packet reply in the transcript.
 *   - A KEY_ROTATED banner appears when this contact has a stored
 *     credential that no longer decrypts under the current SESSION_SECRET.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { MeshCoreActions } from './hooks/useMeshCore';
import './MeshCoreRemoteConsole.css';

interface TranscriptEntry {
  id: string;
  kind: 'sent' | 'reply' | 'error' | 'info';
  text: string;
  ts: number;
}

interface CapabilitySnapshot {
  canRemember: boolean;
  reason?: string;
  rotatedCount: number;
  rotated: Array<{ publicKey: string; name: string | null }>;
}

interface MeshCoreRemoteConsoleProps {
  /** Full 64-char hex public key of the target contact. */
  publicKey: string;
  /** Display name (for log lines). */
  contactName: string;
  /** Action callbacks from useMeshCore. We pull only the four we need so
   *  this component is easy to host in tests without a full hook. */
  actions: Pick<
    MeshCoreActions,
    'loginRemote' | 'sendCliCommand' | 'getRemoteAdminCapability' | 'forgetRemoteCredential'
  >;
}

const nextId = (() => {
  let counter = 0;
  return () => `${Date.now()}-${counter++}`;
})();

export const MeshCoreRemoteConsole: React.FC<MeshCoreRemoteConsoleProps> = ({
  publicKey,
  contactName,
  actions,
}) => {
  const { t } = useTranslation();
  const [capability, setCapability] = useState<CapabilitySnapshot | null>(null);
  const [loggedIn, setLoggedIn] = useState(false);
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([]);
  const [command, setCommand] = useState('');
  const [sending, setSending] = useState(false);
  const [showLogin, setShowLogin] = useState(false);
  const [loginPassword, setLoginPassword] = useState('');
  const [rememberPassword, setRememberPassword] = useState(false);
  const [loginBusy, setLoginBusy] = useState(false);
  const [loginError, setLoginError] = useState<string | null>(null);

  const transcriptEndRef = useRef<HTMLDivElement | null>(null);

  // Auto-scroll the transcript when new entries arrive.
  useEffect(() => {
    transcriptEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [transcript]);

  // Reset state whenever the targeted contact changes — a stale "logged
  // in" badge against the wrong contact would be actively misleading.
  useEffect(() => {
    setLoggedIn(false);
    setTranscript([]);
    setCommand('');
    setShowLogin(false);
    setLoginPassword('');
    setRememberPassword(false);
    setLoginError(null);
  }, [publicKey]);

  const refreshCapability = useCallback(async () => {
    const cap = await actions.getRemoteAdminCapability();
    setCapability(cap);
  }, [actions]);

  useEffect(() => {
    void refreshCapability();
  }, [refreshCapability]);

  const appendTranscript = useCallback((entry: Omit<TranscriptEntry, 'id' | 'ts'>) => {
    setTranscript((prev) => [
      ...prev,
      { id: nextId(), ts: Date.now(), ...entry },
    ]);
  }, []);

  const isRotatedForThisContact =
    capability?.rotated.some((r) => r.publicKey.toLowerCase() === publicKey.toLowerCase()) ?? false;

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
    appendTranscript({
      kind: 'info',
      text: result.persisted
        ? t('meshcore.remoteConsole.login_success_persisted', 'Logged in — password saved on this server')
        : t('meshcore.remoteConsole.login_success', 'Logged in'),
    });
    // Re-pull capability so the rotated list reflects any new persistence.
    void refreshCapability();
  }, [actions, appendTranscript, loginPassword, publicKey, refreshCapability, rememberPassword, t]);

  const handleSend = useCallback(async () => {
    const trimmed = command.trim();
    if (!trimmed || sending) return;
    setSending(true);
    appendTranscript({ kind: 'sent', text: trimmed });
    setCommand('');
    const result = await actions.sendCliCommand(publicKey, trimmed);
    setSending(false);
    if (result.ok) {
      appendTranscript({ kind: 'reply', text: result.reply || '(empty reply)' });
    } else {
      // 401-shaped responses can indicate session eviction on the remote
      // (the ACL slot was reused or the device rebooted). Hint that.
      const hint =
        result.code === 'CLI_TIMEOUT'
          ? t(
              'meshcore.remoteConsole.timeout_hint',
              ' — the remote did not reply. Path may be stale, or the admin session may have expired.',
            )
          : '';
      appendTranscript({ kind: 'error', text: `${result.error}${hint}` });
    }
  }, [actions, appendTranscript, command, publicKey, sending, t]);

  const handleForgetCredential = useCallback(async () => {
    const ok = await actions.forgetRemoteCredential(publicKey);
    appendTranscript({
      kind: 'info',
      text: ok
        ? t('meshcore.remoteConsole.credential_forgotten', 'Stored password forgotten')
        : t('meshcore.remoteConsole.credential_forget_failed', 'Failed to forget stored password'),
    });
    void refreshCapability();
  }, [actions, appendTranscript, publicKey, refreshCapability, t]);

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
          {t(
            'meshcore.remoteConsole.persistence_disabled_hint',
            'Saving passwords is disabled. ',
          )}
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

      <div className="mrc-transcript" role="log" aria-live="polite">
        {transcript.length === 0 ? (
          <p className="mrc-transcript-empty">
            {loggedIn
              ? t('meshcore.remoteConsole.empty_logged_in', 'Type a command below and press Send.')
              : t('meshcore.remoteConsole.empty_logged_out', 'Log in to begin sending commands.')}
          </p>
        ) : (
          transcript.map((entry) => (
            <div key={entry.id} className={`mrc-line mrc-line-${entry.kind}`}>
              <span className="mrc-line-prefix">{prefixFor(entry.kind)}</span>
              <pre className="mrc-line-text">{entry.text}</pre>
            </div>
          ))
        )}
        <div ref={transcriptEndRef} />
      </div>

      <form
        className="mrc-input-row"
        onSubmit={(e) => {
          e.preventDefault();
          void handleSend();
        }}
      >
        <input
          type="text"
          value={command}
          onChange={(e) => setCommand(e.target.value)}
          placeholder={
            loggedIn
              ? t('meshcore.remoteConsole.command_placeholder', 'Type a command (e.g. ver, stats, neighbors)')
              : t('meshcore.remoteConsole.command_placeholder_logged_out', 'Log in first')
          }
          disabled={!loggedIn || sending}
          className="mrc-input"
          spellCheck={false}
          autoComplete="off"
        />
        <button
          type="submit"
          disabled={!loggedIn || sending || command.trim().length === 0}
          className="mrc-btn-primary"
        >
          {sending
            ? t('meshcore.remoteConsole.sending', 'Sending…')
            : t('meshcore.remoteConsole.send', 'Send')}
        </button>
      </form>

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

function prefixFor(kind: TranscriptEntry['kind']): string {
  switch (kind) {
    case 'sent': return '>';
    case 'reply': return '<';
    case 'error': return '!';
    case 'info': return '*';
  }
}
