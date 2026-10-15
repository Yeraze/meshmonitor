/**
 * One password-auth broker's username/password controls (#5825), rendered
 * inside that broker's card in MeshCoreObserverBrokerPanel.
 *
 * Every set and clear names this broker by its `brokerKey`, so clearing one
 * broker never touches another's credential. The password is write-only: it
 * is never returned by the API and is dropped from state once saved.
 */
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { UiIcon } from '../icons';
import { ConfirmDialog } from '../shared/automation/ConfirmDialog';
import type { ObserverBrokerStatus } from '../../services/api';
import type { ObserverCredentialBusy } from './hooks/useObserverCredentials';
import sectionStyles from './MeshCoreObserverSection.module.css';
import styles from './MeshCoreObserverBrokerCredentials.module.css';

export interface MeshCoreObserverBrokerCredentialsProps {
  broker: ObserverBrokerStatus;
  /** This broker's stored credential, or null when none is stored. */
  stored: { username: string | null } | null;
  canWrite: boolean;
  /** false when SESSION_SECRET is auto-generated and nothing can be stored. */
  canStore: boolean;
  /** The hook's in-flight action, for any broker. */
  busy: ObserverCredentialBusy | null;
  /** Error text from this broker's last failed action, if any. */
  errorText: string | null;
  onSave: (username: string, password: string) => Promise<boolean>;
  onClear: () => Promise<boolean>;
}

/** The name shown for a broker: its label, else its URL, else its key. */
function observerBrokerName(broker: Pick<ObserverBrokerStatus, 'label' | 'url' | 'key'>): string {
  return broker.label?.trim() || broker.url || broker.key;
}

export const MeshCoreObserverBrokerCredentials: React.FC<MeshCoreObserverBrokerCredentialsProps> = ({
  broker,
  stored,
  canWrite,
  canStore,
  busy,
  errorText,
  onSave,
  onClear,
}) => {
  const { t } = useTranslation();
  const [formOpen, setFormOpen] = useState(false);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);

  const brokerName = observerBrokerName(broker);
  const anyBusy = busy !== null;
  const mine = busy !== null && busy.brokerKey === broker.key;

  const openForm = () => {
    setUsername(stored?.username ?? '');
    setPassword('');
    setFormOpen(true);
  };

  const closeForm = () => {
    setFormOpen(false);
    setUsername('');
    setPassword('');
  };

  const handleSave = async () => {
    const ok = await onSave(username, password);
    if (ok) {
      // Never keep the password in component state after it is stored.
      closeForm();
      setSavedFlash(true);
      setTimeout(() => setSavedFlash(false), 2500);
    }
  };

  const handleConfirmClear = async () => {
    setConfirmOpen(false);
    await onClear();
  };

  return (
    <div className={styles.credentials}>
      <div className={sectionStyles.statusLabel}>
        {t('meshcore.observer.broker_credentials_heading', 'Username / password')}
      </div>
      <div className={sectionStyles.statusValue}>
        {stored
          ? t('meshcore.observer.credentials_stored', 'Stored for user {{username}}', {
              username: stored.username ?? '',
            })
          : t('meshcore.observer.broker_credentials_none', 'Not set. This broker cannot authenticate until you set them.')}
      </div>

      {canWrite && !formOpen && (
        <div className={sectionStyles.actions}>
          <button
            type="button"
            className="btn-secondary"
            onClick={openForm}
            disabled={anyBusy || !canStore}
            aria-label={t('meshcore.observer.broker_credentials_set_aria', 'Set username and password for {{broker}}', {
              broker: brokerName,
            })}
          >
            <UiIcon name="key" size={14} />{' '}
            {stored
              ? t('meshcore.observer.broker_credentials_change', 'Change')
              : t('meshcore.observer.broker_credentials_set', 'Set')}
          </button>
          <button
            type="button"
            className="btn-secondary"
            style={{ color: 'var(--color-error)' }}
            onClick={() => setConfirmOpen(true)}
            disabled={anyBusy || !stored}
            aria-label={t('meshcore.observer.broker_credentials_clear_aria', 'Clear username and password for {{broker}}', {
              broker: brokerName,
            })}
          >
            <UiIcon name="delete" size={14} />{' '}
            {mine && busy?.action === 'clear'
              ? t('meshcore.observer.clearing', 'Clearing…')
              : t('meshcore.observer.broker_credentials_clear', 'Clear')}
          </button>
          {savedFlash && (
            <span style={{ color: 'var(--color-success)' }}>
              <UiIcon name="check" size={14} /> {t('meshcore.observer.credentials_saved', 'Credentials saved')}
            </span>
          )}
        </div>
      )}

      {canWrite && formOpen && (
        <div className={sectionStyles.panel}>
          <label>
            {t('meshcore.observer.credentials_username', 'Broker username')}
            <input
              type="text"
              autoComplete="off"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="meshcore"
              disabled={anyBusy}
            />
          </label>
          <label>
            {t('meshcore.observer.credentials_password', 'Broker password')}
            <input
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={t('meshcore.observer.credentials_password_placeholder', 'Broker password')}
              disabled={anyBusy}
            />
          </label>
          <div className={sectionStyles.actions}>
            <button type="button" className="btn-secondary" onClick={closeForm} disabled={anyBusy}>
              {t('common.cancel', 'Cancel')}
            </button>
            <button
              type="button"
              className="btn-primary"
              onClick={() => void handleSave()}
              disabled={anyBusy || username.trim().length === 0 || password.length === 0}
            >
              {mine && busy?.action === 'save'
                ? t('meshcore.observer.manual_saving', 'Saving…')
                : t('meshcore.observer.credentials_save', 'Save credentials')}
            </button>
          </div>
        </div>
      )}

      {errorText && (
        <div role="alert" className={sectionStyles.error}>
          {errorText}
        </div>
      )}

      {confirmOpen && (
        <ConfirmDialog
          title={t('meshcore.observer.broker_credentials_clear_title', 'Clear credentials for {{broker}}?', {
            broker: brokerName,
          })}
          message={t(
            'meshcore.observer.broker_credentials_clear_confirm',
            'MeshMonitor forgets the username and password stored for {{broker}}. This broker stops publishing until you set them again. Other brokers keep their credentials.',
            { broker: brokerName },
          )}
          confirmLabel={t('meshcore.observer.broker_credentials_clear', 'Clear')}
          cancelLabel={t('common.cancel', 'Cancel')}
          onConfirm={() => void handleConfirmClear()}
          onCancel={() => setConfirmOpen(false)}
        />
      )}
    </div>
  );
};
