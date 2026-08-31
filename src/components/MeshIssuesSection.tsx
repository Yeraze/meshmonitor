import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useToast } from './ToastContainer';
import { useCsrfFetch } from '../hooks/useCsrfFetch';
import { useSaveBar } from '../hooks/useSaveBar';
import { ISSUE_TYPE_LABELS, ruleIdsByTier, ruleShortId, buildRuleMuteSettingsPatch } from './Analysis/meshIssueRuleIds';

interface MeshIssuesSectionProps {
  baseUrl: string;
}

/**
 * Resolved + clamped thresholds actually in force for the next run
 * (#4964 Phase 3 WP1, `meshIssues/thresholds.ts`). Declared locally rather
 * than imported from server code — the frontend never imports from
 * `src/server/**` — mirroring `PositionEstimationSection`'s locally-declared
 * status shape.
 */
interface MeshIssuesThresholds {
  tierAEnabled: boolean;
  tierBEnabled: boolean;
  tierCEnabled: boolean;
  /** @deprecated legacy; folded into `disabledRules` server-side (report
   *  reorg #4964 WP2, spec §4.5/§5.2). Kept on the wire; the UI no longer
   *  reads it directly — see `disabledRules` and `buildRuleMuteSettingsPatch`. */
  b7Enabled: boolean;
  /** Resolved, validated, sorted per-rule mute list (report reorg #4964 WP2,
   *  spec §4.5). Optional here for the same server-drift reason as
   *  `autoCloseCleanRuns` below — falls back to `[]` (nothing muted). */
  disabledRules?: string[];
  airUtilTxPct: number;
  channelUtilPct: number;
  mobileSpanMeters: number;
  snrAsymmetryDb: number;
  overBroadcastSeconds: number;
  /**
   * #4964 post-epic follow-ups. Named `autoCloseCleanRuns` to match the
   * server's `ResolvedMeshIssueThresholds` (`thresholds.ts`) — NOT
   * `autoCloseRuns`. Optional here — absent on a status response from a
   * server that hasn't registered the setting yet, in which case the form
   * falls back to the same default (3, `AUTO_CLOSE_CLEAN_RUNS`) the server
   * uses.
   */
  autoCloseCleanRuns?: number;
  /** km, B1/B6 cluster-adjacency distance guard (#4976). Optional for the
   *  same server-drift reason as `autoCloseCleanRuns`; falls back to 30. */
  routerClusterMaxLinkKm?: number;
}

interface MeshIssuesRunResult {
  findingCount: number;
  durationMs: number;
}

interface MeshIssuesStatus {
  running: boolean;
  inProgress: boolean;
  enabled: boolean;
  frequencyHours: number;
  lookbackHours: number;
  pairBucketHours: number;
  lastRunTime: number | null;
  lastRunResult: MeshIssuesRunResult | null;
  thresholds: MeshIssuesThresholds;
  lastRunResultFromStorage: boolean;
}

const FREQUENCY_OPTIONS = [6, 12, 24, 48, 168];
const LOOKBACK_OPTIONS = [24, 72, 168, 336, 720]; // 1d, 3d, 7d, 14d, 30d
const PAIR_BUCKET_OPTIONS = [1, 3, 6, 12, 24];

/** `GET`/`POST` envelope every route in this app returns:
 *  `{ success: true, data }` (CLAUDE.md's `ok()`/`fail()` gotcha) — this
 *  component talks to `/api/analysis/mesh-issues/*` directly with
 *  `useCsrfFetch`, so unwrapping `.data` is manual here, unlike
 *  `ApiService.request()` which callers elsewhere rely on NOT unwrapping. */
interface Envelope<T> {
  success: boolean;
  data?: T;
}

/**
 * Settings UI for the Mesh Issues Analysis scheduler (#4964, Phase 3 WP5).
 * Modeled directly on `PositionEstimationSection.tsx`: own local state, a
 * plain `POST /api/settings` (NOT the `SettingsDraft` reducer — see spec
 * P3-D4), and `useSaveBar` for the save/dismiss affordance. Status comes from
 * `GET /api/analysis/mesh-issues/status`, which already returns the
 * resolved + clamped values in force, so the form always reflects what the
 * next run will actually use — including after a value outside its clamp
 * range is saved and the page reloads.
 *
 * Saving here only writes settings keys. It never calls `run-now` and never
 * touches `mesh_issues_last_run` — the scheduler's restart-safety timer
 * (mesh-impact checklist §3) must not be re-armed by a settings save.
 */
