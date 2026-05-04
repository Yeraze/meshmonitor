/**
 * SolarMonitoringReport — analyzes battery / voltage telemetry to identify
 * likely solar-powered nodes. Port of MeshManager's SolarMonitoring view.
 *
 * Renders per-node battery/voltage line + solar-production bar overlay,
 * reference lines for healthy levels, and an optional forecast simulation
 * extending the chart into the future.
 */
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

interface SolarPattern {
  date: string;
  sunrise: { time: string; value: number };
  peak: { time: string; value: number };
  sunset: { time: string; value: number };
  rise: number | null;
  fall: number | null;
  charge_rate_per_hour: number | null;
  discharge_rate_per_hour: number | null;
}

interface SolarChartPoint {
  timestamp: number;
  value: number;
}

interface SolarProductionPoint {
  timestamp: number;
  wattHours: number;
}

interface SolarNode {
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

interface SolarNodesAnalysis {
  lookback_days: number;
  total_nodes_analyzed: number;
  solar_nodes_count: number;
  solar_nodes: SolarNode[];
  solar_production: SolarProductionPoint[];
  avg_charging_hours_per_day: number | null;
  avg_discharge_hours_per_day: number | null;
}

interface ForecastDay {
  date: string;
  forecast_wh: number;
  avg_historical_wh: number;
  pct_of_average: number;
  is_low: boolean;
}

interface ForecastSimulationPoint {
  timestamp: string;
  simulated_battery: number;
  phase: 'sunrise' | 'peak' | 'sunset';
  forecast_factor: number;
}

interface NodeSimulation {
  node_num: number;
  node_name: string;
  metric_type: string;
  current_battery: number | null;
  min_simulated_battery: number;
  simulation: ForecastSimulationPoint[];
}

interface SolarForecastAnalysis {
  lookback_days: number;
  historical_days_analyzed: number;
  avg_historical_daily_wh: number;
  low_output_warning: boolean;
  forecast_days: ForecastDay[];
  nodes_at_risk_count: number;
  nodes_at_risk: NodeSimulation[];
  solar_simulations: NodeSimulation[];
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { credentials: 'include' });
  if (!response.ok) {
    throw new Error(`Request failed (HTTP ${response.status})`);
  }
  return response.json();
}

