/**
 * FindingDetail — the finding-card BODY from `MeshIssuesReport.tsx`
 * (`FindingCard` :704-756), promoted to its own component and reused as the
 * row-expansion body in the new table views (#4964 report reorganization,
 * WP3, spec §3.3/§7.1). No behavioral change from the original body; only
 * the import paths changed and the header/title/badges/actions were left
 * behind in `MeshIssuesReport.tsx` (they dissolve into table cells there).
 */
import {
  STRUCTURED_EVIDENCE_KEYS,
  formatEvidenceKey,
  isEvidenceDirectionalSnr,
  isEvidenceNodeRefArray,
  type MeshIssueRow,
} from '../meshIssueTypes';
import { UiIcon } from '../../icons';
import RouterClusterMap from '../RouterClusterMap';
import { EdgeList, Field, MemberList, NODE_LIST_EVIDENCE_KEYS, SnrDirections, formatFieldValue } from './evidenceRenderers';
import styles from './meshIssues.module.css';

interface FindingDetailProps {
  issue: MeshIssueRow;
  sourceNames: Record<string, string>;
}

const FindingDetail: React.FC<FindingDetailProps> = ({ issue, sourceNames }) => {
  const recommendation =
    typeof issue.evidence.recommendation === 'string' ? issue.evidence.recommendation : null;

  const entries = Object.entries(issue.evidence).filter(([key]) => key !== 'recommendation');
  // `<field>Truncated`/`<field>Total` sibling flags are surfaced as the
  // "+ more" note inside the matching structured component, never as a raw
  // pill of their own.
  const plainEntries = entries.filter(
    ([key]) =>
      !STRUCTURED_EVIDENCE_KEYS.has(key) && !key.endsWith('Truncated') && !key.endsWith('Total'),
  );
  const structuredEntries = entries.filter(([key]) => STRUCTURED_EVIDENCE_KEYS.has(key));

  const showSnrDirections =
    isEvidenceDirectionalSnr(issue.evidence.snrToA) && isEvidenceDirectionalSnr(issue.evidence.snrToB);

  return (
    <div className="reports-node__body">
      {recommendation && (
        <p className={styles.recommendation}>
          <UiIcon name="sparkles" size={14} className={styles.recommendationIcon} />
          {recommendation}
        </p>
      )}

      {showSnrDirections && <SnrDirections issue={issue} />}

      {issue.issueType === 'B1_router_cluster' && isEvidenceNodeRefArray(issue.evidence.members) && (
        <RouterClusterMap
          members={issue.evidence.members}
          bestSitedNodeNum={
            typeof issue.evidence.bestSitedNodeNum === 'number' ? issue.evidence.bestSitedNodeNum : null
          }
        />
      )}

      {structuredEntries.map(([key, value]) => {
        // nodeA/nodeB/snrToA/snrToB/weakerDirection are consumed together
        // by SnrDirections above, not rendered as their own pills/lists.
        if (['nodeA', 'nodeB', 'snrToA', 'snrToB', 'weakerDirection'].includes(key)) return null;
        const truncated = issue.evidence[`${key}Truncated`] === true;
        const totalRaw = issue.evidence[`${key}Total`];
        const total = typeof totalRaw === 'number' ? totalRaw : undefined;
        if (key === 'edges') {
          return (
            <EdgeList key={key} label={formatEvidenceKey(key)} value={value} truncated={truncated} total={total} />
          );
        }
        if (NODE_LIST_EVIDENCE_KEYS.has(key)) {
          return (
            <MemberList
              key={key}
              label={formatEvidenceKey(key)}
              value={value}
              truncated={truncated}
              total={total}
            />
          );
        }
        return null;
      })}

      {plainEntries.length > 0 && (
        <div className="reports-node__fields">
          {plainEntries.map(([key, value]) => (
            <Field key={key} label={formatEvidenceKey(key)} value={formatFieldValue(key, value, sourceNames)} />
          ))}
        </div>
      )}
    </div>
  );
};

export default FindingDetail;
