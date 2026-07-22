/**
 * NodeInfoEnrichmentReport — cross-source NodeInfo enrichment analysis + apply.
 *
 * Finds nodes seen on multiple sources where one source is missing NodeInfo
 * fields (longName, hwModel, role, ...) that another source already has, and
 * lets the user copy the missing fields over — per-row or in bulk.
 *
 * Backend contract (Phase 1, #3837):
 *  - GET  /api/nodes/enrichment/analysis  -> { success, data: EnrichmentAnalysis }
 *  - POST /api/nodes/enrichment/apply     -> { success, data: ApplyResult }
 * `ApiService.request()` returns the raw envelope and does NOT unwrap `data`
 * (CLAUDE.md gotcha) — every call here reads `body.data` explicitly.
 */
import { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import api, { ApiError } from '../../services/api';
import { useToast } from '../ToastContainer';
import { UiIcon } from '../icons';
import { nodeInfoFieldLabel } from '../../utils/nodeInfoFields';

interface EnrichmentTarget {
  targetSourceId: string;
  targetSourceName: string;
  fillableFields: string[];
  donorSourceId: string;
  donorSourceName: string;
}

interface EnrichmentNode {
  nodeNum: number;
  nodeId: string;
  displayName: string;
  targets: EnrichmentTarget[];
}

interface EnrichmentSummary {
  nodeCount: number;
  targetCount: number;
  fieldCount: number;
}

interface EnrichmentAnalysis {
  nodes: EnrichmentNode[];
  summary: EnrichmentSummary;
}

interface ApplyItem {
  nodeNum: number;
  targetSourceId: string;
  donorSourceId: string;
}

interface ApplyResult {
  applied: Array<ApplyItem & { copiedFields: string[]; pushedToDevice: boolean }>;
  totalFieldsCopied: number;
}

const ANALYSIS_KEY = ['nodeinfo-enrichment-analysis'] as const;

interface EnrichmentRow extends EnrichmentTarget {
  nodeNum: number;
  nodeId: string;
  displayName: string;
  rowKey: string;
}

const NodeInfoEnrichmentReport: React.FC = () => {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { showToast } = useToast();
  const [pushToNodeDb, setPushToNodeDb] = useState(false);
  const [inFlightRowKey, setInFlightRowKey] = useState<string | null>(null);

  const { data, isLoading, error, isFetching } = useQuery<EnrichmentAnalysis>({
    queryKey: ANALYSIS_KEY,
    queryFn: async () => {
      const body = await api.get<{ success: boolean; data: EnrichmentAnalysis }>(
        '/api/nodes/enrichment/analysis',
      );
      return body.data; // envelope not unwrapped by ApiService
    },
  });

  const applyMutation = useMutation<ApplyResult, ApiError, ApplyItem[]>({
    mutationFn: async (items) => {
      const body = await api.post<{ success: boolean; data: ApplyResult }>(
        '/api/nodes/enrichment/apply',
        { items, pushToNodeDb },
      );
      return body.data;
    },
    onSuccess: (result) => {
      showToast(
        t(
          'analysis.enrichment.apply_success',
          'Copied {{fields}} field(s) across {{targets}} target(s)',
          { fields: result.totalFieldsCopied, targets: result.applied.length },
        ),
        'success',
      );
      void qc.invalidateQueries({ queryKey: ANALYSIS_KEY });
    },
    onError: (err) => {
      showToast(
        err?.message ?? t('analysis.enrichment.apply_error', 'Failed to apply enrichment'),
        'error',
      );
    },
    onSettled: () => {
      setInFlightRowKey(null);
    },
  });

  const rows = useMemo<EnrichmentRow[]>(
    () =>
      (data?.nodes ?? []).flatMap((n) =>
        n.targets.map((tg) => ({
          ...tg,
          nodeNum: n.nodeNum,
          nodeId: n.nodeId,
          displayName: n.displayName,
          rowKey: `${n.nodeNum}:${tg.targetSourceId}`,
        })),
      ),
    [data],
  );

  const toApplyItem = (row: EnrichmentRow): ApplyItem => ({
    nodeNum: row.nodeNum,
    targetSourceId: row.targetSourceId,
    donorSourceId: row.donorSourceId,
  });

  const handleFixRow = (row: EnrichmentRow) => {
    setInFlightRowKey(row.rowKey);
    applyMutation.mutate([toApplyItem(row)]);
  };

  const handleFixAll = () => {
    setInFlightRowKey(null);
    applyMutation.mutate(rows.map(toApplyItem));
  };

  const summary = data?.summary;

  return (
    <>
      <div>
        <h2 className="reports-section__title">
          <UiIcon name="identity" size={22} />
          {t('analysis.enrichment.title', 'NodeInfo Enrichment')}
        </h2>
        <p className="reports-section__subtitle">
          {t(
            'analysis.enrichment.description',
            'Fill blank NodeInfo fields (name, hardware, role, …) for nodes seen on multiple sources by copying from a source that already has the data.',
          )}
        </p>
      </div>

      {isLoading && (
        <div className="reports-banner">
          {t('analysis.enrichment.loading', 'Analyzing NodeInfo across sources…')}
        </div>
      )}

      {error && (
        <div className="reports-banner reports-banner--error">
          {(error as Error).message}
        </div>
      )}

      {!isLoading && !error && rows.length === 0 && (
        <div className="reports-banner reports-banner--empty">
          <div>{t('analysis.enrichment.empty', 'No nodes need enrichment.')}</div>
          <div className="reports-banner__hint">
            {t(
              'analysis.enrichment.empty_hint',
              "Enrichment compares NodeInfo across the sources you can read. If you're signed out or only have access to one source, sign in to see more.",
            )}
          </div>
        </div>
      )}

      {!isLoading && !error && rows.length > 0 && (
        <>
          <div className="reports-stats">
            <Stat label={t('analysis.enrichment.stat_nodes', 'Nodes')} value={String(summary?.nodeCount ?? 0)} />
            <Stat label={t('analysis.enrichment.stat_targets', 'Targets')} value={String(summary?.targetCount ?? 0)} />
            <Stat label={t('analysis.enrichment.stat_fields', 'Fillable fields')} value={String(summary?.fieldCount ?? 0)} />
          </div>

          <div className="reports-panel">
            <div className="reports-controls">
              <div className="reports-enrichment__push">
                <label>
                  <input
                    type="checkbox"
                    checked={pushToNodeDb}
                    onChange={(e) => setPushToNodeDb(e.target.checked)}
                    disabled={applyMutation.isPending}
                  />
                  {t('analysis.enrichment.push_to_device', 'Also push to device NodeDB')}
                </label>
                <span className="reports-enrichment__push-help">
                  {t(
                    'analysis.enrichment.push_to_device_help',
                    'Sends the copied fields to the target device over the mesh, in addition to updating the local database.',
                  )}
                </span>
              </div>
              <button
                type="button"
                className="reports-btn"
                onClick={handleFixAll}
                disabled={applyMutation.isPending || rows.length === 0}
              >
                <UiIcon name="sparkles" size={16} />
                {applyMutation.isPending && inFlightRowKey === null
                  ? t('analysis.enrichment.fixing_all', 'Fixing…')
                  : t('analysis.enrichment.fix_all', 'Fix All')}
              </button>
              <button
                type="button"
                className="reports-btn reports-btn--ghost"
                onClick={() => void qc.invalidateQueries({ queryKey: ANALYSIS_KEY })}
                disabled={isFetching}
              >
                <UiIcon name="refresh" size={16} />
                {t('analysis.enrichment.refresh', 'Refresh')}
              </button>
            </div>
          </div>

          <div className="reports-table-wrap">
            <table className="reports-table">
              <thead>
                <tr>
                  <th>{t('analysis.enrichment.col_node', 'Node')}</th>
                  <th>{t('analysis.enrichment.col_target', 'Target source')}</th>
                  <th>{t('analysis.enrichment.col_fields', 'Fillable fields')}</th>
                  <th>{t('analysis.enrichment.col_donor', 'Donor source')}</th>
                  <th>{t('analysis.enrichment.col_action', 'Action')}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.rowKey}>
                    <td>
                      <div className="reports-node__name">{row.displayName}</div>
                      <div className="reports-node__meta">{row.nodeId}</div>
                    </td>
                    <td>{row.targetSourceName}</td>
                    <td>
                      {row.fillableFields.map((f) => (
                        <span key={f} className="reports-field-pill">
                          {nodeInfoFieldLabel(f)}
                        </span>
                      ))}
                    </td>
                    <td>{row.donorSourceName}</td>
                    <td>
                      <button
                        type="button"
                        className="reports-btn"
                        onClick={() => handleFixRow(row)}
                        disabled={applyMutation.isPending}
                      >
                        <UiIcon name="copy" size={14} />
                        {applyMutation.isPending && inFlightRowKey === row.rowKey
                          ? t('analysis.enrichment.fixing', 'Fixing…')
                          : t('analysis.enrichment.fix', 'Fix')}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </>
  );
};

const Stat: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <div className="reports-stat">
    <div className="reports-stat__label">{label}</div>
    <div className="reports-stat__value">{value}</div>
  </div>
);

export default NodeInfoEnrichmentReport;
