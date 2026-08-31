/**
 * IssueTable — the generic, type-specific-column-driven table for one
 * By-issue section (#4964 report reorganization, WP4, spec §6.2/§6.5/§8).
 * The shell composes: expand | state | subject | ...type-specific columns
 * from `columnsForType` | sources (hidden with <=1 source) | severity |
 * last detected | actions. Row click expands `FindingDetail` inline,
 * following the `MqttViolationsReport` expandable-row idiom verbatim (spec
 * §3.1): `aria-expanded` lives on the toggle BUTTON, never the `<tr>`
 * (`role="row"` doesn't support it).
 */
import { Fragment, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { UiIcon } from '../../icons';
import { formatSourceIds, hexNodeId, type MeshIssueRow } from '../meshIssueTypes';
import { asNodeRef } from './evidenceRenderers';
import FindingDetail from './FindingDetail';
import SortableTh from './SortableTh';
import { compareIssueRows } from './grouping';
import { columnsForType, type IssueColumn } from './issueColumns';
import type { MeshIssuesSortState } from './useMeshIssuesViewState';
import { SEVERITY_LABEL, SEVERITY_RANK } from './severityUi';
import sharedStyles from './meshIssues.module.css';
import styles from './IssueTable.module.css';

interface IssueTableProps {
  issueType: string;
  rows: MeshIssueRow[];
  sourceNames: Record<string, string>;
  sort?: MeshIssuesSortState;
  onSortChange: (sort: MeshIssuesSortState) => void;
  /** `status.lastRunTime` — drives the "New" chip (`firstDetected >=
   *  lastRunTime`), spec §6.2. `null` before any run has completed. */
  lastRunTime: number | null;
  canAct: boolean;
  onDismiss: (id: number) => void;
  onRestore: (id: number) => void;
  dismissPendingId: number | null;
  restorePendingId: number | null;
}

/** Subject cell, per subject-key prefix (spec §6.5). Every branch is
 *  defensive: `evidence` is parsed JSON and can be malformed or redacted, so
 *  every path falls back to the raw `subjectKey` rather than throwing.
 *  Exported for reuse by `NodeGroupSection` (#4964 report reorg, WP5) — a
 *  by-node finding row needs the same per-prefix rendering the By-issue
 *  table uses, and duplicating ~30 lines here would drift. */
// eslint-disable-next-line react-refresh/only-export-components -- #4964 WP5 reuse by NodeGroupSection; a pure render helper, not a component
export function renderSubject(row: MeshIssueRow): React.ReactNode {
  const key = row.subjectKey;
  if (key.startsWith('node:')) {
    return row.nodeName ?? (row.nodeNum != null ? hexNodeId(row.nodeNum) : key);
  }
  if (key.startsWith('area:')) {
    const lat = row.evidence.centerLat;
    const lon = row.evidence.centerLon;
    return typeof lat === 'number' && typeof lon === 'number' ? `Area ${lat.toFixed(2)}, ${lon.toFixed(2)}` : key;
  }
  if (key.startsWith('edge:')) {
    const a = asNodeRef(row.evidence.nodeA);
    const b = asNodeRef(row.evidence.nodeB);
    if (a && b) return `${a.name ?? hexNodeId(a.nodeNum)} ↔ ${b.name ?? hexNodeId(b.nodeNum)}`;
    return key;
  }
  if (key.startsWith('cluster:')) {
    const size = row.evidence.size;
    const best = row.evidence.bestSitedName;
    return (
      <>
        {`Cluster of ${typeof size === 'number' ? size : '?'}`}
        {typeof best === 'string' && <div className="reports-node__meta">{best}</div>}
      </>
    );
  }
  return row.nodeName ?? key;
}

const IssueTable: React.FC<IssueTableProps> = ({
  issueType,
  rows,
  sourceNames,
  sort,
  onSortChange,
  lastRunTime,
  canAct,
  onDismiss,
  onRestore,
  dismissPendingId,
  restorePendingId,
}) => {
  const { t } = useTranslation();
  const [expandedId, setExpandedId] = useState<number | null>(null);

  const typeColumns = useMemo(() => columnsForType(issueType), [issueType]);
  const primaryColumn = useMemo(() => typeColumns.find((c) => c.primary) ?? typeColumns[0], [typeColumns]);

  const subjectColumn: IssueColumn = useMemo(
    () => ({
      key: 'subject',
      label: t('analysis.mesh_issues.table.subject', 'Subject'),
      sortValue: (row) => row.nodeName ?? row.subjectKey,
      render: (row) => renderSubject(row),
    }),
    [t],
  );

  const severityColumn: IssueColumn = useMemo(
    () => ({
      key: 'severity',
      label: t('analysis.mesh_issues.table.severity', 'Severity'),
      sortValue: (row) => SEVERITY_RANK[row.severity],
      render: (row) => (
        <span className={`${sharedStyles.badge} ${sharedStyles[`badge--${row.severity}`]}`}>
          {SEVERITY_LABEL[row.severity]}
        </span>
      ),
    }),
    [t],
  );

  const lastDetectedColumn: IssueColumn = useMemo(
    () => ({
      key: 'lastDetected',
      label: t('analysis.mesh_issues.table.last_detected', 'Last detected'),
      sortValue: (row) => row.lastDetected,
      render: (row) => (
        <span title={new Date(row.lastDetected).toISOString()}>{new Date(row.lastDetected).toLocaleString()}</span>
      ),
    }),
    [t],
  );

  const sortableColumns = useMemo(
    () => [subjectColumn, ...typeColumns, severityColumn, lastDetectedColumn],
    [subjectColumn, typeColumns, severityColumn, lastDetectedColumn],
  );

  const effectiveSort: MeshIssuesSortState = sort ?? {
    key: primaryColumn?.key ?? 'lastDetected',
    dir: primaryColumn?.defaultDir ?? 'desc',
  };
  const activeColumn = sortableColumns.find((c) => c.key === effectiveSort.key) ?? primaryColumn ?? lastDetectedColumn;

  const sortedRows = useMemo(
    () => [...rows].sort((a, b) => compareIssueRows(a, b, activeColumn.sortValue, effectiveSort.dir)),
    [rows, activeColumn, effectiveSort.dir],
  );

  const showSources = Object.keys(sourceNames).length > 1;
  const columnCount =
    2 /* expand + state */ +
    1 /* subject */ +
    typeColumns.length +
    (showSources ? 1 : 0) +
    1 /* severity */ +
    1 /* last detected */ +
    (canAct ? 1 : 0);

  function handleSort(col: IssueColumn) {
    if (col.key === effectiveSort.key) {
      onSortChange({ key: col.key, dir: effectiveSort.dir === 'asc' ? 'desc' : 'asc' });
    } else {
      onSortChange({ key: col.key, dir: col.defaultDir ?? 'desc' });
    }
  }

  function sortableTh(col: IssueColumn) {
    return (
      <SortableTh
        key={col.key}
        label={col.label}
        active={effectiveSort.key === col.key}
        dir={effectiveSort.key === col.key ? effectiveSort.dir : 'desc'}
        onClick={() => handleSort(col)}
        t={t}
      />
    );
  }

  return (
    <div className="reports-table-wrap">
      <table className="reports-table">
        <thead>
          <tr>
            <th aria-hidden="true" className={styles.expandHeader} />
            <th>{t('analysis.mesh_issues.table.state', 'State')}</th>
            {sortableTh(subjectColumn)}
            {typeColumns.map((col) => sortableTh(col))}
            {showSources && <th>{t('analysis.mesh_issues.table.sources', 'Sources')}</th>}
            {sortableTh(severityColumn)}
            {sortableTh(lastDetectedColumn)}
            {canAct && <th>{t('analysis.mesh_issues.table.actions', 'Actions')}</th>}
          </tr>
        </thead>
        <tbody>
          {sortedRows.map((row) => {
            const isExpanded = expandedId === row.id;
            const isNew = lastRunTime != null && row.firstDetected >= lastRunTime;
            const toggleRow = () => setExpandedId((id) => (id === row.id ? null : row.id));

            return (
              <Fragment key={row.id}>
                <tr className="reports-row--clickable" onClick={toggleRow}>
                  <td className={styles.expandButton}>
                    <button
                      type="button"
                      className={styles.expandButtonControl}
                      aria-expanded={isExpanded}
                      aria-label={
                        isExpanded
                          ? t('analysis.mesh_issues.table.collapse', 'Hide details')
                          : t('analysis.mesh_issues.table.expand', 'Show details')
                      }
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleRow();
                      }}
                    >
                      <UiIcon name={isExpanded ? 'chevronUp' : 'chevronDown'} size={14} />
                    </button>
                  </td>
                  <td>
                    {isNew && (
                      <span className={`${sharedStyles.badge} ${sharedStyles['badge--new']}`}>
                        {t('analysis.mesh_issues.table.new', 'New')}
                      </span>
                    )}
                    {row.dismissed && (
                      <span className={`${sharedStyles.badge} ${sharedStyles.dismissedBadge}`}>
                        {t('analysis.mesh_issues.dismissed_badge', 'Dismissed')}
                      </span>
                    )}
                  </td>
                  <td>{renderSubject(row)}</td>
                  {typeColumns.map((col) => (
                    <td key={col.key} className={col.numeric ? styles.numericCell : undefined}>
                      {col.render(row, { sourceNames })}
                    </td>
                  ))}
                  {showSources && <td>{formatSourceIds(row.sourceIds, sourceNames)}</td>}
                  <td>{severityColumn.render(row, { sourceNames })}</td>
                  <td>{lastDetectedColumn.render(row, { sourceNames })}</td>
                  {canAct && (
                    <td className={styles.actionsCell} onClick={(e) => e.stopPropagation()}>
                      {row.dismissed ? (
                        <button
                          type="button"
                          className={`reports-btn reports-btn--ghost ${sharedStyles.iconButton}`}
                          onClick={() => onRestore(row.id)}
                          disabled={restorePendingId === row.id}
                          aria-label={t('analysis.mesh_issues.restore', 'Restore')}
                          title={t('analysis.mesh_issues.restore', 'Restore')}
                        >
                          <UiIcon name="refresh" size={14} />
                        </button>
                      ) : (
                        <button
                          type="button"
                          className={`reports-btn reports-btn--ghost ${sharedStyles.iconButton}`}
                          onClick={() => onDismiss(row.id)}
                          disabled={dismissPendingId === row.id}
                          aria-label={t('analysis.mesh_issues.dismiss', 'Dismiss')}
                          title={t('analysis.mesh_issues.dismiss', 'Dismiss')}
                        >
                          <UiIcon name="close" size={14} />
                        </button>
                      )}
                    </td>
                  )}
                </tr>
                {isExpanded && (
                  <tr>
                    <td colSpan={columnCount} className={styles.detailCell}>
                      <div className={styles.detailInner}>
                        <FindingDetail issue={row} sourceNames={sourceNames} />
                      </div>
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
};

export default IssueTable;
