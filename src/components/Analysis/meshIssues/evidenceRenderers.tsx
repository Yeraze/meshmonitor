/**
 * Evidence-detail renderers — moved verbatim out of MeshIssuesReport.tsx
 * (#4964 report reorganization, WP3, spec §7.1/§3.3): `MemberList`,
 * `EdgeList`, `SnrDirections`, `Field`, `normalizeMemberList`,
 * `truncationLabel`, `isEvidenceEdgeRefArray`, `asNodeRef`,
 * `formatFieldValue`, `NODE_LIST_EVIDENCE_KEYS`. No behavioral change; only
 * the import paths and the `export` keyword changed.
 */
import { useTranslation } from 'react-i18next';
import {
  formatDurationMs,
  formatEvidenceValue,
  formatSnrDirection,
  formatSourceIds,
  hexNodeId,
  isEvidenceNodeRefArray,
  type EvidenceDirectionalSnr,
  type EvidenceNodeRef,
  type MeshIssueRow,
} from '../meshIssueTypes';
import NodeLink from './NodeLink';
import styles from './meshIssues.module.css';

/** Node-list evidence keys (§2.12/§2.13, WP5b) rendered as member chips via
 * `MemberList` rather than the generic pill grid. Some carry `EvidenceNodeRef`
 * objects (`members`, `otherCoveringRouters`); others carry plain nodeNums
 * (`sharedNeighbors`, `clusterMembers`) — `normalizeMemberList` handles both. */
// eslint-disable-next-line react-refresh/only-export-components -- #4964 evidence renderers and their pure helpers are moved verbatim into one co-located module per spec §7.1; not a component
export const NODE_LIST_EVIDENCE_KEYS: ReadonlySet<string> = new Set([
  'members',
  'sharedNeighbors',
  'otherCoveringRouters',
  'clusterMembers',
  'sharedWithNodes',
]);

/** Evidence keys ending in this suffix hold an elapsed-milliseconds duration
 * (spec §5.3) and render through `formatDurationMs`. */
const AGE_MS_KEY_PATTERN = /AgeMs$/;

// eslint-disable-next-line react-refresh/only-export-components -- #4964 pure helper co-located with the evidence renderers it formats for; not a component
export function formatFieldValue(key: string, value: unknown, sourceNames: Record<string, string>): string {
  if (key === 'sources') return formatSourceIds(value, sourceNames);
  if (AGE_MS_KEY_PATTERN.test(key) && typeof value === 'number') return formatDurationMs(value);
  return formatEvidenceValue(value);
}

/** `{ nodeNum: number }` items, either plain numbers (`sharedNeighbors`,
 * `clusterMembers`) normalized to a bare node ref, or full `EvidenceNodeRef`
 * objects. Returns null for anything else so the caller can fall back to the
 * generic pill instead of throwing on malformed evidence. */
// eslint-disable-next-line react-refresh/only-export-components -- #4964 pure helper co-located with MemberList, its only consumer; not a component
export function normalizeMemberList(value: unknown): EvidenceNodeRef[] | null {
  if (Array.isArray(value) && value.every((v) => typeof v === 'number')) {
    return (value as number[]).map((nodeNum) => ({ nodeNum }));
  }
  if (isEvidenceNodeRefArray(value)) return value;
  return null;
}

/** `+{total - items.length} more not shown` when a pre-cap `total` is known
 * (spec §4.2); falls back to the pre-Phase-3 wording for a row persisted
 * before the `*Total` field existed. */
// eslint-disable-next-line react-refresh/only-export-components -- #4964 pure helper shared by MemberList and EdgeList; not a component
export function truncationLabel(itemsShown: number, total: number | undefined): string {
  if (total != null) {
    const remainder = total - itemsShown;
    return `+${remainder} more not shown`;
  }
  return '+ more not shown (list truncated)';
}

export const MemberList: React.FC<{
  label: string;
  value: unknown;
  truncated: boolean;
  total?: number;
  /** Parent finding's `sourceIds` — used by NodeLink as the source-picker
   *  fallback when the /api/nodes/:nodeNum/sources call is unavailable
   *  (offline / permission failure). */
  fallbackSourceIds?: string[];
}> = ({ label, value, truncated, total, fallbackSourceIds }) => {
  const items = normalizeMemberList(value);
  if (items === null) {
    return <Field label={label} value={formatEvidenceValue(value)} />;
  }
  return (
    <div>
      <div className="reports-node__field-label">{label}</div>
      <div className={styles.memberList}>
        {items.length === 0 && <span className="reports-node__field-value">—</span>}
        {items.map((item, i) => (
          <span key={`${item.nodeNum}-${i}`} className={styles.memberChip}>
            <NodeLink
              nodeNum={item.nodeNum}
              name={item.name ?? null}
              fallbackSourceIds={fallbackSourceIds}
            />
            {item.roleName && <span className={styles.memberChipRole}>{item.roleName}</span>}
          </span>
        ))}
      </div>
      {truncated && <div className={styles.truncationNote}>{truncationLabel(items.length, total)}</div>}
    </div>
  );
};

