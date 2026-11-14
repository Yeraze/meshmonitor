/**
 * Diagnostics card for the embedded MeshCore MQTT broker source (#6197).
 *
 * Shows each connected observer's last topic and last reject reason, so an
 * observer that publishes and "nothing happens" says why (bad region, non-hex
 * origin_id, missing raw, non-PACKET, auth, rate). Polls every 10 s while
 * mounted; the route needs `nodes:read` on this source.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import apiService from '../../services/api';
import styles from './MeshCoreBrokerDiagnostics.module.css';

interface Connection {
  clientId: string;
  remoteAddress: string | null;
  authMode: 'token' | 'static';
  observerKey: string | null;
  connectedAt: number;
  received: number;
  accepted: number;
  rejected: number;
  rateDropped: number;
  lastTopic: string | null;
  lastRejectReason: string | null;
  lastRejectAt: number | null;
}

interface RecentEvent {
  at: number;
  kind: 'auth_rejected' | 'disconnected';
  observerKey: string | null;
  remoteAddress: string | null;
  reason: string | null;
}

interface ForwardTarget {
  id: string;
  label: string;
  identityMode: 'passthrough' | 'own';
  connected: boolean;
  forwarded: number;
  dropped: number;
  lastError: string | null;
}

interface BrokerDiagnostics {
  running: boolean;
  listening?: boolean;
  port?: number | null;
  clientCount?: number;
  lastError?: string | null;
  limits?: { maxClients: number; maxMessagesPerSecond: number; maxPayloadBytes: number };
  totals?: { received: number; accepted: number; rejected: number; rateDropped: number; authRejected: number };
  connections?: Connection[];
  recent?: RecentEvent[];
  forwarding?: ForwardTarget[];
}

const POLL_MS = 10_000;

const shortKey = (k: string | null): string => (k ? `${k.slice(0, 12)}…` : '—');

/** Reason code -> readable text. Unknown codes fall back to the code itself. */
function useRejectReasonLabel(): (reason: string | null) => string {
  const { t } = useTranslation();
  return (reason) => {
    if (!reason) return '—';
    const labels: Record<string, string> = {
      auth_bad_credentials: t('meshcore.broker.reason_auth_bad_credentials', 'Login refused (bad or missing credentials)'),
      auth_not_allowlisted: t('meshcore.broker.reason_auth_not_allowlisted', 'Login refused (key not on the allowlist)'),
      auth_bad_token: t('meshcore.broker.reason_auth_bad_token', 'Login refused (token invalid or expired)'),
      auth_bad_audience: t('meshcore.broker.reason_auth_bad_audience', 'Login refused (token audience does not match)'),
      auth_own_identity: t('meshcore.broker.reason_auth_own_identity', "Login refused (MeshMonitor's own forwarding key)"),
      max_clients: t('meshcore.broker.reason_max_clients', 'Login refused (observer limit reached)'),
      rate: t('meshcore.broker.reason_rate', 'Dropped (over the message rate)'),
      payload_too_large: t('meshcore.broker.reason_payload_too_large', 'Dropped (payload too large)'),
      bad_topic: t('meshcore.broker.reason_bad_topic', 'Dropped (topic is not meshcore/{IATA}/{PUBKEY}/packets or /status)'),
      bad_region: t('meshcore.broker.reason_bad_region', 'Dropped (region not allowed)'),
      key_mismatch: t('meshcore.broker.reason_key_mismatch', 'Dropped (key in topic, token and origin_id differ)'),
      bad_json: t('meshcore.broker.reason_bad_json', 'Dropped (body is not JSON)'),
      bad_status: t('meshcore.broker.reason_bad_status', 'Dropped (status body malformed)'),
      not_allowlisted: t('meshcore.broker.reason_not_allowlisted', 'Dropped (key not on the allowlist)'),
      loop: t('meshcore.broker.reason_loop', 'Dropped (our own forwarded frame came back)'),
      not_object: t('meshcore.broker.reason_not_object', 'Dropped (body is not a JSON object)'),
      non_packet_type: t('meshcore.broker.reason_non_packet_type', 'Dropped (type is not PACKET)'),
      missing_raw: t('meshcore.broker.reason_missing_raw', 'Dropped (raw is missing)'),
      bad_origin_id: t('meshcore.broker.reason_bad_origin_id', 'Dropped (origin_id is not 64 hex characters)'),
      bad_frame: t('meshcore.broker.reason_bad_frame', 'Dropped (raw is not a MeshCore frame)'),
    };
    return labels[reason] ?? reason;
  };
}

