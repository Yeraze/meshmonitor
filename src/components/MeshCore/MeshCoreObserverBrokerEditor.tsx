/**
 * The Analyzer Observer's editable broker list (#5831): region, one card per
 * broker (URL, label, auth mode, token audience), and the preset chips that
 * add a broker. Moved here from the Dashboard source modal.
 *
 * Controlled: every change goes to `useObserverConfigDraft`, which holds the
 * draft and saves it through the SaveBar. Nothing here talks to the server.
 * Removing a broker asks first, because its stored login goes unused once the
 * broker is gone.
 *
 * Owner claims (#6454): a source-level owner key and email, plus a per-broker
 * override on each token-mode card. They ride in the signed auth token so
 * LetsMesh / MeshMapper can link the observer to an account.
 */
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { UiIcon } from '../icons';
import { ConfirmDialog } from '../shared/automation/ConfirmDialog';
import { PresetPicker } from '../shared/config/PresetPicker';
import {
  MAX_OBSERVER_BROKERS,
  OBSERVER_BLOCK_FIELDS,
  OBSERVER_BROKER_FIELDS,
  OBSERVER_BROKER_PRESETS,
  OWNER_EMAIL_INVALID_FALLBACK,
  OWNER_KEY_INVALID_FALLBACK,
  type ObserverBrokerForm,
  type ObserverForm,
} from './observerConfig';
import { isValidOwnerEmailInput, isValidOwnerPublicKeyInput } from '../../utils/observerOwnerClaims';
import styles from './MeshCoreObserverBrokerEditor.module.css';

export interface MeshCoreObserverBrokerEditorProps {
  form: ObserverForm;
  canEdit: boolean;
  onIataCodeChange: (iataCode: string) => void;
  onOwnerPublicKeyChange: (ownerPublicKey: string) => void;
  onOwnerEmailChange: (ownerEmail: string) => void;
  /**
   * The connected companion's own public key, for the "Use this companion's
   * key" button. Absent while disconnected or before the node reports it.
   */
  companionPublicKey?: string | null;
  onAddBroker: (presetId: string) => void;
  onUpdateBroker: (rowId: string, patch: Partial<ObserverBrokerForm>) => void;
  onRemoveBroker: (rowId: string) => void;
}

