import React, { useCallback, useEffect, useState } from 'react';
import Modal from '../common/Modal';
import { UiIcon } from '../icons';
import { useCsrfFetch } from '../../hooks/useCsrfFetch';
import { useSource } from '../../contexts/SourceContext';
import { useToast } from '../ToastContainer';
import { BLOCK_BY_TYPE, numericFields, stringFields, STRING_OP_OPTIONS } from '../automations/catalog';
import type { WorkflowForm, FormBlock, Rule } from '../automations/compile';
import styles from './AutoAckConvertDialog.module.css';

/**
 * Auto-Acknowledge → Automation converter dialog (#4340 Phase 4 WP4, spec §6.2).
 *
 * Three states: Loading (POST preview on open) → Preview (report + checkboxes,
 * or a blocking error) → Result (created/updated/deleted summary). Talks only to
 * the two WP3 endpoints (`POST /api/automations/convert/preview` and
 * `.../create`) via `useCsrfFetch` — no raw `fetch()` (banned in
 * `src/components/**`).
 */

// ─── JSON contract (spec §5.2/§5.3) — mirrored here as plain frontend types.
// This dialog owns no server code; these interfaces describe the response
// shape the WP3 routes are contracted to produce, not a runtime import.

export interface AutoAckConvertReportEntry {
  key: string;
  label: string;
  detail: string;
}

export interface AutoAckConvertReport {
  converted: AutoAckConvertReportEntry[];
  approximated: AutoAckConvertReportEntry[];
  notConvertible: AutoAckConvertReportEntry[];
  dropped: AutoAckConvertReportEntry[];
}

export type AutoAckConvertBlocking = 'NO_CELLS_ENABLED' | 'CHANNEL_ALLOWLIST_UNCONVERTIBLE' | null;

export interface AutoAckConvertAutomation {
  key: 'channel' | 'direct';
  name: string;
  description: string;
  enabled: boolean;
  /** The compiled graph — not rendered directly; the preview renders `form`. */
  config: unknown;
  /** For the preview UI — render the rules as readable English (spec §6.2). */
  form: WorkflowForm;
  /** Pre-rendered, human-readable rule summaries, one per `form.rules` entry, when the
   *  server provides them. Falls back to a local renderer built from `form.rules` when
   *  absent so the preview still reads clearly. */
  ruleSummaries?: string[];
}

export interface AutoAckConvertExisting {
  id: string | number;
  name: string;
  updatedAt: string;
  enabled: boolean;
}

export interface AutoAckConvertPreviewData {
  sourceId: string;
  sourceName: string;
  autoAckEnabled: boolean;
  automations: AutoAckConvertAutomation[];
  report: AutoAckConvertReport;
  existing: AutoAckConvertExisting[];
  blocking: AutoAckConvertBlocking;
}

interface AutoAckConvertResultItem {
  id: string | number;
  name: string;
}

export interface AutoAckConvertCreateData {
  created: AutoAckConvertResultItem[];
  updated: AutoAckConvertResultItem[];
  deleted: AutoAckConvertResultItem[];
  autoAckDisabled: boolean;
  report: AutoAckConvertReport;
}

interface ApiEnvelope<T> {
  success: boolean;
  data?: T;
  error?: string;
  code?: string;
  existing?: AutoAckConvertExisting[];
}

async function safeJson<T>(res: Response): Promise<ApiEnvelope<T> | null> {
  try {
    return (await res.json()) as ApiEnvelope<T>;
  } catch {
    return null;
  }
}

// ─── Fallback readable-rule renderer (used when the server omits `ruleSummaries`) ──

function fieldLabel(kind: 'numeric' | 'string', field: string): string {
  const groups = kind === 'numeric' ? numericFields('trigger.message') : stringFields('trigger.message');
  for (const group of groups) {
    const opt = group.options.find((o) => o.value === field);
    if (opt) return opt.label;
  }
  return field;
}

