/**
 * SortableTh — promoted verbatim from `MqttViolationsReport.tsx:1154-1181`
 * (#4964 report reorganization, WP3, spec §3.1). `MqttViolationsReport.tsx`
 * keeps its own local copy untouched; this is an independent copy for the
 * mesh-issues table views so neither file depends on the other.
 *
 * A sortable `<th>` button, shared by every table header in the mesh-issues
 * views. Callers resolve `active`/`dir` from their own applied sort state
 * since different tables/sections sort independently.
 */
import { useTranslation } from 'react-i18next';
import { UiIcon } from '../../icons';
import styles from './SortableTh.module.css';

export type SortDir = 'asc' | 'desc';

type TFn = ReturnType<typeof useTranslation>['t'];

const SortableTh: React.FC<{
  label: string;
  titleText?: string;
  active: boolean;
  dir: SortDir;
  onClick: () => void;
  t: TFn;
}> = ({ label, titleText, active, dir, onClick, t }) => {
  return (
    <th title={titleText}>
      <button
        type="button"
        className={`${styles.sortHeader}${active ? ` ${styles.sortHeaderActive}` : ''}`}
        onClick={onClick}
        aria-sort={active ? (dir === 'asc' ? 'ascending' : 'descending') : undefined}
        title={t('analysis.mesh_issues.sort_by', 'Sort by {{column}}', { column: label })}
      >
        {label}
        {active && (
          <UiIcon
            name={dir === 'asc' ? 'sortAscending' : 'sortDescending'}
            size={12}
            className={styles.sortIcon}
          />
        )}
      </button>
    </th>
  );
};

export default SortableTh;
