/**
 * Auto-Enrichment settings (#5287): run the NodeInfo Enrichment "Fix All" on a
 * schedule instead of only from the Analysis report.
 *
 * Global — one scheduler covers every source, since enrichment copies blank
 * fields from one source's row to another's. Saved through POST /api/settings;
 * status and "Run now" have their own routes.
 *
 * The push-to-device option is the part with an airtime cost, so its limits
 * are stated right next to the toggle (CLAUDE.md: warn in the UI, not in a doc).
 */
import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useToast } from './ToastContainer';
import { useCsrfFetch } from '../hooks/useCsrfFetch';
import { useSaveBar } from '../hooks/useSaveBar';
import styles from './AutoEnrichmentSection.module.css';

interface AutoEnrichmentSectionProps {
  baseUrl: string;
}

type ScheduleType = 'interval' | 'cron';

interface RunSummary {
  startedAt: number;
  finishedAt: number;
  nodesFilled: number;
  fieldsCopied: number;
  pushesSent: number;
  pushesFailed: number;
  pushesPending: number;
  trigger: 'schedule' | 'manual';
}

interface AutoEnrichmentStatus {
  enabled: boolean;
  scheduleType: ScheduleType;
  intervalMinutes: number;
  cron: string;
  cronValid: boolean;
  pushToNodeDb: boolean;
  inProgress: boolean;
  lastRunAt: number | null;
  lastRunSummary: RunSummary | null;
  pendingPushes: number;
  limits: {
    minIntervalMinutes: number;
    maxIntervalMinutes: number;
    pushCapPerRun: number;
    pushSpacingMs: number;
  };
}

interface Draft {
  enabled: boolean;
  scheduleType: ScheduleType;
  intervalHours: number;
  cron: string;
  pushToNodeDb: boolean;
}

/** Offered intervals, in hours. The server floor is one hour. */
const INTERVAL_HOURS_OPTIONS = [1, 2, 3, 6, 12, 24, 48, 168];

function draftFrom(status: AutoEnrichmentStatus): Draft {
  return {
    enabled: status.enabled,
    scheduleType: status.scheduleType,
    intervalHours: Math.round(status.intervalMinutes / 60),
    cron: status.cron,
    pushToNodeDb: status.pushToNodeDb,
  };
}

const EMPTY_DRAFT: Draft = {
  enabled: false,
  scheduleType: 'interval',
  intervalHours: 6,
  cron: '0 */6 * * *',
  pushToNodeDb: false,
};

