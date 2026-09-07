/**
 * MeshCoreIngestView — the per-source surface for a `meshcore_mqtt` source (#5096).
 *
 * Deliberately NOT `MeshCorePage`. That page is built on `useMeshCore`, which
 * polls roughly twenty device endpoints (contacts, config, advert, CLI, admin)
 * that `meshcoreRouteGuard` refuses for a radio-less source by design. Threading
 * an "ingest mode" through it would mean gating every one of those calls and
 * still rendering views whose props assume a device.
 *
 * So this reads only what an ingest source actually has:
 *
 *   Overview  broker, region, connection, and the observers heard from
 *   Nodes     everything learned from adverts
 *   Channels  messages decrypted with keys we hold
 *   Packets   the existing MeshCorePacketMonitorView, reachable at last
 *
 * There is no Telemetry tab: observer battery/uptime/noise floor land as
 * ordinary telemetry rows, so the cross-source Telemetry page already graphs
 * them and a fourth copy here would drift.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import apiService from '../../services/api';
import { UiIcon } from '../icons';
import { MeshCorePacketMonitorView } from './MeshCorePacketMonitorView';
import styles from './MeshCoreIngestView.module.css';

type IngestTab = 'overview' | 'nodes' | 'channels' | 'packets';

interface ObserverRow {
  publicKey: string;
  online: boolean;
  lastSeenMs: number;
  batteryMv: number | null;
  uptimeSecs: number | null;
  noiseFloor: number | null;
}

interface IngestOverview {
  connected: boolean;
  status?: { region?: string; brokerUrl?: string } & Record<string, unknown>;
  nodeCount: number;
  observers: ObserverRow[];
}

interface IngestNode {
  publicKey: string;
  name?: string | null;
  advType?: number | null;
  latitude?: number | null;
  longitude?: number | null;
  lastHeard?: number | null;
}

interface IngestMessage {
  id?: string | number;
  channelIdx?: number | null;
  text?: string | null;
  fromName?: string | null;
  timestamp?: number | null;
}

/** ApiService returns the raw envelope; `ok(res, x)` puts the payload in `data`. */
interface Envelope<T> {
  success?: boolean;
  data?: T;
}

const REFRESH_MS = 15_000;

function shortKey(key: string): string {
  return key ? `${key.slice(0, 12)}…` : '—';
}