export const MeshCoreObserverBrokerEditor: React.FC<MeshCoreObserverBrokerEditorProps> = ({
  form,
  canEdit,
  onIataCodeChange,
  onOwnerPublicKeyChange,
  onOwnerEmailChange,
  companionPublicKey,
  onAddBroker,
  onUpdateBroker,
  onRemoveBroker,
}) => {
  const { t } = useTranslation();
  const [pendingRemove, setPendingRemove] = useState<{ id: string; name: string } | null>(null);
  const atCap = form.brokers.length >= MAX_OBSERVER_BROKERS;
  const ownerKeyInvalid = !isValidOwnerPublicKeyInput(form.ownerPublicKey);
  const ownerEmailInvalid = !isValidOwnerEmailInput(form.ownerEmail);
  const keyInvalidText = t('meshcore.observer.owner_key_invalid', OWNER_KEY_INVALID_FALLBACK);
  const emailInvalidText = t('meshcore.observer.owner_email_invalid', OWNER_EMAIL_INVALID_FALLBACK);
  const emailPrivacyText = t(
    'meshcore.observer.owner_email_privacy',
    "Sent to this broker's operator inside the signed auth token, so they can link the observer to your account.",
  );
  const inheritsText = t('meshcore.observer.owner_inherits', 'Inherits source default');

  return (
    <div data-testid="observer-broker-editor">
      {OBSERVER_BLOCK_FIELDS.map((f) => (
        <div key={f.key} className={styles.field}>
          <label htmlFor="mc-observer-iata">{t(f.labelKey, f.labelFallback)}</label>
          <input
            id="mc-observer-iata"
            type="text"
            value={form.iataCode}
            onChange={(e) => onIataCodeChange(e.target.value)}
            placeholder={f.placeholder}
            disabled={!canEdit}
            className={styles.shortInput}
          />
          <p className={styles.help}>{t(f.helpKey, f.helpFallback)}</p>
        </div>
      ))}

      <div className={styles.field}>
        <label htmlFor="mc-observer-owner-key">
          {t('meshcore.observer.owner_key', 'Owner public key (optional)')}
        </label>
        <div className={styles.inputRow}>
          <input
            id="mc-observer-owner-key"
            type="text"
            value={form.ownerPublicKey}
            onChange={(e) => onOwnerPublicKeyChange(e.target.value)}
            disabled={!canEdit}
            spellCheck={false}
            autoComplete="off"
            aria-invalid={ownerKeyInvalid}
            className={styles.monoInput}
            data-testid="observer-owner-key"
          />
          {canEdit && (
            <button
              type="button"
              className={styles.inlineButton}
              disabled={!companionPublicKey}
              onClick={() => companionPublicKey && onOwnerPublicKeyChange(companionPublicKey.toUpperCase())}
              data-testid="observer-owner-use-companion"
            >
              {t('meshcore.observer.owner_use_companion', "Use this companion's key")}
            </button>
          )}
        </div>
        {ownerKeyInvalid && (
          <p className={styles.fieldError} role="alert" data-testid="observer-owner-key-error">
            {keyInvalidText}
          </p>
        )}
        <p className={styles.help}>
          {t(
            'meshcore.observer.owner_key_help',
            'Sent as the owner claim in the signed auth token, so LetsMesh and MeshMapper can show the observer under your account. 64 hex characters. Leave blank to send no owner.',
          )}
        </p>
      </div>

      <div className={styles.field}>
        <label htmlFor="mc-observer-owner-email">
          {t('meshcore.observer.owner_email', 'Owner email (optional)')}
        </label>
        <input
          id="mc-observer-owner-email"
          type="email"
          value={form.ownerEmail}
          onChange={(e) => onOwnerEmailChange(e.target.value)}
          disabled={!canEdit}
          autoComplete="off"
          aria-invalid={ownerEmailInvalid}
          data-testid="observer-owner-email"
        />
        {ownerEmailInvalid && (
          <p className={styles.fieldError} role="alert" data-testid="observer-owner-email-error">
            {emailInvalidText}
          </p>
        )}
        <p className={styles.help}>{emailPrivacyText}</p>
      </div>

      {form.brokers.length === 0 && (
        <p className={styles.help} data-testid="observer-broker-empty">
          {t('meshcore.observer.brokers_none', 'No brokers yet. Add one from the presets below.')}
        </p>
      )}

      <div className={styles.brokerList} data-testid="observer-broker-list">
        {form.brokers.map((row, i) => {
          const index = i + 1;
          const name = row.label.trim() || row.url.trim();
          return (
            <div key={row.id} className={styles.brokerRow} data-testid={`observer-broker-row-${index}`}>
              <div className={styles.brokerHead}>
                <span>
                  {t('meshcore.form.observer_broker_heading', 'Broker {{index}}', { index })}
                  {row.label.trim() ? ` — ${row.label.trim()}` : ''}
                </span>
                {canEdit && (
                  <button
                    type="button"
                    className={styles.removeButton}
                    onClick={() =>
                      setPendingRemove({
                        id: row.id,
                        name: name || t('meshcore.form.observer_broker_heading', 'Broker {{index}}', { index }),
                      })
                    }
                    aria-label={t('meshcore.form.observer_broker_remove', 'Remove broker {{index}}', { index })}
                  >
                    <UiIcon name="delete" size={14} />
                  </button>
                )}
              </div>
              {OBSERVER_BROKER_FIELDS.filter((f) => f.key !== 'tokenAudience' || row.authMode === 'token').map((f) => (
                <div key={f.key} className={styles.field}>
                  <label htmlFor={`mc-observer-${row.id}-${f.key}`}>{t(f.labelKey, f.labelFallback)}</label>
                  <input
                    id={`mc-observer-${row.id}-${f.key}`}
                    type="text"
                    value={row[f.key]}
                    onChange={(e) => onUpdateBroker(row.id, { [f.key]: e.target.value })}
                    placeholder={f.placeholder}
                    disabled={!canEdit}
                    // Several rows share the same visible label text.
                    aria-label={t(f.labelKey, f.labelFallback, { index })}
                  />
                  <p className={styles.help}>{t(f.helpKey, f.helpFallback)}</p>
                </div>
              ))}
              <div className={styles.field}>
                <label htmlFor={`mc-observer-${row.id}-auth`}>
                  {t('meshcore.form.observer_auth_mode', 'Broker authentication')}
                </label>
                <select
                  id={`mc-observer-${row.id}-auth`}
                  value={row.authMode}
                  disabled={!canEdit}
                  aria-label={t('meshcore.form.observer_auth_mode', 'Broker authentication', { index })}
                  onChange={(e) =>
                    onUpdateBroker(row.id, { authMode: e.target.value === 'password' ? 'password' : 'token' })
                  }
                >
                  <option value="token">
                    {t('meshcore.form.observer_auth_mode_token', 'Signed token (FL Mesh / LetsMesh)')}
                  </option>
                  <option value="password">{t('meshcore.form.observer_auth_mode_password', 'Username / password')}</option>
                </select>
                <p className={styles.help}>
                  {row.authMode === 'password'
                    ? t(
                        'meshcore.observer.auth_mode_password_help',
                        'For regional brokers with a fixed MQTT login. Save the broker list, then set its username and password under Credentials.',
                      )
                    : t(
                        'meshcore.form.observer_auth_mode_token_help',
                        "MeshMonitor signs a token with the node's own key and connects as v1_{PUBLIC_KEY}. The default, and what FL Mesh / LetsMesh brokers expect.",
                      )}
                </p>
              </div>
              {row.authMode === 'token' && (
                <>
                  <div className={styles.field}>
                    <label htmlFor={`mc-observer-${row.id}-owner-key`}>
                      {t('meshcore.observer.owner_key', 'Owner public key (optional)')}
                    </label>
                    <input
                      id={`mc-observer-${row.id}-owner-key`}
                      type="text"
                      value={row.ownerPublicKey}
                      onChange={(e) => onUpdateBroker(row.id, { ownerPublicKey: e.target.value })}
                      placeholder={inheritsText}
                      disabled={!canEdit}
                      spellCheck={false}
                      autoComplete="off"
                      aria-invalid={!isValidOwnerPublicKeyInput(row.ownerPublicKey)}
                      aria-label={t('meshcore.observer.broker_owner_key', 'Broker {{index}} owner public key', { index })}
                      className={styles.monoInput}
                    />
                    {!isValidOwnerPublicKeyInput(row.ownerPublicKey) && (
                      <p className={styles.fieldError} role="alert">
                        {keyInvalidText}
                      </p>
                    )}
                  </div>
                  <div className={styles.field}>
                    <label htmlFor={`mc-observer-${row.id}-owner-email`}>
                      {t('meshcore.observer.owner_email', 'Owner email (optional)')}
                    </label>
                    <input
                      id={`mc-observer-${row.id}-owner-email`}
                      type="email"
                      value={row.ownerEmail}
                      onChange={(e) => onUpdateBroker(row.id, { ownerEmail: e.target.value })}
                      placeholder={inheritsText}
                      disabled={!canEdit}
                      autoComplete="off"
                      aria-invalid={!isValidOwnerEmailInput(row.ownerEmail)}
                      aria-label={t('meshcore.observer.broker_owner_email', 'Broker {{index}} owner email', { index })}
                    />
                    {!isValidOwnerEmailInput(row.ownerEmail) && (
                      <p className={styles.fieldError} role="alert">
                        {emailInvalidText}
                      </p>
                    )}
                    <p className={styles.help}>{emailPrivacyText}</p>
                  </div>
                </>
              )}
              <div className={styles.field}>
                <label className={styles.checkboxLabel}>
                  <input
                    type="checkbox"
                    checked={row.verifyTls}
                    disabled={!canEdit}
                    aria-label={t('meshcore.observer.verify_tls', 'Verify TLS certificate', { index })}
                    onChange={(e) => onUpdateBroker(row.id, { verifyTls: e.target.checked })}
                  />
                  <span>{t('meshcore.observer.verify_tls', 'Verify TLS certificate')}</span>
                </label>
                <p className={styles.help}>
                  {t(
                    'meshcore.observer.verify_tls_help',
                    'Applies to wss:// and mqtts:// brokers. Turn off only for a broker with a self-signed certificate.',
                  )}
                </p>
                {!row.verifyTls && (
                  <p className={styles.warning} role="alert" data-testid={`observer-broker-tls-warning-${index}`}>
                    <UiIcon name="alert" size={14} />
                    {t(
                      'meshcore.observer.verify_tls_off_warning',
                      'Certificate checks are off. Anyone between this server and the broker could read or alter what the observer sends.',
                    )}
                  </p>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {canEdit && (
        <PresetPicker
          label={t('meshcore.observer.add_broker', 'Add a broker')}
          description={
            atCap
              ? t('meshcore.observer.broker_cap', 'At most {{max}} brokers.', { max: MAX_OBSERVER_BROKERS })
              : undefined
          }
          options={OBSERVER_BROKER_PRESETS.map((p) => ({
            id: p.id,
            label: t(p.labelKey, p.labelFallback),
            title: p.url || undefined,
          }))}
          onPick={onAddBroker}
          disabled={atCap}
          data-testid="observer-preset-picker"
        />
      )}

      {pendingRemove && (
        <ConfirmDialog
          title={t('meshcore.observer.remove_broker_title', 'Remove {{broker}}?', { broker: pendingRemove.name })}
          message={t(
            'meshcore.observer.remove_broker_confirm',
            'The observer stops publishing to this broker once you save. A username and password stored for it are no longer used.',
          )}
          confirmLabel={t('meshcore.observer.remove_broker', 'Remove')}
          cancelLabel={t('common.cancel', 'Cancel')}
          danger
          onConfirm={() => {
            onRemoveBroker(pendingRemove.id);
            setPendingRemove(null);
          }}
          onCancel={() => setPendingRemove(null)}
        />
      )}
    </div>
  );
};
