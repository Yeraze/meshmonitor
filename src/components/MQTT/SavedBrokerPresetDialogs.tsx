/**
 * Admin dialogs for saved MQTT broker presets (#5794):
 *
 *   SaveBrokerPresetDialog     "Save as preset" from a form's current values.
 *   ManageBrokerPresetsDialog  edit, rename, duplicate and delete saved presets.
 *
 * Saving or deleting a preset changes no source and no radio: a form copies a
 * preset in when someone picks it, so what is already saved stays as it is.
 */
import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Modal from '../common/Modal';
import { NumberInput } from '../common/NumberInput';
import {
  useCreateBrokerPreset,
  useDeleteBrokerPreset,
  useUpdateBrokerPreset,
  type SavedBrokerPreset,
  type SavedBrokerPresetBody,
} from '../../hooks/useMqttBrokerPresets';
import { defaultMqttPort } from '../../utils/mqttBrokerEndpoint';
import styles from './SavedBrokerPresetDialogs.module.css';

/** A form's current broker values, offered to "Save as preset". */
export interface BrokerPresetDraft {
  host: string;
  port: number;
  tls: boolean;
  username: string;
  password: string;
  rootTopic: string;
}

interface EditorValues {
  name: string;
  host: string;
  port: number;
  tls: boolean;
  username: string;
  password: string;
  rootTopic: string;
}

function valuesFromDraft(draft: BrokerPresetDraft, name = ''): EditorValues {
  return {
    name,
    host: draft.host,
    port: draft.port,
    tls: draft.tls,
    username: draft.username,
    password: draft.password,
    rootTopic: draft.rootTopic,
  };
}

function valuesFromPreset(p: SavedBrokerPreset, name = p.name): EditorValues {
  return {
    name,
    host: p.host,
    port: p.port,
    tls: p.tls,
    username: p.username ?? '',
    password: p.password ?? '',
    rootTopic: p.rootTopic ?? '',
  };
}

