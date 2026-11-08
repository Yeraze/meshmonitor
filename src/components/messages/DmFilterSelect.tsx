import React from 'react';
import { useTranslation } from 'react-i18next';
import type { DmFilter } from '../../types/ui';

const LABEL_KEYS: Record<DmFilter, string> = {
  all: 'messages.all_conversations',
  unread: 'messages.unread_only',
  recent: 'messages.recent_24h',
  hops: 'messages.by_hops',
  favorites: 'messages.favorites_only',
  withPosition: 'messages.with_position',
  noInfra: 'messages.exclude_infrastructure',
};

const ALL_DM_FILTERS: readonly DmFilter[] = [
  'all',
  'unread',
  'recent',
  'hops',
  'favorites',
  'withPosition',
  'noInfra',
];

export interface DmFilterSelectProps {
  value: DmFilter;
  onChange: (value: DmFilter) => void;
  /** Subset of filters to offer; defaults to all seven. */
  options?: readonly DmFilter[];
}

/** Conversation filter dropdown shared by the Meshtastic and MeshCore DM lists. */
export const DmFilterSelect: React.FC<DmFilterSelectProps> = ({ value, onChange, options = ALL_DM_FILTERS }) => {
  const { t } = useTranslation();
  return (
    <select
      value={value}
      onChange={e => onChange(e.target.value as DmFilter)}
      className="sort-dropdown"
      title={t('messages.filter_conversations_title')}
    >
      {options.map(o => (
        <option key={o} value={o}>
          {t(LABEL_KEYS[o])}
        </option>
      ))}
    </select>
  );
};