function describeCondition(block: FormBlock): string {
  switch (block.type) {
    case 'condition.sourceFilter':
      return 'the message is from this source';
    case 'condition.numeric': {
      const { field, op, value } = block.params as { field: string; op: string; value: string };
      const label = fieldLabel('numeric', String(field));
      const opLabel = op === '==' ? 'is' : op === '!=' ? 'is not' : op;
      return `${label} ${opLabel} ${value}`;
    }
    case 'condition.string': {
      const { field, op, value } = block.params as { field: string; op: string; value: string };
      const label = fieldLabel('string', String(field));
      const opDef = STRING_OP_OPTIONS.find((o) => o.value === op);
      return `${label} ${opDef?.label ?? op} "${value}"`;
    }
    default:
      return BLOCK_BY_TYPE[block.type]?.label ?? block.type;
  }
}

function describeAction(block: FormBlock): string {
  switch (block.type) {
    case 'action.delay':
      return `wait ${String(block.params.seconds)}s`;
    case 'action.tapback':
      return 'react with a hop-count tapback';
    case 'action.sendMessage': {
      const asDm = block.params.to ? ' as a DM' : '';
      return `send "${String(block.params.text)}"${asDm}`;
    }
    default:
      return BLOCK_BY_TYPE[block.type]?.label ?? block.type;
  }
}

function describeRule(rule: Rule): string {
  const conditions = rule.conditions.map(describeCondition).join(' AND ');
  const actions = rule.actions.map(describeAction).join(', then ');
  return `IF ${conditions} THEN ${actions}`;
}

function ruleSummariesFor(automation: AutoAckConvertAutomation): string[] {
  if (automation.ruleSummaries && automation.ruleSummaries.length > 0) return automation.ruleSummaries;
  return automation.form.rules.map(describeRule);
}

// ─── Report rendering ───────────────────────────────────────────────────────

const REPORT_GROUPS: Array<{ key: keyof AutoAckConvertReport; title: string; emptyText: string }> = [
  { key: 'notConvertible', title: 'Not convertible', emptyText: 'Nothing was dropped — every setting that has an effect was converted or approximated.' },
  { key: 'converted', title: 'Converted', emptyText: '' },
  { key: 'approximated', title: 'Approximated', emptyText: '' },
  { key: 'dropped', title: 'Deprecated (nothing to convert)', emptyText: '' },
];