function bodyFromValues(v: EditorValues): SavedBrokerPresetBody {
  return {
    name: v.name.trim(),
    host: v.host.trim(),
    port: v.port,
    tls: v.tls,
    username: v.username.trim() || null,
    password: v.password || null,
    rootTopic: v.rootTopic.trim() || null,
  };
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const PresetEditor: React.FC<{
  values: EditorValues;
  onChange: (next: EditorValues) => void;
  idPrefix: string;
}> = ({ values, onChange, idPrefix }) => {
  const { t } = useTranslation();
  const set = <K extends keyof EditorValues>(key: K, value: EditorValues[K]) => onChange({ ...values, [key]: value });
  const field = (key: keyof EditorValues) => `${idPrefix}-${key}`;
  return (
    <div className={styles.editor}>
      <label htmlFor={field('name')}>{t('mqtt_presets.saved.field_name', 'Preset name')}</label>
      <input
        id={field('name')}
        type="text"
        maxLength={64}
        value={values.name}
        onChange={(e) => set('name', e.target.value)}
        placeholder={t('mqtt_presets.saved.field_name_placeholder', 'e.g. Florida Mesh Broker')}
      />
      <label htmlFor={field('host')}>{t('mqtt_presets.saved.field_host', 'Broker host')}</label>
      <input
        id={field('host')}
        type="text"
        value={values.host}
        onChange={(e) => set('host', e.target.value)}
        placeholder="broker.example.org"
      />
      <label htmlFor={field('port')}>{t('mqtt_presets.saved.field_port', 'Port')}</label>
      <NumberInput
        id={field('port')}
        integer
        min={1}
        max={65535}
        value={values.port}
        onChange={(port) => set('port', port)}
      />
      <label className={styles.checkbox}>
        <input
          type="checkbox"
          checked={values.tls}
          onChange={(e) => {
            // Switching TLS moves a default port along with it.
            const port = values.port === defaultMqttPort(values.tls) ? defaultMqttPort(e.target.checked) : values.port;
            onChange({ ...values, tls: e.target.checked, port });
          }}
        />
        {t('mqtt_presets.saved.field_tls', 'Use TLS')}
      </label>
      <label htmlFor={field('username')}>{t('mqtt_presets.saved.field_username', 'Username')}</label>
      <input
        id={field('username')}
        type="text"
        autoComplete="off"
        value={values.username}
        onChange={(e) => set('username', e.target.value)}
      />
      <label htmlFor={field('password')}>{t('mqtt_presets.saved.field_password', 'Password')}</label>
      <input
        id={field('password')}
        type="password"
        autoComplete="new-password"
        value={values.password}
        onChange={(e) => set('password', e.target.value)}
      />
      <label htmlFor={field('rootTopic')}>{t('mqtt_presets.saved.field_root', 'Root topic (optional)')}</label>
      <input
        id={field('rootTopic')}
        type="text"
        value={values.rootTopic}
        onChange={(e) => set('rootTopic', e.target.value)}
        placeholder="msh/US/FL"
      />
      <p className={styles.hint}>
        {t(
          'mqtt_presets.saved.root_hint',
          'When set, picking the preset fills a device’s root topic, and sets a bridge’s subscription to <root>/#.',
        )}
      </p>
    </div>
  );
};

export const SaveBrokerPresetDialog: React.FC<{
  isOpen: boolean;
  onClose: () => void;
  draft: BrokerPresetDraft | null;
  /** The bridge form never shows a stored password, so it cannot be saved from there. */
  passwordNotIncluded?: boolean;
}> = ({ isOpen, onClose, draft, passwordNotIncluded = false }) => {
  const { t } = useTranslation();
  const create = useCreateBrokerPreset();
  const [values, setValues] = useState<EditorValues | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (isOpen && draft) {
      setValues(valuesFromDraft(draft));
      setError('');
    }
  }, [isOpen, draft]);

  const save = async () => {
    if (!values) return;
    setError('');
    try {
      await create.mutateAsync(bodyFromValues(values));
      onClose();
    } catch (err) {
      setError(errorText(err));
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={t('mqtt_presets.saved.save_title', 'Save as preset')}>
      <div data-testid="save-broker-preset-dialog">
        <p className={styles.hint}>
          {t(
            'mqtt_presets.saved.save_intro',
            'Saves this broker so any MQTT form can fill it in. Only admins see its login; anyone else who picks it gets the login added by the server when they save.',
          )}
        </p>
        {passwordNotIncluded && (
          <p className={styles.hint} data-testid="save-broker-preset-no-password">
            {t(
              'mqtt_presets.saved.password_not_included',
              'This form does not show the stored password, so type it below if the preset should include it.',
            )}
          </p>
        )}
        {values && <PresetEditor values={values} onChange={setValues} idPrefix="save-broker-preset" />}
        {error && <p className={styles.error} role="alert">{error}</p>}
        <div className={styles.actions}>
          <button type="button" className="btn-secondary" onClick={onClose}>
            {t('common.cancel', 'Cancel')}
          </button>
          <button
            type="button"
            className="btn-primary"
            onClick={() => void save()}
            disabled={!values || !values.name.trim() || create.isPending}
            data-testid="save-broker-preset-submit"
          >
            {t('mqtt_presets.saved.save_button', 'Save preset')}
          </button>
        </div>
      </div>
    </Modal>
  );
};

type EditTarget = { mode: 'edit'; preset: SavedBrokerPreset } | { mode: 'duplicate'; preset: SavedBrokerPreset };

