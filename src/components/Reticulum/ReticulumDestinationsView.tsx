/**
 * ReticulumDestinationsView — destinations table for a Reticulum source
 * (#3960 Phase 1b WP3).
 *
 * Mirrors `MeshCoreNodesView`'s sort/filter/search/favorites-first patterns
 * (`src/components/MeshCore/MeshCoreNodesView.tsx`), simplified to a flat
 * table since destinations have no map/DM surface in Phase 1b. "Announce
 * rate" is derived here, never persisted server-side (build spec §2):
 * `announceCount / max(1, (lastSeen - firstSeen) / 1000)` announces/second,
 * rescaled to whichever of /hr or /day reads best for a given row.
 */
import React, { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ReticulumDestinationRow } from '../../types/reticulum';
import { useSettings } from '../../contexts/SettingsContext';
import { formatTimeOrDate } from '../../utils/datetime';
import { UiIcon } from '../icons';
import styles from './ReticulumDestinationsView.module.css';

export interface ReticulumDestinationsViewProps {
  destinations: ReticulumDestinationRow[];
  /**
   * Callers wiring this to `useReticulum().toggleFavorite` pass an async
   * function that resolves `Promise<boolean>`; a plain sync `void` callback
   * (e.g. in tests) also fits. The return value is never awaited/used here.
   */
  onToggleFavorite: (hash: string, favorite: boolean) => void | Promise<void> | Promise<boolean>;
  loading?: boolean;
}

type SortField = 'name' | 'lastSeen';
type SortDirection = 'asc' | 'desc';

/**
 * Raw announce rate in announces/second, per the build spec §2 formula.
 * `max(1, …)` guards the freshly-seen case (lastSeen === firstSeen) from a
 * divide-by-zero.
 */
// eslint-disable-next-line react-refresh/only-export-components -- #3960 pure helper co-located with its only consumer for focused unit testing; not a component
export function computeAnnounceRatePerSecond(
  row: Pick<ReticulumDestinationRow, 'announceCount' | 'firstSeen' | 'lastSeen'>,
): number {
  const elapsedSeconds = Math.max(1, (row.lastSeen - row.firstSeen) / 1000);
  return row.announceCount / elapsedSeconds;
}

/**
 * Human-readable announce rate. The raw per-second figure from
 * {@link computeAnnounceRatePerSecond} is unreadably small for most
 * real-world announce cadences, so this rescales to /hr (when that reads as
 * at least "roughly one an hour") and falls back to /day otherwise.
 */
// eslint-disable-next-line react-refresh/only-export-components -- #3960 pure helper co-located with its only consumer for focused unit testing; not a component
export function formatAnnounceRate(
  row: Pick<ReticulumDestinationRow, 'announceCount' | 'firstSeen' | 'lastSeen'>,
): string {
  // A destination seen exactly once has no elapsed window to derive a rate
  // from — the max(1, …) clamp in computeAnnounceRatePerSecond would
  // otherwise report a misleading "1.0/hr", implying active traffic for a
  // single sighting (review finding, #3960 Phase 1b WP3).
  if (row.announceCount === 1 && row.firstSeen === row.lastSeen) {
    return '—';
  }
  const perHour = computeAnnounceRatePerSecond(row) * 3600;
  if (perHour >= 1) return `${perHour.toFixed(1)}/hr`;
  const perDay = perHour * 24;
  return `${perDay.toFixed(2)}/day`;
}

function truncateHash(hash: string): string {
  return hash.length > 12 ? `${hash.substring(0, 12)}…` : hash;
}

function renderNullable(value: number | null | undefined, digits = 0): string {
  if (value === null || value === undefined) return '—';
  return digits > 0 ? value.toFixed(digits) : String(value);
}

function sortRows(
  rows: ReticulumDestinationRow[],
  field: SortField,
  direction: SortDirection,
): ReticulumDestinationRow[] {
  const dir = direction === 'asc' ? 1 : -1;
  const comparator = (a: ReticulumDestinationRow, b: ReticulumDestinationRow): number => {
    if (field === 'name') {
      const an = a.displayName || a.destinationHash;
      const bn = b.displayName || b.destinationHash;
      return an.localeCompare(bn, undefined, { sensitivity: 'base' }) * dir;
    }
    return (a.lastSeen - b.lastSeen) * dir;
  };
  // Favorites-first, mirroring MeshCoreNodesView.sortRows: sort each
  // partition independently by the chosen field/direction, then concatenate
  // favorites first.
  const favorites = rows.filter(r => r.isFavorite).sort(comparator);
  const nonFavorites = rows.filter(r => !r.isFavorite).sort(comparator);
  return [...favorites, ...nonFavorites];
}