const AutoEnrichmentSection: React.FC<AutoEnrichmentSectionProps> = ({ baseUrl }) => {
  const { t } = useTranslation();
  const csrfFetch = useCsrfFetch();
  const { showToast } = useToast();

  const [status, setStatus] = useState<AutoEnrichmentStatus | null>(null);
  const [saved, setSaved] = useState<Draft>(EMPTY_DRAFT);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [isSaving, setIsSaving] = useState(false);
  const [isRunning, setIsRunning] = useState(false);

  const fetchStatus = useCallback(async () => {
    try {
      const response = await csrfFetch(`${baseUrl}/api/settings/auto-enrichment/status`);
      if (!response.ok) return;
      const body = await response.json();
      const data: AutoEnrichmentStatus = body.data;
      setStatus(data);
      const next = draftFrom(data);
      // A server with no cron stored yet keeps the friendly default in the field.
      if (!next.cron) next.cron = EMPTY_DRAFT.cron;
      setSaved(next);
      setDraft(next);
    } catch {
      // Status is informational; the form still works without it.
    }
  }, [csrfFetch, baseUrl]);

  useEffect(() => {
    void fetchStatus();
  }, [fetchStatus]);

  const hasChanges =
    draft.enabled !== saved.enabled ||
    draft.scheduleType !== saved.scheduleType ||
    draft.intervalHours !== saved.intervalHours ||
    draft.cron !== saved.cron ||
    draft.pushToNodeDb !== saved.pushToNodeDb;

  const handleSave = useCallback(async () => {
    setIsSaving(true);
    try {
      const response = await csrfFetch(`${baseUrl}/api/settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          autoEnrichmentEnabled: String(draft.enabled),
          autoEnrichmentScheduleType: draft.scheduleType,
          autoEnrichmentIntervalMinutes: String(draft.intervalHours * 60),
          autoEnrichmentCron: draft.cron.trim(),
          autoEnrichmentPushToNodeDb: String(draft.pushToNodeDb),
        }),
      });
      if (response.ok) {
        setSaved(draft);
        showToast(t('automation.settings_saved', 'Settings saved'), 'success');
        void fetchStatus();
      } else {
        // The server explains a rejected schedule (too frequent, bad cron).
        const body = await response.json().catch(() => ({}));
        showToast(body.error || t('automation.settings_save_failed', 'Failed to save'), 'error');
      }
    } catch {
      showToast(t('automation.settings_save_failed', 'Failed to save'), 'error');
    } finally {
      setIsSaving(false);
    }
  }, [draft, csrfFetch, baseUrl, showToast, t, fetchStatus]);

  useSaveBar({
    id: 'auto-enrichment',
    sectionName: t('automation.auto_enrichment.title', 'Auto-Enrichment'),
    hasChanges,
    isSaving,
    onSave: handleSave,
    onDismiss: () => setDraft(saved),
  });

  const handleRunNow = useCallback(async () => {
    setIsRunning(true);
    try {
      const response = await csrfFetch(`${baseUrl}/api/settings/auto-enrichment/run-now`, { method: 'POST' });
      if (response.ok) {
        const body = await response.json();
        const summary: RunSummary = body.data;
        showToast(
          t('automation.auto_enrichment.run_result', {
            nodes: summary.nodesFilled,
            fields: summary.fieldsCopied,
            defaultValue: `Filled ${summary.nodesFilled} node(s), ${summary.fieldsCopied} field(s)`,
          }),
          'success',
        );
        void fetchStatus();
      } else if (response.status === 409) {
        showToast(t('automation.auto_enrichment.already_running', 'Auto-enrichment is already running'), 'warning');
      } else {
        showToast(t('automation.auto_enrichment.run_failed', 'Failed to run auto-enrichment'), 'error');
      }
    } catch {
      showToast(t('automation.auto_enrichment.run_failed', 'Failed to run auto-enrichment'), 'error');
    } finally {
      setIsRunning(false);
    }
  }, [csrfFetch, baseUrl, showToast, t, fetchStatus]);

  const busy = isRunning || Boolean(status?.inProgress);
  const cap = status?.limits.pushCapPerRun ?? 25;
  const spacingSec = Math.round((status?.limits.pushSpacingMs ?? 30_000) / 1000);
  const summary = status?.lastRunSummary ?? null;

  return (
    <>
      <div className={`automation-section-header ${styles.header}`}>
        <h2 className={styles.title}>
          <input
            type="checkbox"
            checked={draft.enabled}
            onChange={(e) => setDraft(d => ({ ...d, enabled: e.target.checked }))}
            className={styles.enableBox}
            aria-label={t('automation.auto_enrichment.enable', 'Enable auto-enrichment')}
          />
          {t('automation.auto_enrichment.title', 'Auto-Enrichment')}
        </h2>
        <button
          type="button"
          onClick={handleRunNow}
          disabled={busy}
          className={`btn-primary ${styles.runNow}`}
        >
          {busy
            ? t('automation.auto_enrichment.running', 'Running…')
            : t('automation.auto_enrichment.run_now', 'Run now')}
        </button>
      </div>

      <div className={`settings-section ${draft.enabled ? '' : styles.dimmed}`}>
        <p className={styles.description}>
          {t('automation.auto_enrichment.description',
            'Runs the NodeInfo Enrichment "Fix All" on a schedule: blank names, hardware and keys on one source are filled from another source that has them. Nothing is overwritten.')}
        </p>

        <div className="setting-item">
          <label htmlFor="auto-enrichment-schedule-type">
            {t('automation.auto_enrichment.schedule_type', 'Schedule')}
          </label>
          <select
            id="auto-enrichment-schedule-type"
            className="setting-input"
            value={draft.scheduleType}
            disabled={!draft.enabled}
            onChange={(e) => setDraft(d => ({ ...d, scheduleType: e.target.value as ScheduleType }))}
          >
            <option value="interval">{t('automation.auto_enrichment.type_interval', 'Fixed interval')}</option>
            <option value="cron">{t('automation.auto_enrichment.type_cron', 'Cron expression')}</option>
          </select>
        </div>

        {draft.scheduleType === 'interval' ? (
          <div className="setting-item">
            <label htmlFor="auto-enrichment-interval">
              {t('automation.auto_enrichment.interval', 'Run every')}
            </label>
            <select
              id="auto-enrichment-interval"
              className="setting-input"
              value={draft.intervalHours}
              disabled={!draft.enabled}
              onChange={(e) => setDraft(d => ({ ...d, intervalHours: parseInt(e.target.value, 10) }))}
            >
              {INTERVAL_HOURS_OPTIONS.map(h => (
                <option key={h} value={h}>
                  {t('automation.auto_enrichment.every_hours', { count: h, defaultValue: `Every ${h} hour(s)` })}
                </option>
              ))}
            </select>
          </div>
        ) : (
          <div className="setting-item">
            <label htmlFor="auto-enrichment-cron">
              {t('automation.auto_enrichment.cron', 'Cron expression')}
            </label>
            <input
              id="auto-enrichment-cron"
              type="text"
              className={`setting-input ${styles.cronInput}`}
              value={draft.cron}
              disabled={!draft.enabled}
              spellCheck={false}
              placeholder="0 */6 * * *"
              onChange={(e) => setDraft(d => ({ ...d, cron: e.target.value }))}
            />
            <p className={styles.help}>
              {t('automation.auto_enrichment.cron_help',
                'Must fire at most once an hour. Example: 0 */6 * * * runs every six hours.')}
            </p>
          </div>
        )}

        <div className="setting-item">
          <label className={styles.checkLabel}>
            <input
              type="checkbox"
              checked={draft.pushToNodeDb}
              disabled={!draft.enabled}
              onChange={(e) => setDraft(d => ({ ...d, pushToNodeDb: e.target.checked }))}
            />
            {t('automation.auto_enrichment.push', 'Also push corrections to the device NodeDB')}
          </label>
          {/* Airtime warning next to the input, per CLAUDE.md. */}
          <p className={styles.warning} role="note">
            {t('automation.auto_enrichment.push_warning', {
              cap,
              spacing: spacingSec,
              defaultValue:
                `Sends one NodeInfo request over the mesh per enriched node. Limited to ${cap} per run, ${spacingSec} s apart; the rest wait for the next run. Leave off unless you need the radio's own NodeDB kept in sync.`,
            })}
          </p>
        </div>

        {status && (
          <div className={styles.statusBlock}>
            <div>
              {t('automation.auto_enrichment.last_run', 'Last run')}:{' '}
              {status.lastRunAt
                ? new Date(status.lastRunAt).toLocaleString()
                : t('automation.auto_enrichment.never', 'never')}
            </div>
            {summary && (
              <div>
                {t('automation.auto_enrichment.last_result', {
                  nodes: summary.nodesFilled,
                  fields: summary.fieldsCopied,
                  sent: summary.pushesSent,
                  defaultValue:
                    `${summary.nodesFilled} node(s) filled, ${summary.fieldsCopied} field(s); ${summary.pushesSent} NodeInfo request(s) sent`,
                })}
              </div>
            )}
            {status.pendingPushes > 0 && (
              <div>
                {t('automation.auto_enrichment.pending', {
                  count: status.pendingPushes,
                  defaultValue: `${status.pendingPushes} push(es) waiting for the next run`,
                })}
              </div>
            )}
          </div>
        )}
      </div>
    </>
  );
};

export default AutoEnrichmentSection;