function formatAge(ms: number | null | undefined): string {
  if (!ms) return '—';
  const secs = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86400)}d ago`;
}

interface MeshCoreIngestViewProps {
  sourceId: string;
  baseUrl: string;
}

export const MeshCoreIngestView: React.FC<MeshCoreIngestViewProps> = ({ sourceId, baseUrl }) => {
  const { t } = useTranslation();
  const [tab, setTab] = useState<IngestTab>('overview');
  const [overview, setOverview] = useState<IngestOverview | null>(null);
  const [nodes, setNodes] = useState<IngestNode[]>([]);
  const [messages, setMessages] = useState<IngestMessage[]>([]);
  const [error, setError] = useState<string | null>(null);

  const prefix = useMemo(
    // ApiService.get() does NOT prepend /api — baseUrl is the app base only.
    () => `/api/sources/${encodeURIComponent(sourceId)}/meshcore/ingest`,
    [sourceId],
  );

  const loadOverview = useCallback(async () => {
    try {
      const res = await apiService.get<Envelope<IngestOverview>>(`${prefix}/overview`);
      setOverview(res?.data ?? null);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [prefix]);

  // Overview drives the header on every tab, so it polls regardless of which
  // tab is showing; the heavier lists load only when their tab is opened.
  useEffect(() => {
    void loadOverview();
    const timer = setInterval(() => void loadOverview(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [loadOverview]);

  useEffect(() => {
    if (tab !== 'nodes') return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await apiService.get<Envelope<{ nodes: IngestNode[] }>>(`${prefix}/nodes`);
        if (!cancelled) setNodes(res?.data?.nodes ?? []);
      } catch {
        if (!cancelled) setNodes([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tab, prefix]);

  useEffect(() => {
    if (tab !== 'channels') return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await apiService.get<Envelope<{ messages: IngestMessage[] }>>(
          `${prefix}/messages?limit=100`,
        );
        if (!cancelled) setMessages(res?.data?.messages ?? []);
      } catch {
        if (!cancelled) setMessages([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tab, prefix]);

  const region = (overview?.status?.region as string | undefined) ?? '—';
  const broker = (overview?.status?.brokerUrl as string | undefined) ?? '—';

  const TABS: Array<{ id: IngestTab; label: string }> = [
    { id: 'overview', label: t('meshcore.ingest.tab_overview', 'Overview') },
    { id: 'nodes', label: t('meshcore.ingest.tab_nodes', 'Nodes') },
    { id: 'channels', label: t('meshcore.ingest.tab_channels', 'Channels') },
    { id: 'packets', label: t('meshcore.ingest.tab_packets', 'Packets') },
  ];

  return (
    <div className={styles.wrap}>
      <div className={styles.banner}>
        <UiIcon name="info" size={14} />
        <span>
          {t(
            'meshcore.ingest.banner',
            'Receive-only region feed. This source has no radio: it reads what other observers heard and cannot transmit.',
          )}
        </span>
      </div>

      <div className={styles.summary}>
        <div className={styles.stat}>
          <span className={styles.statLabel}>{t('meshcore.ingest.region', 'Region')}</span>
          <span className={styles.statValue}>{region}</span>
        </div>
        <div className={styles.stat}>
          <span className={styles.statLabel}>{t('meshcore.ingest.broker', 'Broker')}</span>
          <span className={styles.statValue} title={broker}>
            {broker}
          </span>
        </div>
        <div className={styles.stat}>
          <span className={styles.statLabel}>{t('meshcore.ingest.nodes_seen', 'Nodes')}</span>
          <span className={styles.statValue}>{overview?.nodeCount ?? '—'}</span>
        </div>
        <div className={styles.stat}>
          <span className={styles.statLabel}>{t('meshcore.ingest.observers', 'Observers')}</span>
          <span className={styles.statValue}>{overview?.observers?.length ?? '—'}</span>
        </div>
      </div>

      <nav className={styles.tabs}>
        {TABS.map(item => (
          <button
            key={item.id}
            className={`${styles.tab} ${tab === item.id ? styles.tabActive : ''}`}
            onClick={() => setTab(item.id)}
          >
            {item.label}
          </button>
        ))}
      </nav>

      {error && <div className={styles.error}>{error}</div>}

      {tab === 'overview' && (
        <section className={styles.panel}>
          <h3 className={styles.panelTitle}>
            {t('meshcore.ingest.observers_title', 'Observers reporting')}
          </h3>
          {(overview?.observers?.length ?? 0) === 0 ? (
            <p className={styles.empty}>
              {t('meshcore.ingest.no_observers', 'No observer status heartbeats received yet.')}
            </p>
          ) : (
            <div className={styles.tableScroll}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>{t('meshcore.ingest.observer', 'Observer')}</th>
                    <th>{t('meshcore.ingest.last_seen', 'Last heartbeat')}</th>
                    <th>{t('meshcore.ingest.battery', 'Battery')}</th>
                    <th>{t('meshcore.ingest.uptime', 'Uptime')}</th>
                    <th>{t('meshcore.ingest.noise_floor', 'Noise floor')}</th>
                  </tr>
                </thead>
                <tbody>
                  {overview!.observers.map(o => (
                    <tr key={o.publicKey}>
                      <td title={o.publicKey}>{shortKey(o.publicKey)}</td>
                      <td>{formatAge(o.lastSeenMs)}</td>
                      <td>{o.batteryMv != null ? `${(o.batteryMv / 1000).toFixed(2)} V` : '—'}</td>
                      <td>
                        {o.uptimeSecs != null ? `${Math.floor(o.uptimeSecs / 3600)}h` : '—'}
                      </td>
                      <td>{o.noiseFloor != null ? `${o.noiseFloor} dB` : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {tab === 'nodes' && (
        <section className={styles.panel}>
          {nodes.length === 0 ? (
            <p className={styles.empty}>
              {t('meshcore.ingest.no_nodes', 'No nodes discovered from adverts yet.')}
            </p>
          ) : (
            <div className={styles.tableScroll}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>{t('meshcore.ingest.node_name', 'Name')}</th>
                    <th>{t('meshcore.ingest.node_key', 'Public key')}</th>
                    <th>{t('meshcore.ingest.node_position', 'Position')}</th>
                    <th>{t('meshcore.ingest.last_heard', 'Last heard')}</th>
                  </tr>
                </thead>
                <tbody>
                  {nodes.map(n => (
                    <tr key={n.publicKey}>
                      <td>{n.name || t('meshcore.ingest.unnamed', 'Unnamed')}</td>
                      <td title={n.publicKey}>{shortKey(n.publicKey)}</td>
                      <td>
                        {n.latitude != null && n.longitude != null
                          ? `${n.latitude.toFixed(4)}, ${n.longitude.toFixed(4)}`
                          : '—'}
                      </td>
                      <td>{formatAge(n.lastHeard ?? null)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {tab === 'channels' && (
        <section className={styles.panel}>
          {messages.length === 0 ? (
            <p className={styles.empty}>
              {t(
                'meshcore.ingest.no_messages',
                'No channel messages decrypted. Only channels you hold a key for can be read.',
              )}
            </p>
          ) : (
            <ul className={styles.messages}>
              {messages.map((m, i) => (
                <li key={m.id ?? i} className={styles.message}>
                  <span className={styles.messageMeta}>
                    {m.channelIdx != null ? `#${m.channelIdx}` : ''} {m.fromName || ''}
                  </span>
                  <span className={styles.messageText}>{m.text}</span>
                  <span className={styles.messageAge}>{formatAge(m.timestamp ?? null)}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {tab === 'packets' && (
        <MeshCorePacketMonitorView baseUrl={baseUrl} sourceId={sourceId} />
      )}
    </div>
  );
};

export default MeshCoreIngestView;