function ReportGroup({ groupKey, title, entries, emptyText }: {
  groupKey: keyof AutoAckConvertReport;
  title: string;
  entries: AutoAckConvertReportEntry[];
  emptyText: string;
}) {
  // notConvertible always renders, even empty (spec §6.2: "the report is clean").
  if (entries.length === 0 && groupKey !== 'notConvertible') return null;
  const isNotConvertible = groupKey === 'notConvertible';
  return (
    <div className={`${styles.reportGroup} ${isNotConvertible ? styles.reportGroupWarning : ''}`}>
      <h4 className={styles.reportGroupTitle}>
        {isNotConvertible && <UiIcon name="alert" size={16} />}
        {title} ({entries.length})
      </h4>
      {entries.length === 0 ? (
        <p className={styles.reportEmpty}>{emptyText}</p>
      ) : (
        <ul className={styles.reportList}>
          {entries.map((entry) => (
            <li key={entry.key} className={styles.reportEntry}>
              <span className={styles.reportEntryKey}>{entry.key}</span>
              <span className={styles.reportEntryLabel}>{entry.label}</span>
              <span className={styles.reportEntryDetail}>{entry.detail}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const BLOCKING_MESSAGES: Record<Exclude<AutoAckConvertBlocking, null>, string> = {
  NO_CELLS_ENABLED: 'Nothing to convert — no cell in the Response matrix has "Message" or "Tapback" enabled, so Auto-Acknowledge never sends anything for this source.',
  CHANNEL_ALLOWLIST_UNCONVERTIBLE: 'The channel allowlist could not be converted — every listed channel was missing, disabled, or unnamed. Fix the allowlist (see the report below) and try again.',
};

interface AutoAckConvertDialogProps {
  isOpen: boolean;
  onClose: () => void;
  baseUrl: string;
  /** Called with `false` when the server reports `autoAckDisabled: true`, so the
   *  parent's saved-enabled state matches the server without a refetch (spec §6.2). */
  onEnabledChange: (enabled: boolean) => void;
}

type Phase = 'loading' | 'preview' | 'creating' | 'result' | 'load-error';

const AutoAckConvertDialog: React.FC<AutoAckConvertDialogProps> = ({ isOpen, onClose, baseUrl, onEnabledChange }) => {
  const csrfFetch = useCsrfFetch();
  const { sourceId } = useSource();
  const { showToast } = useToast();

  const [phase, setPhase] = useState<Phase>('loading');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [previewData, setPreviewData] = useState<AutoAckConvertPreviewData | null>(null);

  const [enableNow, setEnableNow] = useState(false);
  // Checked by default (epic decision 8) — turning it off only flips the on/off
  // switch; every other Auto-Acknowledge setting is left untouched, so the user
  // can switch back to the old behaviour at any time.
  const [disableAutoAck, setDisableAutoAck] = useState(true);
  const [replaceExisting, setReplaceExisting] = useState(false);

  const [createError, setCreateError] = useState<string | null>(null);
  const [createResult, setCreateResult] = useState<AutoAckConvertCreateData | null>(null);

  const fetchPreview = useCallback(async () => {
    setPhase('loading');
    setLoadError(null);
    if (!sourceId) {
      setLoadError('No source is selected — open this dialog from a specific source’s Automation settings.');
      setPhase('load-error');
      return;
    }
    try {
      const res = await csrfFetch(`${baseUrl}/api/automations/convert/preview`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sourceId }),
      });
      const body = await safeJson<AutoAckConvertPreviewData>(res);
      if (!res.ok || !body?.success || !body.data) {
        setLoadError(body?.error || 'Failed to load the conversion preview.');
        setPhase('load-error');
        return;
      }
      setPreviewData(body.data);
      setEnableNow(body.data.autoAckEnabled);
      setDisableAutoAck(true);
      setReplaceExisting(false);
      setPhase('preview');
    } catch {
      setLoadError('Network error while loading the conversion preview.');
      setPhase('load-error');
    }
  }, [sourceId, baseUrl, csrfFetch]);

  useEffect(() => {
    if (!isOpen) return;
    setCreateError(null);
    setCreateResult(null);
    void fetchPreview();
    // fetchPreview is stable per sourceId/baseUrl; re-running per `isOpen` toggle
    // is the intended behaviour (re-fetch the preview every time the dialog opens).
    // eslint-disable-next-line react-hooks/exhaustive-deps -- #4340 re-run only on open, not on every fetchPreview identity change
  }, [isOpen]);

  const handleConvert = useCallback(async () => {
    if (!sourceId || !previewData) return;
    setPhase('creating');
    setCreateError(null);
    try {
      const res = await csrfFetch(`${baseUrl}/api/automations/convert/create`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sourceId, enable: enableNow, disableAutoAck, replaceExisting }),
      });
      const body = await safeJson<AutoAckConvertCreateData>(res);
      if (!res.ok || !body?.success || !body.data) {
        const message = body?.error || 'Failed to create the automation(s).';
        setCreateError(message);
        showToast(message, 'error');
        setPhase('preview');
        return;
      }
      setCreateResult(body.data);
      if (body.data.autoAckDisabled) onEnabledChange(false);
      showToast('Auto-Acknowledge converted to an automation.', 'success');
      setPhase('result');
    } catch {
      const message = 'Network error while creating the automation(s).';
      setCreateError(message);
      showToast(message, 'error');
      setPhase('preview');
    }
  }, [sourceId, previewData, baseUrl, csrfFetch, enableNow, disableAutoAck, replaceExisting, onEnabledChange, showToast]);

  const handleClose = useCallback(() => {
    onClose();
  }, [onClose]);

  return (
    <Modal
      isOpen={isOpen}
      onClose={handleClose}
      title="Convert Auto-Acknowledge to an Automation"
      className={styles.dialog}
      maxWidth="720px"
    >
      {phase === 'loading' && (
        <div className={styles.loading}>
          <UiIcon name="refresh" className={styles.spinner} />
          <span>Building a preview…</span>
        </div>
      )}

      {phase === 'load-error' && (
        <div className={styles.errorBanner}>
          <UiIcon name="error" size={18} />
          <span>{loadError}</span>
        </div>
      )}

      {(phase === 'preview' || phase === 'creating') && previewData && (
        <div className={styles.preview}>
          {previewData.blocking && (
            <div className={styles.blockingBanner} role="alert">
              <UiIcon name="error" size={18} />
              <span>{BLOCKING_MESSAGES[previewData.blocking]}</span>
            </div>
          )}

          {createError && (
            <div className={styles.errorBanner}>
              <UiIcon name="error" size={18} />
              <span>{createError}</span>
            </div>
          )}

          {previewData.existing.length > 0 && (
            <div className={styles.existingBanner}>
              <div>
                <UiIcon name="info" size={16} />
                {' '}This source was already converted before:{' '}
                {previewData.existing.map((e) => e.name).join(', ')}.
              </div>
              <label className={styles.checkboxRow}>
                <input
                  type="checkbox"
                  checked={replaceExisting}
                  onChange={(e) => setReplaceExisting(e.target.checked)}
                />
                Replace them
              </label>
            </div>
          )}

          {previewData.automations.length === 2 && (
            <p className={styles.twoAutomationsNote}>
              <UiIcon name="info" size={16} />
              {' '}Two automations will be created, one for Channel messages and one for
              Direct messages. They can’t be combined: an automation’s channel filter
              also applies to direct messages, but Auto-Acknowledge’s channel allowlist
              only ever gated channel replies — sharing one automation would silently start
              filtering your Direct replies by channel too.
            </p>
          )}

          {previewData.automations.length > 0 && (
            <div className={styles.automationCards}>
              {previewData.automations.map((automation) => (
                <div key={automation.key} className={styles.automationCard}>
                  <div className={styles.automationCardHeader}>
                    <UiIcon name="bot" size={16} />
                    <span className={styles.automationCardName}>{automation.name}</span>
                    {!automation.enabled && <span className={styles.disabledPill}>disabled</span>}
                  </div>
                  <ul className={styles.ruleList}>
                    {ruleSummariesFor(automation).map((summary, idx) => (
                      <li key={idx}>{summary}</li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          )}

          <div className={styles.reportSection}>
            <h3 className={styles.reportSectionTitle}>Conversion report</h3>
            {REPORT_GROUPS.map((g) => (
              <ReportGroup
                key={g.key}
                groupKey={g.key}
                title={g.title}
                entries={previewData.report[g.key]}
                emptyText={g.emptyText}
              />
            ))}
          </div>

          <div className={styles.optionsSection}>
            <label className={styles.checkboxRow}>
              <input
                type="checkbox"
                checked={enableNow}
                onChange={(e) => setEnableNow(e.target.checked)}
                disabled={phase === 'creating'}
              />
              Enable the new automation now
            </label>
            <label className={styles.checkboxRow}>
              <input
                type="checkbox"
                checked={disableAutoAck}
                onChange={(e) => setDisableAutoAck(e.target.checked)}
                disabled={phase === 'creating'}
              />
              Turn off Auto-Acknowledge for this source
            </label>
            <p className={styles.helperText}>
              Your Auto-Acknowledge settings are kept — only the on/off switch is turned off,
              so you can switch back at any time.
            </p>
          </div>

          <div className={styles.actions}>
            <button type="button" className={styles.secondaryButton} onClick={handleClose} disabled={phase === 'creating'}>
              Cancel
            </button>
            <button
              type="button"
              className={styles.primaryButton}
              onClick={handleConvert}
              disabled={!!previewData.blocking || phase === 'creating'}
            >
              {phase === 'creating' ? 'Converting…' : 'Convert'}
            </button>
          </div>
        </div>
      )}

      {phase === 'result' && createResult && (
        <div className={styles.result}>
          <div className={styles.resultBanner}>
            <UiIcon name="check" size={18} />
            <span>Conversion complete.</span>
          </div>
          {createResult.created.length > 0 && (
            <p>Created: {createResult.created.map((a) => a.name).join(', ')}</p>
          )}
          {createResult.updated.length > 0 && (
            <p>Updated: {createResult.updated.map((a) => a.name).join(', ')}</p>
          )}
          {createResult.deleted.length > 0 && (
            <p>Removed: {createResult.deleted.map((a) => a.name).join(', ')}</p>
          )}
          {createResult.autoAckDisabled && <p>Auto-Acknowledge has been turned off for this source.</p>}
          <div className={styles.actions}>
            <a href="/automations" className={styles.primaryButton}>
              View automations
            </a>
            <button type="button" className={styles.secondaryButton} onClick={handleClose}>
              Close
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
};

export default AutoAckConvertDialog;
