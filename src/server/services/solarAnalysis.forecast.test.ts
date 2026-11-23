/**
 * Per-node solar forecast from Open-Meteo sunlight (#6523).
 */
import { describe, it, expect } from 'vitest';
import {
  computeSolarForecast,
  summarizeSolarProduction,
  MIN_HISTORICAL_DAYS,
  type SolarIrradianceHour,
  type SolarNode,
  type SolarNodesAnalysis,
} from './solarAnalysis.js';

const DAY_S = 86_400;
// 2026-11-23T10:00:00Z — "today" for every test.
const NOW_MS = Date.parse('2026-11-23T10:00:00Z');
const TODAY_S = Date.parse('2026-11-23T00:00:00Z') / 1000;

/** 24 hourly rows for the UTC day starting at `dayStartS`, sunny 06–17 at `peak` W/m². */
function day(dayStartS: number, peak: number): SolarIrradianceHour[] {
  return Array.from({ length: 24 }, (_, h) => ({
    timestamp: dayStartS + h * 3600,
    shortwaveRadiation: h >= 6 && h < 18 ? peak : 0,
  }));
}

function series(pastPeaks: number[], futurePeaks: number[]): SolarIrradianceHour[] {
  const past = pastPeaks.flatMap((p, i) => day(TODAY_S - (pastPeaks.length - i) * DAY_S, p));
  const future = futurePeaks.flatMap((p, i) => day(TODAY_S + i * DAY_S, p));
  return [...past, ...future];
}

function node(nodeNum: number, overrides: Partial<SolarNode> = {}): SolarNode {
  return {
    node_num: nodeNum,
    node_name: `Node ${nodeNum}`,
    solar_score: 80,
    days_analyzed: 7,
    days_with_pattern: 6,
    recent_patterns: [],
    metric_type: 'batteryLevel',
    metrics_detected: ['batteryLevel'],
    chart_data: [{ timestamp: NOW_MS - 3600_000, value: 80 }],
    avg_charge_rate_per_hour: 5,
    avg_discharge_rate_per_hour: 2,
    insufficient_solar: false,
    manual_override: false,
    ...overrides,
  };
}

function analysis(nodes: SolarNode[]): SolarNodesAnalysis {
  return {
    lookback_days: 7,
    total_nodes_analyzed: nodes.length,
    solar_nodes_count: nodes.length,
    solar_nodes: nodes,
    avg_charging_hours_per_day: 6,
    avg_discharge_hours_per_day: 14,
    analyzed_nodes: [],
  };
}

describe('summarizeSolarProduction', () => {
  it('converts to ms, skips null hours and sorts', () => {
    const points = summarizeSolarProduction([
      { timestamp: 7200, shortwaveRadiation: 300.04 },
      { timestamp: 3600, shortwaveRadiation: null },
      { timestamp: 0, shortwaveRadiation: 0 },
    ]);
    expect(points).toEqual([
      { timestamp: 0, wattsPerM2: 0 },
      { timestamp: 7_200_000, wattsPerM2: 300 },
    ]);
  });
});

describe('computeSolarForecast (per node)', () => {
  it('compares each node with its own cell, not a global series', () => {
    const sunny = series([500, 500, 500], [500, 500]); // forecast = average
    const cloudy = series([500, 500, 500], [100, 500]); // today 20% of average
    const result = computeSolarForecast(
      analysis([node(1), node(2)]),
      new Map([[1, sunny], [2, cloudy]]),
      NOW_MS,
    );

    expect(result.solar_simulations).toHaveLength(2);
    const a = result.solar_simulations.find((s) => s.node_num === 1)!;
    const b = result.solar_simulations.find((s) => s.node_num === 2)!;

    // 12 sunny hours × 500 W/m² = 6000 Wh/m² a day.
    expect(a.avg_historical_daily_wh_m2).toBe(6000);
    expect(a.historical_days_analyzed).toBe(3);
    expect(a.forecast_days.map((d) => d.is_low)).toEqual([false, false]);

    expect(b.forecast_days[0]).toMatchObject({ date: '2026-11-23', forecast_wh_m2: 1200, pct_of_average: 20, is_low: true });
    expect(b.simulation[0].forecast_factor).toBe(0.2);
    expect(result.low_output_warning).toBe(true);
  });

  it(`skips a node with fewer than ${MIN_HISTORICAL_DAYS} past days or no series`, () => {
    const short = series([500, 500], [500]);
    const result = computeSolarForecast(analysis([node(1), node(2)]), new Map([[1, short]]), NOW_MS);
    expect(result.solar_simulations).toHaveLength(0);
    expect(result.nodes_without_forecast).toBe(2);
    expect(result.low_output_warning).toBe(false);
  });

  it('ignores partial days so a half-stored day is not read as cloudy', () => {
    const rows = series([500, 500, 500], [500]);
    // A past day with only six stored hours, all bright.
    rows.push(...day(TODAY_S - 4 * DAY_S, 900).slice(6, 12));
    const result = computeSolarForecast(analysis([node(1)]), new Map([[1, rows]]), NOW_MS);
    expect(result.solar_simulations[0].historical_days_analyzed).toBe(3);
  });

  it('caps the factor at 1.5 and flags at-risk nodes', () => {
    const bright = series([100, 100, 100], [900]);
    const drained = node(3, { chart_data: [{ timestamp: NOW_MS, value: 30 }], avg_charge_rate_per_hour: 0.1 });
    const result = computeSolarForecast(analysis([node(1), drained]), new Map([[1, bright], [3, bright]]), NOW_MS);
    expect(result.solar_simulations[0].simulation[0].forecast_factor).toBe(1.5);
    expect(result.nodes_at_risk.map((n) => n.node_num)).toEqual([3]);
    expect(result.nodes_at_risk_count).toBe(1);
  });
});