interface EvidenceEdgeRef {
  a: number;
  b: number;
  evidenceClasses?: unknown;
}

// eslint-disable-next-line react-refresh/only-export-components -- #4964 type guard co-located with EdgeList, its only consumer; not a component
export function isEvidenceEdgeRefArray(v: unknown): v is EvidenceEdgeRef[] {
  return (
    Array.isArray(v) &&
    v.every((item) => {
      if (item === null || typeof item !== 'object') return false;
      const o = item as Record<string, unknown>;
      return typeof o.a === 'number' && typeof o.b === 'number';
    })
  );
}

export const EdgeList: React.FC<{ label: string; value: unknown; truncated: boolean; total?: number }> = ({
  label,
  value,
  truncated,
  total,
}) => {
  if (!isEvidenceEdgeRefArray(value)) {
    return <Field label={label} value={formatEvidenceValue(value)} />;
  }
  return (
    <div>
      <div className="reports-node__field-label">{label}</div>
      <div className={styles.memberList}>
        {value.length === 0 && <span className="reports-node__field-value">—</span>}
        {value.map((edge, i) => (
          <span key={`${edge.a}-${edge.b}-${i}`} className={styles.memberChip}>
            {hexNodeId(edge.a)} ↔ {hexNodeId(edge.b)}
            {Array.isArray(edge.evidenceClasses) && edge.evidenceClasses.length > 0 && (
              <span className={styles.memberChipRole}>{edge.evidenceClasses.join(', ')}</span>
            )}
          </span>
        ))}
      </div>
      {truncated && <div className={styles.truncationNote}>{truncationLabel(value.length, total)}</div>}
    </div>
  );
};

/** Reads `nodeA`/`nodeB`/`snrToA`/`snrToB`/`weakerDirection` off the issue's
 * evidence directly (rather than taking them as props) since the first four
 * must agree to render at all — see the `showSnrDirections` guard in
 * `FindingDetail`. `weakerDirection` is optional; when absent or malformed the
 * table renders exactly as before (spec §5.5).
 *
 * DIRECTION CONVENTION (rfGraph.ts §2.5, load-bearing): `snrToA` is SNR
 * measured AT `a` (i.e. the b -> a direction); `snrToB` is measured AT `b`
 * (i.e. a -> b). So the "A -> B" row displays `snrToB` and the "B -> A" row
 * displays `snrToA`. */
export const SnrDirections: React.FC<{ issue: MeshIssueRow }> = ({ issue }) => {
  const { t } = useTranslation();
  const nodeA = asNodeRef(issue.evidence.nodeA);
  const nodeB = asNodeRef(issue.evidence.nodeB);
  const snrToA = issue.evidence.snrToA as EvidenceDirectionalSnr;
  const snrToB = issue.evidence.snrToB as EvidenceDirectionalSnr;
  const nameA = nodeA ? (nodeA.name ?? hexNodeId(nodeA.nodeNum)) : '?';
  const nameB = nodeB ? (nodeB.name ?? hexNodeId(nodeB.nodeNum)) : '?';
  const weakerDirection = issue.evidence.weakerDirection;
  const weakerTag = () => (
    <span className={styles.weakerTag}> {t('analysis.mesh_issues.weaker', '(weaker)')}</span>
  );

  return (
    <div>
      <div className="reports-node__field-label">SNR by direction</div>
      <table className={styles.snrTable}>
        <tbody>
          <tr className={styles.snrRow}>
            {/* ASCII "->", not the unicode arrow glyph — no-hardcoded-ui-glyph
             * flags a leading unicode arrow, and the codebase's own directional
             * convention (RfEdge.weakerDirection: 'a->b' | 'b->a') already uses
             * ASCII here. */}
            <td className={styles.snrLabel}>
              {`${nameA} -> ${nameB}`}
              {weakerDirection === 'a->b' && weakerTag()}
            </td>
            <td className={styles.snrValue}>{formatSnrDirection(snrToB)}</td>
          </tr>
          <tr className={styles.snrRow}>
            <td className={styles.snrLabel}>
              {`${nameB} -> ${nameA}`}
              {weakerDirection === 'b->a' && weakerTag()}
            </td>
            <td className={styles.snrValue}>{formatSnrDirection(snrToA)}</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
};

// eslint-disable-next-line react-refresh/only-export-components -- #4964 pure helper shared by SnrDirections and issueColumns.ts's weakerDirectionColumn; not a component
export function asNodeRef(v: unknown): EvidenceNodeRef | null {
  if (v !== null && typeof v === 'object' && typeof (v as Record<string, unknown>).nodeNum === 'number') {
    return v as EvidenceNodeRef;
  }
  return null;
}

export const Field: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <div>
    <div className="reports-node__field-label">{label}</div>
    <div className="reports-node__field-value">{value}</div>
  </div>
);