export const MeshCoreBrokerDiagnostics: React.FC<{ sourceId: string }> = ({ sourceId }) => {
  const { t } = useTranslation();
  const reasonLabel = useRejectReasonLabel();
  const [diag, setDiag] = useState<BrokerDiagnostics | null>(null);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await apiService.get<{ data: BrokerDiagnostics }>(
        `/api/sources/${encodeURIComponent(sourceId)}/meshcore-broker/diagnostics`,
      );
      setDiag(res.data);
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, [sourceId]);

  useEffect(() => {
    void load();
    const id = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(id);
  }, [load]);

  if (failed && !diag) {
    return (
      <section className={styles.panel}>
        <p className={styles.empty}>{t('meshcore.broker.diag_unavailable', 'Broker diagnostics are not available.')}</p>
      </section>
    );
  }
  if (!diag) return null;

  if (!diag.running) {
    return (
      <section className={styles.panel}>
        <h3 className={styles.title}>{t('meshcore.broker.diag_title', 'Broker connections')}</h3>
        <p className={styles.empty}>{t('meshcore.broker.not_running', 'The broker is not running.')}</p>
      </section>
    );
  }

  const connections = diag.connections ?? [];
  const recent = diag.recent ?? [];
  const forwarding = diag.forwarding ?? [];

  return (
    <section className={styles.panel}>
      <h3 className={styles.title}>{t('meshcore.broker.diag_title', 'Broker connections')}</h3>
      <div className={styles.summary}>
        <span>
          {diag.listening
            ? t('meshcore.broker.listening_on', 'Listening on port {{port}}', { port: diag.port ?? '—' })
            : t('meshcore.broker.not_listening', 'Not listening')}
        </span>
        <span>
          {t('meshcore.broker.client_count', '{{count}} of {{max}} observers connected', {
            count: diag.clientCount ?? 0,
            max: diag.limits?.maxClients ?? '—',
          })}
        </span>
        {diag.totals && (
          <span>
            {t('meshcore.broker.totals', '{{accepted}} accepted, {{rejected}} dropped, {{rate}} over rate', {
              accepted: diag.totals.accepted,
              rejected: diag.totals.rejected,
              rate: diag.totals.rateDropped,
            })}
          </span>
        )}
      </div>
      {diag.lastError && <p className={styles.error}>{diag.lastError}</p>}

      {connections.length === 0 ? (
        <p className={styles.empty}>{t('meshcore.broker.no_connections', 'No observers connected.')}</p>
      ) : (
        <div className={styles.tableScroll}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>{t('meshcore.broker.col_observer', 'Observer')}</th>
                <th>{t('meshcore.broker.col_auth', 'Login')}</th>
                <th>{t('meshcore.broker.col_counts', 'Accepted / dropped')}</th>
                <th>{t('meshcore.broker.col_last_topic', 'Last topic')}</th>
                <th>{t('meshcore.broker.col_last_reject', 'Last reject reason')}</th>
              </tr>
            </thead>
            <tbody>
              {connections.map((c) => (
                <tr key={`${c.clientId}-${c.connectedAt}`}>
                  <td title={c.observerKey ?? undefined}>
                    {shortKey(c.observerKey)}
                    {c.remoteAddress && <span className={styles.sub}>{c.remoteAddress}</span>}
                  </td>
                  <td>
                    {c.authMode === 'token'
                      ? t('meshcore.broker.auth_token', 'Token')
                      : t('meshcore.broker.auth_static', 'Static')}
                  </td>
                  <td>
                    {c.accepted} / {c.rejected}
                  </td>
                  <td className={styles.topic}>{c.lastTopic ?? '—'}</td>
                  <td className={c.lastRejectReason ? styles.reject : undefined}>{reasonLabel(c.lastRejectReason)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {recent.length > 0 && (
        <>
          <h4 className={styles.subtitle}>{t('meshcore.broker.recent_title', 'Recent refusals and disconnects')}</h4>
          <ul className={styles.recent}>
            {recent.slice(0, 10).map((r, i) => (
              <li key={`${r.at}-${i}`}>
                <span className={styles.time}>{new Date(r.at).toLocaleTimeString()}</span> {shortKey(r.observerKey)}{' '}
                {r.kind === 'auth_rejected'
                  ? reasonLabel(r.reason)
                  : t('meshcore.broker.disconnected', 'Disconnected')}
                {r.kind === 'disconnected' && r.reason ? ` (${reasonLabel(r.reason)})` : ''}
              </li>
            ))}
          </ul>
        </>
      )}

      {forwarding.length > 0 && (
        <>
          <h4 className={styles.subtitle}>{t('meshcore.broker.forwarding_title', 'Upstream forwarding')}</h4>
          <ul className={styles.recent}>
            {forwarding.map((f) => (
              <li key={f.id}>
                <strong>{f.label}</strong>{' '}
                {f.connected
                  ? t('meshcore.broker.fwd_connected', 'connected')
                  : t('meshcore.broker.fwd_disconnected', 'not connected')}
                {' · '}
                {t('meshcore.broker.fwd_counts', '{{forwarded}} sent, {{dropped}} dropped', {
                  forwarded: f.forwarded,
                  dropped: f.dropped,
                })}
                {f.lastError && <span className={styles.error}>{f.lastError}</span>}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
};

export default MeshCoreBrokerDiagnostics;
