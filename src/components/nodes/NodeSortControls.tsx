import React from 'react';
import { useTranslation } from 'react-i18next';
import { UiIcon } from '../icons';
import type { SortDirection } from '../../types/ui';

export interface NodeSortOption<F extends string> {
  value: F;
  label: string;
}

export interface NodeSortControlsProps<F extends string> {
  value: F;
  direction: SortDirection;
  options: ReadonlyArray<NodeSortOption<F>>;
  onChange: (field: F) => void;
  onToggleDirection: () => void;
  className?: string;
  ariaLabel?: string;
  /** Render the select and button without the `.sort-controls` wrapper, for
   *  callers that already sit inside a toolbar row. */
  bare?: boolean;
}

/**
 * Sort field select plus ascending/descending button, shared by the
 * Meshtastic and MeshCore node and DM lists.
 */
export function NodeSortControls<F extends string>({
  value,
  direction,
  options,
  onChange,
  onToggleDirection,
  className,
  ariaLabel,
  bare,
}: NodeSortControlsProps<F>): React.ReactElement {
  const { t } = useTranslation();
  const label = ariaLabel ?? t('nodes.sort_by');
  const body = (
    <>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as F)}
        className="sort-dropdown"
        title={label}
        aria-label={label}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <button
        type="button"
        className="sort-direction-btn"
        onClick={(e) => {
          e.stopPropagation();
          e.nativeEvent.stopImmediatePropagation();
          onToggleDirection();
        }}
        onMouseDown={(e) => {
          e.stopPropagation();
          e.nativeEvent.stopImmediatePropagation();
        }}
        title={direction === 'asc' ? t('nodes.ascending') : t('nodes.descending')}
      >
        <UiIcon name={direction === 'asc' ? 'sortAscending' : 'sortDescending'} />
      </button>
    </>
  );
  if (bare) return body;
  return <div className={className ? `sort-controls ${className}` : 'sort-controls'}>{body}</div>;
}
