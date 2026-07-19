/**
 * Signal trend / link-attenuation computation (issue #4110).
 *
 * Derives an at-a-glance "is this link getting worse?" indicator per node from
 * the historical signal telemetry MeshMonitor already stores:
 *   - `rssi`      — received signal strength of packets heard from the node (dBm)
 *   - `snr_local` — SNR of packets heard from the node (dB)
 *   - `noiseFloor`— the node's device-reported noise floor (dBm, since #3396)
 *
 * The computation is a pure function over raw telemetry samples so it is
 * trivially unit-testable with crafted sample sets and carries no DB coupling.
 * The repository (`TelemetryRepository.getSignalTrendSamples`) supplies the rows.
 *
 * ## Windows (kept deliberately simple)
 *   recent   = the last 24 hours          [now - 24h,  now]
 *   baseline = the 7 days before that      [now - 8d,   now - 24h)
 * A metric contributes only when BOTH windows hold at least
 * MIN_SAMPLES_PER_WINDOW points — otherwise the day-vs-week comparison is noise.
 *
 * ## Basis + thresholds
 * RSSI is the primary basis: it is the absolute received power and is therefore
 * a clean, noise-independent proxy for path attenuation. When RSSI has enough
 * data we classify purely on its day-vs-week average delta.
 *
 * When RSSI is too sparse we fall back to SNR. SNR ≈ signal − noise, so a rising
 * noise floor drags SNR down without the link path actually degrading. To avoid
 * mistaking a noisier RF environment for attenuation we add the noise-floor rise
 * back into the SNR delta ("path delta"): a purely noise-driven SNR drop then
 * reads as 'stable'. This is exactly the noise-floor factor the issue asks for.
 *
 * Deltas smaller than the per-metric threshold read as 'stable'. When neither
 * metric has enough data the trend is 'insufficient' (the UI renders nothing).
 */

/** Telemetry `telemetryType` strings this feature reads (see meshtasticManager ingest). */
export const RSSI_TELEMETRY_TYPE = 'rssi';
export const SNR_TELEMETRY_TYPE = 'snr_local';
export const NOISE_FLOOR_TELEMETRY_TYPE = 'noiseFloor';
export const SIGNAL_TREND_TELEMETRY_TYPES = [
  RSSI_TELEMETRY_TYPE,
  SNR_TELEMETRY_TYPE,
  NOISE_FLOOR_TELEMETRY_TYPE,
] as const;

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** Recent window: the trailing 24 hours. */
export const RECENT_WINDOW_MS = DAY_MS;
/** Baseline window: the 7 days immediately before the recent window. */
export const BASELINE_WINDOW_MS = 7 * DAY_MS;
/** Total history the repository needs to fetch (recent + baseline = 8 days). */
export const SIGNAL_TREND_LOOKBACK_MS = RECENT_WINDOW_MS + BASELINE_WINDOW_MS;

/**
 * Minimum samples required in EACH window for a metric to be usable. Below this
 * a day-vs-week average is dominated by single-packet variance, so we prefer to
 * say nothing over guessing.
 */
export const MIN_SAMPLES_PER_WINDOW = 3;

/**
 * RSSI trend threshold (dBm). A shift of the day-average received power of at
 * least this much versus the week baseline is treated as a real link change.
 * ~5 dBm ≈ a >3x change in received power — coarse on purpose, because RSSI is
 * a noisy per-packet measurement even after daily averaging.
 */
export const RSSI_TREND_THRESHOLD_DB = 5;

/**
 * SNR trend threshold (dB). ~3 dB ≈ a 2x change in link margin. Applied to the
 * noise-corrected "path delta" when RSSI is unavailable.
 */
export const SNR_TREND_THRESHOLD_DB = 3;

/**
 * Noise floor is flagged as "rising" when it climbs by at least this much (dB)
 * from baseline to recent. Purely informational — surfaced so the UI can explain
 * a signal change that is attributable to the RF environment, not the link.
 */
export const NOISE_FLOOR_RISE_THRESHOLD_DB = 3;

export type SignalTrend = 'improving' | 'stable' | 'degrading' | 'insufficient';
export type SignalTrendBasis = 'rssi' | 'snr' | null;

export interface SignalSample {
  telemetryType: string;
  timestamp: number;
  value: number;
}

