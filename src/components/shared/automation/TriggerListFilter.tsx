/**
 * TriggerListFilter — search box + type select over a trigger list (#5808).
 *
 * Sections show it only once the list is long enough to need it (see
 * `TRIGGER_FILTER_THRESHOLD` in `triggerList.ts`). Filtering itself stays in
 * the section, which knows what to search.
 */
import React from 'react';
import { useTranslation } from 'react-i18next';
import { UiIcon } from '../../icons';
import styles from './TriggerListFilter.module.css';

export interface TriggerTypeOption {
  value: string;
  label: string;
}

export interface TriggerListFilterProps {
  search: string;
  onSearchChange: (value: string) => void;
  type: string;
  onTypeChange: (value: string) => void;
  /** Includes the "all" option, first. */
  typeOptions: TriggerTypeOption[];
  searchPlaceholder?: string;
}

export const TriggerListFilter: React.FC<TriggerListFilterProps> = ({
  search,
  onSearchChange,
  type,
  onTypeChange,
  typeOptions,
  searchPlaceholder,
}) => {
  const { t } = useTranslation();
  return (
    <div className={styles.row}>
      <label className={styles.search}>
        <UiIcon name="search" size={14} />
        <input
          type="search"
          value={search}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder={searchPlaceholder ?? t('automation.trigger_list.search', 'Search triggers…')}
          aria-label={t('automation.trigger_list.search_label', 'Search triggers')}
          className={`setting-input ${styles.input}`}
        />
      </label>
      <select
        value={type}
        onChange={(e) => onTypeChange(e.target.value)}
        aria-label={t('automation.trigger_list.type_label', 'Filter by type')}
        className={`setting-input ${styles.select}`}
      >
        {typeOptions.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
    </div>
  );
};

export default TriggerListFilter;
