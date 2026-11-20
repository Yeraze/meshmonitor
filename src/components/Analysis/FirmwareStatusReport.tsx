/**
 * Firmware Status report (#4943, Phase 1: read-only).
 *
 * One row per Meshtastic TCP / MeshCore source's own radio: installed firmware,
 * the newest release on that source's channel, and whether an update is
 * available. Admin only (the /api/firmware routes are). Meshtastic rows link to
 * the source's existing OTA panel; MeshCore rows pick their stable/alpha
 * channel here, since MeshCore has no OTA panel yet. Nothing here talks to a
 * radio.
 */
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import apiService from '../../services/api';
import { formatDateTime } from '../../utils/datetime';
import { UiIcon } from '../icons';
import styles from './FirmwareStatusReport.module.css';

interface FleetRow {
  sourceId: string;
  sourceName: string;
  protocol: 'meshtastic' | 'meshcore';
  enabled: boolean;
  connected: boolean;
  device: string | null;
  hardware: string | null;
  role: 'companion' | 'repeater' | 'room-server' | null;
  installed: string | null;
  latest: string | null;
  latestUrl: string | null;
  channel: string;
  status: 'up_to_date' | 'update_available' | 'unknown';
  reason: string | null;
  method: 'ota' | 'manual';
}

interface FleetResponse {
  success: boolean;
  data?: { rows: FleetRow[]; checkedAt: { meshtastic: number | null; meshcore: number | null } };
  error?: string;
}

