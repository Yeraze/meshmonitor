/**
 * MeshCore Analyzer Observer — signing-key management + live publish status
 * (#4457 Phase 3 WP3).
 *
 * Mounted by MeshCoreConfigurationView (see the gate at ~L541): companion-only,
 * present regardless of connection state or configuration:write — this
 * component does its OWN configuration:read / configuration:write gating so
 * read-only users still see status while write-denied users get status only.
 *
 * Three independently-gated blocks:
 *   [A] Live publish status  — off useSourceStatuses; present only when the
 *       backend includes `observer` on GET /api/sources/:id/status. Absent
 *       means either the publisher isn't running/configured for this source
 *       or the caller lacks nodes:read — both silent, neither an error (D-6).
 *   [B] Signing-key status   — off useObserverKey; requires configuration:read.
 *   [C] Signing-key actions  — off useObserverKey; requires configuration:write.
 *
 * See docs/internal/dev-notes/MESHCORE_OBSERVER_PHASE3_SPEC.md §6/§7.
 */
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../../contexts/AuthContext';
import { useSourceStatuses } from '../../hooks/useDashboardData';
import { formatRelativeTime } from '../../utils/datetime';
import { UiIcon } from '../icons';
import { CollapsibleSection } from './CollapsibleSection';
import { useObserverKey, type ObserverKeyError, type ObserverKeyAction } from './hooks/useObserverKey';
import { useObserverCredentials } from './hooks/useObserverCredentials';
import { MeshCoreObserverBrokerPanel } from './MeshCoreObserverBrokerPanel';
import styles from './MeshCoreObserverSection.module.css';

interface MeshCoreObserverSectionProps {
  /** Source UUID. Required by the hook + status lookup — the caller's mount
   *  gate already guarantees this is present before rendering the section. */
  sourceId: string;
  /** Live device-link state. Gates ONLY the "Fetch from device" button —
   *  status/paste/clear all work while disconnected. */
  connected: boolean;
  /** advType off status.localNode. Companion-only gating already happens at
   *  the mount site (MeshCoreConfigurationView); kept on the props contract
   *  per spec §6 even though this component does not branch on it directly. */
  deviceType?: number;
}

/** Deliberately a narrow, LOCAL slice — not an import of a server-side type —
 *  since the status endpoint's payload crosses the client/server boundary as
 *  plain JSON (§1.4 pattern, mirrors MqttBridgeConfigurationView). */
interface ObserverSourceStatusSlice {
  observer?: {
    configured: boolean;
    /** #4595. Absent on a pre-4595 server — treated as unknown, not 'token'. */
    authMode?: 'token' | 'password';
    keyStored: boolean;
    connected: boolean;
    publishes: number;
    dropped: number;
    lastPublishAt: number | null;
    lastError: string | null;
    /** unix SECONDS — the ×1000 conversion happens at render time below. */
    tokenExpiresAt: number | null;
  };
}

/** Error-code → i18n mapping shared by the load path and every mutation
 *  (§7). Codes not in this table fall back to the server's own message. */
const ERROR_CODE_MAP: Record<string, { key: string; fallback: string }> = {
  SOURCE_NOT_CONNECTED: {
    key: 'meshcore.observer.err_not_connected',
    fallback: 'Not connected to the device. Connect the source, then fetch the key again.',
  },
  EXPORT_FAILED: {
    key: 'meshcore.observer.err_export_failed',
    fallback:
      'The device refused to export its key. Check that it is a Companion (not a repeater) and still connected, then retry.',
  },
  INVALID_KEY_LENGTH: {
    key: 'meshcore.observer.err_key_length',
    fallback: 'The key must be exactly 128 hex characters (64 bytes).',
  },
  INVALID_KEY_MATERIAL: {
    key: 'meshcore.observer.err_key_material',
    fallback: 'That is 128 hex characters, but not a valid MeshCore signing key.',
  },
  CREDENTIAL_PERSISTENCE_DISABLED: {
    key: 'meshcore.observer.err_no_persistence',
    fallback: 'MeshMonitor cannot store credentials — set a fixed SESSION_SECRET and restart.',
  },
  INVALID_PARAMETER_TYPE: {
    key: 'meshcore.observer.err_bad_request',
    fallback: 'The key could not be read from the request.',
  },
  SOURCE_NOT_FOUND: {
    key: 'meshcore.observer.err_source_missing',
    fallback: 'This source no longer exists.',
  },
  INVALID_PARAMETER: {
    key: 'meshcore.observer.err_not_meshcore',
    fallback: 'The Analyzer Observer applies to MeshCore sources only.',
  },
  INTERNAL_ERROR: {
    key: 'meshcore.observer.err_internal',
    fallback: 'Something went wrong on the server. Check the MeshMonitor logs.',
  },
};

