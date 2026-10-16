/**
 * Admin view of one user's passkeys, with Revoke (#5841, D1). Revoking the
 * last passkey of a passkey-only user is refused by the server; the admin
 * sets a new password for them instead, which turns password sign-in on.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Modal from './common/Modal';
import { UiIcon } from './icons';
import { useToast } from './ToastContainer';
import { logger } from '../utils/logger';
import { ApiError } from '../services/api';
import {
  adminListUserPasskeys,
  adminRevokeUserPasskey,
  type AdminUserPasskeys,
} from '../services/passkeyClient';
import styles from './PasskeyManagement.module.css';

interface AdminPasskeysDialogProps {
  userId: number;
  username: string;
  onClose: () => void;
  /** Called with the new passkey count after a revoke, for the users list. */
  onChanged?: (passkeyCount: number) => void;
}

function formatTime(ms: number | null, never: string): string {
  return ms ? new Date(ms).toLocaleString() : never;
}

const AdminPasskeysDialog: React.FC<AdminPasskeysDialogProps> = ({ userId, username, onClose, onChanged }) => {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const [data, setData] = useState<AdminUserPasskeys | null>(null);
  const [confirmId, setConfirmId] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (): Promise<AdminUserPasskeys | null> => {
    try {
      const fresh = await adminListUserPasskeys(userId);
      setData(fresh);
      return fresh;
    } catch (err) {
      logger.error('Failed to load user passkeys:', err);
      showToast(t('passkey.load_failed'), 'error');
      setData({ userId, username, passwordLoginDisabled: false, passkeys: [] });
      return null;
    }
  }, [userId, username, showToast, t]);

  useEffect(() => {
    void load();
  }, [load]);

  const handleRevoke = async (id: number) => {
    setBusy(true);
    try {
      await adminRevokeUserPasskey(userId, id);
      setConfirmId(null);
      showToast(t('passkey_admin.revoked'), 'success');
      const fresh = await load();
      if (fresh) onChanged?.(fresh.passkeys.length);
    } catch (err) {
      logger.error('Failed to revoke passkey:', err);
      const last = err instanceof ApiError && err.code === 'LAST_PASSKEY';
      showToast(last ? t('passkey_admin.last_passkey') : t('passkey_admin.revoke_failed'), 'error');
      setConfirmId(null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal isOpen onClose={onClose} title={t('passkey_admin.title', { username })}>
      <div className={styles.section}>
        {data?.passwordLoginDisabled && (
          <p className={styles.unsupported}>{t('passkey_admin.password_off')}</p>
        )}
        {data === null ? (
          <p className={styles.muted}>{t('common.loading')}</p>
        ) : data.passkeys.length === 0 ? (
          <p className={styles.muted}>{t('passkey_admin.none')}</p>
        ) : (
          <ul className={styles.list}>
            {data.passkeys.map(pk => (
              <li key={pk.id} className={styles.item} data-testid="admin-passkey-item">
                <div className={styles.itemMain}>
                  <div className={styles.name}>{pk.nickname || t('passkey.unnamed')}</div>
                  <div className={styles.meta}>
                    <span>{t('passkey.hostname', { host: pk.rpId })}</span>
                    <span>{t('passkey.created', { when: formatTime(pk.createdAt, t('passkey.never')) })}</span>
                    <span>{t('passkey.last_used', { when: formatTime(pk.lastUsedAt, t('passkey.never')) })}</span>
                  </div>
                </div>
                {confirmId === pk.id ? (
                  <div className={styles.actions}>
                    <span className={styles.confirmText}>{t('passkey_admin.revoke_confirm')}</span>
                    <button
                      type="button"
                      className={`button ${styles.danger}`}
                      onClick={() => handleRevoke(pk.id)}
                      disabled={busy}
                    >
                      {t('passkey_admin.revoke')}
                    </button>
                    <button type="button" className="button" onClick={() => setConfirmId(null)} disabled={busy}>
                      {t('common.cancel')}
                    </button>
                  </div>
                ) : (
                  <div className={styles.actions}>
                    <button type="button" className="button" onClick={() => setConfirmId(pk.id)} disabled={busy}>
                      <UiIcon name="delete" size={16} />
                      {t('passkey_admin.revoke')}
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </Modal>
  );
};

export default AdminPasskeysDialog;