const MeshIssuesSection: React.FC<MeshIssuesSectionProps> = ({ baseUrl }) => {
  const { t } = useTranslation();
  const csrfFetch = useCsrfFetch();
  const { showToast } = useToast();

  // Schedule
  const [enabled, setEnabled] = useState(true);
  const [frequencyHours, setFrequencyHours] = useState(24);
  const [lookbackHours, setLookbackHours] = useState(168);
  const [pairBucketHours, setPairBucketHours] = useState(6);

  // Rules
  const [tierAEnabled, setTierAEnabled] = useState(true);
  const [tierBEnabled, setTierBEnabled] = useState(true);
  const [tierCEnabled, setTierCEnabled] = useState(true);
  /** Per-rule mute list (report reorg #4964 WP2). Baseline mirror, per the
   *  same local/dirty split every other field here uses. */
  const [disabledRules, setDisabledRules] = useState<string[]>([]);

  // Thresholds
  const [airUtilTxPct, setAirUtilTxPct] = useState(8);
  const [channelUtilPct, setChannelUtilPct] = useState(25);
  const [mobileSpanMeters, setMobileSpanMeters] = useState(500);
  const [snrAsymmetryDb, setSnrAsymmetryDb] = useState(6);
  const [overBroadcastSeconds, setOverBroadcastSeconds] = useState(300);
  const [autoCloseRuns, setAutoCloseRuns] = useState(3);
  const [clusterMaxLinkKm, setClusterMaxLinkKm] = useState(30);

  // Local (dirty) mirrors
  const [localEnabled, setLocalEnabled] = useState(true);
  const [localFrequencyHours, setLocalFrequencyHours] = useState(24);
  const [localLookbackHours, setLocalLookbackHours] = useState(168);
  const [localPairBucketHours, setLocalPairBucketHours] = useState(6);
  const [localTierAEnabled, setLocalTierAEnabled] = useState(true);
  const [localTierBEnabled, setLocalTierBEnabled] = useState(true);
  const [localTierCEnabled, setLocalTierCEnabled] = useState(true);
  const [localDisabledRules, setLocalDisabledRules] = useState<string[]>([]);
  const [localAirUtilTxPct, setLocalAirUtilTxPct] = useState(8);
  const [localChannelUtilPct, setLocalChannelUtilPct] = useState(25);
  const [localMobileSpanMeters, setLocalMobileSpanMeters] = useState(500);
  const [localSnrAsymmetryDb, setLocalSnrAsymmetryDb] = useState(6);
  const [localOverBroadcastSeconds, setLocalOverBroadcastSeconds] = useState(300);
  const [localAutoCloseRuns, setLocalAutoCloseRuns] = useState(3);
  const [localClusterMaxLinkKm, setLocalClusterMaxLinkKm] = useState(30);

  const [status, setStatus] = useState<MeshIssuesStatus | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [isRunning, setIsRunning] = useState(false);

  const applyStatus = useCallback((data: MeshIssuesStatus) => {
    setStatus(data);
    setEnabled(data.enabled);
    setFrequencyHours(data.frequencyHours);
    setLookbackHours(data.lookbackHours);
    setPairBucketHours(data.pairBucketHours);
    setTierAEnabled(data.thresholds.tierAEnabled);
    setTierBEnabled(data.thresholds.tierBEnabled);
    setTierCEnabled(data.thresholds.tierCEnabled);
    setDisabledRules(data.thresholds.disabledRules ?? []);
    setAirUtilTxPct(data.thresholds.airUtilTxPct);
    setChannelUtilPct(data.thresholds.channelUtilPct);
    setMobileSpanMeters(data.thresholds.mobileSpanMeters);
    setSnrAsymmetryDb(data.thresholds.snrAsymmetryDb);
    setOverBroadcastSeconds(data.thresholds.overBroadcastSeconds);
    setAutoCloseRuns(data.thresholds.autoCloseCleanRuns ?? 3);
    setClusterMaxLinkKm(data.thresholds.routerClusterMaxLinkKm ?? 30);

    setLocalEnabled(data.enabled);
    setLocalFrequencyHours(data.frequencyHours);
    setLocalLookbackHours(data.lookbackHours);
    setLocalPairBucketHours(data.pairBucketHours);
    setLocalTierAEnabled(data.thresholds.tierAEnabled);
    setLocalTierBEnabled(data.thresholds.tierBEnabled);
    setLocalTierCEnabled(data.thresholds.tierCEnabled);
    setLocalDisabledRules(data.thresholds.disabledRules ?? []);
    setLocalAirUtilTxPct(data.thresholds.airUtilTxPct);
    setLocalChannelUtilPct(data.thresholds.channelUtilPct);
    setLocalMobileSpanMeters(data.thresholds.mobileSpanMeters);
    setLocalSnrAsymmetryDb(data.thresholds.snrAsymmetryDb);
    setLocalOverBroadcastSeconds(data.thresholds.overBroadcastSeconds);
    setLocalAutoCloseRuns(data.thresholds.autoCloseCleanRuns ?? 3);
    setLocalClusterMaxLinkKm(data.thresholds.routerClusterMaxLinkKm ?? 30);
  }, []);

  const fetchStatus = useCallback(async () => {
    try {
      const response = await csrfFetch(`${baseUrl}/api/analysis/mesh-issues/status`);
      if (response.ok) {
        const body: Envelope<MeshIssuesStatus> = await response.json();
        if (body.success && body.data) {
          applyStatus(body.data);
        }
      }
    } catch {
      // Status is non-critical; ignore fetch failures.
    }
  }, [csrfFetch, baseUrl, applyStatus]);

  useEffect(() => {
    void fetchStatus();
  }, [fetchStatus]);

  /** Order-independent set comparison — `localDisabledRules` accumulates in
   *  checkbox-click order, not the server's sorted order. */
  const sameRuleSet = (a: string[], b: string[]): boolean =>
    [...new Set(a)].sort().join(',') === [...new Set(b)].sort().join(',');

  const hasChanges =
    localEnabled !== enabled ||
    localFrequencyHours !== frequencyHours ||
    localLookbackHours !== lookbackHours ||
    localPairBucketHours !== pairBucketHours ||
    localTierAEnabled !== tierAEnabled ||
    localTierBEnabled !== tierBEnabled ||
    localTierCEnabled !== tierCEnabled ||
    !sameRuleSet(localDisabledRules, disabledRules) ||
    localAirUtilTxPct !== airUtilTxPct ||
    localChannelUtilPct !== channelUtilPct ||
    localMobileSpanMeters !== mobileSpanMeters ||
    localSnrAsymmetryDb !== snrAsymmetryDb ||
    localOverBroadcastSeconds !== overBroadcastSeconds ||
    localAutoCloseRuns !== autoCloseRuns ||
    localClusterMaxLinkKm !== clusterMaxLinkKm;

  const handleSave = useCallback(async () => {
    setIsSaving(true);
    try {
      const response = await csrfFetch(`${baseUrl}/api/settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mesh_issues_enabled: String(localEnabled),
          mesh_issues_frequency_hours: String(localFrequencyHours),
          mesh_issues_lookback_hours: String(localLookbackHours),
          mesh_issues_pair_bucket_hours: String(localPairBucketHours),
          mesh_issues_tier_a_enabled: String(localTierAEnabled),
          mesh_issues_tier_b_enabled: String(localTierBEnabled),
          mesh_issues_tier_c_enabled: String(localTierCEnabled),
          // Writes BOTH mesh_issues_disabled_rules and the legacy
          // mesh_issues_b7_enabled together — see buildRuleMuteSettingsPatch's
          // TRAP comment (spec §5.2): writing the CSV key alone cannot
          // un-mute B7 while the legacy key still says 'false'.
          ...buildRuleMuteSettingsPatch(localDisabledRules),
          mesh_issues_air_util_tx_pct: String(localAirUtilTxPct),
          mesh_issues_channel_util_pct: String(localChannelUtilPct),
          mesh_issues_mobile_span_meters: String(localMobileSpanMeters),
          mesh_issues_snr_asymmetry_db: String(localSnrAsymmetryDb),
          mesh_issues_over_broadcast_seconds: String(localOverBroadcastSeconds),
          mesh_issues_auto_close_runs: String(localAutoCloseRuns),
          mesh_issues_router_cluster_max_link_km: String(localClusterMaxLinkKm),
        }),
      });
      if (response.ok) {
        showToast(t('automation.settings_saved', 'Settings saved'), 'success');
        // Re-fetch so the form reflects the resolved+clamped values actually
        // in force (spec §9 WP5 acceptance: an out-of-range save comes back
        // clamped after reload).
        void fetchStatus();
      } else {
        showToast(t('automation.settings_save_failed', 'Failed to save'), 'error');
      }
    } catch {
      showToast(t('automation.settings_save_failed', 'Failed to save'), 'error');
    } finally {
      setIsSaving(false);
    }
  }, [
    localEnabled,
    localFrequencyHours,
    localLookbackHours,
    localPairBucketHours,
    localTierAEnabled,
    localTierBEnabled,
    localTierCEnabled,
    localDisabledRules,
    localAirUtilTxPct,
    localChannelUtilPct,
    localMobileSpanMeters,
    localSnrAsymmetryDb,
    localOverBroadcastSeconds,
    localAutoCloseRuns,
    localClusterMaxLinkKm,
    csrfFetch,
    baseUrl,
    showToast,
    t,
    fetchStatus,
  ]);

  const resetChanges = useCallback(() => {
    setLocalEnabled(enabled);
    setLocalFrequencyHours(frequencyHours);
    setLocalLookbackHours(lookbackHours);
    setLocalPairBucketHours(pairBucketHours);
    setLocalTierAEnabled(tierAEnabled);
    setLocalTierBEnabled(tierBEnabled);
    setLocalTierCEnabled(tierCEnabled);
    setLocalDisabledRules(disabledRules);
    setLocalAirUtilTxPct(airUtilTxPct);
    setLocalChannelUtilPct(channelUtilPct);
    setLocalMobileSpanMeters(mobileSpanMeters);
    setLocalSnrAsymmetryDb(snrAsymmetryDb);
    setLocalOverBroadcastSeconds(overBroadcastSeconds);
    setLocalAutoCloseRuns(autoCloseRuns);
    setLocalClusterMaxLinkKm(clusterMaxLinkKm);
  }, [
    enabled,
    frequencyHours,
    lookbackHours,
    pairBucketHours,
    tierAEnabled,
    tierBEnabled,
    tierCEnabled,
    disabledRules,
    airUtilTxPct,
    channelUtilPct,
    mobileSpanMeters,
    snrAsymmetryDb,
    overBroadcastSeconds,
    autoCloseRuns,
    clusterMaxLinkKm,
  ]);

  useSaveBar({
    id: 'mesh-issues',
    sectionName: t('automation.mesh_issues.title', 'Mesh Issues Analysis'),
    hasChanges,
    isSaving,
    onSave: handleSave,
    onDismiss: resetChanges,
  });

  const handleRunNow = useCallback(async () => {
    setIsRunning(true);
    try {
      const response = await csrfFetch(`${baseUrl}/api/analysis/mesh-issues/run-now`, {
        method: 'POST',
      });
      if (response.ok) {
        const body: Envelope<MeshIssuesRunResult> = await response.json();
        showToast(
          t('automation.mesh_issues.run_result', {
            count: body.data?.findingCount ?? 0,
            defaultValue: `Analysis complete: ${body.data?.findingCount ?? 0} finding(s)`,
          }),
          'success'
        );
        void fetchStatus();
      } else if (response.status === 409) {
        showToast(t('automation.mesh_issues.already_running', 'Mesh issues analysis already running'), 'warning');
      } else {
        showToast(t('automation.settings_save_failed', 'Failed to run'), 'error');
      }
    } catch {
      showToast(t('automation.settings_save_failed', 'Failed to run'), 'error');
    } finally {
      setIsRunning(false);
    }
  }, [csrfFetch, baseUrl, showToast, t, fetchStatus]);

  const lookbackLabel = (hours: number): string => {
    if (hours % 24 === 0) return t('automation.position_estimation.lookback_days', { count: hours / 24, defaultValue: `${hours / 24} day(s)` });
    return t('automation.position_estimation.lookback_hours', { count: hours, defaultValue: `${hours} hour(s)` });
  };

  /** Rule ids grouped by tier, computed once (report reorg #4964 WP2). */
  const tierGroups = useMemo(() => ruleIdsByTier(), []);

  const toggleRule = useCallback((ruleId: string, ruleEnabled: boolean) => {
    setLocalDisabledRules((prev) =>
      ruleEnabled ? prev.filter((id) => id !== ruleId) : Array.from(new Set([...prev, ruleId]))
    );
  }, []);

  const badgeStyle = (kind: 'official' | 'ours'): React.CSSProperties => ({
    display: 'inline-block',
    marginLeft: '0.5rem',
    padding: '0.05rem 0.4rem',
    fontSize: '11px',
    fontWeight: 600,
    borderRadius: '4px',
    verticalAlign: 'middle',
    background: 'var(--color-surface-active)',
    color: kind === 'official' ? 'var(--color-info)' : 'var(--color-text-muted)',
  });

  return (
    <>
      <div className="automation-section-header" style={{
        display: 'flex',
        alignItems: 'center',
        marginBottom: '1.5rem',
        padding: '1rem 1.25rem',
        background: 'var(--color-surface-hover)',
        border: '1px solid var(--color-surface-active)',
        borderRadius: '8px'
      }}>
        <h2 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          <input
            type="checkbox"
            checked={localEnabled}
            onChange={(e) => setLocalEnabled(e.target.checked)}
            style={{ width: 'auto', margin: 0, cursor: 'pointer' }}
          />
          {t('automation.mesh_issues.title', 'Mesh Issues Analysis')}
        </h2>
        <div className="automation-button-container" style={{ display: 'flex', gap: '0.75rem', marginLeft: 'auto' }}>
          <button
            onClick={handleRunNow}
            disabled={isRunning || status?.inProgress}
            className="btn-primary"
            style={{
              padding: '0.5rem 1.5rem',
              fontSize: '14px',
              opacity: (!isRunning && !status?.inProgress) ? 1 : 0.5,
              cursor: (!isRunning && !status?.inProgress) ? 'pointer' : 'not-allowed'
            }}
          >
            {(isRunning || status?.inProgress)
              ? t('automation.mesh_issues.running', 'Running…')
              : t('automation.mesh_issues.run_now', 'Run analysis now')}
          </button>
        </div>
      </div>

      <div className="settings-section" style={{ opacity: localEnabled ? 1 : 0.5, transition: 'opacity 0.2s' }}>
        <p style={{ marginBottom: '1rem', color: 'var(--color-text-muted)', lineHeight: '1.5', marginLeft: '1.75rem' }}>
          {t('automation.mesh_issues.description',
            'Scheduled health report over routing, RF adjacency, and node-flag data your sources have already collected. Sends zero packets — it never generates a traceroute, polls a node, or sends a message. "Run analysis now" is also passive.')}
        </p>

        <h3 style={{ marginLeft: '1.75rem', marginTop: '1.5rem' }}>{t('automation.mesh_issues.schedule_heading', 'Schedule')}</h3>

        <div className="setting-item" style={{ marginTop: '1rem' }}>
          <label>{t('automation.mesh_issues.frequency', 'Analysis frequency')}</label>
          <select
            value={localFrequencyHours}
            onChange={(e) => setLocalFrequencyHours(parseInt(e.target.value, 10))}
            disabled={!localEnabled}
            className="setting-input"
          >
            {FREQUENCY_OPTIONS.map((h) => (
              <option key={h} value={h}>
                {t('automation.mesh_issues.every_hours', { count: h, defaultValue: `Every ${h} hours` })}
              </option>
            ))}
          </select>
        </div>

        <div className="setting-item" style={{ marginTop: '1rem' }}>
          <label>{t('automation.mesh_issues.lookback', 'Lookback window')}</label>
          <select
            value={localLookbackHours}
            onChange={(e) => setLocalLookbackHours(parseInt(e.target.value, 10))}
            disabled={!localEnabled}
            className="setting-input"
          >
            {LOOKBACK_OPTIONS.map((h) => (
              <option key={h} value={h}>{lookbackLabel(h)}</option>
            ))}
          </select>
        </div>

        <div className="setting-item" style={{ marginTop: '1rem' }}>
          <label>{t('automation.mesh_issues.pair_bucket', 'Traceroute pair bucket')}</label>
          <select
            value={localPairBucketHours}
            onChange={(e) => setLocalPairBucketHours(parseInt(e.target.value, 10))}
            disabled={!localEnabled}
            className="setting-input"
          >
            {PAIR_BUCKET_OPTIONS.map((h) => (
              <option key={h} value={h}>
                {t('automation.mesh_issues.every_hours', { count: h, defaultValue: `Every ${h} hours` })}
              </option>
            ))}
          </select>
          <p style={{ fontSize: '12px', color: 'var(--color-text-subtle)', margin: '0.35rem 0 0 0' }}>
            {t('automation.mesh_issues.pair_bucket_help',
              'How the traceroute corpus dedupes repeated observations of the same node pair before sampling.')}
          </p>
        </div>

        <h3 style={{ marginLeft: '1.75rem', marginTop: '1.5rem' }}>{t('automation.mesh_issues.rules_heading', 'Rules')}</h3>

        <div className="setting-item" style={{ marginTop: '1rem' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <input
              type="checkbox"
              checked={localTierAEnabled}
              onChange={(e) => setLocalTierAEnabled(e.target.checked)}
              disabled={!localEnabled}
              style={{ width: 'auto', margin: 0 }}
            />
            {t('automation.mesh_issues.tier_a', 'Tier A — Node health')}
          </label>
          <p style={{ fontSize: '12px', color: 'var(--color-text-subtle)', margin: '0.35rem 0 0 1.75rem' }}>
            {t('automation.mesh_issues.tier_a_help',
              'Battery, uptime, airtime/channel utilization, and mobility of infrastructure-role nodes.')}
          </p>
        </div>

        <div className="setting-item" style={{ marginTop: '1rem' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <input
              type="checkbox"
              checked={localTierBEnabled}
              onChange={(e) => setLocalTierBEnabled(e.target.checked)}
              disabled={!localEnabled}
              style={{ width: 'auto', margin: 0 }}
            />
            {t('automation.mesh_issues.tier_b', 'Tier B — RF adjacency graph')}
          </label>
          <p style={{ fontSize: '12px', color: 'var(--color-text-subtle)', margin: '0.35rem 0 0 1.75rem' }}>
            {t('automation.mesh_issues.tier_b_help',
              'Router clustering, redundancy, SNR asymmetry, idle/load-bearing routers, hop horizon, and coverage shadow, built from traceroutes, NeighborInfo, and packet-log evidence.')}
          </p>
        </div>

        <div className="setting-item" style={{ marginTop: '1rem' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <input
              type="checkbox"
              checked={localTierCEnabled}
              onChange={(e) => setLocalTierCEnabled(e.target.checked)}
              disabled={!localEnabled}
              style={{ width: 'auto', margin: 0 }}
            />
            {t('automation.mesh_issues.tier_c', 'Tier C — Node flags')}
          </label>
          <p style={{ fontSize: '12px', color: 'var(--color-text-subtle)', margin: '0.35rem 0 0 1.75rem' }}>
            {t('automation.mesh_issues.tier_c_help',
              'Excessive packet rate, key security (low-entropy/duplicate/mismatched keys), clock offset, and over-broadcasting — folded in from flags other services already compute.')}
          </p>
        </div>

        <h3 style={{ marginLeft: '1.75rem', marginTop: '1.5rem' }}>{t('automation.mesh_issues.rule_mute_heading', 'Individual rules')}</h3>
        <p style={{ marginLeft: '1.75rem', fontSize: '12px', color: 'var(--color-text-subtle)' }}>
          {t('automation.mesh_issues.rule_mute_help',
            'Uncheck a rule to stop detecting it. Muting does not delete anything: its existing open findings stay as they are and auto-close on their own after {{runs}} analysis run(s) in a row with nothing re-detected — the same way a disabled tier already behaves.',
            { runs: localAutoCloseRuns })}
        </p>

        <div className="setting-item" style={{ marginTop: '0.75rem', marginLeft: '1.75rem', display: 'flex', flexWrap: 'wrap', gap: '1.5rem' }}>
          {(['A', 'B', 'C'] as const).map((tier) => (
            <div key={tier} style={{ minWidth: '220px' }}>
              <div style={{ fontSize: '12px', fontWeight: 600, color: 'var(--color-text-muted)', marginBottom: '0.4rem' }}>
                {t(`automation.mesh_issues.tier_${tier.toLowerCase()}_short`, `Tier ${tier}`)}
              </div>
              {tierGroups[tier].map((ruleId) => {
                const ruleEnabled = !localDisabledRules.includes(ruleId);
                return (
                  <label
                    key={ruleId}
                    style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginTop: '0.4rem' }}
                  >
                    <input
                      type="checkbox"
                      checked={ruleEnabled}
                      onChange={(e) => toggleRule(ruleId, e.target.checked)}
                      disabled={!localEnabled}
                      style={{ width: 'auto', margin: 0 }}
                    />
                    <span
                      style={{
                        fontFamily: 'var(--font-mono, monospace)',
                        fontSize: '11px',
                        color: 'var(--color-text-subtle)',
                        minWidth: '2.25rem',
                      }}
                    >
                      {ruleShortId(ruleId)}
                    </span>
                    <span style={{ fontSize: '13px' }}>{ISSUE_TYPE_LABELS[ruleId] ?? ruleId}</span>
                  </label>
                );
              })}
            </div>
          ))}
        </div>

        <h3 style={{ marginLeft: '1.75rem', marginTop: '1.5rem' }}>{t('automation.mesh_issues.thresholds_heading', 'Thresholds')}</h3>

        <div className="setting-item" style={{ marginTop: '1rem' }}>
          <label>
            {t('automation.mesh_issues.air_util_tx', 'Airtime TX ceiling (%)')}
            <span style={badgeStyle('official')}>{t('automation.mesh_issues.badge_official', '[official]')}</span>
          </label>
          <input
            type="number"
            min={1}
            max={50}
            step={1}
            value={localAirUtilTxPct}
            onChange={(e) => {
              const v = parseFloat(e.target.value);
              setLocalAirUtilTxPct(Number.isFinite(v) ? v : 8);
            }}
            disabled={!localEnabled}
            className="setting-input"
          />
          <p style={{ fontSize: '12px', color: 'var(--color-text-subtle)', margin: '0.35rem 0 0 0' }}>
            {t('automation.mesh_issues.air_util_tx_help',
              'Official Meshtastic guidance: above 8% a node is using too much of the channel.')}
          </p>
        </div>

        <div className="setting-item" style={{ marginTop: '1rem' }}>
          <label>
            {t('automation.mesh_issues.channel_util', 'Channel utilization ceiling (%)')}
            <span style={badgeStyle('official')}>{t('automation.mesh_issues.badge_official', '[official]')}</span>
          </label>
          <input
            type="number"
            min={5}
            max={100}
            step={1}
            value={localChannelUtilPct}
            onChange={(e) => {
              const v = parseFloat(e.target.value);
              setLocalChannelUtilPct(Number.isFinite(v) ? v : 25);
            }}
            disabled={!localEnabled}
            className="setting-input"
          />
          <p style={{ fontSize: '12px', color: 'var(--color-text-subtle)', margin: '0.35rem 0 0 0' }}>
            {t('automation.mesh_issues.channel_util_help',
              'Official Meshtastic guidance: above 25% the local RF area is congested.')}
          </p>
        </div>

        <div className="setting-item" style={{ marginTop: '1rem' }}>
          <label>
            {t('automation.mesh_issues.mobile_span', 'Mobile span (metres)')}
            <span style={badgeStyle('ours')}>{t('automation.mesh_issues.badge_meshmonitor', '[MeshMonitor]')}</span>
          </label>
          <input
            type="number"
            min={50}
            max={50000}
            step={10}
            value={localMobileSpanMeters}
            onChange={(e) => {
              const v = parseFloat(e.target.value);
              setLocalMobileSpanMeters(Number.isFinite(v) ? v : 500);
            }}
            disabled={!localEnabled}
            className="setting-input"
          />
          <p style={{ fontSize: '12px', color: 'var(--color-text-subtle)', margin: '0.35rem 0 0 0' }}>
            {t('automation.mesh_issues.mobile_span_help',
              'How far an infrastructure node may move before it is flagged. Not an official Meshtastic figure.')}
          </p>
        </div>

        <div className="setting-item" style={{ marginTop: '1rem' }}>
          <label>
            {t('automation.mesh_issues.snr_asymmetry', 'Link SNR asymmetry (dB)')}
            <span style={badgeStyle('ours')}>{t('automation.mesh_issues.badge_meshmonitor', '[MeshMonitor]')}</span>
          </label>
          <input
            type="number"
            min={1}
            max={30}
            step={1}
            value={localSnrAsymmetryDb}
            onChange={(e) => {
              const v = parseFloat(e.target.value);
              setLocalSnrAsymmetryDb(Number.isFinite(v) ? v : 6);
            }}
            disabled={!localEnabled}
            className="setting-input"
          />
          <p style={{ fontSize: '12px', color: 'var(--color-text-subtle)', margin: '0.35rem 0 0 0' }}>
            {t('automation.mesh_issues.snr_asymmetry_help',
              'Directional mean-SNR delta above which a link is flagged as asymmetric. MeshMonitor\'s own judgement, not an official figure.')}
          </p>
        </div>

        <div className="setting-item" style={{ marginTop: '1rem' }}>
          <label>
            {t('automation.mesh_issues.over_broadcast', 'Broadcast interval floor (seconds)')}
            <span style={badgeStyle('ours')}>{t('automation.mesh_issues.badge_meshmonitor', '[MeshMonitor]')}</span>
          </label>
          <input
            type="number"
            min={30}
            max={3600}
            step={10}
            value={localOverBroadcastSeconds}
            onChange={(e) => {
              const v = parseFloat(e.target.value);
              setLocalOverBroadcastSeconds(Number.isFinite(v) ? v : 300);
            }}
            disabled={!localEnabled}
            className="setting-input"
          />
          <p style={{ fontSize: '12px', color: 'var(--color-text-subtle)', margin: '0.35rem 0 0 0' }}>
            {t('automation.mesh_issues.over_broadcast_help',
              'Median position/telemetry inter-arrival below which a non-tracker node counts as over-broadcasting. MeshMonitor\'s own judgement, not an official figure.')}
          </p>
        </div>

        <div className="setting-item" style={{ marginTop: '1rem' }}>
          <label>
            {t('automation.mesh_issues.auto_close_runs', 'Auto-close after')}
            <span style={badgeStyle('ours')}>{t('automation.mesh_issues.badge_meshmonitor', '[MeshMonitor]')}</span>
          </label>
          <input
            type="number"
            min={1}
            max={20}
            step={1}
            value={localAutoCloseRuns}
            onChange={(e) => {
              const v = parseFloat(e.target.value);
              setLocalAutoCloseRuns(Number.isFinite(v) ? v : 3);
            }}
            disabled={!localEnabled}
            className="setting-input"
          />
          <p style={{ fontSize: '12px', color: 'var(--color-text-subtle)', margin: '0.35rem 0 0 0' }}>
            {t('automation.mesh_issues.auto_close_runs_help',
              'Runs without re-detection before an issue auto-closes.')}
          </p>
        </div>

        <div className="setting-item" style={{ marginTop: '1rem' }}>
          <label>
            {t('automation.mesh_issues.cluster_max_link_km', 'Router cluster max link (km)')}
            <span style={badgeStyle('ours')}>{t('automation.mesh_issues.badge_meshmonitor', '[MeshMonitor]')}</span>
          </label>
          <input
            type="number"
            min={1}
            max={500}
            step={1}
            value={localClusterMaxLinkKm}
            onChange={(e) => {
              const v = parseFloat(e.target.value);
              setLocalClusterMaxLinkKm(Number.isFinite(v) ? v : 30);
            }}
            disabled={!localEnabled}
            className="setting-input"
          />
          <p style={{ fontSize: '12px', color: 'var(--color-text-subtle)', margin: '0.35rem 0 0 0' }}>
            {t('automation.mesh_issues.cluster_max_link_km_help',
              'Positioned routers farther apart than this never count as one Router Cluster or as redundant coverage. Filters MQTT-bridged "hops" that never happened over RF.')}
          </p>
        </div>

        <p style={{ marginLeft: '1.75rem', marginTop: '1rem', fontSize: '12px', color: 'var(--color-text-subtle)' }}>
          {t('automation.mesh_issues.other_thresholds',
            'Other thresholds are fixed in code. See the Mesh Issues documentation for the full list and where each number comes from.')}
        </p>

        {status && (
          <div style={{ marginTop: '1.5rem', marginLeft: '1.75rem', fontSize: '13px', color: 'var(--color-text-muted)' }}>
            <div>
              {t('automation.mesh_issues.last_run', 'Last run')}:{' '}
              {status.lastRunTime ? new Date(status.lastRunTime).toLocaleString() : t('automation.mesh_issues.never', 'never')}
            </div>
            {status.lastRunResult && (
              <div style={{ marginTop: '0.25rem' }}>
                {t('automation.mesh_issues.last_result', {
                  count: status.lastRunResult.findingCount,
                  defaultValue: `${status.lastRunResult.findingCount} finding(s)`,
                })}
                {status.lastRunResultFromStorage ? (
                  <>
                    {' '}
                    {t('automation.mesh_issues.from_storage', '(from the last completed run before restart)')}
                  </>
                ) : null}
              </div>
            )}
          </div>
        )}
      </div>
    </>
  );
};

export default MeshIssuesSection;
