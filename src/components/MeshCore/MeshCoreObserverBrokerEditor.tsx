/**
 * The Analyzer Observer's editable broker list (#5831): region, one card per
 * broker (URL, label, auth mode, token audience), and the preset chips that
 * add a broker. Moved here from the Dashboard source modal.
 *
 * Controlled: every change goes to `useObserverConfigDraft`, which holds the
 * draft and saves it through the SaveBar. Nothing here talks to the server.
 * Removing a broker asks first, because its stored login goes unused once the
 * broker is gone.
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
  type ObserverBrokerForm,
  type ObserverForm,
} from './observerConfig';
import styles from './MeshCoreObserverBrokerEditor.module.css';

export interface MeshCoreObserverBrokerEditorProps {
  form: ObserverForm;
  canEdit: boolean;
  onIataCodeChange: (iataCode: string) => void;
  onAddBroker: (presetId: string) => void;
  onUpdateBroker: (rowId: string, patch: Partial<ObserverBrokerForm>) => void;
  onRemoveBroker: (rowId: string) => void;
}

export const MeshCoreObserverBrokerEditor: React.FC<MeshCoreObserverBrokerEditorProps> = ({
  form,
  canEdit,
  onIataCodeChange,
  onAddBroker,
  onUpdateBroker,
  onRemoveBroker,
}) => {
  const { t } = useTranslation();
  const [pendingRemove, setPendingRemove] = useState<{ id: string; name: string } | null>(null);
  const atCap = form.brokers.length >= MAX_OBSERVER_BROKERS;

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