export const ReticulumDestinationsView: React.FC<ReticulumDestinationsViewProps> = ({
  destinations,
  onToggleFavorite,
  loading = false,
}) => {
  const { t } = useTranslation();
  const { timeFormat, dateFormat } = useSettings();
  const [sortField, setSortField] = useState<SortField>('lastSeen');
  const [sortDirection, setSortDirection] = useState<SortDirection>('desc');
  const [searchQuery, setSearchQuery] = useState('');
  const [copiedHash, setCopiedHash] = useState<string | null>(null);

  const handleCopyHash = useCallback(async (hash: string) => {
    try {
      await navigator.clipboard.writeText(hash);
    } catch {
      window.prompt(t('reticulum.destinations.copy_fallback', 'Copy this destination hash:'), hash);
    }
    setCopiedHash(hash);
    window.setTimeout(() => setCopiedHash(prev => (prev === hash ? null : prev)), 1500);
  }, [t]);

  const sorted = useMemo(
    () => sortRows(destinations, sortField, sortDirection),
    [destinations, sortField, sortDirection],
  );

  const rows = useMemo(() => {
    if (!searchQuery.trim()) return sorted;
    const q = searchQuery.toLowerCase();
    return sorted.filter(r => (
      (r.displayName || '').toLowerCase().includes(q) ||
      (r.appName || '').toLowerCase().includes(q) ||
      (r.aspects || '').toLowerCase().includes(q) ||
      r.destinationHash.toLowerCase().includes(q)
    ));
  }, [sorted, searchQuery]);

  return (
    <div className={styles.container}>
      <div className={styles.toolbar}>
        <div className={styles.searchBar}>
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder={t('reticulum.destinations.search', 'Search destinations…')}
            aria-label={t('reticulum.destinations.search', 'Search destinations…')}
            className={styles.searchInput}
          />
          {searchQuery && (
            <button
              type="button"
              className={styles.searchClear}
              onClick={() => setSearchQuery('')}
              aria-label={t('common.clear', 'Clear')}
            >
              <UiIcon name="close" size={16} />
            </button>
          )}
        </div>
        <div className={styles.sortControls}>
          <select
            aria-label={t('reticulum.destinations.sort_by', 'Sort by')}
            title={t('reticulum.destinations.sort_by', 'Sort by')}
            value={sortField}
            onChange={(e) => setSortField(e.target.value as SortField)}
            className={styles.sortDropdown}
          >
            <option value="lastSeen">{t('reticulum.destinations.sort_last_heard', 'Last heard')}</option>
            <option value="name">{t('reticulum.destinations.sort_name', 'Name')}</option>
          </select>
          <button
            type="button"
            className={styles.sortDirectionBtn}
            onClick={() => setSortDirection(d => (d === 'asc' ? 'desc' : 'asc'))}
            title={sortDirection === 'asc' ? t('meshcore.ascending', 'Ascending') : t('meshcore.descending', 'Descending')}
            aria-label={sortDirection === 'asc' ? t('meshcore.ascending', 'Ascending') : t('meshcore.descending', 'Descending')}
          >
            <UiIcon name={sortDirection === 'asc' ? 'sortAscending' : 'sortDescending'} size={16} />
          </button>
        </div>
        <span className={styles.count}>{rows.length}</span>
      </div>

      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th className={styles.favoriteCol} aria-label={t('reticulum.favorite.column', 'Favorite')} />
              <th>{t('reticulum.destinations.col_hash', 'Hash')}</th>
              <th>{t('reticulum.destinations.col_name', 'Name')}</th>
              <th>{t('reticulum.destinations.col_app', 'App')}</th>
              <th>{t('reticulum.destinations.col_aspects', 'Aspects')}</th>
              <th>{t('reticulum.destinations.col_hops', 'Hops')}</th>
              <th>{t('reticulum.destinations.col_rssi', 'RSSI')}</th>
              <th>{t('reticulum.destinations.col_snr', 'SNR')}</th>
              <th>{t('reticulum.destinations.col_quality', 'Quality')}</th>
              <th>{t('reticulum.destinations.col_last_heard', 'Last Heard')}</th>
              <th>{t('reticulum.destinations.col_announce_rate', 'Announce Rate')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={11} className={styles.emptyState}>
                  {loading
                    ? t('reticulum.destinations.loading', 'Loading destinations…')
                    : searchQuery
                      ? t('reticulum.destinations.no_search_results', 'No destinations match your search')
                      : t('reticulum.destinations.empty', 'No destinations seen yet')}
                </td>
              </tr>
            ) : rows.map(row => (
              <tr key={row.destinationHash} className={row.isFavorite ? styles.favoriteRow : undefined}>
                <td className={styles.favoriteCol}>
                  <button
                    type="button"
                    className={`${styles.favoriteBtn}${row.isFavorite ? ` ${styles.isFavorite}` : ''}`}
                    title={row.isFavorite
                      ? t('reticulum.favorite.remove', 'Remove from favorites')
                      : t('reticulum.favorite.add', 'Add to favorites')}
                    aria-label={row.isFavorite
                      ? t('reticulum.favorite.remove', 'Remove from favorites')
                      : t('reticulum.favorite.add', 'Add to favorites')}
                    aria-pressed={row.isFavorite}
                    onClick={() => onToggleFavorite(row.destinationHash, !row.isFavorite)}
                  >
                    <UiIcon name={row.isFavorite ? 'favorite' : 'favoriteOff'} size={16} />
                  </button>
                </td>
                <td>
                  <button
                    type="button"
                    className={styles.hashBtn}
                    title={row.destinationHash}
                    onClick={() => void handleCopyHash(row.destinationHash)}
                  >
                    <span className={styles.hashText}>{truncateHash(row.destinationHash)}</span>
                    <UiIcon name="copy" size={13} />
                    {copiedHash === row.destinationHash && (
                      <span className={styles.copiedBadge}>{t('common.copied', 'Copied')}</span>
                    )}
                  </button>
                </td>
                <td>{row.displayName || '—'}</td>
                <td>{row.appName || '—'}</td>
                <td>{row.aspects || '—'}</td>
                <td>{renderNullable(row.hops)}</td>
                <td>{renderNullable(row.rssi)}</td>
                <td>{renderNullable(row.snr, 1)}</td>
                <td>{renderNullable(row.quality)}</td>
                <td>{formatTimeOrDate(new Date(row.lastSeen), timeFormat, dateFormat)}</td>
                <td>{formatAnnounceRate(row)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
};

export default ReticulumDestinationsView;