const SolarMonitoringReport: React.FC<{ baseUrl: string }> = ({ baseUrl }) => {
  const { t } = useTranslation();
  const [lookbackDays, setLookbackDays] = useState(7);
  const [run, setRun] = useState(false);
  const [runForecast, setRunForecast] = useState(false);

  const { data, isLoading, error, refetch } = useQuery<SolarNodesAnalysis>({
    queryKey: ['solar-nodes-analysis', lookbackDays],
    queryFn: () =>
      fetchJson<SolarNodesAnalysis>(
        `${baseUrl}/api/analysis/solar-nodes?lookback_days=${lookbackDays}`,
      ),
    enabled: run,
  });

  const {
    data: forecast,
    isLoading: forecastLoading,
    error: forecastError,
    refetch: refetchForecast,
  } = useQuery<SolarForecastAnalysis>({
    queryKey: ['solar-forecast-analysis', lookbackDays],
    queryFn: () =>
      fetchJson<SolarForecastAnalysis>(
        `${baseUrl}/api/analysis/solar-forecast?lookback_days=${lookbackDays}`,
      ),
    enabled: runForecast,
  });

  return (
    <>
      <div>
        <h2 className="reports-section__title">
          <span aria-hidden>☀️</span>
          {t('analysis.solar_monitoring.title', 'Solar Monitoring Analysis')}
        </h2>
        <p className="reports-section__subtitle">
          {t(
            'analysis.solar_monitoring.description',
            'Identify solar-powered nodes by analyzing battery and voltage patterns that show daytime charging and nighttime discharge.',
          )}
        </p>
      </div>

      <div className="reports-panel">
        <div className="reports-controls">
          <label className="reports-controls__field">
            <span>{t('analysis.solar_monitoring.lookback', 'Lookback (days):')}</span>
            <input
              type="number"
              min={1}
              max={90}
              value={lookbackDays}
              onChange={(e) => {
                const n = parseInt(e.target.value, 10);
                if (Number.isFinite(n)) setLookbackDays(Math.min(90, Math.max(1, n)));
              }}
            />
          </label>
          <button
            type="button"
            className="reports-btn"
            onClick={() => {
              if (run) {
                refetch();
              } else {
                setRun(true);
              }
            }}
            disabled={isLoading}
          >
            {isLoading
              ? t('analysis.solar_monitoring.analyzing', 'Analyzing…')
              : run
                ? t('analysis.solar_monitoring.refresh', 'Re-run analysis')
                : t('analysis.solar_monitoring.run', 'Run analysis')}
          </button>
          <button
            type="button"
            className="reports-btn reports-btn--ghost"
            onClick={() => {
              if (runForecast) {
                refetchForecast();
              } else {
                setRunForecast(true);
              }
            }}
            disabled={forecastLoading}
            title={t(
              'analysis.solar_monitoring.forecast_help',
              'Project battery state across the next several days using forecast.solar production estimates.',
            )}
          >
            {forecastLoading
              ? t('analysis.solar_monitoring.forecast_loading', 'Forecasting…')
              : runForecast
                ? t('analysis.solar_monitoring.forecast_refresh', 'Re-run forecast')
                : t('analysis.solar_monitoring.forecast_run', 'Run forecast')}
          </button>
        </div>
      </div>

      {error && (
        <div className="reports-banner reports-banner--error">
          {t('analysis.solar_monitoring.error', 'Error analyzing data:')}{' '}
          {(error as Error).message}
        </div>
      )}

      {forecastError && (
        <div className="reports-banner reports-banner--error">
          {t('analysis.solar_monitoring.forecast_error', 'Error computing forecast:')}{' '}
          {(forecastError as Error).message}
        </div>
      )}

      {data && (
        <SolarSummary
          totalAnalyzed={data.total_nodes_analyzed}
          solarCount={data.solar_nodes_count}
          avgCharging={data.avg_charging_hours_per_day}
          avgDischarge={data.avg_discharge_hours_per_day}
          lookbackDays={data.lookback_days}
          solarPointCount={data.solar_production.length}
        />
      )}

      {forecast && <ForecastResults forecast={forecast} />}

      {data && data.solar_nodes.length === 0 && !isLoading && (
        <div className="reports-banner reports-banner--empty">
          {t(
            'analysis.solar_monitoring.empty',
            'No solar-powered nodes identified. Try increasing the lookback period or ensure nodes have sufficient telemetry data.',
          )}
        </div>
      )}

      {data && data.solar_nodes.length > 0 && (
        <div className="reports-node-list">
          {data.solar_nodes.map((node) => (
            <SolarNodeCard
              key={node.node_num}
              node={node}
              solarProduction={data.solar_production}
              forecast={forecast}
            />
          ))}
        </div>
      )}
    </>
  );
};

const SolarSummary: React.FC<{
  totalAnalyzed: number;
  solarCount: number;
  avgCharging: number | null;
  avgDischarge: number | null;
  lookbackDays: number;
  solarPointCount: number;
}> = ({ totalAnalyzed, solarCount, avgCharging, avgDischarge, lookbackDays, solarPointCount }) => (
  <div className="reports-stats">
    <Stat label="Lookback" value={`${lookbackDays} d`} />
    <Stat label="Nodes analyzed" value={String(totalAnalyzed)} />
    <Stat label="Solar nodes detected" value={String(solarCount)} />
    <Stat
      label="Avg charging hrs/day"
      value={avgCharging !== null ? `${avgCharging.toFixed(1)} h` : '—'}
    />
    <Stat
      label="Avg discharge hrs/day"
      value={avgDischarge !== null ? `${avgDischarge.toFixed(1)} h` : '—'}
    />
    <Stat label="Solar production points" value={String(solarPointCount)} />
  </div>
);

const Stat: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <div className="reports-stat">
    <div className="reports-stat__label">{label}</div>
    <div className="reports-stat__value">{value}</div>
  </div>
);

