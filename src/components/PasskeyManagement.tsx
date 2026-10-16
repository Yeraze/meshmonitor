/**
 * Passkey management for the signed-in local user (#5841): list, add, rename,
 * delete. Shown from the user menu next to two-factor auth.
 *
 * The turn-off-password switch and recovery codes come in PR 3.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useToast } from './ToastContainer';
import { UiIcon } from './icons';
import { logger } from '../utils/logger';
import { ApiError } from '../services/api';
import {
  deletePasskey,
  isPasskeyCancel,
  listPasskeys,
  passkeysSupported,
  registerPasskey,
  renamePasskey,
  type PasskeySummary,
} from '../services/passkeyClient';
import styles from './PasskeyManagement.module.css';

const NICKNAME_MAX = 64;

function formatTime(ms: number | null, never: string): string {
  return ms ? new Date(ms).toLocaleString() : never;
}

const PasskeyManagement: React.FC = () => {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const supported = passkeysSupported();

  const [passkeys, setPasskeys] = useState<PasskeySummary[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const [newNickname, setNewNickname] = useState('');
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editNickname, setEditNickname] = useState('');
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null);

  const load = useCallback(async () => {
    try {
      setPasskeys(await listPasskeys());
    } catch (err) {
      logger.error('Failed to load passkeys:', err);
      setPasskeys([]);
      showToast(t('passkey.load_failed'), 'error');
    }
  }, [showToast, t]);

  useEffect(() => {
    void load();
  }, [load]);

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await registerPasskey(newNickname.trim() || null);
      setAdding(false);
      setNewNickname('');
      showToast(t('passkey.added'), 'success');
      await load();
    } catch (err) {
      if (isPasskeyCancel(err)) return;
      logger.error('Failed to add passkey:', err);
      const exists = err instanceof ApiError && err.code === 'PASSKEY_EXISTS';
      showToast(exists ? t('passkey.already_registered') : t('passkey.add_failed'), 'error');
    } finally {
      setBusy(false);
    }
  };

  const handleRename = async (e: React.FormEvent, id: number) => {
    e.preventDefault();
    setBusy(true);
    try {
      await renamePasskey(id, editNickname.trim() || null);
      setEditingId(null);
      await load();
    } catch (err) {
      logger.error('Failed to rename passkey:', err);
      showToast(t('passkey.rename_failed'), 'error');
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async (id: number) => {
    setBusy(true);
    try {
      await deletePasskey(id);
      setConfirmDeleteId(null);
      showToast(t('passkey.deleted'), 'success');
      await load();
    } catch (err) {
      logger.error('Failed to delete passkey:', err);
      const last = err instanceof ApiError && err.code === 'LAST_PASSKEY';
      showToast(last ? t('passkey.last_passkey') : t('passkey.delete_failed'), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className={styles.section} aria-labelledby="passkey-heading">
      <h3 id="passkey-heading" className={styles.heading}>
        <UiIcon name="key" size={18} />
        {t('passkey.title')}
      </h3>
      <p className={styles.description}>{t('passkey.description')}</p>

      {!supported && <p className={styles.unsupported}>{t('passkey.unsupported')}</p>}

      {passkeys === null ? (
        <p className={styles.muted}>{t('common.loading')}</p>
      ) : passkeys.length === 0 ? (
        <p className={styles.muted}>{t('passkey.none')}</p>
      ) : (
        <ul className={styles.list}>
          {passkeys.map((pk) => (
            <li key={pk.id} className={styles.item} data-testid="passkey-item">
              {editingId === pk.id ? (
                <form className={styles.inlineForm} onSubmit={(e) => handleRename(e, pk.id)}>
                  <input
                    type="text"
                    value={editNickname}
                    maxLength={NICKNAME_MAX}
                    onChange={(e) => setEditNickname(e.target.value)}
                    aria-label={t('passkey.nickname')}
                    disabled={busy}
                    autoFocus
                  />
                  <button type="submit" className="button button-primary" disabled={busy}>
                    {t('common.save')}
                  </button>
                  <button type="button" className="button" onClick={() => setEditingId(null)} disabled={busy}>
                    {t('common.cancel')}
                  </button>
                </form>
              ) : (
                <div className={styles.itemMain}>
                  <div className={styles.name}>{pk.nickname || t('passkey.unnamed')}</div>
                  <div className={styles.meta}>
                    <span>{t('passkey.hostname', { host: pk.rpId })}</span>
                    <span>{t('passkey.created', { when: formatTime(pk.createdAt, t('passkey.never')) })}</span>
                    <span>{t('passkey.last_used', { when: formatTime(pk.lastUsedAt, t('passkey.never')) })}</span>
                  </div>
                </div>
              )}

              {editingId !== pk.id && (
                confirmDeleteId === pk.id ? (
                  <div className={styles.actions}>
                    <span className={styles.confirmText}>{t('passkey.delete_confirm')}</span>
                    <button
                      type="button"
                      className={`button ${styles.danger}`}
                      onClick={() => handleDelete(pk.id)}
                      disabled={busy}
                    >
                      {t('common.delete')}
                    </button>
                    <button type="button" className="button" onClick={() => setConfirmDeleteId(null)} disabled={busy}>
                      {t('common.cancel')}
                    </button>
                  </div>
                ) : (
                  <div className={styles.actions}>
                    <button
                      type="button"
                      className={styles.iconButton}
                      onClick={() => {
                        setEditingId(pk.id);
                        setEditNickname(pk.nickname ?? '');
                        setConfirmDeleteId(null);
                      }}
                      disabled={busy}
                      aria-label={t('passkey.rename')}
                      title={t('passkey.rename')}
                    >
                      <UiIcon name="edit" size={16} />
                    </button>
                    <button
                      type="button"
                      className={styles.iconButton}
                      onClick={() => {
                        setConfirmDeleteId(pk.id);
                        setEditingId(null);
                      }}
                      disabled={busy}
                      aria-label={t('passkey.delete')}
                      title={t('passkey.delete')}
                    >
                      <UiIcon name="delete" size={16} />
                    </button>
                  </div>
                )
              )}
            </li>
          ))}
        </ul>
      )}

      {supported && (
        adding ? (
          <form className={styles.inlineForm} onSubmit={handleAdd}>
            <input
              type="text"
              value={newNickname}
              maxLength={NICKNAME_MAX}
              onChange={(e) => setNewNickname(e.target.value)}
              placeholder={t('passkey.nickname_placeholder')}
              aria-label={t('passkey.nickname')}
              disabled={busy}
              autoFocus
            />
            <button type="submit" className="button button-primary" disabled={busy}>
              {busy ? t('passkey.adding') : t('passkey.continue')}
            </button>
            <button type="button" className="button" onClick={() => setAdding(false)} disabled={busy}>
              {t('common.cancel')}
            </button>
          </form>
        ) : (
          <button
            type="button"
            className={`button button-primary ${styles.addButton}`}
            onClick={() => setAdding(true)}
            disabled={busy}
          >
            <UiIcon name="plus" size={16} />
            {t('passkey.add')}
          </button>
        )
      )}
    </section>
  );
};

export default PasskeyManagement;
