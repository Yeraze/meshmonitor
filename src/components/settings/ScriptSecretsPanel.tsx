/**
 * ScriptSecretsPanel — store API keys and other values that user scripts
 * receive as environment variables.
 *
 * Write only: the API never returns a value, so the panel lists names and
 * offers Replace / Delete. Admin only (the routes enforce it; the panel sits
 * in the admin-gated Scripts section). GLOBAL: every script gets every secret,
 * and the panel says so permanently.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import apiService from '../../services/api';
import { UiIcon } from '../icons';
import styles from './ScriptSecretsPanel.module.css';

interface SecretRow {
  name: string;
  updatedAt: number;
  status: 'ok' | 'unreadable';
}

interface SecretListResponse {
  success: boolean;
  data: { canStore: boolean; reason?: string; secrets: SecretRow[] };
}

const NAME_PATTERN = /^[A-Z_][A-Z0-9_]{0,63}$/;
const MAX_VALUE_LENGTH = 4096;

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

const ScriptSecretsPanel: React.FC = () => {
  const { t } = useTranslation();
  const [secrets, setSecrets] = useState<SecretRow[]>([]);
  const [canStore, setCanStore] = useState(true);
  const [reason, setReason] = useState<string | undefined>();
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [newName, setNewName] = useState('');
  const [newValue, setNewValue] = useState('');
  const [addError, setAddError] = useState<string | null>(null);

  const [replacing, setReplacing] = useState<string | null>(null);
  const [replaceValue, setReplaceValue] = useState('');
  const [replaceError, setReplaceError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await apiService.get<SecretListResponse>('/api/script-secrets');
      setSecrets(res.data.secrets);
      setCanStore(res.data.canStore);
      setReason(res.data.reason);
      setLoadError(null);
    } catch (err) {
      setLoadError(errorMessage(err, t('scripts.secrets.load_failed', 'Could not load script secrets.')));
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async (name: string, value: string): Promise<string | null> => {
    setBusy(true);
    try {
      await apiService.put(`/api/script-secrets/${encodeURIComponent(name)}`, { value });
      await load();
      return null;
    } catch (err) {
      return errorMessage(err, t('scripts.secrets.save_failed', 'Could not save the secret.'));
    } finally {
      setBusy(false);
    }
  };

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    const name = newName.trim().toUpperCase();
    if (!NAME_PATTERN.test(name)) {
      setAddError(t('scripts.secrets.invalid_name', 'Use upper-case letters, digits and underscores (up to 64), not starting with a digit.'));
      return;
    }
    if (newValue.length < 1 || newValue.length > MAX_VALUE_LENGTH) {
      setAddError(t('scripts.secrets.invalid_value', 'Enter a value of 1 to 4096 characters.'));
      return;
    }
    const error = await save(name, newValue);
    setAddError(error);
    if (!error) {
      setNewName('');
      setNewValue('');
    }
  };

  const handleReplace = async (name: string) => {
    if (replaceValue.length < 1 || replaceValue.length > MAX_VALUE_LENGTH) {
      setReplaceError(t('scripts.secrets.invalid_value', 'Enter a value of 1 to 4096 characters.'));
      return;
    }
    const error = await save(name, replaceValue);
    setReplaceError(error);
    if (!error) {
      setReplacing(null);
      setReplaceValue('');
    }
  };

  const handleDelete = async (name: string) => {
    setBusy(true);
    try {
      await apiService.delete(`/api/script-secrets/${encodeURIComponent(name)}`);
      setConfirmDelete(null);
      await load();
    } catch (err) {
      setLoadError(errorMessage(err, t('scripts.secrets.delete_failed', 'Could not delete the secret.')));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className={styles.panel} aria-labelledby="script-secrets-title">
      <h4 id="script-secrets-title" className={styles.title}>
        <UiIcon name="key" size={15} /> {t('scripts.secrets.title', 'Script Secrets')}
      </h4>
      <p className={styles.description}>
        {t(
          'scripts.secrets.description',
          'Store API keys and other values your scripts need. Each one reaches every script as an environment variable of the same name, for example os.environ["OPENAI_API_KEY"].',
        )}
      </p>

      <div className={styles.warning} role="note">
        <UiIcon name="securityAlert" size={16} className={styles.warningIcon} />
        <div>
          <strong>{t('scripts.secrets.warning_title', 'Every script receives every secret.')}</strong>
          <ul>
            <li>{t('scripts.secrets.warning_any_script', 'Any script uploaded here can read these values and print them, send them over the mesh, or send them to any web server.')}</li>
            <li>{t('scripts.secrets.warning_triggers', 'Users who can edit automations can run existing scripts, and so make them use these secrets.')}</li>
            <li>{t('scripts.secrets.warning_write_only', 'A value cannot be viewed after you save it. Replace it or delete it.')}</li>
            <li>{t('scripts.secrets.warning_session_secret', 'Values are encrypted with a key made from SESSION_SECRET. If SESSION_SECRET changes, enter each value again.')}</li>
          </ul>
        </div>
      </div>

      {!canStore && (
        <div className={styles.disabledNotice} role="alert">
          <strong>{t('scripts.secrets.disabled_title', 'Storing secrets is turned off.')}</strong>{' '}
          {reason ?? t('scripts.secrets.disabled_reason', 'Set SESSION_SECRET in your environment to store script secrets.')}
        </div>
      )}

      {loadError && <div className={styles.error} role="alert">{loadError}</div>}

      {secrets.length === 0 ? (
        <p className={styles.empty}>{t('scripts.secrets.empty', 'No script secrets stored.')}</p>
      ) : (
        <table className={styles.table}>
          <thead>
            <tr>
              <th>{t('scripts.secrets.col_name', 'Name')}</th>
              <th>{t('scripts.secrets.col_updated', 'Last updated')}</th>
              <th>{t('scripts.secrets.col_status', 'Status')}</th>
              <th aria-label={t('scripts.secrets.col_actions', 'Actions')} />
            </tr>
          </thead>
          <tbody>
            {secrets.map((secret) => (
              <tr key={secret.name}>
                <td className={styles.name}>{secret.name}</td>
                <td>{new Date(secret.updatedAt).toLocaleString()}</td>
                <td>
                  {secret.status === 'ok' ? (
                    <span className={styles.statusOk}>{t('scripts.secrets.status_ok', 'OK')}</span>
                  ) : (
                    <span className={styles.statusUnreadable} title={t('scripts.secrets.status_unreadable_hint', 'Encrypted under a different SESSION_SECRET. Scripts do not receive it. Enter the value again.')}>
                      {t('scripts.secrets.status_unreadable', 'Unreadable, enter again')}
                    </span>
                  )}
                </td>
                <td>
                  {replacing === secret.name ? (
                    <div className={styles.form}>
                      <input
                        type="password"
                        className={styles.input}
                        value={replaceValue}
                        onChange={(e) => setReplaceValue(e.target.value)}
                        maxLength={MAX_VALUE_LENGTH}
                        autoComplete="new-password"
                        aria-label={t('scripts.secrets.new_value_for', 'New value for {{name}}', { name: secret.name })}
                        autoFocus
                      />
                      <button type="button" className={styles.primaryButton} disabled={busy || !canStore} onClick={() => handleReplace(secret.name)}>
                        <UiIcon name="save" size={13} /> {t('scripts.secrets.save', 'Save')}
                      </button>
                      <button
                        type="button"
                        className={styles.button}
                        disabled={busy}
                        onClick={() => { setReplacing(null); setReplaceValue(''); setReplaceError(null); }}
                      >
                        {t('common.cancel', 'Cancel')}
                      </button>
                      {replaceError && <div className={styles.error} role="alert">{replaceError}</div>}
                    </div>
                  ) : confirmDelete === secret.name ? (
                    <div className={styles.actions}>
                      <button type="button" className={styles.dangerButton} disabled={busy} onClick={() => handleDelete(secret.name)}>
                        <UiIcon name="delete" size={13} /> {t('scripts.secrets.confirm_delete', 'Delete {{name}}', { name: secret.name })}
                      </button>
                      <button type="button" className={styles.button} disabled={busy} onClick={() => setConfirmDelete(null)}>
                        {t('common.cancel', 'Cancel')}
                      </button>
                    </div>
                  ) : (
                    <div className={styles.actions}>
                      <button
                        type="button"
                        className={styles.button}
                        disabled={busy || !canStore}
                        onClick={() => { setReplacing(secret.name); setReplaceValue(''); setReplaceError(null); setConfirmDelete(null); }}
                      >
                        <UiIcon name="edit" size={13} /> {t('scripts.secrets.replace', 'Replace')}
                      </button>
                      <button
                        type="button"
                        className={styles.dangerButton}
                        disabled={busy}
                        onClick={() => { setConfirmDelete(secret.name); setReplacing(null); }}
                      >
                        <UiIcon name="delete" size={13} /> {t('scripts.secrets.delete', 'Delete')}
                      </button>
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <form className={styles.form} onSubmit={handleAdd}>
        <input
          type="text"
          className={`${styles.input} ${styles.nameInput}`}
          placeholder={t('scripts.secrets.name_placeholder', 'NAME, e.g. OPENAI_API_KEY')}
          value={newName}
          onChange={(e) => setNewName(e.target.value.toUpperCase())}
          maxLength={64}
          disabled={!canStore}
          autoComplete="off"
          spellCheck={false}
          aria-label={t('scripts.secrets.col_name', 'Name')}
        />
        <input
          type="password"
          className={styles.input}
          placeholder={t('scripts.secrets.value_placeholder', 'Value')}
          value={newValue}
          onChange={(e) => setNewValue(e.target.value)}
          maxLength={MAX_VALUE_LENGTH}
          disabled={!canStore}
          autoComplete="new-password"
          aria-label={t('scripts.secrets.value_placeholder', 'Value')}
        />
        <button type="submit" className={styles.primaryButton} disabled={busy || !canStore || !newName || !newValue}>
          <UiIcon name="plus" size={13} /> {t('scripts.secrets.add', 'Add secret')}
        </button>
        <div className={styles.hint}>
          {t('scripts.secrets.name_hint', 'Some names are reserved, such as PATH, MESSAGE, and names starting with PARAM_, MSG_, NODE_ or PYTHON. Saving a name that exists replaces its value.')}
        </div>
        {addError && <div className={styles.error} role="alert">{addError}</div>}
      </form>
    </section>
  );
};

export default ScriptSecretsPanel;