const ForecastResults: React.FC<{ forecast: SolarForecastAnalysis }> = ({ forecast }) => {
  return (
    <div className="reports-panel reports-forecast">
      <div className="reports-forecast__header">
        <h3 className="reports-forecast__title">
          🔮 Solar Forecast
        </h3>
        <div className="reports-forecast__sub">
          Based on {forecast.historical_days_analyzed} historical day(s) avg{' '}
          <strong>{forecast.avg_historical_daily_wh.toFixed(0)} Wh/day</strong>.{' '}
          {forecast.nodes_at_risk_count} of {forecast.solar_simulations.length} solar nodes
          predicted at risk.
        </div>
      </div>

      {forecast.low_output_warning && (
        <div className="reports-banner reports-banner--warning">
          ⚠ Forecast output is significantly below historical average — battery levels may
          drop on at-risk nodes.
        </div>
      )}

      {forecast.forecast_days.length > 0 && (
        <div className="reports-table-wrap">
          <table className="reports-table">
            <thead>
              <tr>
                <th>Day</th>
                <th>Forecast Wh</th>
                <th>Historical Wh</th>
                <th>% of avg</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {forecast.forecast_days.map((d) => (
                <tr key={d.date}>
                  <td>{d.date}</td>
                  <td>{d.forecast_wh.toFixed(0)}</td>
                  <td>{d.avg_historical_wh.toFixed(0)}</td>
                  <td>{d.pct_of_average.toFixed(0)}%</td>
                  <td>
                    {d.is_low ? (
                      <span className="reports-pill reports-pill--warn">Low</span>
                    ) : (
                      <span className="reports-pill reports-pill--ok">OK</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {forecast.nodes_at_risk.length > 0 && (
        <div>
          <p className="reports-node__patterns-title">Nodes predicted at risk</p>
          <ul className="reports-at-risk">
            {forecast.nodes_at_risk.map((n) => (
              <li key={n.node_num}>
                <strong>{n.node_name}</strong> — min battery{' '}
                <span className="reports-pill reports-pill--warn">
                  {n.min_simulated_battery.toFixed(1)}
                  {n.metric_type === 'batteryLevel' ? '%' : ' V'}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
};

interface ChartPoint {
  timestamp: number;
  value?: number | null;
  forecastBattery?: number | null;
  solarWh?: number | null;
}

const SolarNodeCard: React.FC<{
  node: SolarNode;
  solarProduction: SolarProductionPoint[];
  forecast?: SolarForecastAnalysis;
}> = ({ node, solarProduction, forecast }) => {
  const [expanded, setExpanded] = useState(false);

  const isPercent = node.metric_type === 'batteryLevel';
  const metricLabel = isPercent
    ? 'Battery %'
    : node.metric_type === 'voltage'
      ? 'Voltage V'
      : node.metric_type;

  const nodeForecast = forecast?.solar_simulations.find(
    (s) => s.node_num === node.node_num,
  );

  const chartData = useMemo<ChartPoint[]>(() => {
    if (node.chart_data.length === 0) return [];
    const HOUR = 3_600_000;
    const solarByHour = new Map<number, number>();
    for (const sp of solarProduction) {
      const hour = Math.floor(sp.timestamp / HOUR) * HOUR;
      solarByHour.set(hour, sp.wattHours);
    }
    const points: ChartPoint[] = node.chart_data.map((p) => ({
      timestamp: p.timestamp,
      value: p.value,
      solarWh: solarByHour.get(Math.floor(p.timestamp / HOUR) * HOUR) ?? null,
    }));
    const telemetryHours = new Set(
      points.map((p) => Math.floor(p.timestamp / HOUR) * HOUR),
    );
    const lastTs = points[points.length - 1]?.timestamp ?? 0;

    // Add solar-only hourly points the telemetry didn't cover
    for (const [hour, wh] of solarByHour.entries()) {
      if (!telemetryHours.has(hour) && hour <= lastTs) {
        points.push({ timestamp: hour, value: null, solarWh: wh });
      }
    }

    // Append forecast simulation points (if loaded) — connects last value
    if (nodeForecast?.simulation && nodeForecast.simulation.length > 0) {
      const lastValue = points[points.length - 1]?.value ?? null;
      // Bridge point: same x as last actual, forecastBattery = last actual value
      points.push({
        timestamp: lastTs + 1,
        value: null,
        forecastBattery: typeof lastValue === 'number' ? lastValue : null,
        solarWh: null,
      });
      for (const s of nodeForecast.simulation) {
        const ts = new Date(s.timestamp).getTime();
        if (ts <= lastTs) continue;
        const hour = Math.floor(ts / HOUR) * HOUR;
        points.push({
          timestamp: ts,
          value: null,
          forecastBattery: s.simulated_battery,
          solarWh: solarByHour.get(hour) ?? null,
        });
      }
    } else {
      // Even without forecast, append future solar-only points
      for (const [hour, wh] of solarByHour.entries()) {
        if (hour > lastTs) {
          points.push({ timestamp: hour, value: null, solarWh: wh });
        }
      }
    }

    points.sort((a, b) => a.timestamp - b.timestamp);
    return points;
  }, [node.chart_data, solarProduction, nodeForecast]);

  // Reference levels — battery uses %, voltage uses LiPo-style thresholds
  const refLines = isPercent
    ? [
        { y: 100, label: '100%', tone: 'good' as const },
        { y: 50, label: '50%', tone: 'mid' as const },
        { y: 20, label: '20%', tone: 'low' as const },
      ]
    : [
        { y: 4.2, label: '4.2 V (full)', tone: 'good' as const },
        { y: 3.7, label: '3.7 V (nominal)', tone: 'mid' as const },
        { y: 3.3, label: '3.3 V (low)', tone: 'low' as const },
      ];

  const yMin = isPercent ? 0 : 3.0;
  const yMax = isPercent ? 105 : 4.3;
  const hasSolar = chartData.some((p) => typeof p.solarWh === 'number');
  const hasForecast = chartData.some((p) => typeof p.forecastBattery === 'number');

  return (
    <div
      className={`reports-node${node.insufficient_solar ? ' reports-node--insufficient' : ''}`}
    >
      <button
        type="button"
        className="reports-node__header"
        onClick={() => setExpanded((v) => !v)}
      >
        <div>
          <div className="reports-node__name">
            {node.node_name}
            {node.insufficient_solar && (
              <span className="reports-node__warning">⚠ Insufficient solar</span>
            )}
          </div>
          <div className="reports-node__meta">
            Score {node.solar_score.toFixed(1)}% • {node.days_with_pattern}/
            {node.days_analyzed} days • Metric: {metricLabel}
          </div>
        </div>
        <div className="reports-node__chevron">{expanded ? '▼' : '▶'}</div>
      </button>

      {expanded && (
        <div className="reports-node__body">
          <div className="reports-node__fields">
            <Field
              label="Avg charge rate"
              value={
                node.avg_charge_rate_per_hour !== null
                  ? `${node.avg_charge_rate_per_hour.toFixed(2)} /h`
                  : '—'
              }
            />
            <Field
              label="Avg discharge rate"
              value={
                node.avg_discharge_rate_per_hour !== null
                  ? `${node.avg_discharge_rate_per_hour.toFixed(2)} /h`
                  : '—'
              }
            />
            <Field
              label="Metrics detected"
              value={node.metrics_detected.length > 0 ? node.metrics_detected.join(', ') : '—'}
            />
            {nodeForecast && (
              <Field
                label="Forecast min battery"
                value={`${nodeForecast.min_simulated_battery.toFixed(1)}${isPercent ? '%' : ' V'}`}
              />
            )}
          </div>

          {chartData.length > 0 && (
            <div className="reports-node__chart">
              <ResponsiveContainer>
                <ComposedChart
                  data={chartData}
                  margin={{ top: 8, right: 16, bottom: 4, left: 8 }}
                >
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--ctp-surface0)" />
                  <XAxis
                    dataKey="timestamp"
                    type="number"
                    domain={['dataMin', 'dataMax']}
                    tickFormatter={(ts: number) =>
                      new Date(ts).toLocaleDateString(undefined, {
                        month: 'short',
                        day: 'numeric',
                      })
                    }
                    stroke="var(--ctp-subtext0)"
                    fontSize={11}
                  />
                  <YAxis
                    yAxisId="left"
                    domain={[yMin, yMax]}
                    stroke="var(--ctp-subtext0)"
                    fontSize={11}
                    tickFormatter={(v: number) => (isPercent ? `${v}%` : `${v.toFixed(1)}V`)}
                  />
                  <YAxis
                    yAxisId="right"
                    orientation="right"
                    stroke="var(--ctp-yellow)"
                    fontSize={11}
                    tickFormatter={(v: number) => `${Math.round(v)} Wh`}
                    hide={!hasSolar}
                  />
                  <Tooltip
                    labelFormatter={(ts) => new Date(Number(ts)).toLocaleString()}
                    contentStyle={{
                      background: 'var(--ctp-mantle)',
                      border: '1px solid var(--ctp-surface1)',
                      borderRadius: 6,
                      color: 'var(--ctp-text)',
                    }}
                    labelStyle={{ color: 'var(--ctp-subtext0)' }}
                    formatter={(value, name) => {
                      if (name === 'solarWh') return [`${Number(value).toFixed(0)} Wh`, 'Solar'];
                      if (name === 'forecastBattery')
                        return [
                          isPercent ? `${value}%` : `${Number(value).toFixed(2)} V`,
                          'Forecast',
                        ];
                      return [
                        isPercent ? `${value}%` : `${Number(value).toFixed(2)} V`,
                        metricLabel,
                      ];
                    }}
                  />
                  <Legend
                    wrapperStyle={{ fontSize: 11, color: 'var(--ctp-subtext0)' }}
                  />

                  {/* Reference levels — drawn behind the data lines */}
                  {refLines.map((rl) => (
                    <ReferenceLine
                      key={rl.label}
                      yAxisId="left"
                      y={rl.y}
                      stroke={
                        rl.tone === 'good'
                          ? 'var(--ctp-green)'
                          : rl.tone === 'mid'
                            ? 'var(--ctp-yellow)'
                            : 'var(--ctp-red)'
                      }
                      strokeDasharray="4 4"
                      strokeOpacity={0.5}
                      label={{
                        value: rl.label,
                        position: 'insideRight',
                        fill: 'var(--ctp-subtext0)',
                        fontSize: 10,
                      }}
                    />
                  ))}

                  {/* Solar production area — sits behind battery line */}
                  {hasSolar && (
                    <Area
                      yAxisId="right"
                      type="monotone"
                      dataKey="solarWh"
                      fill="var(--ctp-yellow)"
                      fillOpacity={0.18}
                      stroke="var(--ctp-yellow)"
                      strokeOpacity={0.4}
                      strokeWidth={1}
                      isAnimationActive={false}
                      connectNulls={false}
                      name="Solar Wh"
                    />
                  )}

                  {/* Actual battery / voltage */}
                  <Line
                    yAxisId="left"
                    type="monotone"
                    dataKey="value"
                    stroke="var(--ctp-blue)"
                    dot={false}
                    strokeWidth={2}
                    isAnimationActive={false}
                    connectNulls
                    name={metricLabel}
                  />

                  {/* Forecast simulation — dashed extension */}
                  {hasForecast && (
                    <Line
                      yAxisId="left"
                      type="monotone"
                      dataKey="forecastBattery"
                      stroke="var(--ctp-mauve)"
                      strokeDasharray="6 4"
                      strokeWidth={2}
                      dot={{ r: 3 }}
                      isAnimationActive={false}
                      connectNulls
                      name="Forecast"
                    />
                  )}
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          )}

          {node.recent_patterns.length > 0 && (
            <div>
              <p className="reports-node__patterns-title">Recent daily patterns</p>
              <div className="reports-table-wrap">
                <table className="reports-table">
                  <thead>
                    <tr>
                      <th>Date</th>
                      <th>Sunrise</th>
                      <th>Peak</th>
                      <th>Sunset</th>
                      <th>Rise</th>
                      <th>Fall</th>
                      <th>Charge /h</th>
                      <th>Discharge /h</th>
                    </tr>
                  </thead>
                  <tbody>
                    {node.recent_patterns.map((p) => (
                      <tr key={p.date}>
                        <td>{p.date}</td>
                        <td>
                          {p.sunrise.time} ({p.sunrise.value})
                        </td>
                        <td>
                          {p.peak.time} ({p.peak.value})
                        </td>
                        <td>
                          {p.sunset.time} ({p.sunset.value})
                        </td>
                        <td>{p.rise !== null ? p.rise.toFixed(1) : '—'}</td>
                        <td>{p.fall !== null ? p.fall.toFixed(1) : '—'}</td>
                        <td>
                          {p.charge_rate_per_hour !== null
                            ? p.charge_rate_per_hour.toFixed(2)
                            : '—'}
                        </td>
                        <td>
                          {p.discharge_rate_per_hour !== null
                            ? p.discharge_rate_per_hour.toFixed(2)
                            : '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

const Field: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <div>
    <div className="reports-node__field-label">{label}</div>
    <div className="reports-node__field-value">{value}</div>
  </div>
);

export default SolarMonitoringReport;
