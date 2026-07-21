/**
 * Bottom-drawer overlay for the Terrain Link Profile tool (epic #4111, Phase
 * 2, WP-B). Renders a recharts terrain/LOS/Fresnel chart plus a full
 * link-budget readout and an editable budget-input form for a picked
 * endpoint pair.
 *
 * Reads `linkProfileMode`/`linkEndpoints` straight from `MapAnalysisContext`
 * (LINK_PROFILE_TOOL_SPEC.md §2.8) — WP-D mounts it unconditionally
 * (`<LinkProfileDrawer />`) alongside `<BaseMap>` in `MapAnalysisCanvas.tsx`;
 * this component returns `null` itself once both `linkProfileMode` is off
 * and there are no picked endpoints. Elevation samples are fetched once per
 * endpoint pair via `useElevationProfile` (geometry-only, WP-A). Every
 * budget-input edit (frequency, antenna heights, power, gains, cable loss,
 * RX sensitivity, k-factor) recomputes `analyzeLinkProfile`/
 * `computeLinkBudget` client-side via `useMemo` — no refetch.
 */
import React, { useMemo, useState, useCallback, useEffect } from 'react';
import {
  ComposedChart,
  Area,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  ReferenceDot,
  ReferenceLine,
} from 'recharts';
import { useSettings } from '../../contexts/SettingsContext';
import { ApiError } from '../../services/api';
import { useElevationProfile } from '../../hooks/useElevationProfile';
import { useAutoRadioDefaults } from '../../hooks/useAutoRadioDefaults';
import { useMapAnalysisCtx } from './MapAnalysisContext';
import { aglFromNodeAltitude, analyzeLinkProfile, VERDICT_LABEL, VERDICT_COLOR } from '../../utils/linkProfile';
import { computeLinkBudget, DEFAULT_K_FACTOR } from '../../utils/linkBudget';
import { formatDistance } from '../../utils/distance';
import { UiIcon } from '../icons';

// Documented defaults (LINK_PROFILE_TOOL_SPEC.md §0.7).
const DEFAULT_FREQ_MHZ = 915;
const DEFAULT_AGL_M = 2;
const DEFAULT_TX_POWER_DBM = 20;
const DEFAULT_GAIN_DBI = 2.15;
const DEFAULT_CABLE_LOSS_DB = 0;
const DEFAULT_RX_SENSITIVITY_DBM = -129;

// Friendly copy for the elevation-profile error codes the server can return
// (#4111 P3 WP-2 — elevationService.ts §"Validation order"). Falls back to a
// generic message for anything else (network failure, unmapped code, etc).
const FRIENDLY_ERROR_BY_CODE: Record<string, string> = {
  IDENTICAL_POINTS: 'Pick two different points.',
  PATH_TOO_LONG: 'That link is too long to profile (max 500 km).',
  INVALID_COORDINATES: 'One of the points has invalid coordinates.',
};
const GENERIC_ERROR_MESSAGE = 'Failed to load the elevation profile. Please try again.';

interface ChartTooltipPayloadItem {
  dataKey?: string;
  value?: number | null;
  color?: string;
}

/** Custom tooltip content — formats terrain/LOS/Fresnel at the hovered distance. */
const ChartTooltip: React.FC<{
  active?: boolean;
  label?: number;
  payload?: ChartTooltipPayloadItem[];
}> = ({ active, label, payload }) => {
  if (!active || !payload || payload.length === 0) return null;
  const rows: Array<{ key: string; label: string }> = [
    { key: 'effectiveTerrain', label: 'Terrain' },
    { key: 'los', label: 'Line of sight' },
    { key: 'fresnelLower', label: 'Fresnel lower bound' },
  ];
  return (
    <div
      style={{
        backgroundColor: '#1e1e2e',
        border: '1px solid #45475a',
        borderRadius: '4px',
        color: '#cdd6f4',
        padding: '6px 10px',
        fontSize: 12,
      }}
    >
      <div>{typeof label === 'number' ? `${label.toFixed(2)} km` : ''}</div>
      {rows.map(row => {
        const item = payload.find(p => p.dataKey === row.key);
        if (!item || item.value == null) return null;
        return (
          <div key={row.key} style={{ color: item.color }}>
            {row.label}: {item.value.toFixed(1)} m
          </div>
        );
      })}
    </div>
  );
};