export interface MetricWindowStats {
  /** Recent-window (last 24h) average, rounded to 1 decimal. */
  recent: number;
  /** Baseline-window (prior 7d) average, rounded to 1 decimal. */
  baseline: number;
  /** recent − baseline, rounded to 1 decimal. Positive = higher/stronger. */
  delta: number;
  recentCount: number;
  baselineCount: number;
  unit: string;
}

export interface SignalTrendResult {
  trend: SignalTrend;
  /** Which metric drove the classification ('rssi' preferred, 'snr' fallback). */
  basis: SignalTrendBasis;
  rssi: MetricWindowStats | null;
  snr: MetricWindowStats | null;
  noiseFloor: MetricWindowStats | null;
  /** True when the node's noise floor rose ≥ NOISE_FLOOR_RISE_THRESHOLD_DB. */
  noiseFloorRising: boolean;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function average(values: number[]): number {
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

/**
 * Reduce one metric's samples into recent/baseline window averages, or null when
 * either window is below MIN_SAMPLES_PER_WINDOW.
 */
function computeMetric(
  samples: SignalSample[],
  telemetryType: string,
  unit: string,
  now: number,
): MetricWindowStats | null {
  const recentStart = now - RECENT_WINDOW_MS;
  const baselineStart = now - SIGNAL_TREND_LOOKBACK_MS;

  const recent: number[] = [];
  const baseline: number[] = [];

  for (const s of samples) {
    if (s.telemetryType !== telemetryType) continue;
    if (!Number.isFinite(s.value) || !Number.isFinite(s.timestamp)) continue;
    if (s.timestamp > now || s.timestamp < baselineStart) continue;
    if (s.timestamp >= recentStart) {
      recent.push(s.value);
    } else {
      baseline.push(s.value);
    }
  }

  if (recent.length < MIN_SAMPLES_PER_WINDOW || baseline.length < MIN_SAMPLES_PER_WINDOW) {
    return null;
  }

  const recentAvg = average(recent);
  const baselineAvg = average(baseline);
  return {
    recent: round1(recentAvg),
    baseline: round1(baselineAvg),
    delta: round1(recentAvg - baselineAvg),
    recentCount: recent.length,
    baselineCount: baseline.length,
    unit,
  };
}

/**
 * Classify a "higher is better" delta against a symmetric threshold.
 * delta ≥ +threshold → improving; delta ≤ −threshold → degrading; else stable.
 */
function classify(delta: number, threshold: number): SignalTrend {
  if (delta >= threshold) return 'improving';
  if (delta <= -threshold) return 'degrading';
  return 'stable';
}

/**
 * Compute the signal trend for a node from its recent signal telemetry samples.
 *
 * @param samples raw rows for RSSI / snr_local / noiseFloor over the lookback window
 * @param now     evaluation time (defaults to Date.now(); injectable for tests)
 */
export function computeSignalTrend(
  samples: SignalSample[],
  now: number = Date.now(),
): SignalTrendResult {
  const rssi = computeMetric(samples, RSSI_TELEMETRY_TYPE, 'dBm', now);
  const snr = computeMetric(samples, SNR_TELEMETRY_TYPE, 'dB', now);
  const noiseFloor = computeMetric(samples, NOISE_FLOOR_TELEMETRY_TYPE, 'dBm', now);

  const noiseFloorRising =
    noiseFloor !== null && noiseFloor.delta >= NOISE_FLOOR_RISE_THRESHOLD_DB;

  let trend: SignalTrend;
  let basis: SignalTrendBasis;

  if (rssi) {
    // RSSI is noise-independent, so no noise correction is needed here.
    trend = classify(rssi.delta, RSSI_TREND_THRESHOLD_DB);
    basis = 'rssi';
  } else if (snr) {
    // SNR ≈ signal − noise. Add the noise-floor rise back so that a signal
    // change caused purely by a noisier RF environment does not read as
    // path attenuation (issue #4110's noise-floor requirement).
    const noiseCorrection = noiseFloor ? noiseFloor.delta : 0;
    const pathDelta = round1(snr.delta + noiseCorrection);
    trend = classify(pathDelta, SNR_TREND_THRESHOLD_DB);
    basis = 'snr';
  } else {
    trend = 'insufficient';
    basis = null;
  }

  return { trend, basis, rssi, snr, noiseFloor, noiseFloorRising };
}
