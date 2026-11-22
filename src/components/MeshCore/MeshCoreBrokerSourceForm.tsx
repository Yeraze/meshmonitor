/**
 * Source modal fields for the embedded MeshCore MQTT broker (#6197).
 *
 * Controlled: the dashboard modal owns the state and saves it through
 * `brokerFormToConfig`. The own-identity key panel talks to the server
 * directly, and only for a saved source (the key is stored per source id).
 */
import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import api, { ApiError } from '../../services/api';
import { PasswordField } from '../shared/config/PasswordField';
import { NumberInput } from '../common/NumberInput';
import { UiIcon } from '../icons';
import { emptyBrokerTarget, type BrokerFormState, type BrokerTargetForm } from './meshcoreBrokerForm';
import styles from './MeshCoreBrokerSourceForm.module.css';

interface Props {
  value: BrokerFormState;
  onChange: (next: BrokerFormState) => void;
  /** Saved source id, when editing. The key panel needs one. */
  sourceId: string | null;
  /** Placeholder for a password input that already has a stored value. */
  secretPlaceholder: (path: string) => string;
}

interface KeyStatus {
  stored: boolean;
  publicKey: string | null;
  keyRotated: boolean;
  canStore: boolean;
  reason: string | null;
}

const BrokerKeyPanel: React.FC<{ sourceId: string }> = ({ sourceId }) => {
  const { t } = useTranslation();
  const [status, setStatus] = useState<KeyStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const base = `/api/sources/${encodeURIComponent(sourceId)}/meshcore-broker/key`;

  const load = useCallback(async () => {
    try {
      const res = await api.get<{ data: KeyStatus }>(base);
      setStatus(res.data);
    } catch {
      setStatus(null);
    }
  }, [base]);

  useEffect(() => {
    void load();
  }, [load]);

  const run = async (op: () => Promise<{ data: KeyStatus }>) => {
    setBusy(true);
    setError('');
    try {
      setStatus((await op()).data);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t('source.form.mcb_key_error', 'Could not change the key'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={styles.keyPanel}>
      <div className={styles.keyRow}>
        <UiIcon name="key" size={14} />
        <span className={styles.keyText}>
          {status?.stored && status.publicKey
            ? t('source.form.mcb_key_public', 'MeshMonitor observer key: {{key}}', {
                key: `${status.publicKey.slice(0, 16)}…`,
              })
            : t('source.form.mcb_key_none', 'No MeshMonitor observer key yet. Own-identity targets stay off until you add one.')}
        </span>
      </div>
      {status?.keyRotated && (
        <p className={styles.warn}>
          {t('source.form.mcb_key_rotated', 'The stored key cannot be read with the current SESSION_SECRET. Generate a new one.')}
        </p>
      )}
      {status && !status.canStore && <p className={styles.warn}>{status.reason}</p>}
      <div className={styles.keyActions}>
        <button
          type="button"
          className={styles.button}
          disabled={busy || status?.canStore === false}
          onClick={() => void run(() => api.put<{ data: KeyStatus }>(base, { generate: true }))}
        >
          {status?.stored
            ? t('source.form.mcb_key_regenerate', 'Generate a new key')
            : t('source.form.mcb_key_generate', 'Generate key')}
        </button>
        {status?.stored && (
          <button
            type="button"
            className={styles.button}
            disabled={busy}
            onClick={() => void run(() => api.delete<{ data: KeyStatus }>(base))}
          >
            {t('source.form.mcb_key_clear', 'Remove key')}
          </button>
        )}
      </div>
      {error && <p className={styles.warn}>{error}</p>}
    </div>
  );
};

export const MeshCoreBrokerSourceForm: React.FC<Props> = ({ value, onChange, sourceId, secretPlaceholder }) => {
  const { t } = useTranslation();
  const set = <K extends keyof BrokerFormState>(key: K, v: BrokerFormState[K]) => onChange({ ...value, [key]: v });
  const setTarget = (i: number, patch: Partial<BrokerTargetForm>) =>
    onChange({ ...value, targets: value.targets.map((tg, j) => (j === i ? { ...tg, ...patch } : tg)) });
  const removeTarget = (i: number) => onChange({ ...value, targets: value.targets.filter((_, j) => j !== i) });

  return (
    <div className={styles.form}>
      <p className={styles.intro}>
        {t(
          'source.form.mcb_intro',
          'MeshCore observers publish straight to MeshMonitor on meshcore/{IATA}/{PUBKEY}/packets and /status. No radio: this source never transmits.',
        )}
      </p>

      <label className="dashboard-form-field">
        <span className="dashboard-form-label">{t('source.form.mcb_port', 'Listener port (TCP)')}</span>
        <NumberInput
          className="dashboard-form-input"
          integer
          min={1}
          max={65535}
          value={Number(value.port)}
          onChange={(n) => set('port', String(n))}
        />
      </label>

      <label className="dashboard-form-field">
        <span className="dashboard-form-label">{t('source.form.mcb_regions', 'Allowed regions (optional)')}</span>
        <input
          className="dashboard-form-input"
          type="text"
          value={value.regions}
          placeholder="SEA, PDX"
          onChange={(e) => set('regions', e.target.value)}
        />
        <span className="dashboard-form-help">
          {t('source.form.mcb_regions_help', 'IATA codes, comma separated. Leave blank to accept any region.')}
        </span>
      </label>

      <fieldset className={styles.group}>
        <legend className={styles.legend}>{t('source.form.mcb_auth', 'Who may connect')}</legend>
        <label className="dashboard-form-field">
          <span className="dashboard-form-label">{t('source.form.mcb_token_audience', 'Token audience')}</span>
          <input
            className="dashboard-form-input"
            type="text"
            value={value.tokenAudience}
            onChange={(e) => set('tokenAudience', e.target.value)}
            autoComplete="off"
          />
          <span className="dashboard-form-help">
            {t(
              'source.form.mcb_token_audience_help',
              'The audience observers sign their token for. Leave blank to turn token logins off.',
            )}
          </span>
        </label>
        <label className="dashboard-form-field">
          <span className="dashboard-form-label">{t('source.form.mcb_allowlist', 'Allowed observer public keys')}</span>
          <textarea
            className={`dashboard-form-input ${styles.keys}`}
            rows={3}
            value={value.allowedObservers}
            onChange={(e) => set('allowedObservers', e.target.value)}
            spellCheck={false}
          />
          <span className="dashboard-form-help">
            {t(
              'source.form.mcb_allowlist_help',
              'One 64-character hex key per line. Binds every login: a token login needs a key on this list, and a static login may only publish under keys on it.',
            )}
          </span>
        </label>
        <label className="dashboard-form-field">
          <span className="dashboard-form-label">{t('source.form.mc_local_observer', 'My node (optional)')}</span>
          <input
            className="dashboard-form-input"
            type="text"
            value={value.localObserverKey}
            onChange={(e) => set('localObserverKey', e.target.value)}
            spellCheck={false}
            autoComplete="off"
          />
          <span className="dashboard-form-help">
            {t(
              'source.form.mc_local_observer_help',
              "Public key of the observer that is your own node. It is marked as \"My node\" on the dashboard map and this source's pages. Display only: nothing is sent to it.",
            )}
          </span>
        </label>
        <label className="dashboard-form-field">
          <span className="dashboard-form-label">{t('source.form.mcb_username', 'Static username (optional)')}</span>
          <input
            className="dashboard-form-input"
            type="text"
            value={value.username}
            onChange={(e) => set('username', e.target.value)}
            autoComplete="off"
          />
        </label>
        <label className="dashboard-form-field">
          <span className="dashboard-form-label">{t('source.form.mcb_password', 'Static password (optional)')}</span>
          <PasswordField
            className="dashboard-form-input"
            value={value.password}
            onChange={(e) => set('password', e.target.value)}
            autoComplete="new-password"
            placeholder={secretPlaceholder('auth.password')}
          />
          <span className="dashboard-form-help">
            {t('source.form.mcb_static_help', 'For observers that use a fixed login. They may still publish only under allowlisted keys. Anonymous logins are always refused.')}
          </span>
        </label>
      </fieldset>

      <fieldset className={styles.group}>
        <legend className={styles.legend}>{t('source.form.mcb_limits', 'Limits')}</legend>
        <div className={styles.limits}>
          <label className="dashboard-form-field">
            <span className="dashboard-form-label">{t('source.form.mcb_max_clients', 'Max observers')}</span>
            <NumberInput
              className="dashboard-form-input"
              integer
              min={1}
              max={1000}
              value={Number(value.maxClients)}
              onChange={(n) => set('maxClients', String(n))}
            />
          </label>
          <label className="dashboard-form-field">
            <span className="dashboard-form-label">{t('source.form.mcb_max_rate', 'Messages per second, each')}</span>
            <NumberInput
              className="dashboard-form-input"
              integer
              min={1}
              max={200}
              value={Number(value.maxMessagesPerSecond)}
              onChange={(n) => set('maxMessagesPerSecond', String(n))}
            />
          </label>
          <label className="dashboard-form-field">
            <span className="dashboard-form-label">{t('source.form.mcb_max_payload', 'Max payload (KB)')}</span>
            <NumberInput
              className="dashboard-form-input"
              integer
              min={1}
              max={1024}
              value={Number(value.maxPayloadKb)}
              onChange={(n) => set('maxPayloadKb', String(n))}
            />
          </label>
        </div>
        <span className="dashboard-form-help">
          {t('source.form.mcb_limits_help', 'Messages over the rate are dropped and counted; the observer stays connected.')}
        </span>
      </fieldset>

      <fieldset className={styles.group}>
        <legend className={styles.legend}>{t('source.form.mcb_forwarding', 'Upstream forwarding (optional)')}</legend>
        <p className={styles.warn}>
          <UiIcon name="alert" size={14} />{' '}
          {t(
            'source.form.mcb_forward_warning',
            'Forwarding sends observer data out of MeshMonitor to the broker you name. Only the observers you list on each target are sent.',
          )}
        </p>
        {sourceId ? (
          <BrokerKeyPanel sourceId={sourceId} />
        ) : (
          <p className="dashboard-form-help">
            {t('source.form.mcb_key_after_save', 'Save the source first to add a MeshMonitor observer key for own-identity targets.')}
          </p>
        )}
        <label className="dashboard-form-field">
          <span className="dashboard-form-label">{t('source.form.mcb_own_name', 'Own-identity name')}</span>
          <input
            className="dashboard-form-input"
            type="text"
            value={value.ownIdentityName}
            placeholder="MeshMonitor"
            onChange={(e) => set('ownIdentityName', e.target.value)}
          />
        </label>

        {value.targets.map((tg, i) => (
          <div key={tg.id} className={styles.target}>
            <div className={styles.targetHead}>
              <label className="dashboard-form-checkbox">
                <input type="checkbox" checked={tg.enabled} onChange={(e) => setTarget(i, { enabled: e.target.checked })} />
                <span>{t('source.form.mcb_target_enabled', 'Forward to this broker')}</span>
              </label>
              <button
                type="button"
                className={styles.button}
                onClick={() => removeTarget(i)}
                aria-label={t('source.form.mcb_target_remove', 'Remove target')}
              >
                <UiIcon name="delete" size={14} />
              </button>
            </div>
            {tg.enabled && (
              <p className={styles.warn}>
                {t('source.form.mcb_target_warning', 'Observer data from the listed keys leaves MeshMonitor for this broker.')}
              </p>
            )}
            <label className="dashboard-form-field">
              <span className="dashboard-form-label">{t('source.form.mcb_target_label', 'Label')}</span>
              <input
                className="dashboard-form-input"
                type="text"
                value={tg.label}
                onChange={(e) => setTarget(i, { label: e.target.value })}
              />
            </label>
            <label className="dashboard-form-field">
              <span className="dashboard-form-label">{t('source.form.mcb_target_url', 'Broker URL')}</span>
              <input
                className="dashboard-form-input"
                type="text"
                value={tg.url}
                placeholder="mqtts://broker.example:8883"
                onChange={(e) => setTarget(i, { url: e.target.value })}
              />
            </label>
            <label className="dashboard-form-field">
              <span className="dashboard-form-label">{t('source.form.mcb_target_identity', 'Identity')}</span>
              <select
                className="dashboard-form-input"
                value={tg.identityMode}
                onChange={(e) => setTarget(i, { identityMode: e.target.value === 'own' ? 'own' : 'passthrough' })}
              >
                <option value="passthrough">
                  {t('source.form.mcb_identity_passthrough', 'Pass-through (original topic, static login)')}
                </option>
                <option value="own">{t('source.form.mcb_identity_own', 'Own identity (MeshMonitor key and token)')}</option>
              </select>
              <span className="dashboard-form-help">
                {tg.identityMode === 'own'
                  ? t(
                      'source.form.mcb_identity_own_help',
                      'Works with token-only brokers like LetsMesh. Every frame appears to come from one observer.',
                    )
                  : t(
                      'source.form.mcb_identity_passthrough_help',
                      'Keeps each observer attributed. Token-only brokers like LetsMesh refuse it.',
                    )}
              </span>
            </label>
            {tg.identityMode === 'passthrough' ? (
              <>
                <label className="dashboard-form-field">
                  <span className="dashboard-form-label">{t('source.form.mcb_target_username', 'Upstream username')}</span>
                  <input
                    className="dashboard-form-input"
                    type="text"
                    value={tg.username}
                    autoComplete="off"
                    onChange={(e) => setTarget(i, { username: e.target.value })}
                  />
                </label>
                <label className="dashboard-form-field">
                  <span className="dashboard-form-label">{t('source.form.mcb_target_password', 'Upstream password')}</span>
                  <PasswordField
                    className="dashboard-form-input"
                    value={tg.password}
                    autoComplete="new-password"
                    placeholder={secretPlaceholder(`forwarding.targets.${i}.password`)}
                    onChange={(e) => setTarget(i, { password: e.target.value })}
                  />
                </label>
              </>
            ) : (
              <label className="dashboard-form-field">
                <span className="dashboard-form-label">{t('source.form.mcb_target_audience', 'Upstream token audience')}</span>
                <input
                  className="dashboard-form-input"
                  type="text"
                  value={tg.tokenAudience}
                  onChange={(e) => setTarget(i, { tokenAudience: e.target.value })}
                />
              </label>
            )}
            <label className="dashboard-form-field">
              <span className="dashboard-form-label">{t('source.form.mcb_target_observers', 'Observers to forward')}</span>
              <textarea
                className={`dashboard-form-input ${styles.keys}`}
                rows={2}
                value={tg.observers}
                spellCheck={false}
                onChange={(e) => setTarget(i, { observers: e.target.value })}
              />
              <span className="dashboard-form-help">
                {t('source.form.mcb_target_observers_help', 'One public key per line. An empty list forwards nothing.')}
              </span>
            </label>
            <label className="dashboard-form-field">
              <span className="dashboard-form-label">{t('source.form.mcb_target_iata', 'IATA filter (optional)')}</span>
              <input
                className="dashboard-form-input"
                type="text"
                value={tg.iataFilter}
                placeholder="SEA"
                onChange={(e) => setTarget(i, { iataFilter: e.target.value })}
              />
            </label>
            <label className="dashboard-form-checkbox">
              <input
                type="checkbox"
                checked={tg.rejectUnauthorized}
                onChange={(e) => setTarget(i, { rejectUnauthorized: e.target.checked })}
              />
              <span>{t('source.form.mc_mqtt_reject_unauthorized', 'Verify TLS certificate')}</span>
            </label>
          </div>
        ))}
        <button
          type="button"
          className={styles.button}
          onClick={() => onChange({ ...value, targets: [...value.targets, emptyBrokerTarget()] })}
        >
          <UiIcon name="plus" size={14} /> {t('source.form.mcb_target_add', 'Add forwarding target')}
        </button>
      </fieldset>

      <label className="dashboard-form-checkbox">
        <input type="checkbox" checked={value.autoConnect} onChange={(e) => set('autoConnect', e.target.checked)} />
        <span>{t('source.form.mcb_auto_start', 'Start listening automatically on startup')}</span>
      </label>
    </div>
  );
};

export default MeshCoreBrokerSourceForm;
