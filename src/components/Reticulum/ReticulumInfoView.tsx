/**
 * ReticulumInfoView — status/health panel for a Reticulum source (#3960
 * Phase 1b WP5).
 *
 * R2 (build spec §0, "log-tail DESCOPE, INCLUDE WP-B"): no `CliConsoleBody`
 * bridge-log tail — there is no bridge log protocol/route for one to back
 * onto, and `CliConsoleBody` is a command console, not a tailer. This view
 * is a read-only summary of the most recently polled `/status` snapshot
 * (`useReticulum`, 30s cadence — R4 "no realtime"): connected state, attach
 * `mode`, interface/destination counts, and the RNS daemon / bridge version
 * strings WP-B cached from the bridge's last `welcome`/`status` frame. No
 * transport ID (Phase 3, R2).
 */
import React from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import type { ReticulumStatus, ReticulumInterfaceRow } from '../../types/reticulum';
import { UiIcon } from '../icons';
import styles from './ReticulumInfoView.module.css';

interface ReticulumInfoViewProps {
  status: ReticulumStatus | null;
  /**
   * Live interface snapshots (#6120). Only interfaces that report at least one
   * RNode gauge (airtime / channel load / noise floor / interference / CPU /
   * battery) render a status card — every other interface is omitted here.
   */
  interfaces?: ReticulumInterfaceRow[];
  loading?: boolean;
}

/** One hide-if-empty row inside an interface's status card. */
interface GaugeRow {
  key: string;
  label: string;
  value: string;
}

