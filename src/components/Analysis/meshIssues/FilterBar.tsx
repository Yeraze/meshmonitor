/**
 * FilterBar — severity/tier/source/node-name filters shared by both views
 * (#4964 report reorganization, WP4, spec §6/§4.1). Persisted via the
 * caller's `useMeshIssuesViewState`; this component is a controlled
 * `filters` <-> `onChange` pair and owns no persistence itself. Also hosts
 * `includeClosed`/`includeDismissed` — the old shell's standalone "Show
 * dismissed" toggle, rewired here as one of the five filter dimensions
 * rather than a separate control.
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { UiIcon } from '../../icons';
import type { MeshIssueSeverity, MeshIssuesFilters } from '../meshIssueTypes';
import { SEVERITY_LABEL } from './severityUi';
import styles from './FilterBar.module.css';

const SEVERITIES: MeshIssueSeverity[] = ['critical', 'warning', 'info'];
const TIERS = ['A', 'B', 'C'] as const;
/** Debounce for the free-text search so every keystroke doesn't refetch
 *  `/summary` and every expanded section. */
const SEARCH_DEBOUNCE_MS = 300;

interface FilterBarProps {
  filters: MeshIssuesFilters;
  /** Permitted-source id -> display name. The source filter only renders
   *  when there is more than one (spec §6.2's sources-column rule, reused
   *  here: a single-source install has nothing to filter by). */
  sourceNames: Record<string, string>;
  onChange: (filters: MeshIssuesFilters) => void;
}

function toggle<T>(list: T[], value: T): T[] {
  return list.includes(value) ? list.filter((v) => v !== value) : [...list, value];
}

const FilterBar: React.FC<FilterBarProps> = ({ filters, sourceNames, onChange }) => {
  const { t } = useTranslation();
  const [qDraft, setQDraft] = useState(filters.q);

  // A filter reset elsewhere (Clear button, tile click) can change `filters.q`
  // out from under the draft — keep them in sync.
  useEffect(() => setQDraft(filters.q), [filters.q]);

  useEffect(() => {
    if (qDraft === filters.q) return;
    const timer = setTimeout(() => onChange({ ...filters, q: qDraft }), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- #4964 debounced search box: only re-arm the timer on draft changes; `filters`/`onChange` are read via closure by design (matches the latest values at fire time)
  }, [qDraft]);

  const sourceIds = Object.keys(sourceNames);
  const showSources = sourceIds.length > 1;

  const hasActiveFilters =
    filters.severities.length > 0 ||
    filters.tiers.length > 0 ||
    filters.sources.length > 0 ||
    filters.q.trim().length > 0 ||
    filters.includeClosed ||
    filters.includeDismissed;

  const clearAll = () => {
    setQDraft('');
    onChange({
      severities: [],
      tiers: [],
      // The issueType tile selection is a separate concern (spec §6.1) —
      // clearing filters here does not clear which tile is active.
      issueTypes: filters.issueTypes,
      sources: [],
      q: '',
      includeClosed: false,
      includeDismissed: false,
    });
  };

  return (
    <div className={styles.bar}>
      <div className={styles.group}>
        <UiIcon name="search" size={14} />
        <span className={styles.searchInput}>
          <input
            type="text"
            value={qDraft}
            onChange={(e) => setQDraft(e.target.value)}
            placeholder={t('analysis.mesh_issues.filters.search_placeholder', 'Node name…')}
            aria-label={t('analysis.mesh_issues.filters.search_label', 'Search by node name')}
          />
        </span>
      </div>

      <div className={styles.group}>
        <span className={styles.groupLabel}>{t('analysis.mesh_issues.filters.severity', 'Severity')}</span>
        {SEVERITIES.map((s) => (
          <button
            key={s}
            type="button"
            className={`${styles.chip} ${filters.severities.includes(s) ? styles.chipActive : ''}`}
            aria-pressed={filters.severities.includes(s)}
            onClick={() => onChange({ ...filters, severities: toggle(filters.severities, s) })}
          >
            {SEVERITY_LABEL[s]}
          </button>
        ))}
      </div>

      <div className={styles.group}>
        <span className={styles.groupLabel}>{t('analysis.mesh_issues.filters.tier', 'Tier')}</span>
        {TIERS.map((tier) => (
          <button
            key={tier}
            type="button"
            className={`${styles.chip} ${filters.tiers.includes(tier) ? styles.chipActive : ''}`}
            aria-pressed={filters.tiers.includes(tier)}
            onClick={() => onChange({ ...filters, tiers: toggle(filters.tiers, tier) })}
          >
            {tier}
          </button>
        ))}
      </div>

      {showSources && (
        <div className={styles.group}>
          <span className={styles.groupLabel}>{t('analysis.mesh_issues.filters.source', 'Source')}</span>
          {sourceIds.map((id) => (
            <button
              key={id}
              type="button"
              className={`${styles.chip} ${filters.sources.includes(id) ? styles.chipActive : ''}`}
              aria-pressed={filters.sources.includes(id)}
              onClick={() => onChange({ ...filters, sources: toggle(filters.sources, id) })}
            >
              {sourceNames[id]}
            </button>
          ))}
        </div>
      )}

      <label className={styles.checkboxLabel}>
        <input
          type="checkbox"
          checked={filters.includeClosed}
          onChange={(e) => onChange({ ...filters, includeClosed: e.target.checked })}
        />
        {t('analysis.mesh_issues.filters.show_closed', 'Show closed')}
      </label>

      <label className={styles.checkboxLabel}>
        <input
          type="checkbox"
          checked={filters.includeDismissed}
          onChange={(e) => onChange({ ...filters, includeDismissed: e.target.checked })}
        />
        {t('analysis.mesh_issues.show_dismissed', 'Show dismissed')}
      </label>

      {hasActiveFilters && (
        <button type="button" className={`${styles.chip} ${styles.clearButton}`} onClick={clearAll}>
          <UiIcon name="close" size={12} />
          {t('analysis.mesh_issues.filters.clear', 'Clear filters')}
        </button>
      )}
    </div>
  );
};

export default FilterBar;
