import React, { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import apiService from '../../services/api';
import { useSource } from '../../contexts/SourceContext';
import { UiIcon } from '../icons';
import { getPortnumName } from '../../utils/packetFormat';
import {
  TMM_MIRROR_FIRMWARE_VERSION,
  type BreakdownRow,
  type ReplayCaveat,
  type ReplayRefusalReason,
  type ReplaySettings,
  type RuleOutcome,
  type TrafficReplayResponse,
} from '../../utils/trafficManagementReplay';
import styles from './TrafficManagementReplayPanel.module.css';

/**
 * "Estimate impact" for the Traffic Management form (#5670).
 *
 * Replays the local node's packet log against the values in the form, for
 * position dedup and rate limit only. It is a READ: pressing Estimate makes one
 * GET, and nothing is saved or sent to the node. It runs only when the button
 * is pressed, never as the form changes.
 *
 * Every number is shown with its limits beside it. When the replay cannot
 * answer, the panel says why and what would let it answer.
 */
interface TrafficManagementReplayPanelProps extends ReplaySettings {
  /** The section is unsupported on this firmware. */
  disabled: boolean;
}

type PanelState =
  | { phase: 'idle' }
  | { phase: 'loading' }
  | { phase: 'error'; message: string }
  | { phase: 'done'; result: TrafficReplayResponse; used: ReplaySettings };

function span(ms: number, t: TFunction): string {
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return t('trafficmanagement_replay.span_seconds', '{{count}} s', { count: totalSeconds });
  const totalMinutes = Math.round(totalSeconds / 60);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return t('trafficmanagement_replay.span_minutes', '{{minutes}} min', { minutes });
  if (minutes === 0) return t('trafficmanagement_replay.span_hours', '{{hours}} h', { hours });
  return t('trafficmanagement_replay.span_hours_minutes', '{{hours}} h {{minutes}} min', { hours, minutes });
}

const range = (min: number, max: number): string => (min === max ? String(min) : `${min}–${max}`);

function caveatText(caveat: ReplayCaveat, result: TrafficReplayResponse, t: TFunction): string {
  switch (caveat) {
    case 'ALREADY_FILTERED_ABSENT':
      return t('trafficmanagement_replay.caveat_already_filtered', 'Packets the node already drops never reach MeshMonitor, so they are not counted here. A low number, or zero, does not mean the node drops little.');
    case 'EMPTY_CACHE_AT_START':
      return t('trafficmanagement_replay.caveat_empty_cache', 'The replay starts with an empty cache, so the first packets in the log always pass. This undercounts.');
    case 'TICK_PHASE_UNKNOWN':
      return t('trafficmanagement_replay.caveat_tick_phase', 'The node counts time in ticks from its boot. MeshMonitor cannot see where a tick starts, so it tried {{count}} starting points and shows the lowest and highest result.', { count: result.phasesSampled });
    case 'CACHE_LOSS_NOT_MODELLED':
      return t('trafficmanagement_replay.caveat_cache_loss', 'A reboot or a full cache makes the node forget a sender. The replay assumes neither happened.');
    case 'LOCAL_NODE_ONLY':
      return t('trafficmanagement_replay.caveat_local_only', 'This covers packets this one node heard. It is not a figure for the whole mesh, and it is not a count of real drops.');
    case 'RELAYED_UNICAST_INVISIBLE':
      return t('trafficmanagement_replay.caveat_relayed_unicast', 'The node also counts direct messages it relays for others. MeshMonitor never sees those, so real drops are likely higher.');
    case 'NET_CHANGE_MAY_BE_SMALLER':
      return t('trafficmanagement_replay.caveat_net_change', 'Some packets the node drops today could pass under the new value. They are not in the log, so the net change may be smaller than shown.');
    case 'SENDER_ROLE_FROM_MESHMONITOR':
      return t('trafficmanagement_replay.caveat_sender_role', 'The firmware lets a tracker repeat a position after 1 hour and a lost-and-found node after 15 minutes, whatever the interval. The replay uses the role MeshMonitor last heard for each sender.');
    case 'SERVER_DECRYPTED_NOT_COUNTED':
      return t('trafficmanagement_replay.caveat_server_decrypted', '{{count}} packets were decrypted by MeshMonitor, not by the node. The node could not read them, so neither rule counts them.', { count: result.skipped.serverDecrypted });
    case 'SCAN_TRUNCATED':
      return t('trafficmanagement_replay.caveat_truncated', 'The log holds more than {{cap}} rows for this source. Only the newest {{cap}} were read.', { cap: result.scanCap });
    case 'OTHER_RULE_HELD_AT_CURRENT':
      return t('trafficmanagement_replay.caveat_other_rule', 'The other rule could not be estimated, so the replay kept it at the value the node runs now.');
    case 'SWEEP_RESETS_SHORT_WINDOW':
      return t('trafficmanagement_replay.caveat_sweep', 'This value is short enough that the node\'s 60 second cleanup resets it. It acts like a window of 60 seconds at most.');
  }
}

function refusalText(reason: ReplayRefusalReason, outcome: RuleOutcome, t: TFunction): { why: string; fix: string } {
  switch (reason) {
    case 'PACKET_LOG_DISABLED':
      return {
        why: t('trafficmanagement_replay.refuse_logging_off', 'Packet logging is off, so there is no history to replay.'),
        fix: t('trafficmanagement_replay.refuse_logging_off_fix', 'Turn on packet logging under Settings → Packet Monitor, let it collect traffic, then estimate again.'),
      };
    case 'HISTORY_TOO_SHORT':
      return {
        why: t('trafficmanagement_replay.refuse_history', 'The log covers {{have}}. This value needs at least {{need}}.', {
          have: span(outcome.historySpanMs, t),
          need: span(outcome.requiredSpanMs, t),
        }),
        fix: t('trafficmanagement_replay.refuse_history_fix', 'Wait for more history, or raise the row and age limits under Settings → Packet Monitor. The log keeps 1,000 rows across all sources and 24 hours by default.'),
      };
    case 'LOOSER_THAN_CURRENT':
      return {
        why: t('trafficmanagement_replay.refuse_looser', 'This value is looser than the one the node runs now.'),
        fix: t('trafficmanagement_replay.refuse_looser_fix', 'The log holds only packets the node already let through, so it cannot show what a looser value would let in. Only a tighter value can be estimated.'),
      };
  }
}

const TrafficManagementReplayPanel: React.FC<TrafficManagementReplayPanelProps> = ({
  positionMinIntervalSecs,
  rateLimitWindowSecs,
  rateLimitMaxPackets,
  disabled,
}) => {
  const { t } = useTranslation();
  const { sourceId } = useSource();
  const [state, setState] = useState<PanelState>({ phase: 'idle' });

  const estimate = useCallback(async () => {
    if (!sourceId) return;
    // The values in the form right now, saved or not.
    const used: ReplaySettings = { positionMinIntervalSecs, rateLimitWindowSecs, rateLimitMaxPackets };
    setState({ phase: 'loading' });
    try {
      const result = await apiService.getTrafficManagementReplay(sourceId, used);
      setState({ phase: 'done', result, used });
    } catch (error) {
      setState({
        phase: 'error',
        message: error instanceof Error && error.message
          ? error.message
          : t('trafficmanagement_replay.error_generic', 'The estimate failed.'),
      });
    }
  }, [sourceId, positionMinIntervalSecs, rateLimitWindowSecs, rateLimitMaxPackets, t]);

  if (disabled) return null;

  const stale =
    state.phase === 'done' &&
    (state.used.positionMinIntervalSecs !== positionMinIntervalSecs ||
      state.used.rateLimitWindowSecs !== rateLimitWindowSecs ||
      state.used.rateLimitMaxPackets !== rateLimitMaxPackets);

  const senderLabel = (result: TrafficReplayResponse, key: number | null): string => {
    if (key === null) return t('trafficmanagement_replay.other_senders', 'Other senders (hidden from you, unknown, or less affected)');
    const node = result.senders[String(key)];
    if (!node) return `!${key.toString(16).padStart(8, '0')}`;
    return node.longName ? `${node.shortName ?? node.nodeId} (${node.longName})` : (node.shortName ?? node.nodeId);
  };
  const portLabel = (key: number | null): string =>
    key === null ? t('trafficmanagement_replay.other_ports', 'Other packet types') : getPortnumName(key);

  const table = (
    heading: string,
    rows: BreakdownRow<number>[],
    label: (key: number | null) => string,
    testId: string,
  ) =>
    rows.length === 0 ? null : (
      <table className={styles.table} data-testid={testId}>
        <thead>
          <tr>
            <th>{heading}</th>
            <th className={styles.numeric}>{t('trafficmanagement_replay.col_would_drop', 'Would be dropped')}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.key ?? 'other'}>
              <td>{label(row.key)}</td>
              <td className={styles.numeric}>{range(row.min, row.max)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    );

  const rule = (
    result: TrafficReplayResponse,
    id: 'dedup' | 'rate',
    title: string,
    outcome: RuleOutcome,
    effectiveNote: string | null,
  ) => (
    <div className={styles.rule} data-testid={`tm-replay-${id}`}>
      <div className={styles.ruleTitle}>{title}</div>
      {effectiveNote && <p className={styles.note}>{effectiveNote}</p>}

      {outcome.status === 'unchanged' && (
        <p className={styles.note} data-testid={`tm-replay-${id}-unchanged`}>
          {t('trafficmanagement_replay.unchanged', 'This value acts the same as the one the node runs now, so there is nothing to estimate.')}
        </p>
      )}

      {outcome.status === 'cannot_estimate' && (() => {
        const text = refusalText(outcome.reason, outcome, t);
        return (
          <div className={styles.refusal} data-testid={`tm-replay-${id}-refused`} data-reason={outcome.reason}>
            <UiIcon name="info" className={styles.icon} />
            <div>
              <strong>{t('trafficmanagement_replay.cannot_estimate', 'Cannot estimate.')}</strong> {text.why}
              <div className={styles.fix}>{text.fix}</div>
            </div>
          </div>
        );
      })()}

      {outcome.status === 'estimate' && (
        <>
          <p className={styles.headline} data-testid={`tm-replay-${id}-range`}>
            <span className={styles.rangeValue}>{range(outcome.droppedMin, outcome.droppedMax)}</span>{' '}
            {id === 'dedup'
              ? t('trafficmanagement_replay.headline_dedup', 'of {{count}} logged positions would have been dropped', { count: outcome.consideredPackets })
              : t('trafficmanagement_replay.headline_rate', 'of {{count}} logged packets would have been dropped', { count: outcome.consideredPackets })}
            <span className={styles.badge} data-testid={`tm-replay-${id}-bound`}>
              {outcome.bound === 'lower_bound'
                ? t('trafficmanagement_replay.bound_lower', 'Lower bound')
                : t('trafficmanagement_replay.bound_logged', 'Logged packets only')}
            </span>
          </p>
          <p className={styles.note}>
            {t('trafficmanagement_replay.history_vs_window', 'History used: {{have}}. This value needs at least {{need}}.', {
              have: span(outcome.historySpanMs, t),
              need: span(outcome.requiredSpanMs, t),
            })}
          </p>
          <ul className={styles.caveats} data-testid={`tm-replay-${id}-caveats`}>
            {outcome.caveats.map((caveat) => (
              <li key={caveat}>{caveatText(caveat, result, t)}</li>
            ))}
          </ul>
          {table(t('trafficmanagement_replay.col_sender', 'Sender'), outcome.bySender, (key) => senderLabel(result, key), `tm-replay-${id}-senders`)}
          {id === 'rate' && table(t('trafficmanagement_replay.col_type', 'Packet type'), outcome.byPortnum, portLabel, `tm-replay-${id}-ports`)}
        </>
      )}
    </div>
  );

  const effectiveNote = (configuredSecs: number, effectiveMs: number, enabled: boolean): string | null =>
    enabled && configuredSecs * 1000 !== effectiveMs
      ? t('trafficmanagement_replay.effective', 'The firmware works in fixed ticks: it treats {{configured}} as {{effective}}.', {
          configured: span(configuredSecs * 1000, t),
          effective: span(effectiveMs, t),
        })
      : null;

  return (
    <div className={styles.panel} data-testid="tm-replay-panel">
      <div className={styles.title}>{t('trafficmanagement_replay.title', 'Estimate impact')}</div>
      <p className={styles.note}>
        {t('trafficmanagement_replay.intro', 'Replays this node\'s packet log against the Position Deduplication and Rate Limiting values in the form above, saved or not. It reads MeshMonitor\'s own database: nothing is sent to the node and nothing is saved. NodeInfo Direct Response and Drop Unknown Packets are not estimated.')}
      </p>

      <button
        type="button"
        className="save-button"
        onClick={estimate}
        disabled={state.phase === 'loading' || !sourceId}
        data-testid="tm-replay-estimate"
      >
        {state.phase === 'loading'
          ? t('trafficmanagement_replay.estimating', 'Estimating…')
          : t('trafficmanagement_replay.estimate', 'Estimate')}
      </button>

      {state.phase === 'error' && (
        <div className={styles.refusal} role="alert" data-testid="tm-replay-error">
          <UiIcon name="alert" className={styles.icon} />
          <div>{state.message}</div>
        </div>
      )}

      {state.phase === 'done' && (() => {
        const { result, used } = state;
        const eff = result.effective.proposed;
        return (
          <div className={styles.result}>
            {stale && (
              <div className={styles.refusal} data-testid="tm-replay-stale">
                <UiIcon name="info" className={styles.icon} />
                <div>{t('trafficmanagement_replay.stale', 'The form changed since this estimate. Press Estimate to run it again.')}</div>
              </div>
            )}
            <p className={styles.note} data-testid="tm-replay-meta">
              {t('trafficmanagement_replay.meta', 'Estimated for: minimum interval {{interval}} s, window {{window}} s, max {{max}} packets. Compared with what the node runs now: {{curInterval}} s, {{curWindow}} s, {{curMax}} packets. Log read: {{rows}} rows over {{span}}.', {
                interval: used.positionMinIntervalSecs,
                window: used.rateLimitWindowSecs,
                max: used.rateLimitMaxPackets,
                curInterval: result.current.positionMinIntervalSecs,
                curWindow: result.current.rateLimitWindowSecs,
                curMax: result.current.rateLimitMaxPackets,
                rows: result.rowsScanned,
                span: span(result.historySpanMs, t),
              })}
            </p>
            {rule(
              result,
              'dedup',
              t('trafficmanagement_config.position_dedup', 'Position Deduplication'),
              result.positionDedup,
              effectiveNote(used.positionMinIntervalSecs, eff.positionDedup.effectiveMs, eff.positionDedup.enabled),
            )}
            {rule(
              result,
              'rate',
              t('trafficmanagement_config.rate_limiting', 'Rate Limiting'),
              result.rateLimit,
              [
                effectiveNote(used.rateLimitWindowSecs, eff.rateLimit.effectiveMs, eff.rateLimit.enabled),
                eff.rateLimit.enabled && used.rateLimitMaxPackets > eff.rateLimit.threshold
                  ? t('trafficmanagement_replay.threshold_cap', 'The firmware caps Max Packets at {{cap}}.', { cap: eff.rateLimit.threshold })
                  : null,
              ].filter(Boolean).join(' ') || null,
            )}
          </div>
        );
      })()}

      <p className={styles.footer}>
        {t('trafficmanagement_replay.firmware', 'Rules copied from Meshtastic firmware {{version}}. Other firmware may behave differently.', { version: TMM_MIRROR_FIRMWARE_VERSION })}
      </p>
    </div>
  );
};

export default TrafficManagementReplayPanel;