export default function FirmwareStatusReport() {
  const { t } = useTranslation();
  const [rows, setRows] = useState<FleetRow[] | null>(null);
  const [checkedAt, setCheckedAt] = useState<{ meshtastic: number | null; meshcore: number | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const apply = (res: FleetResponse) => {
    if (!res.success || !res.data) throw new Error(res.error || 'Request failed');
    setRows(res.data.rows);
    setCheckedAt(res.data.checkedAt);
    setError(null);
  };

  const load = useCallback(async () => {
    try {
      apply(await apiService.get<FleetResponse>('/api/firmware/fleet'));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const checkNow = async () => {
    setBusy(true);
    try {
      apply(await apiService.post<FleetResponse>('/api/firmware/fleet/check'));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const setChannel = async (sourceId: string, channel: string) => {
    setBusy(true);
    try {
      await apiService.post('/api/firmware/channel', { channel, sourceId });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const statusLabel = (r: FleetRow) => {
    if (r.status === 'update_available') return t('firmware_status.update_available', 'Update available');
    if (r.status === 'up_to_date') return t('firmware_status.up_to_date', 'Up to date');
    switch (r.reason) {
      case 'disconnected':
        return t('firmware_status.unknown_disconnected', 'Unknown: not connected');
      case 'no_version':
        return t('firmware_status.unknown_no_version', 'Unknown: version not reported');
      case 'unparseable_version':
        return t('firmware_status.unknown_unparseable', 'Unknown: version not recognised');
      case 'no_release':
        return t('firmware_status.unknown_no_release', 'Unknown: no release found for this channel');
      case 'channel_has_no_feed':
        return t('firmware_status.unknown_custom', 'Unknown: custom or local firmware channel');
      case 'unknown_role':
        return t('firmware_status.unknown_role', 'Unknown: firmware role not detected');
      default:
        return t('firmware_status.unknown', 'Unknown');
    }
  };

  const statusClass = (r: FleetRow) =>
    r.status === 'update_available' ? styles.statusUpdate : r.status === 'up_to_date' ? styles.statusOk : styles.statusUnknown;

  const roleLabel = (r: FleetRow) => {
    if (r.protocol === 'meshtastic') return '—';
    if (r.role === 'companion') return t('firmware_status.role_companion', 'Companion');
    if (r.role === 'repeater') return t('firmware_status.role_repeater', 'Repeater');
    if (r.role === 'room-server') return t('firmware_status.role_room_server', 'Room server');
    return t('firmware_status.unknown', 'Unknown');
  };

  const lastChecked = [checkedAt?.meshtastic, checkedAt?.meshcore].filter((v): v is number => typeof v === 'number');

  return (
    <div className={styles.report}>
      <h2 className={styles.title}>
        <UiIcon name="firmware" size={20} /> {t('firmware_status.title', 'Firmware Status')}
      </h2>
      <p className={styles.intro}>
        {t(
          'firmware_status.intro',
          "Installed firmware on each source's own radio, against the newest release on that source's channel. Release lists refresh every 6 hours. Nothing is sent to your radios.",
        )}
      </p>
      <div className={styles.controls}>
        <button type="button" className={styles.button} onClick={() => void checkNow()} disabled={busy}>
          <UiIcon name="refresh" size={14} /> {t('firmware_status.check_now', 'Check for updates')}
        </button>
        {lastChecked.length > 0 && (
          <span className={styles.muted}>
            {t('firmware_status.last_checked', 'Last checked {{when}}', {
              when: formatDateTime(new Date(Math.min(...lastChecked))),
            })}
          </span>
        )}
      </div>
      {error && <p className={styles.error} role="alert">{error}</p>}
      {rows && rows.length === 0 && (
        <p className={styles.muted}>{t('firmware_status.empty', 'No Meshtastic or MeshCore radio sources are set up.')}</p>
      )}
      {rows && rows.length > 0 && (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>{t('firmware_status.col_device', 'Device')}</th>
                <th>{t('firmware_status.col_source', 'Source')}</th>
                <th>{t('firmware_status.col_protocol', 'Protocol')}</th>
                <th>{t('firmware_status.col_hardware', 'Hardware')}</th>
                <th>{t('firmware_status.col_role', 'Role')}</th>
                <th>{t('firmware_status.col_installed', 'Installed')}</th>
                <th>{t('firmware_status.col_latest', 'Latest')}</th>
                <th>{t('firmware_status.col_channel', 'Channel')}</th>
                <th>{t('firmware_status.col_status', 'Status')}</th>
                <th>{t('firmware_status.col_method', 'Update')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.sourceId}>
                  <td>{r.device ?? '—'}</td>
                  <td>{r.sourceName}</td>
                  <td>{r.protocol === 'meshtastic' ? 'Meshtastic' : 'MeshCore'}</td>
                  <td>{r.hardware ?? '—'}</td>
                  <td>{roleLabel(r)}</td>
                  <td className={styles.mono}>{r.installed ?? '—'}</td>
                  <td className={styles.mono}>
                    {r.latest ? (
                      r.latestUrl ? (
                        <a href={r.latestUrl} target="_blank" rel="noopener noreferrer">{r.latest}</a>
                      ) : (
                        r.latest
                      )
                    ) : (
                      '—'
                    )}
                  </td>
                  <td>
                    {r.protocol === 'meshcore' ? (
                      <select
                        className={styles.select}
                        aria-label={t('firmware_status.channel_for', 'Release channel for {{name}}', { name: r.sourceName })}
                        value={r.channel === 'alpha' ? 'alpha' : 'stable'}
                        disabled={busy}
                        onChange={(e) => void setChannel(r.sourceId, e.target.value)}
                      >
                        <option value="stable">{t('firmware_status.channel_stable', 'Stable')}</option>
                        <option value="alpha">{t('firmware_status.channel_alpha', 'Alpha (prereleases)')}</option>
                      </select>
                    ) : (
                      r.channel
                    )}
                  </td>
                  <td><span className={statusClass(r)}>{statusLabel(r)}</span></td>
                  <td>
                    {r.protocol === 'meshtastic' ? (
                      <Link to={`/source/${encodeURIComponent(r.sourceId)}/configuration#config-firmware`}>
                        {r.method === 'ota'
                          ? t('firmware_status.method_ota', 'OTA update')
                          : t('firmware_status.method_details', 'Details')}
                      </Link>
                    ) : (
                      <span className={styles.muted}>{t('firmware_status.method_manual', 'Manual (USB / app)')}</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
