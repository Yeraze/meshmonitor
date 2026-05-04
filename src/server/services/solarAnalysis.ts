/**
 * Solar Analysis Service
 *
 * Identifies solar-powered nodes by analyzing battery and voltage telemetry
 * patterns over a lookback window. A "solar pattern" is detected when a
 * metric shows a morning low followed by a midday/afternoon peak (charging
 * during daylight hours), and overnight discharge.
 *
 * Algorithm port of MeshManager's `_analyze_metric_for_solar_patterns` and
 * `identify_solar_nodes` (backend/app/routers/ui.py).
 */

export interface SolarPattern {
  date: string;
  sunrise: { time: string; value: number };
  peak: { time: string; value: number };
  sunset: { time: string; value: number };
  rise: number | null;
  fall: number | null;
  charge_rate_per_hour: number | null;
  discharge_rate_per_hour: number | null;
}

export interface SolarChartPoint {
  timestamp: number;
  value: number;
}

export interface SolarNode {
  node_num: number;
  node_name: string;
  solar_score: number;
  days_analyzed: number;
  days_with_pattern: number;
  recent_patterns: SolarPattern[];
  metric_type: string;
  metrics_detected: string[];
  chart_data: SolarChartPoint[];
  avg_charge_rate_per_hour: number | null;
  avg_discharge_rate_per_hour: number | null;
  insufficient_solar: boolean | null;
}

export interface SolarProductionPoint {
  timestamp: number; // ms epoch
  wattHours: number;
}

export interface SolarNodesAnalysis {
  lookback_days: number;
  total_nodes_analyzed: number;
  solar_nodes_count: number;
  solar_nodes: SolarNode[];
  solar_production: SolarProductionPoint[];
  avg_charging_hours_per_day: number | null;
  avg_discharge_hours_per_day: number | null;
}

export interface ForecastDay {
  date: string;
  forecast_wh: number;
  avg_historical_wh: number;
  pct_of_average: number;
  is_low: boolean;
}

export type ForecastPhase = 'sunrise' | 'peak' | 'sunset';

export interface ForecastSimulationPoint {
  timestamp: string; // ISO 8601
  simulated_battery: number;
  phase: ForecastPhase;
  forecast_factor: number;
}

export interface NodeSimulation {
  node_num: number;
  node_name: string;
  metric_type: string;
  current_battery: number | null;
  min_simulated_battery: number;
  simulation: ForecastSimulationPoint[];
}

export interface SolarForecastAnalysis {
  lookback_days: number;
  historical_days_analyzed: number;
  avg_historical_daily_wh: number;
  low_output_warning: boolean;
  forecast_days: ForecastDay[];
  nodes_at_risk_count: number;
  nodes_at_risk: NodeSimulation[];
  solar_simulations: NodeSimulation[];
}

interface MetricReading {
  time: number; // ms epoch
  value: number;
}

interface MetricResult {
  has_pattern: true;
  is_high_efficiency: boolean;
  sunrise: { time: number; value: number };
  peak: { time: number; value: number };
  sunset: { time: number; value: number };
  rise: number;
  fall: number;
  charge_rate: number | null;
  discharge_rate: number | null;
  daylight_hours: number | null;
  discharge_hours: number | null;
  daily_range: number;
}

interface MetricStats {
  days_with_pattern: number;
  total_days: number;
  high_efficiency_days: number;
  daily_patterns: SolarPattern[];
  charge_rates: number[];
  discharge_rates: number[];
  previous_day_sunset: { time: number; value: number } | null;
  total_variance: number;
}

const HOUR_MS = 3600_000;
const DAY_MS = 24 * HOUR_MS;
const MIN_HOURS_FOR_RATE = 0.5;

function newStats(): MetricStats {
  return {
    days_with_pattern: 0,
    total_days: 0,
    high_efficiency_days: 0,
    daily_patterns: [],
    charge_rates: [],
    discharge_rates: [],
    previous_day_sunset: null,
    total_variance: 0,
  };
}