export const ManageBrokerPresetsDialog: React.FC<{
  isOpen: boolean;
  onClose: () => void;
  presets: SavedBrokerPreset[];
}> = ({ isOpen, onClose, presets }) => {
  const { t } = useTranslation();
  const create = useCreateBrokerPreset();
  const update = useUpdateBrokerPreset();
  const remove = useDeleteBrokerPreset();
  const [target, setTarget] = useState<EditTarget | null>(null);
  const [values, setValues] = useState<EditorValues | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!isOpen) {
      setTarget(null);
      setValues(null);
      setConfirmDeleteId(null);
      setError('');
    }
  }, [isOpen]);

  const startEdit = (next: EditTarget) => {
    setTarget(next);
    setError('');
    setConfirmDeleteId(null);
    setValues(
      next.mode === 'edit'
        ? valuesFromPreset(next.preset)
        : valuesFromPreset(next.preset, t('mqtt_presets.saved.copy_of', 'Copy of {{name}}', { name: next.preset.name })),
    );
  };

  const saveEdit = async () => {
    if (!target || !values) return;
    setError('');
    try {
      if (target.mode === 'edit') await update.mutateAsync({ id: target.preset.id, body: bodyFromValues(values) });
      else await create.mutateAsync(bodyFromValues(values));
      setTarget(null);
      setValues(null);
    } catch (err) {
      setError(errorText(err));
    }
  };

  const doDelete = async (id: number) => {
    setError('');
    try {
      await remove.mutateAsync(id);
      setConfirmDeleteId(null);
    } catch (err) {
      setError(errorText(err));
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={t('mqtt_presets.saved.manage_title', 'Saved broker presets')}
      maxWidth="640px"
    >
      <div data-testid="manage-broker-presets-dialog">
        <p className={styles.hint}>
          {t(
            'mqtt_presets.saved.manage_intro',
            'Changing or deleting a preset does not change any source or radio already using its values. Pick the preset again in a form to apply the new values.',
          )}
        </p>
        {target && values ? (
          <>
            <h4 className={styles.subtitle}>
              {target.mode === 'edit'
                ? t('mqtt_presets.saved.edit_title', 'Edit preset')
                : t('mqtt_presets.saved.duplicate_title', 'Duplicate preset')}
            </h4>
            <PresetEditor values={values} onChange={setValues} idPrefix="manage-broker-preset" />
            {error && <p className={styles.error} role="alert">{error}</p>}
            <div className={styles.actions}>
              <button type="button" className="btn-secondary" onClick={() => { setTarget(null); setValues(null); }}>
                {t('common.cancel', 'Cancel')}
              </button>
              <button
                type="button"
                className="btn-primary"
                onClick={() => void saveEdit()}
                disabled={!values.name.trim() || update.isPending || create.isPending}
                data-testid="manage-broker-preset-submit"
              >
                {t('mqtt_presets.saved.save_button', 'Save preset')}
              </button>
            </div>
          </>
        ) : (
          <>
            {presets.length === 0 ? (
              <p className={styles.hint}>{t('mqtt_presets.saved.none', 'No saved presets yet. Use Save as preset in an MQTT form.')}</p>
            ) : (
              <ul className={styles.list}>
                {presets.map((p) => (
                  <li key={p.id} className={styles.row} data-testid={`saved-broker-preset-${p.id}`}>
                    <div className={styles.rowText}>
                      <strong>{p.name}</strong>
                      <span className={styles.endpoint}>
                        {`${p.tls ? 'mqtts' : 'mqtt'}://${p.host}:${p.port}`}
                        {p.rootTopic ? ` · ${p.rootTopic}` : ''}
                      </span>
                    </div>
                    {confirmDeleteId === p.id ? (
                      <div className={styles.rowActions}>
                        <span>{t('mqtt_presets.saved.confirm_delete', 'Delete this preset?')}</span>
                        <button type="button" className="btn-secondary" onClick={() => setConfirmDeleteId(null)}>
                          {t('common.cancel', 'Cancel')}
                        </button>
                        <button
                          type="button"
                          className={`btn-secondary ${styles.danger}`}
                          onClick={() => void doDelete(p.id)}
                          disabled={remove.isPending}
                          data-testid={`saved-broker-preset-confirm-delete-${p.id}`}
                        >
                          {t('common.delete', 'Delete')}
                        </button>
                      </div>
                    ) : (
                      <div className={styles.rowActions}>
                        <button type="button" className="btn-secondary" onClick={() => startEdit({ mode: 'edit', preset: p })}>
                          {t('common.edit', 'Edit')}
                        </button>
                        <button
                          type="button"
                          className="btn-secondary"
                          onClick={() => startEdit({ mode: 'duplicate', preset: p })}
                        >
                          {t('mqtt_presets.saved.duplicate', 'Duplicate')}
                        </button>
                        <button
                          type="button"
                          className="btn-secondary"
                          onClick={() => setConfirmDeleteId(p.id)}
                          data-testid={`saved-broker-preset-delete-${p.id}`}
                        >
                          {t('common.delete', 'Delete')}
                        </button>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {error && <p className={styles.error} role="alert">{error}</p>}
            <div className={styles.actions}>
              <button type="button" className="btn-secondary" onClick={onClose}>
                {t('common.close', 'Close')}
              </button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
};