/** The state object Recharts hands to `<ComposedChart onMouseMove>` — derived
 *  from its own prop type so it can't drift from the installed Recharts version. */
type ChartMouseState = Parameters<NonNullable<React.ComponentProps<typeof ComposedChart>['onMouseMove']>>[0];

const LinkProfileDrawer: React.FC = () => {
  const { distanceUnit } = useSettings();
  const { linkProfileMode, linkEndpoints, setLinkProfileMode, setLinkEndpoints, setLinkVerdict, setHoverPoint } =
    useMapAnalysisCtx();
  const [endpointA, endpointB] = linkEndpoints;

  const onClose = useCallback(() => {
    setLinkProfileMode(false);
    setLinkEndpoints([]);
    setLinkVerdict(null);
    setHoverPoint(null);
  }, [setLinkProfileMode, setLinkEndpoints, setLinkVerdict, setHoverPoint]);

  // Local budget-input state, seeded from documented defaults. Edits
  // recompute the analysis client-side — they never trigger a refetch.
  const [freqMhz, setFreqMhz] = useState(DEFAULT_FREQ_MHZ);
  const [aglA, setAglA] = useState(DEFAULT_AGL_M);
  const [aglB, setAglB] = useState(DEFAULT_AGL_M);
  const [txPowerDbm, setTxPowerDbm] = useState(DEFAULT_TX_POWER_DBM);
  const [txGainDbi, setTxGainDbi] = useState(DEFAULT_GAIN_DBI);
  const [rxGainDbi, setRxGainDbi] = useState(DEFAULT_GAIN_DBI);
  const [cableLossDb, setCableLossDb] = useState(DEFAULT_CABLE_LOSS_DB);
  const [rxSensitivityDbm, setRxSensitivityDbm] = useState(DEFAULT_RX_SENSITIVITY_DBM);
  const [kFactor, setKFactor] = useState(DEFAULT_K_FACTOR);

  // Per-source auto-frequency/RX-sensitivity suggestion for the picked pair
  // (#4111 P3 WP-2). Manual edits always win: an auto value only overwrites
  // the field while the user hasn't touched it *for this endpoint pair* —
  // picking a new pair resets both "edited" flags so the new pair re-seeds.
  const auto = useAutoRadioDefaults(endpointA, endpointB);
  const [freqEdited, setFreqEdited] = useState(false);
  const [rxEdited, setRxEdited] = useState(false);
  const pairKey = `${endpointA?.id ?? ''}|${endpointB?.id ?? ''}`;

  useEffect(() => {
    setFreqEdited(false);
    setRxEdited(false);
  }, [pairKey]);

  useEffect(() => {
    if (!freqEdited && auto.freqMhz != null) setFreqMhz(auto.freqMhz);
  }, [pairKey, auto.freqMhz, freqEdited]);

  useEffect(() => {
    if (!rxEdited && auto.rxSensitivityDbm != null) setRxSensitivityDbm(auto.rxSensitivityDbm);
  }, [pairKey, auto.rxSensitivityDbm, rxEdited]);

  const { data: profile, isLoading, error } = useElevationProfile(endpointA, endpointB);

  // Antenna-AGL seeding from node-reported altitude (same manual-edits-win
  // contract as auto-frequency above): when an endpoint is a node with a
  // known altitude, suggest `altitude - DEM ground` as the starting height
  // once the profile arrives. The datum decision stands — node altitude only
  // seeds the editable input, the model still runs on DEM + AGL.
  const [aglAEdited, setAglAEdited] = useState(false);
  const [aglBEdited, setAglBEdited] = useState(false);
  const [aglASeeded, setAglASeeded] = useState(false);
  const [aglBSeeded, setAglBSeeded] = useState(false);
  useEffect(() => {
    setAglAEdited(false);
    setAglBEdited(false);
    setAglASeeded(false);
    setAglBSeeded(false);
    setAglA(DEFAULT_AGL_M);
    setAglB(DEFAULT_AGL_M);
  }, [pairKey]);
  useEffect(() => {
    if (aglAEdited || !profile?.samples.length) return;
    const seeded = aglFromNodeAltitude(endpointA?.altitudeM, profile.samples[0]?.elevation);
    if (seeded != null) {
      setAglA(seeded);
      setAglASeeded(true);
    }
  }, [pairKey, profile, endpointA?.altitudeM, aglAEdited]);
  useEffect(() => {
    if (aglBEdited || !profile?.samples.length) return;
    const seeded = aglFromNodeAltitude(
      endpointB?.altitudeM,
      profile.samples[profile.samples.length - 1]?.elevation,
    );
    if (seeded != null) {
      setAglB(seeded);
      setAglBSeeded(true);
    }
  }, [pairKey, profile, endpointB?.altitudeM, aglBEdited]);

  // Sync the elevation-graph cursor to a marker on the map: each chart row is
  // index-parallel with the fetched sample, which carries the exact lat/lng of
  // that point along the link. On mousemove set the hovered sample's coordinate;
  // clear it when the cursor leaves the plot. The mousemove state type is derived
  // from Recharts' own onMouseMove prop so it always matches the chart's contract.
  const handleChartMouseMove = useCallback(
    (state: ChartMouseState) => {
      // Recharts types activeTooltipIndex as string | number — coerce to an int.
      const idx = Number(state?.activeTooltipIndex);
      if (!profile || !state?.isTooltipActive || !Number.isInteger(idx) || idx < 0) {
        setHoverPoint(null);
        return;
      }
      const sample = profile.samples[idx];
      setHoverPoint(sample ? { lat: sample.lat, lng: sample.lng } : null);
    },
    [profile, setHoverPoint]
  );
  const handleChartMouseLeave = useCallback(() => setHoverPoint(null), [setHoverPoint]);

  const analysis = useMemo(
    () =>
      profile
        ? analyzeLinkProfile(profile.samples, {
            freqMhz,
            antennaHeightAglAM: aglA,
            antennaHeightAglBM: aglB,
            kFactor,
          })
        : null,
    [profile, freqMhz, aglA, aglB, kFactor]
  );

  const budget = useMemo(
    () =>
      analysis
        ? computeLinkBudget(analysis.totalDistanceKm, freqMhz, {
            txPowerDbm,
            txGainDbi,
            rxGainDbi,
            cableLossDb,
            rxSensitivityDbm,
          })
        : null,
    [analysis, freqMhz, txPowerDbm, txGainDbi, rxGainDbi, cableLossDb, rxSensitivityDbm]
  );

  // Mirror the computed verdict into context so the map-path Polyline
  // (`LinkProfileController`, rendered outside the drawer) can color itself
  // to match (#4111 Phase 3 WP-3). Cleared whenever there's no resolved
  // analysis (no pair picked yet, loading, error, all-null terrain) and on
  // unmount, so a closed/reset drawer never leaves a stale color behind.
  useEffect(() => {
    setLinkVerdict(analysis?.verdict ?? null);
  }, [analysis?.verdict, setLinkVerdict]);

  useEffect(() => {
    return () => {
      setLinkVerdict(null);
      setHoverPoint(null);
    };
  }, [setLinkVerdict, setHoverPoint]);

  const allTerrainNull = profile ? profile.samples.every(s => s.elevation === null) : false;

  const worstPoint = useMemo(() => {
    if (!analysis?.worst) return undefined;
    return analysis.points.find(p => p.distanceKm === analysis.worst!.distanceKm);
  }, [analysis]);

  const isElevationDisabled = error instanceof ApiError && error.code === 'ELEVATION_DISABLED';

  // Friendly per-code copy for the elevation-profile error branch (#4111 P3
  // WP-2). Falls back to the generic message for unmapped codes / non-ApiError
  // failures (e.g. a network error).
  const errorMessage =
    error instanceof ApiError && error.code && FRIENDLY_ERROR_BY_CODE[error.code]
      ? FRIENDLY_ERROR_BY_CODE[error.code]
      : GENERIC_ERROR_MESSAGE;

  // Nothing to show: tool is off and no endpoints were ever picked. Hooks
  // above are still called unconditionally (react-hooks rule) — this guard
  // runs after them.
  if (!linkProfileMode && linkEndpoints.length === 0) return null;

  return (
    <div className="map-analysis-link-drawer">
      <div className="map-analysis-link-drawer-chart">
        {!endpointA || !endpointB ? (
          <div className="map-analysis-link-drawer-empty">
            {!endpointA
              ? 'Pick two points on the map to build a link profile.'
              : 'Pick a second point to build a link profile.'}
          </div>
        ) : isLoading ? (
          <div className="map-analysis-link-drawer-loading">Loading elevation profile…</div>
        ) : isElevationDisabled ? (
          <div className="map-analysis-link-drawer-error">
            Terrain elevation is disabled on this server.
          </div>
        ) : error ? (
          <div className="map-analysis-link-drawer-error">{errorMessage}</div>
        ) : allTerrainNull ? (
          <div className="map-analysis-link-drawer-empty">No terrain data for this path.</div>
        ) : analysis ? (
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart
              data={analysis.points}
              margin={{ top: 10, right: 20, bottom: 5, left: 0 }}
              onMouseMove={handleChartMouseMove}
              onMouseLeave={handleChartMouseLeave}
            >
              <CartesianGrid strokeDasharray="3 3" stroke="#333" />
              <XAxis
                dataKey="distanceKm"
                type="number"
                domain={['dataMin', 'dataMax']}
                tick={{ fontSize: 11, fill: '#aaa' }}
                tickFormatter={(v: number) => v.toFixed(1)}
                label={{ value: 'Distance (km)', position: 'insideBottom', offset: -2, fill: '#888', fontSize: 11 }}
              />
              <YAxis
                domain={['auto', 'auto']}
                tick={{ fontSize: 11, fill: '#aaa' }}
                label={{ value: 'Elevation (m)', angle: -90, position: 'insideLeft', fill: '#888', fontSize: 11 }}
              />
              <Tooltip content={<ChartTooltip />} />
              <Area
                type="monotone"
                dataKey="effectiveTerrain"
                name="Terrain"
                fill="#8d6e63"
                fillOpacity={0.5}
                stroke="#8d6e63"
                strokeWidth={1}
                connectNulls={false}
                isAnimationActive={false}
              />
              <Line
                type="linear"
                dataKey="los"
                name="Line of sight"
                stroke="#22c55e"
                strokeWidth={2}
                strokeDasharray={analysis.verdict === 'obstructed' ? '6 4' : undefined}
                dot={false}
                isAnimationActive={false}
              />
              <Line
                type="linear"
                dataKey="fresnelLower"
                name="Fresnel lower bound"
                stroke="#f59e0b"
                strokeWidth={1.5}
                strokeDasharray="4 3"
                dot={false}
                isAnimationActive={false}
              />
              {analysis.worst && worstPoint && (
                <>
                  <ReferenceLine
                    x={analysis.worst.distanceKm}
                    stroke={VERDICT_COLOR[analysis.verdict]}
                    strokeDasharray="2 2"
                  />
                  <ReferenceDot
                    x={analysis.worst.distanceKm}
                    y={worstPoint.effectiveTerrain ?? worstPoint.los}
                    r={5}
                    fill={VERDICT_COLOR[analysis.verdict]}
                    stroke="#fff"
                  />
                </>
              )}
            </ComposedChart>
          </ResponsiveContainer>
        ) : null}
      </div>

      <div className="map-analysis-link-drawer-side">
        <div className="map-analysis-link-drawer-header">
          <span className="map-analysis-link-drawer-title">Link Profile</span>
          <button
            className="map-analysis-link-drawer-close"
            onClick={onClose}
            aria-label="Close link profile"
            title="Close"
          >
            <UiIcon name="close" size={16} />
          </button>
        </div>

        {analysis && budget && endpointA && endpointB && !isLoading && !error && (
          <div className="map-analysis-link-drawer-stats">
            <div className={`link-verdict-pill link-verdict-${analysis.verdict}`}>
              {VERDICT_LABEL[analysis.verdict]} · {budget.marginDb >= 0 ? '+' : ''}
              {budget.marginDb.toFixed(1)} dB margin
            </div>
            <dl className="map-analysis-link-drawer-statlist">
              <dt>Distance</dt>
              <dd>{formatDistance(analysis.totalDistanceKm, distanceUnit)}</dd>
              <dt>Frequency</dt>
              <dd>{freqMhz.toFixed(0)} MHz</dd>
              <dt>FSPL</dt>
              <dd>{budget.fsplDb.toFixed(1)} dB</dd>
              <dt>RX power</dt>
              <dd>{budget.rxPowerDbm.toFixed(1)} dBm</dd>
              <dt>Margin</dt>
              <dd className={budget.marginDb >= 0 ? 'link-margin-positive' : 'link-margin-negative'}>
                {budget.marginDb >= 0 ? '+' : ''}
                {budget.marginDb.toFixed(1)} dB
              </dd>
              <dt>Fresnel clearance</dt>
              <dd>
                {Number.isFinite(analysis.fresnelClearancePct)
                  ? `${analysis.fresnelClearancePct.toFixed(0)}%`
                  : 'N/A'}
              </dd>
            </dl>
          </div>
        )}

        <div className="map-analysis-link-drawer-form">
          <label>
            Frequency (MHz)
            <input
              type="number"
              className="map-analysis-tr-num"
              value={freqMhz}
              onChange={e => {
                const v = Number(e.target.value);
                if (!Number.isNaN(v)) setFreqMhz(v);
                setFreqEdited(true);
              }}
            />
          </label>
          {auto.provenance && !freqEdited && (
            <span className="link-profile-provenance">{auto.provenance}</span>
          )}
          <label>
            Antenna A height AGL (m)
            <input
              type="number"
              className="map-analysis-tr-num"
              value={aglA}
              onChange={e => {
                const v = Number(e.target.value);
                if (!Number.isNaN(v)) {
                  setAglA(v);
                  setAglAEdited(true);
                }
              }}
            />
          </label>
          {aglASeeded && !aglAEdited && (
            <span className="link-profile-provenance">from node altitude</span>
          )}
          <label>
            Antenna B height AGL (m)
            <input
              type="number"
              className="map-analysis-tr-num"
              value={aglB}
              onChange={e => {
                const v = Number(e.target.value);
                if (!Number.isNaN(v)) {
                  setAglB(v);
                  setAglBEdited(true);
                }
              }}
            />
          </label>
          {aglBSeeded && !aglBEdited && (
            <span className="link-profile-provenance">from node altitude</span>
          )}
          <label>
            TX power (dBm)
            <input
              type="number"
              className="map-analysis-tr-num"
              value={txPowerDbm}
              onChange={e => {
                const v = Number(e.target.value);
                if (!Number.isNaN(v)) setTxPowerDbm(v);
              }}
            />
          </label>
          <label>
            TX gain (dBi)
            <input
              type="number"
              className="map-analysis-tr-num"
              value={txGainDbi}
              onChange={e => {
                const v = Number(e.target.value);
                if (!Number.isNaN(v)) setTxGainDbi(v);
              }}
            />
          </label>
          <label>
            RX gain (dBi)
            <input
              type="number"
              className="map-analysis-tr-num"
              value={rxGainDbi}
              onChange={e => {
                const v = Number(e.target.value);
                if (!Number.isNaN(v)) setRxGainDbi(v);
              }}
            />
          </label>
          <label>
            Cable loss (dB)
            <input
              type="number"
              className="map-analysis-tr-num"
              value={cableLossDb}
              onChange={e => {
                const v = Number(e.target.value);
                if (!Number.isNaN(v)) setCableLossDb(v);
              }}
            />
          </label>
          <label>
            RX sensitivity (dBm)
            <input
              type="number"
              className="map-analysis-tr-num"
              value={rxSensitivityDbm}
              onChange={e => {
                const v = Number(e.target.value);
                if (!Number.isNaN(v)) setRxSensitivityDbm(v);
                setRxEdited(true);
              }}
            />
          </label>
          <label>
            Earth k-factor
            <input
              type="number"
              step="0.01"
              className="map-analysis-tr-num"
              value={kFactor}
              onChange={e => {
                const v = Number(e.target.value);
                if (!Number.isNaN(v)) setKFactor(v);
              }}
            />
          </label>
        </div>
      </div>
    </div>
  );
};

export default LinkProfileDrawer;