/** Codes returned with a device-fault flavor on the IMPORT path only — the
 *  paste-path message ("that is 128 hex chars but...") assumes the user just
 *  typed it, which is wrong when the device supplied it (§7). */
const DEVICE_FAULT_CODES = new Set(['INVALID_KEY_LENGTH', 'INVALID_KEY_MATERIAL']);

type TFunc = (key: string, fallback: string, opts?: Record<string, unknown>) => string;

/**
 * Resolve one `ObserverKeyError` to display text. `action` is the mutation
 * that produced it (null for the initial GET) — used only to prefix the two
 * device-fault codes when they came back from the import path (§7).
 *
 * A `code: null` error covers two real shapes from the hook: an actual
 * transport failure (no body, `message: null`) and a non-JSON/uncoded error
 * response that still carried a message (e.g. the device rate limiter, which
 * replies `{error: '...', retryAfter: '1 minute'}` with no `code` field at
 * all). We can't distinguish these by HTTP status — the hook doesn't surface
 * it — so a present message is shown verbatim and only a truly empty one
 * falls back to the generic network-error copy.
 */
function describeObserverError(t: TFunc, error: ObserverKeyError, action: ObserverKeyAction | null): string {
  if (error.code === null) {
    if (error.message) return error.message;
    return t('meshcore.observer.err_network', 'Could not reach MeshMonitor. Check your connection and retry.');
  }
  const mapped = ERROR_CODE_MAP[error.code];
  if (!mapped) {
    return (
      error.message ??
      t('meshcore.observer.err_internal', 'Something went wrong on the server. Check the MeshMonitor logs.')
    );
  }
  const text = t(mapped.key, mapped.fallback);
  if (action === 'import' && DEVICE_FAULT_CODES.has(error.code)) {
    return `${t('meshcore.observer.err_from_device', 'The device returned an unusable key: ')}${text}`;
  }
  return text;
}

/** Client pre-check mirroring the server's 128-hex validation, applied to the
 *  trimmed, `0x`-stripped value for fast feedback (§6.2 [C]). The RAW draft is
 *  still what gets sent to `setManualKey` — the hook/server own the actual
 *  trim/strip, so this check exists purely to give fast UI feedback. */
function isPlausibleHexKey(raw: string): boolean {
  return /^[0-9a-fA-F]{128}$/.test(raw.trim().replace(/^0x/i, ''));
}