function hourOf(ts: number): number {
  return new Date(ts).getUTCHours();
}

function dateKey(ts: number): string {
  const d = new Date(ts);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

function formatHM(ts: number): string {
  const d = new Date(ts);
  const h = String(d.getUTCHours()).padStart(2, '0');
  const m = String(d.getUTCMinutes()).padStart(2, '0');
  return `${h}:${m}`;
}

function round(value: number, digits: number = 2): number {
  const f = Math.pow(10, digits);
  return Math.round(value * f) / f;
}

function analyzeMetricForSolarPatterns(
  values: MetricReading[],
  isBattery: boolean,
  previousDaySunset: { time: number; value: number } | null,
): MetricResult | null {
  if (values.length < 3) return null;

  const allValues = values.map((v) => v.value);
  const minValue = Math.min(...allValues);
  const maxValue = Math.max(...allValues);
  const dailyRange = maxValue - minValue;

  const minVariance = isBattery ? 10 : 0.3;

  let isHighEfficiencyCandidate = false;
  if (isBattery) {
    isHighEfficiencyCandidate =
      minValue >= 90 && dailyRange >= 2 && dailyRange < minVariance;
  } else {
    isHighEfficiencyCandidate =
      minValue >= 4.1 && dailyRange >= 0.05 && dailyRange < minVariance;
  }

  if (dailyRange < minVariance && !isHighEfficiencyCandidate) {
    return null;
  }

  const morning = values.filter((v) => {
    const h = hourOf(v.time);
    return h >= 6 && h <= 10;
  });
  const afternoon = values.filter((v) => {
    const h = hourOf(v.time);
    return h >= 12 && h <= 18;
  });

  let sunrise: MetricReading;
  let peak: MetricReading;
  let sunset: MetricReading;
  let rise: number;
  let fall: number;

  if (morning.length > 0 && afternoon.length > 0) {
    sunrise = morning.reduce((a, b) => (a.value <= b.value ? a : b));
    peak = afternoon.reduce((a, b) => (a.value >= b.value ? a : b));
    rise = peak.value - sunrise.value;
    sunset = values[values.length - 1];
    fall = peak.value - sunset.value;
  } else {
    // Fallback: overall min/max
    sunrise = values.reduce((a, b) => (a.value <= b.value ? a : b));
    peak = values.reduce((a, b) => (a.value >= b.value ? a : b));
    rise = peak.value - sunrise.value;
    sunset = values[values.length - 1];
    fall = peak.value - sunset.value;
  }

  const peakHour = hourOf(peak.time);
  const sunriseHour = hourOf(sunrise.time);

  let minRiseThreshold: number;
  let minRatio: number;
  if (isHighEfficiencyCandidate) {
    minRiseThreshold = isBattery ? 1 : 0.02;
    minRatio = 0.98;
  } else {
    minRiseThreshold = Math.max(minVariance, dailyRange * 0.3);
    minRatio = 0.95;
  }

  const hasSolarPattern =
    rise >= minRiseThreshold &&
    peakHour >= 10 &&
    peakHour <= 18 &&
    sunriseHour <= 12 &&
    sunrise.value <= peak.value * minRatio;

  if (!hasSolarPattern) return null;

  // For batteries, use first reading where value hits 100% as effective peak
  let effectivePeakTime = peak.time;
  let effectivePeakValue = peak.value;
  if (isBattery) {
    for (const v of values) {
      if (v.time > sunrise.time && v.time <= sunset.time && v.value >= 100) {
        effectivePeakTime = v.time;
        effectivePeakValue = v.value;
        break;
      }
    }
  }

  const chargingHours = (effectivePeakTime - sunrise.time) / HOUR_MS;
  const chargeRate =
    chargingHours >= MIN_HOURS_FOR_RATE
      ? (effectivePeakValue - sunrise.value) / chargingHours
      : null;

  const daylightHours = (sunset.time - sunrise.time) / HOUR_MS;

  let dischargeRate: number | null = null;
  let dischargeHours: number | null = null;
  if (previousDaySunset !== null) {
    dischargeHours = (sunrise.time - previousDaySunset.time) / HOUR_MS;
    if (dischargeHours >= MIN_HOURS_FOR_RATE) {
      dischargeRate = (previousDaySunset.value - sunrise.value) / dischargeHours;
    }
  }

  return {
    has_pattern: true,
    is_high_efficiency: isHighEfficiencyCandidate,
    sunrise: { time: sunrise.time, value: sunrise.value },
    peak: { time: peak.time, value: peak.value },
    sunset: { time: sunset.time, value: sunset.value },
    rise,
    fall,
    charge_rate: chargeRate,
    discharge_rate: dischargeRate,
    daylight_hours: daylightHours > 0 ? daylightHours : null,
    discharge_hours: dischargeHours,
    daily_range: dailyRange,
  };
}

function applyMetricResult(
  stats: MetricStats,
  result: MetricResult | null,
  values: MetricReading[],
  date: string,
  isBattery: boolean,
  allChargingHours: number[],
  allDischargeHours: number[],
): void {
  if (result) {
    stats.days_with_pattern += 1;
    if (result.charge_rate !== null) stats.charge_rates.push(result.charge_rate);
    if (result.discharge_rate !== null) stats.discharge_rates.push(result.discharge_rate);
    if (result.daylight_hours !== null) allChargingHours.push(result.daylight_hours);
    if (result.discharge_hours !== null) allDischargeHours.push(result.discharge_hours);
    stats.total_variance += result.daily_range;
    if (result.is_high_efficiency) stats.high_efficiency_days += 1;
    stats.daily_patterns.push({
      date,
      sunrise: { time: formatHM(result.sunrise.time), value: round(result.sunrise.value, 1) },
      peak: { time: formatHM(result.peak.time), value: round(result.peak.value, 1) },
      sunset: { time: formatHM(result.sunset.time), value: round(result.sunset.value, 1) },
      rise: result.rise !== null ? round(result.rise, 1) : null,
      fall: result.fall !== null ? round(result.fall, 1) : null,
      charge_rate_per_hour: result.charge_rate !== null ? round(result.charge_rate, 2) : null,
      discharge_rate_per_hour:
        result.discharge_rate !== null ? round(result.discharge_rate, 2) : null,
    });
    stats.previous_day_sunset = { time: result.sunset.time, value: result.sunset.value };
    stats.total_days += 1;
  } else if (values.length > 0) {
    const allVals = values.map((v) => v.value);
    const dailyRange = Math.max(...allVals) - Math.min(...allVals);
    const minVarConsider = isBattery ? 2 : 0.05;
    if (dailyRange >= minVarConsider) {
      stats.total_days += 1;
    }
  }
}

export interface SolarTelemetryRow {
  nodeNum: number;
  telemetryType: string;
  timestamp: number;
  value: number;
}

export interface NodeNameLookup {
  nodeNum: number;
  longName?: string | null;
  shortName?: string | null;
}

/**
 * Run the solar pattern detection across all telemetry rows for the lookback
 * window. Telemetry rows must include batteryLevel, voltage, and any INA
 * voltage channels (e.g. ch1Voltage). Caller is responsible for fetching
 * rows from the database.
 */
export function identifySolarNodes(
  telemetryRows: SolarTelemetryRow[],
  nodes: NodeNameLookup[],
  lookbackDays: number,
): SolarNodesAnalysis {
  // Build node name lookup
  const nodeNames = new Map<number, string>();
  for (const node of nodes) {
    if (node.longName) nodeNames.set(node.nodeNum, node.longName);
    else if (node.shortName) nodeNames.set(node.nodeNum, node.shortName);
    else nodeNames.set(node.nodeNum, `!${(node.nodeNum >>> 0).toString(16).padStart(8, '0')}`);
  }

  // Group telemetry by node, then date, then metric
  // Structure: Map<nodeNum, Map<dateKey, Map<metricName, MetricReading[]>>>
  const nodeData = new Map<number, Map<string, Map<string, MetricReading[]>>>();
  const inaChannelsByNode = new Map<number, Set<string>>();

  for (const row of telemetryRows) {
    const nodeNum = Number(row.nodeNum);
    if (!Number.isFinite(nodeNum)) continue;
    const date = dateKey(row.timestamp);
    let byDate = nodeData.get(nodeNum);
    if (!byDate) {
      byDate = new Map();
      nodeData.set(nodeNum, byDate);
    }
    let byMetric = byDate.get(date);
    if (!byMetric) {
      byMetric = new Map();
      byDate.set(date, byMetric);
    }
    let arr = byMetric.get(row.telemetryType);
    if (!arr) {
      arr = [];
      byMetric.set(row.telemetryType, arr);
    }
    arr.push({ time: row.timestamp, value: row.value });

    if (
      row.telemetryType !== 'voltage' &&
      row.telemetryType.endsWith('Voltage')
    ) {
      let set = inaChannelsByNode.get(nodeNum);
      if (!set) {
        set = new Set();
        inaChannelsByNode.set(nodeNum, set);
      }
      set.add(row.telemetryType);
    }
  }

  const allChargingHours: number[] = [];
  const allDischargeHours: number[] = [];
  const solarCandidates: SolarNode[] = [];

  for (const [nodeNum, byDate] of nodeData.entries()) {
    const batteryStats = newStats();
    const voltageStats = newStats();
    const inaChannels = inaChannelsByNode.get(nodeNum) ?? new Set<string>();
    const inaStats = new Map<string, MetricStats>();
    for (const ch of inaChannels) inaStats.set(ch, newStats());

    const sortedDates = Array.from(byDate.keys()).sort();
    for (const date of sortedDates) {
      const byMetric = byDate.get(date)!;
      const batteryReadings = (byMetric.get('batteryLevel') ?? [])
        .slice()
        .sort((a, b) => a.time - b.time);
      const voltageReadings = (byMetric.get('voltage') ?? [])
        .slice()
        .sort((a, b) => a.time - b.time);

      // Need at least 3 readings of any metric to consider this day
      const totalReadings =
        batteryReadings.length + voltageReadings.length +
        Array.from(inaChannels).reduce(
          (sum, ch) => sum + (byMetric.get(ch)?.length ?? 0),
          0,
        );
      if (totalReadings < 3) continue;

      if (batteryReadings.length >= 3) {
        const result = analyzeMetricForSolarPatterns(
          batteryReadings,
          true,
          batteryStats.previous_day_sunset,
        );
        applyMetricResult(
          batteryStats,
          result,
          batteryReadings,
          date,
          true,
          allChargingHours,
          allDischargeHours,
        );
      }

      if (voltageReadings.length >= 3) {
        const result = analyzeMetricForSolarPatterns(
          voltageReadings,
          false,
          voltageStats.previous_day_sunset,
        );
        applyMetricResult(
          voltageStats,
          result,
          voltageReadings,
          date,
          false,
          allChargingHours,
          allDischargeHours,
        );
      }

      for (const ch of inaChannels) {
        const readings = (byMetric.get(ch) ?? []).slice().sort((a, b) => a.time - b.time);
        if (readings.length < 3) continue;
        const stats = inaStats.get(ch)!;
        const result = analyzeMetricForSolarPatterns(
          readings,
          false,
          stats.previous_day_sunset,
        );
        applyMetricResult(
          stats,
          result,
          readings,
          date,
          false,
          allChargingHours,
          allDischargeHours,
        );
      }
    }

    // Pick best metric: prefer the one with most days_with_pattern, break ties by total_variance
    const candidates: Array<{
      metric: string;
      stats: MetricStats;
    }> = [];
    if (batteryStats.days_with_pattern > 0) {
      candidates.push({ metric: 'batteryLevel', stats: batteryStats });
    }
    if (voltageStats.days_with_pattern > 0) {
      candidates.push({ metric: 'voltage', stats: voltageStats });
    }
    for (const [ch, stats] of inaStats.entries()) {
      if (stats.days_with_pattern > 0) {
        candidates.push({ metric: ch, stats });
      }
    }

    if (candidates.length === 0) continue;

    candidates.sort((a, b) => {
      if (b.stats.days_with_pattern !== a.stats.days_with_pattern) {
        return b.stats.days_with_pattern - a.stats.days_with_pattern;
      }
      return b.stats.total_variance - a.stats.total_variance;
    });

    const chosen = candidates[0];
    const stats = chosen.stats;
    const totalDays = Math.max(stats.total_days, stats.days_with_pattern);
    const daysWithPattern = stats.days_with_pattern;

    // Apply pattern threshold (33% if high-efficiency majority, else 50%)
    const isMostlyHighEff =
      stats.total_days > 0 && stats.high_efficiency_days >= stats.total_days / 2;
    const minPatternRatio = isMostlyHighEff ? 0.33 : 0.5;
    const patternRatio = totalDays > 0 ? daysWithPattern / totalDays : 0;
    if (patternRatio < minPatternRatio) continue;

    const solarScore = round((daysWithPattern / Math.max(totalDays, 1)) * 100, 1);
    const avgChargeRate =
      stats.charge_rates.length > 0
        ? round(stats.charge_rates.reduce((a, b) => a + b, 0) / stats.charge_rates.length, 2)
        : null;
    const avgDischargeRate =
      stats.discharge_rates.length > 0
        ? round(
            stats.discharge_rates.reduce((a, b) => a + b, 0) / stats.discharge_rates.length,
            2,
          )
        : null;

    // Build chart data for the chosen metric across the lookback window
    const chart: SolarChartPoint[] = [];
    for (const [, byMetric] of byDate.entries()) {
      const readings = byMetric.get(chosen.metric) ?? [];
      for (const r of readings) {
        chart.push({ timestamp: r.time, value: round(r.value, 3) });
      }
    }
    chart.sort((a, b) => a.timestamp - b.timestamp);

    const metricsDetected: string[] = [];
    if (batteryStats.days_with_pattern > 0) metricsDetected.push('battery');
    if (voltageStats.days_with_pattern > 0) metricsDetected.push('voltage');
    for (const [ch, s] of inaStats.entries()) {
      if (s.days_with_pattern > 0) metricsDetected.push(ch);
    }

    solarCandidates.push({
      node_num: nodeNum,
      node_name: nodeNames.get(nodeNum) ?? `!${(nodeNum >>> 0).toString(16).padStart(8, '0')}`,
      solar_score: solarScore,
      days_analyzed: totalDays,
      days_with_pattern: daysWithPattern,
      recent_patterns: stats.daily_patterns.slice(-3),
      metric_type: chosen.metric,
      metrics_detected: metricsDetected,
      chart_data: chart,
      avg_charge_rate_per_hour: avgChargeRate,
      avg_discharge_rate_per_hour: avgDischargeRate,
      insufficient_solar: null,
    });
  }

  solarCandidates.sort((a, b) => b.solar_score - a.solar_score);

  const avgChargingHoursPerDay =
    allChargingHours.length > 0
      ? round(allChargingHours.reduce((a, b) => a + b, 0) / allChargingHours.length, 1)
      : null;
  const avgDischargeHoursPerDay =
    allDischargeHours.length > 0
      ? round(allDischargeHours.reduce((a, b) => a + b, 0) / allDischargeHours.length, 1)
      : null;

  // Mark insufficient_solar
  for (const node of solarCandidates) {
    const chargeRate = node.avg_charge_rate_per_hour;
    const dischargeRate = node.avg_discharge_rate_per_hour;
    const recent = node.recent_patterns;

    let nearFullSolved = false;
    if (recent.length > 0) {
      const peakValues = recent.map((p) => p.peak.value ?? 0);
      const daysAtFull = peakValues.filter((pv) => pv >= 98).length;
      if (daysAtFull >= peakValues.length / 2) {
        node.insufficient_solar = false;
        nearFullSolved = true;
      }
    }
    if (nearFullSolved) continue;

    if (
      chargeRate !== null &&
      dischargeRate !== null &&
      avgChargingHoursPerDay !== null &&
      avgDischargeHoursPerDay !== null
    ) {
      const totalCharge = chargeRate * avgChargingHoursPerDay;
      const totalDischarge = dischargeRate * avgDischargeHoursPerDay;
      node.insufficient_solar = totalCharge <= totalDischarge * 1.1;
    } else {
      node.insufficient_solar = null;
    }
  }

  void DAY_MS; // reserved for future per-day windowing

  return {
    lookback_days: lookbackDays,
    total_nodes_analyzed: nodeData.size,
    solar_nodes_count: solarCandidates.length,
    solar_nodes: solarCandidates,
    solar_production: [],
    avg_charging_hours_per_day: avgChargingHoursPerDay,
    avg_discharge_hours_per_day: avgDischargeHoursPerDay,
  };
}

/**
 * Group raw solar estimate points (unix seconds + watt_hours) into hourly
 * points keyed by ms-epoch — used as a chart-ready overlay alongside the
 * battery telemetry.
 */
export function summarizeSolarProduction(
  estimates: Array<{ timestamp: number; watt_hours: number }>,
): SolarProductionPoint[] {
  // Group by hour, average across estimates that fall in the same bucket
  // (the upsert is keyed on (timestamp, fetched_at) so multiple fetches can
  // land in the same hour).
  const byHour = new Map<number, { sum: number; count: number }>();
  for (const e of estimates) {
    const ms = e.timestamp * 1000;
    const hour = Math.floor(ms / HOUR_MS) * HOUR_MS;
    const cell = byHour.get(hour) ?? { sum: 0, count: 0 };
    cell.sum += e.watt_hours;
    cell.count += 1;
    byHour.set(hour, cell);
  }
  return Array.from(byHour.entries())
    .map(([hour, cell]) => ({
      timestamp: hour,
      wattHours: round(cell.sum / cell.count, 2),
    }))
    .sort((a, b) => a.timestamp - b.timestamp);
}

/**
 * Build the solar forecast analysis from the per-node solar analysis and the
 * raw solar estimate dataset (unix-seconds rows from the forecast.solar
 * cache). Compares historical (pre-today) average daily output to forecast
 * (today + future) and simulates each solar node's battery state over the
 * forecast window using its measured charge/discharge rates.
 */
export function computeSolarForecast(
  analysis: SolarNodesAnalysis,
  estimates: Array<{ timestamp: number; watt_hours: number }>,
): SolarForecastAnalysis {
  const now = Date.now();
  const todayStartMs = (() => {
    const d = new Date(now);
    d.setUTCHours(0, 0, 0, 0);
    return d.getTime();
  })();

  // Aggregate Wh per UTC day
  const dailyWh = new Map<string, number>();
  for (const e of estimates) {
    const ms = e.timestamp * 1000;
    const date = dateKey(ms);
    dailyWh.set(date, (dailyWh.get(date) ?? 0) + e.watt_hours);
  }

  // Historical = days strictly before today
  const todayKey = dateKey(todayStartMs);
  const historicalDailyWh: number[] = [];
  for (const [date, wh] of dailyWh.entries()) {
    if (date < todayKey) historicalDailyWh.push(wh);
  }
  const avgHistoricalDailyWh =
    historicalDailyWh.length > 0
      ? historicalDailyWh.reduce((a, b) => a + b, 0) / historicalDailyWh.length
      : 0;

  // Forecast days = today + future where data is available
  const forecastDays: ForecastDay[] = [];
  for (let dayOffset = 0; dayOffset < 5; dayOffset++) {
    const ms = todayStartMs + dayOffset * DAY_MS;
    const date = dateKey(ms);
    const forecastWh = dailyWh.get(date);
    if (forecastWh === undefined) continue;
    const pct = avgHistoricalDailyWh > 0 ? (forecastWh / avgHistoricalDailyWh) * 100 : 100;
    forecastDays.push({
      date,
      forecast_wh: round(forecastWh, 1),
      avg_historical_wh: round(avgHistoricalDailyWh, 1),
      pct_of_average: round(pct, 1),
      is_low: pct < 75,
    });
  }

  const lowOutputWarning = forecastDays.some((d) => d.is_low);

  // Simulate per-node battery state across forecast horizon
  const simulations: NodeSimulation[] = [];
  const atRisk: NodeSimulation[] = [];
  const avgChargingHours = analysis.avg_charging_hours_per_day ?? 6;
  const avgDischargeHours = analysis.avg_discharge_hours_per_day ?? 14;

  for (const node of analysis.solar_nodes) {
    if (
      node.avg_charge_rate_per_hour === null ||
      node.avg_discharge_rate_per_hour === null
    ) {
      continue;
    }
    const lastPoint = node.chart_data[node.chart_data.length - 1];
    if (!lastPoint) continue;

    const points: ForecastSimulationPoint[] = [];
    let battery = lastPoint.value;
    let minBattery = battery;
    const isPercent = node.metric_type === 'batteryLevel';
    const clamp = (v: number) => (isPercent ? Math.max(0, Math.min(100, v)) : Math.max(0, v));

    for (const fd of forecastDays) {
      const factor =
        avgHistoricalDailyWh > 0
          ? Math.min(1.5, Math.max(0, fd.forecast_wh / avgHistoricalDailyWh))
          : 1;
      const effectiveCharge = node.avg_charge_rate_per_hour * factor;

      // Sunrise — drained overnight
      battery = clamp(battery - node.avg_discharge_rate_per_hour * avgDischargeHours);
      if (battery < minBattery) minBattery = battery;
      points.push({
        timestamp: `${fd.date}T12:00:00Z`,
        simulated_battery: round(battery, 1),
        phase: 'sunrise',
        forecast_factor: round(factor, 2),
      });

      // Peak — charged through daylight
      battery = clamp(battery + effectiveCharge * avgChargingHours);
      points.push({
        timestamp: `${fd.date}T19:00:00Z`,
        simulated_battery: round(battery, 1),
        phase: 'peak',
        forecast_factor: round(factor, 2),
      });

      // Sunset — small afternoon drain (~4h)
      battery = clamp(battery - node.avg_discharge_rate_per_hour * 4);
      points.push({
        timestamp: `${fd.date}T23:00:00Z`,
        simulated_battery: round(battery, 1),
        phase: 'sunset',
        forecast_factor: round(factor, 2),
      });
    }

    const sim: NodeSimulation = {
      node_num: node.node_num,
      node_name: node.node_name,
      metric_type: node.metric_type,
      current_battery: lastPoint.value,
      min_simulated_battery: round(minBattery, 1),
      simulation: points,
    };
    simulations.push(sim);

    // At-risk: percentage metric drops below 50%, voltage drops below 3.5V
    const riskThreshold = isPercent ? 50 : 3.5;
    if (minBattery < riskThreshold) atRisk.push(sim);
  }

  return {
    lookback_days: analysis.lookback_days,
    historical_days_analyzed: historicalDailyWh.length,
    avg_historical_daily_wh: round(avgHistoricalDailyWh, 1),
    low_output_warning: lowOutputWarning,
    forecast_days: forecastDays,
    nodes_at_risk_count: atRisk.length,
    nodes_at_risk: atRisk,
    solar_simulations: simulations,
  };
}
