/**
 * Derived signal-trend / link-attenuation badge (#4110), shared by the
 * Meshtastic node details block and the MeshCore contact panel (#6262).
 *
 * Fetches `/api/telemetry/:nodeId/signal-trend` once per (nodeId, sourceId):
 * the trend is a day-vs-week aggregate, so polling would not change the verdict.
 * Renders nothing while loading, on error, or with too little history.
 */
import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import apiService, { SignalTrendResult } from '../services/api';
import { UiIcon, type UiIconName } from './icons';
import './NodeDetailsBlock.css';

export interface SignalTrendBadgeProps {
  /** Meshtastic `!hex` node id, or a 64-hex MeshCore public key. */
  nodeId: string;
  /** The endpoint requires a source; nothing renders without one. */
  sourceId?: string | null;
}

/** Semantic icon for a signal trend direction (#4110). */
function signalTrendIcon(trend: SignalTrendResult['trend']): UiIconName {
  switch (trend) {
    case 'improving': return 'chevronUp';
    case 'degrading': return 'chevronDown';
    default: return 'forward';
  }
}

/**
 * Build a human-readable tooltip summarizing the day-vs-week deltas behind a
 * signal-trend badge (#4110). Kept plain-text so it works as a `title` attr.
 * `translate` is i18next's `t` so the descriptive words are localized (the
 * RSSI/SNR acronyms and dB units are left as-is).
 */
function buildSignalTrendTooltip(
  trend: SignalTrendResult,
  translate: (key: string, opts?: Record<string, unknown>) => string,
): string {
  const parts: string[] = [];
  const signed = (n: number) => `${n >= 0 ? '+' : ''}${n}`;
  const metricLine = (label: string, m: NonNullable<SignalTrendResult['rssi']>) =>
    translate('node_details.signal_trend_tooltip_metric', {
      label,
      delta: signed(m.delta),
      unit: m.unit,
      recent: m.recent,
      baseline: m.baseline,
      defaultValue: `${label} ${signed(m.delta)} ${m.unit} (24h avg ${m.recent} vs 7d ${m.baseline})`,
    });
  if (trend.rssi) parts.push(metricLine('RSSI', trend.rssi));
  if (trend.snr) parts.push(metricLine('SNR', trend.snr));
  if (trend.noiseFloorRising && trend.noiseFloor) {
    parts.push(translate('node_details.signal_trend_tooltip_noise', {
      delta: signed(trend.noiseFloor.delta),
      unit: trend.noiseFloor.unit,
      defaultValue: `Noise floor rising ${signed(trend.noiseFloor.delta)} ${trend.noiseFloor.unit}`,
    }));
  }
  return parts.join('\n');
}

export const SignalTrendBadge: React.FC<SignalTrendBadgeProps> = ({ nodeId, sourceId }) => {
  const { t } = useTranslation();
  const [signalTrend, setSignalTrend] = useState<SignalTrendResult | null>(null);

  useEffect(() => {
    if (!nodeId || !sourceId) {
      setSignalTrend(null);
      return;
    }
    let cancelled = false;
    setSignalTrend(null);
    apiService.getSignalTrend(nodeId, sourceId)
      .then(result => { if (!cancelled) setSignalTrend(result); })
      .catch(() => { if (!cancelled) setSignalTrend(null); });
    return () => { cancelled = true; };
  }, [nodeId, sourceId]);

  if (!signalTrend || signalTrend.trend === 'insufficient') return null;

  return (
    <div className="node-detail-card">
      <div className="node-detail-label">{t('node_details.signal_trend', 'Signal Trend')}</div>
      <div
        className={`node-detail-value signal-trend signal-trend-${signalTrend.trend}`}
        title={buildSignalTrendTooltip(signalTrend, t)}
      >
        <span className="signal-trend-arrow" aria-hidden="true"><UiIcon name={signalTrendIcon(signalTrend.trend)} size={14} /></span>
        {' '}
        {t(`node_details.signal_trend_${signalTrend.trend}`,
          signalTrend.trend === 'improving' ? 'Improving'
            : signalTrend.trend === 'degrading' ? 'Degrading'
            : 'Stable')}
      </div>
    </div>
  );
};

export default SignalTrendBadge;