export const MeshCoreObserverSection: React.FC<MeshCoreObserverSectionProps> = ({ sourceId, connected }) => {
  const { t } = useTranslation();
  const { hasPermission } = useAuth();
  const canRead = hasPermission('configuration', 'read', { sourceId });
  const canWrite = hasPermission('configuration', 'write', { sourceId });

  const {
    status,
    loading,
    loadError,
    busy,
    actionError,
    importFromDevice,
    setManualKey,
    clearKey,
    clearActionError,
  } = useObserverKey(sourceId, { enabled: canRead });

  // Joins the dashboard's existing 15s-polling status query by key rather
  // than opening a second polling loop (§1.5 — same trick MqttBridgeConfigurationView uses).
  const statuses = useSourceStatuses([sourceId]);
  const observer = (statuses.get(sourceId) as ObserverSourceStatusSlice | null | undefined)?.observer;

  const creds = useObserverCredentials(sourceId, { enabled: canRead });

  const [manualOpen, setManualOpen] = useState(false);
  const [manualDraft, setManualDraft] = useState('');
  const [manualError, setManualError] = useState<string | null>(null);
  const [importedFlash, setImportedFlash] = useState(false);
  const [lastAction, setLastAction] = useState<ObserverKeyAction | null>(null);
  const [credUser, setCredUser] = useState('');
  const [credPass, setCredPass] = useState('');
  const [credFlash, setCredFlash] = useState(false);

  /**
   * Which auth mode's credential UI to show (#4595). The running publisher is
   * authoritative; with no publisher (source disconnected / observer off) a
   * stored username/password is the next best signal. When neither says
   * anything we show BOTH blocks rather than guessing — an operator setting up
   * password mode on a disconnected source must still be able to enter it.
   */
  const observerAuthMode: 'token' | 'password' | null =
    observer?.authMode ?? (creds.status?.stored ? 'password' : null);
  const showKeyBlock = observerAuthMode !== 'password';
  const showCredentialsBlock = observerAuthMode !== 'token';

  // Companion-only + sourceId presence is already enforced by the mount site;
  // this is the component's own permission gate (§6.2).
  if (!canRead) return null;

  const openManualPanel = () => {
    setManualDraft('');
    setManualError(null);
    clearActionError();
    setManualOpen(true);
  };

  const cancelManualPanel = () => {
    setManualOpen(false);
    setManualDraft('');
    setManualError(null);
  };

  const handleImport = async () => {
    setLastAction('import');
    const ok = await importFromDevice();
    if (ok) {
      setImportedFlash(true);
      setTimeout(() => setImportedFlash(false), 2500);
    }
  };

  const handleManualSave = async () => {
    setLastAction('manual');
    if (!isPlausibleHexKey(manualDraft)) {
      setManualError(
        t('meshcore.observer.manual_invalid_length', 'The key must be exactly 128 hex characters (64 bytes).'),
      );
      return;
    }
    setManualError(null);
    // Sent verbatim (not the pre-check's trimmed/stripped copy) — the hook
    // and server own the actual trim/0x-strip, keeping one source of truth.
    const ok = await setManualKey(manualDraft);
    if (ok) {
      cancelManualPanel();
    }
  };

  const handleClear = async () => {
    if (!status?.stored) return;
    const msg = t(
      'meshcore.observer.clear_confirm',
      'Forget the stored Analyzer Observer signing key? The observer will stop publishing until a new key is added.',
    );
    if (typeof window !== 'undefined' && !window.confirm(msg)) return;
    setLastAction('clear');
    await clearKey();
  };

  const handleCredentialsSave = async () => {
    const ok = await creds.saveCredentials(credUser, credPass);
    if (ok) {
      // Never keep the password in component state after it is stored.
      setCredPass('');
      setCredFlash(true);
      setTimeout(() => setCredFlash(false), 2500);
    }
  };

  const handleCredentialsClear = async () => {
    if (!creds.status?.stored) return;
    const msg = t(
      'meshcore.observer.credentials_clear_confirm',
      'Forget the stored broker username and password? The observer will stop publishing until you enter them again.',
    );
    if (typeof window !== 'undefined' && !window.confirm(msg)) return;
    await creds.clearCredentials();
    setCredUser('');
    setCredPass('');
  };

  const handleCopyPublicKey = async (pk: string) => {
    try {
      await navigator.clipboard.writeText(pk);
    } catch {
      window.prompt(t('meshcore.observer.copy_public_key', 'Copy public key'), pk);
    }
  };

  const publicKey = status?.publicKey ?? null;
  const truncatedPublicKey =
    publicKey && publicKey.length > 16 ? `${publicKey.slice(0, 8)}…${publicKey.slice(-8)}` : (publicKey ?? '');

  return (
    <CollapsibleSection title={t('meshcore.observer.title', 'Analyzer Observer')} className="form-section">
      <p className="hint">
        {t(
          'meshcore.observer.intro',
          "Publishes every packet this node hears to a MeshCore Analyzer MQTT broker. Configure the broker and its authentication mode on the source's edit form; manage the credentials here.",
        )}
      </p>

      {/* [A] Live publish status — absent means either not configured/running
          or the caller lacks nodes:read (D-6); both silent, neither an error. */}
      {observer && (
        <div className={styles.statusGrid}>
          <div className={styles.statusLabel}>{t('meshcore.observer.status_heading', 'Publisher status')}</div>
          <div className={styles.statusValue}>
            <UiIcon name={observer.connected ? 'statusOn' : 'statusOff'} size={14} />{' '}
            {observer.connected
              ? t('meshcore.observer.status_connected', 'Connected to broker')
              : t('meshcore.observer.status_disconnected', 'Not connected to broker')}
          </div>

          {!observer.configured && (
            <div
              className={`${styles.statusValue} ${styles.warning}`}
              role="alert"
              style={{ gridColumn: '1 / -1' }}
            >
              {t(
                'meshcore.observer.not_configured',
                'Enabled, but the broker URL, region, or audience is missing. Edit the source to complete it.',
              )}
            </div>
          )}

          {!observer.keyStored && (
            <div
              className={`${styles.statusValue} ${styles.warning}`}
              role="alert"
              style={{ gridColumn: '1 / -1' }}
            >
              {observer.authMode === 'password'
                ? t(
                    'meshcore.observer.no_credentials_running',
                    'No usable broker username/password — the publisher will not connect. Enter them below.',
                  )
                : t(
                    'meshcore.observer.no_key_running',
                    'No usable signing key — the publisher will not connect. Import or paste one below.',
                  )}
            </div>
          )}

          <div className={styles.statusLabel}>{t('meshcore.observer.published_count', 'Packets published')}</div>
          <div className={styles.statusValue}>{observer.publishes}</div>

          <div className={styles.statusLabel}>{t('meshcore.observer.dropped_count', 'Packets dropped')}</div>
          <div className={styles.statusValue}>
            {observer.dropped}
            {observer.dropped > 0 && (
              <span className={styles.hint}>
                {' '}
                {t('meshcore.observer.dropped_help', 'Packets heard while the broker socket was down.')}
              </span>
            )}
          </div>

          <div className={styles.statusLabel}>{t('meshcore.observer.last_publish', 'Last publish')}</div>
          <div className={styles.statusValue}>
            {observer.lastPublishAt ? formatRelativeTime(observer.lastPublishAt) : t('common.never', 'Never')}
          </div>

          {/* Static credentials never expire, so the row is meaningless in
              password mode (#4595) — hidden rather than shown as a dash. */}
          {observer.authMode !== 'password' && (
            <>
              <div className={styles.statusLabel}>{t('meshcore.observer.token_expires', 'Auth token expires')}</div>
              <div className={styles.statusValue}>
                {/* tokenExpiresAt is unix SECONDS — ×1000 here only; lastPublishAt
                    above is already milliseconds and must NOT be converted.
                    Rendered as an absolute local time: formatRelativeTime clamps
                    FUTURE timestamps to "just now", which reads wrong for a +24h
                    expiry (caught in Phase 3 browser validation). */}
                {observer.tokenExpiresAt ? new Date(observer.tokenExpiresAt * 1000).toLocaleString() : '—'}
              </div>
            </>
          )}

          {observer.lastError && (
            <div className={`${styles.statusValue} ${styles.error}`} role="alert" style={{ gridColumn: '1 / -1' }}>
              <UiIcon name="alert" size={14} /> {t('meshcore.observer.last_error', 'Last error')}: {observer.lastError}
            </div>
          )}
        </div>
      )}

      {/* Per-broker breakdown of the aggregate block above (#5014 Phase 2 WP3). */}
      <MeshCoreObserverBrokerPanel sourceId={sourceId} enabled={canRead} />

      {/* [B] Key status — token mode (or unknown mode) only. */}
      {showKeyBlock && (
      <div className={styles.section}>
        <h4>{t('meshcore.observer.key_heading', 'Signing key')}</h4>

        {loading && <p>{t('meshcore.observer.key_loading', 'Checking…')}</p>}

        {!loading && loadError && (
          <div className={styles.error} role="alert">
            {describeObserverError(t, loadError, null)}
          </div>
        )}

        {!loading && !loadError && status?.canStore === false && (
          <div className={styles.warning} role="alert">
            <p>
              {t('meshcore.observer.cannot_store', 'MeshMonitor cannot store the signing key: {{reason}}', {
                reason: status.reason ?? '',
              })}
            </p>
            <p>
              {t(
                'meshcore.observer.cannot_store_fix',
                'Set a fixed SESSION_SECRET and restart to enable observer key storage.',
              )}
            </p>
          </div>
        )}

        {!loading && !loadError && status?.canStore !== false && status?.stored === false && (
          <p>
            {t(
              'meshcore.observer.key_none',
              'No signing key stored. The observer cannot authenticate to the broker until you add one.',
            )}
          </p>
        )}

        {!loading && !loadError && status?.stored === true && (
          <div>
            <p>
              <span className={styles.pubkey} title={publicKey ?? ''}>
                {truncatedPublicKey}
              </span>{' '}
              <button
                type="button"
                className="btn-secondary"
                onClick={() => void handleCopyPublicKey(publicKey ?? '')}
              >
                <UiIcon name="copy" size={14} /> {t('meshcore.observer.copy_public_key', 'Copy public key')}
              </button>
            </p>
            <p className={styles.hint}>
              {t('meshcore.observer.public_key', 'Node public key')} —{' '}
              {t(
                'meshcore.observer.public_key_help',
                "This is the node's public key — safe to share. It is also the broker username and part of the topic path.",
              )}
            </p>
            <p className={styles.hint}>
              {status.origin === 'manual'
                ? t('meshcore.observer.origin_manual', 'Entered manually')
                : t('meshcore.observer.origin_device', 'Read from device')}
              {' · '}
              {t('meshcore.observer.key_updated', 'Stored')} {status.updatedAt ? formatRelativeTime(status.updatedAt) : ''}
            </p>
            {status.keyRotated && (
              <div className={styles.warning} role="alert">
                {t(
                  'meshcore.observer.key_rotated',
                  'The stored signing key can no longer be decrypted — SESSION_SECRET changed since it was saved. The observer will not connect until you re-import or re-paste the key. The public key above is still correct.',
                )}
              </div>
            )}
          </div>
        )}
      </div>
      )}

      {/* [C] Key actions — configuration:write only */}
      {showKeyBlock && canWrite && (
        <div className={styles.actions}>
          <button
            type="button"
            className="btn-secondary"
            onClick={() => void handleImport()}
            disabled={!connected || busy !== null || status?.canStore === false}
            title={
              !connected
                ? t(
                    'meshcore.observer.fetch_needs_connection',
                    'Connect to the device first — the key is read over the live link.',
                  )
                : undefined
            }
          >
            <UiIcon name="import" size={14} />{' '}
            {busy === 'import'
              ? t('meshcore.observer.fetching', 'Fetching…')
              : t('meshcore.observer.fetch_button', 'Fetch from device')}
          </button>
          {importedFlash && (
            <span style={{ color: 'var(--color-success)' }}>
              <UiIcon name="check" size={14} /> {t('meshcore.observer.key_imported', 'Key saved')}
            </span>
          )}

          <button
            type="button"
            className="btn-secondary"
            onClick={openManualPanel}
            disabled={busy !== null || status?.canStore === false}
          >
            <UiIcon name="key" size={14} /> {t('meshcore.observer.manual_button', 'Enter key manually')}
          </button>

          <button
            type="button"
            className="btn-secondary"
            style={{ color: 'var(--color-error)' }}
            onClick={() => void handleClear()}
            disabled={busy !== null || !status?.stored}
          >
            <UiIcon name="delete" size={14} />{' '}
            {busy === 'clear'
              ? t('meshcore.observer.clearing', 'Clearing…')
              : t('meshcore.observer.clear_button', 'Clear stored key')}
          </button>

          {manualOpen && (
            <div className={styles.panel}>
              <p>{t('meshcore.observer.manual_heading', "Paste the node's 128-character hex private key")}</p>
              <input
                type="password"
                autoComplete="off"
                value={manualDraft}
                onChange={(e) => setManualDraft(e.target.value)}
                placeholder={t('meshcore.observer.manual_placeholder', '128-character hex private key')}
                disabled={busy !== null}
              />
              {manualError && (
                <div role="alert" className={styles.error}>
                  {manualError}
                </div>
              )}
              <div>
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={cancelManualPanel}
                  disabled={busy !== null}
                >
                  {t('common.cancel', 'Cancel')}
                </button>
                <button
                  type="button"
                  className="btn-primary"
                  onClick={() => void handleManualSave()}
                  disabled={busy !== null || manualDraft.trim().length === 0}
                >
                  {busy === 'manual'
                    ? t('meshcore.observer.manual_saving', 'Saving…')
                    : t('meshcore.observer.manual_save', 'Save key')}
                </button>
              </div>
            </div>
          )}

          {actionError && (
            <div role="alert" className={styles.error}>
              {describeObserverError(t, actionError, lastAction)}
            </div>
          )}
        </div>
      )}

      {/* [D] Static broker credentials (#4595) — password mode (or unknown
          mode) only. The password is write-only: it is never returned by the
          API and is dropped from component state the moment it is saved. */}
      {showCredentialsBlock && (
        <div className={styles.section}>
          <h4>{t('meshcore.observer.credentials_heading', 'Broker username / password')}</h4>
          <p className={styles.hint}>
            {t(
              'meshcore.observer.credentials_intro',
              "For Analyzer brokers that use a fixed MQTT login instead of a signed token (e.g. meshcoretel.ru). Set the source's broker authentication to \"Username / password\" on its edit form to use these.",
            )}
          </p>

          {creds.loading && <p>{t('meshcore.observer.key_loading', 'Checking…')}</p>}

          {!creds.loading && creds.loadError && (
            <div className={styles.error} role="alert">
              {describeObserverError(t, creds.loadError, null)}
            </div>
          )}

          {!creds.loading && !creds.loadError && creds.status?.canStore === false && (
            <div className={styles.warning} role="alert">
              <p>
                {t('meshcore.observer.credentials_cannot_store', 'MeshMonitor cannot store the broker password: {{reason}}', {
                  reason: creds.status.reason ?? '',
                })}
              </p>
            </div>
          )}

          {!creds.loading && !creds.loadError && creds.status?.stored === true && (
            <>
              <p className={styles.hint}>
                {t('meshcore.observer.credentials_stored', 'Stored for user {{username}}', {
                  username: creds.status.username ?? '',
                })}
                {' · '}
                {creds.status.updatedAt ? formatRelativeTime(creds.status.updatedAt) : ''}
              </p>
              {creds.status.keyRotated && (
                <div className={styles.warning} role="alert">
                  {t(
                    'meshcore.observer.credentials_rotated',
                    'The stored broker password can no longer be decrypted — SESSION_SECRET changed since it was saved. Re-enter it below.',
                  )}
                </div>
              )}
            </>
          )}

          {!creds.loading && !creds.loadError && creds.status?.stored === false && (
            <p>
              {t(
                'meshcore.observer.credentials_none',
                'No broker username/password stored. The observer cannot authenticate in this mode until you add them.',
              )}
            </p>
          )}

          {canWrite && (
            <div className={styles.actions}>
              <label>
                {t('meshcore.observer.credentials_username', 'Broker username')}
                <input
                  type="text"
                  autoComplete="off"
                  value={credUser}
                  onChange={(e) => setCredUser(e.target.value)}
                  placeholder={creds.status?.username ?? 'meshcore'}
                  disabled={creds.busy !== null || creds.status?.canStore === false}
                />
              </label>
              <label>
                {t('meshcore.observer.credentials_password', 'Broker password')}
                <input
                  type="password"
                  autoComplete="new-password"
                  value={credPass}
                  onChange={(e) => setCredPass(e.target.value)}
                  placeholder={t('meshcore.observer.credentials_password_placeholder', 'Broker password')}
                  disabled={creds.busy !== null || creds.status?.canStore === false}
                />
              </label>
              <button
                type="button"
                className="btn-primary"
                onClick={() => void handleCredentialsSave()}
                disabled={
                  creds.busy !== null ||
                  creds.status?.canStore === false ||
                  credUser.trim().length === 0 ||
                  credPass.length === 0
                }
              >
                {creds.busy === 'save'
                  ? t('meshcore.observer.manual_saving', 'Saving…')
                  : t('meshcore.observer.credentials_save', 'Save credentials')}
              </button>
              {credFlash && (
                <span style={{ color: 'var(--color-success)' }}>
                  <UiIcon name="check" size={14} /> {t('meshcore.observer.credentials_saved', 'Credentials saved')}
                </span>
              )}
              <button
                type="button"
                className="btn-secondary"
                style={{ color: 'var(--color-error)' }}
                onClick={() => void handleCredentialsClear()}
                disabled={creds.busy !== null || !creds.status?.stored}
              >
                <UiIcon name="delete" size={14} />{' '}
                {creds.busy === 'clear'
                  ? t('meshcore.observer.clearing', 'Clearing…')
                  : t('meshcore.observer.credentials_clear', 'Clear stored credentials')}
              </button>

              {creds.actionError && (
                <div role="alert" className={styles.error}>
                  {describeObserverError(t, creds.actionError, null)}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </CollapsibleSection>
  );
};
