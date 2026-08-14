/**
 * ReticulumConfigurationView — RNode radio configuration + device info for an
 * `own`-mode Reticulum source (#3960 Phase 3). Only mounted in own mode (the
 * sub-toolbar hides the item otherwise), because editable radio params exist
 * only when the bridge drives the RNode directly. Write controls require
 * `configuration:write`, mirroring MeshCore's config view.
 *
 * Talks to WP4's routes:
 *   GET/PUT /api/sources/:id/reticulum/radio-config
 *   GET     /api/sources/:id/reticulum/device-info
 * Both use the ok() envelope, so responses are read via `.data`.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import api from '../../services/api';
import { useAuth } from '../../contexts/AuthContext';
import { UiIcon } from '../icons';
import styles from './ReticulumConfigurationView.module.css';

interface RadioConfig {
  frequency: number | null;
  bandwidth: number | null;
  spreadingFactor: number | null;
  codingRate: number | null;
  txPower: number | null;
  stAlock: number | null;
  ltAlock: number | null;
  radioState: number | null;
}

interface DeviceInfo {
  firmwareVersion?: string | null;
  mcu?: string | null;
  platform?: string | null;
  chipTemp?: number | null;
  csma?: Record<string, unknown> | null;
  phy?: Record<string, unknown> | null;
}

interface ReticulumConfigurationViewProps {
  sourceId: string;
}

const EMPTY: RadioConfig = {
  frequency: null, bandwidth: null, spreadingFactor: null, codingRate: null,
  txPower: null, stAlock: null, ltAlock: null, radioState: null,
};

function unwrap<T>(res: unknown): T | null {
  if (res && typeof res === 'object' && 'data' in (res as Record<string, unknown>)) {
    return (res as { data: T }).data;
  }
  return (res as T) ?? null;
}

export const ReticulumConfigurationView: React.FC<ReticulumConfigurationViewProps> = ({ sourceId }) => {
  const { t } = useTranslation();
  const { hasPermission } = useAuth();
  const canWrite = hasPermission('configuration', 'write');

  const [config, setConfig] = useState<RadioConfig>(EMPTY);
  const [deviceInfo, setDeviceInfo] = useState<DeviceInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  const base = `/api/sources/${encodeURIComponent(sourceId)}/reticulum`;

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [cfgRes, devRes] = await Promise.all([
        api.get<unknown>(`${base}/radio-config`),
        api.get<unknown>(`${base}/device-info`).catch(() => null),
      ]);
      const cfg = unwrap<RadioConfig>(cfgRes);
      if (cfg) setConfig({ ...EMPTY, ...cfg });
      const dev = devRes ? unwrap<DeviceInfo>(devRes) : null;
      setDeviceInfo(dev);
    } catch (e) {
      setError(e instanceof Error ? e.message : t('reticulum.config.loadError', 'Failed to load radio configuration'));
    } finally {
      setLoading(false);
    }
  }, [base, t]);

  useEffect(() => { void load(); }, [load]);

  const setField = (key: keyof RadioConfig, value: string) => {
    const num = value === '' ? null : Number(value);
    setConfig(prev => ({ ...prev, [key]: Number.isNaN(num as number) ? prev[key] : num }));
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    setStatus(null);
    try {
      await api.post(`${base}/radio-config`, config);
      setStatus(t('reticulum.config.saved', 'Radio configuration applied'));
      void load();
    } catch (e) {
      setError(e instanceof Error ? e.message : t('reticulum.config.saveError', 'Failed to apply radio configuration'));
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return <div className={styles.view}><div className={styles.muted}>{t('common.loading', 'Loading…')}</div></div>;
  }

  const disabled = !canWrite || saving;

  return (
    <div className={styles.view}>
      {!canWrite && (
        <div className={styles.banner} role="status">
          <UiIcon name="info" size={14} />
          <span>{t('reticulum.config.readOnly', 'You have read-only access — radio configuration cannot be changed.')}</span>
        </div>
      )}
      {error && <div className={styles.error} role="alert">{error}</div>}
      {status && <div className={styles.success} role="status">{status}</div>}

      <section className={styles.section}>
        <h3 className={styles.heading}>{t('reticulum.config.radioHeading', 'RNode Radio')}</h3>
        <div className={styles.grid}>
          <label className={styles.field}>
            <span>{t('reticulum.config.frequency', 'Frequency (Hz)')}</span>
            <input type="number" value={config.frequency ?? ''} disabled={disabled}
              onChange={e => setField('frequency', e.target.value)} />
          </label>
          <label className={styles.field}>
            <span>{t('reticulum.config.bandwidth', 'Bandwidth (Hz)')}</span>
            <input type="number" value={config.bandwidth ?? ''} disabled={disabled}
              onChange={e => setField('bandwidth', e.target.value)} />
          </label>
          <label className={styles.field}>
            <span>{t('reticulum.config.sf', 'Spreading Factor')}</span>
            <input type="number" min={5} max={12} value={config.spreadingFactor ?? ''} disabled={disabled}
              onChange={e => setField('spreadingFactor', e.target.value)} />
          </label>
          <label className={styles.field}>
            <span>{t('reticulum.config.cr', 'Coding Rate')}</span>
            <input type="number" min={5} max={8} value={config.codingRate ?? ''} disabled={disabled}
              onChange={e => setField('codingRate', e.target.value)} />
          </label>
          <label className={styles.field}>
            <span>{t('reticulum.config.txPower', 'TX Power (dBm)')}</span>
            <input type="number" min={0} max={22} value={config.txPower ?? ''} disabled={disabled}
              onChange={e => setField('txPower', e.target.value)} />
          </label>
          <label className={styles.field}>
            <span>{t('reticulum.config.stAlock', 'Short Airtime Lock (%)')}</span>
            <input type="number" min={0} max={100} value={config.stAlock ?? ''} disabled={disabled}
              onChange={e => setField('stAlock', e.target.value)} />
          </label>
          <label className={styles.field}>
            <span>{t('reticulum.config.ltAlock', 'Long Airtime Lock (%)')}</span>
            <input type="number" min={0} max={100} value={config.ltAlock ?? ''} disabled={disabled}
              onChange={e => setField('ltAlock', e.target.value)} />
          </label>
          <label className={styles.checkField}>
            <input type="checkbox" checked={config.radioState === 1} disabled={disabled}
              onChange={e => setConfig(prev => ({ ...prev, radioState: e.target.checked ? 1 : 0 }))} />
            <span>{t('reticulum.config.radioOn', 'Radio on')}</span>
          </label>
        </div>
        <div className={styles.actions}>
          <button className={styles.saveBtn} onClick={() => void save()} disabled={disabled}>
            {saving ? t('common.saving', 'Applying…') : t('reticulum.config.apply', 'Apply')}
          </button>
        </div>
      </section>

      <section className={styles.section}>
        <h3 className={styles.heading}>{t('reticulum.config.deviceHeading', 'Device Info')}</h3>
        {deviceInfo ? (
          <dl className={styles.deviceGrid}>
            {deviceInfo.firmwareVersion && (<><dt>{t('reticulum.config.firmware', 'Firmware')}</dt><dd>{deviceInfo.firmwareVersion}</dd></>)}
            {deviceInfo.mcu && (<><dt>{t('reticulum.config.mcu', 'MCU')}</dt><dd>{deviceInfo.mcu}</dd></>)}
            {deviceInfo.platform && (<><dt>{t('reticulum.config.platform', 'Platform')}</dt><dd>{deviceInfo.platform}</dd></>)}
            {typeof deviceInfo.chipTemp === 'number' && (<><dt>{t('reticulum.config.chipTemp', 'Chip temp')}</dt><dd>{deviceInfo.chipTemp} °C</dd></>)}
          </dl>
        ) : (
          <div className={styles.muted}>{t('reticulum.config.noDevice', 'Device info unavailable.')}</div>
        )}
      </section>
    </div>
  );
};

export default ReticulumConfigurationView;