/** Compact "time since" for the interference timestamp (RNS epoch SECONDS). */
function formatAgoSeconds(tsSeconds: number): string {
  const sec = Math.max(0, Math.floor(Date.now() / 1000 - tsSeconds));
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h`;
  return `${Math.floor(sec / 86400)}d`;
}

/** Joins the short (15s) / long (1h) window samples, skipping absent ones. */
function windowValue(short: number | null, long: number | null): string | null {
  const parts: string[] = [];
  if (short != null) parts.push(`${short}% (15s)`);
  if (long != null) parts.push(`${long}% (1h)`);
  return parts.length ? parts.join(' · ') : null;
}

/**
 * Build the hide-empty gauge rows for one interface (#6120). A field with no
 * value yields no row, so a non-RNode interface (every gauge null) returns an
 * empty list and renders no card at all.
 */
function buildInterfaceGaugeRows(iface: ReticulumInterfaceRow, t: TFunction): GaugeRow[] {
  const rows: GaugeRow[] = [];

  if (iface.batteryPercent != null) {
    const state = iface.batteryState ? ` (${iface.batteryState})` : '';
    rows.push({
      key: 'battery',
      label: t('reticulum.info.iface_battery', 'Battery'),
      value: `${iface.batteryPercent}%${state}`,
    });
  }

  const airtime = windowValue(iface.airtimeShort, iface.airtimeLong);
  if (airtime) {
    rows.push({ key: 'airtime', label: t('reticulum.info.iface_airtime', 'Airtime'), value: airtime });
  }

  const channelLoad = windowValue(iface.channelLoadShort, iface.channelLoadLong);
  if (channelLoad) {
    rows.push({ key: 'channel_load', label: t('reticulum.info.iface_channel_load', 'Channel load'), value: channelLoad });
  }

  if (iface.noiseFloor != null) {
    rows.push({ key: 'noise_floor', label: t('reticulum.info.iface_noise_floor', 'Noise floor'), value: `${iface.noiseFloor} dBm` });
  }

  if (iface.interference != null) {
    rows.push({ key: 'interference', label: t('reticulum.info.iface_interference', 'Interference'), value: `${iface.interference} dBm` });
  }

  if (iface.interferenceLastDbm != null && iface.interferenceLastTs != null) {
    rows.push({
      key: 'interference_last',
      label: t('reticulum.info.iface_interference_last', 'Last interference'),
      value: `${iface.interferenceLastDbm} dBm, ${formatAgoSeconds(iface.interferenceLastTs)} ${t('reticulum.info.iface_ago', 'ago')}`,
    });
  }

  if (iface.cpuLoad != null) {
    rows.push({ key: 'cpu_load', label: t('reticulum.info.iface_cpu_load', 'CPU load'), value: `${iface.cpuLoad}%` });
  }

  return rows;
}

export const ReticulumInfoView: React.FC<ReticulumInfoViewProps> = ({ status, interfaces = [], loading }) => {
  const { t } = useTranslation();

  // Only interfaces that actually report an RNode gauge get a status card
  // (#6120). A non-RNode interface reports none, so it is skipped and the whole
  // section is hidden when nothing reports anything.
  const interfaceGauges = interfaces
    .map((iface) => ({ iface, rows: buildInterfaceGaugeRows(iface, t) }))
    .filter((entry) => entry.rows.length > 0);

  if (!status) {
    return (
      <div className={styles.view} data-testid="reticulum-info-view">
        <div className={styles.empty}>
          {loading
            ? t('reticulum.info.loading', 'Loading status…')
            : t('reticulum.info.no_status', 'No status available yet.')}
        </div>
      </div>
    );
  }

  const connected = status.connected;
  const modeLabel = status.mode === 'attach'
    ? t('reticulum.info.mode_attach', 'Attach (shared rnsd)')
    : status.mode === 'tcp_peer'
      ? t('reticulum.info.mode_tcp_peer', 'TCP peer')
      : t('reticulum.info.mode_unknown', 'Unknown');

  return (
    <div className={styles.view} data-testid="reticulum-info-view">
      <section className={styles.card} data-testid="reticulum-info-connection">
        <header className={styles.cardHeader}>
          <div className={styles.cardTitle}>
            <UiIcon name="info" size={16} />
            <span>{t('reticulum.info.connection', 'Connection')}</span>
          </div>
          <span
            className={`${styles.chip} ${connected ? styles.chipOnline : styles.chipOffline}`}
            data-testid="reticulum-info-status-chip"
          >
            <UiIcon name={connected ? 'statusOn' : 'statusOff'} size={12} />
            {connected
              ? t('reticulum.status.connected', 'Connected')
              : t('reticulum.status.disconnected', 'Disconnected')}
          </span>
        </header>
        <dl className={styles.statGrid}>
          <div className={styles.stat}>
            <dt>
              <UiIcon name="wifi" size={13} />
              {t('reticulum.info.attach_mode', 'Attach mode')}
            </dt>
            <dd data-testid="reticulum-info-mode">{modeLabel}</dd>
          </div>
        </dl>
      </section>

      <section className={styles.card} data-testid="reticulum-info-inventory">
        <header className={styles.cardHeader}>
          <div className={styles.cardTitle}>
            <UiIcon name="network" size={16} />
            <span>{t('reticulum.info.inventory', 'Inventory')}</span>
          </div>
        </header>
        <dl className={styles.statGrid}>
          <div className={styles.stat}>
            <dt>
              <UiIcon name="server" size={13} />
              {t('reticulum.info.interfaces', 'Interfaces')}
            </dt>
            <dd data-testid="reticulum-info-interface-count">{status.interfaceCount}</dd>
          </div>
          <div className={styles.stat}>
            <dt>
              <UiIcon name="nodes" size={13} />
              {t('reticulum.info.destinations', 'Destinations')}
            </dt>
            <dd data-testid="reticulum-info-destination-count">{status.destinationCount}</dd>
          </div>
        </dl>
      </section>

      {interfaceGauges.length > 0 && (
        <section className={styles.card} data-testid="reticulum-info-interface-status">
          <header className={styles.cardHeader}>
            <div className={styles.cardTitle}>
              <UiIcon name="zap" size={16} />
              <span>{t('reticulum.info.interface_status', 'Interface status')}</span>
            </div>
          </header>
          {interfaceGauges.map(({ iface, rows }) => (
            <div
              key={iface.interfaceName}
              className={styles.ifaceBlock}
              data-testid={`reticulum-info-iface-${iface.interfaceName}`}
            >
              <div className={styles.ifaceName}>{iface.interfaceName}</div>
              <dl className={styles.statGrid}>
                {rows.map((row) => (
                  <div
                    key={row.key}
                    className={styles.stat}
                    data-testid={`reticulum-info-iface-${iface.interfaceName}-${row.key}`}
                  >
                    <dt>{row.label}</dt>
                    <dd>{row.value}</dd>
                  </div>
                ))}
              </dl>
            </div>
          ))}
        </section>
      )}

      <section className={styles.card} data-testid="reticulum-info-versions">
        <header className={styles.cardHeader}>
          <div className={styles.cardTitle}>
            <UiIcon name="code" size={16} />
            <span>{t('reticulum.info.versions', 'Versions')}</span>
          </div>
        </header>
        <dl className={styles.statGrid}>
          <div className={styles.stat}>
            <dt>{t('reticulum.info.rns_version', 'RNS version')}</dt>
            <dd data-testid="reticulum-info-rns-version">{status.rnsVersion ?? '—'}</dd>
          </div>
          <div className={styles.stat}>
            <dt>{t('reticulum.info.bridge_version', 'Bridge version')}</dt>
            <dd data-testid="reticulum-info-bridge-version">
              {status.bridgeVersion ?? t('reticulum.info.version_unknown', 'unknown')}
            </dd>
          </div>
        </dl>
      </section>
    </div>
  );
};

export default ReticulumInfoView;
