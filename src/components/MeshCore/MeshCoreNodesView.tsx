import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { MeshCoreNode } from './hooks/useMeshCore';
import { MeshCoreContact } from '../../utils/meshcoreHelpers';
import { MeshCoreMap } from './MeshCoreMap';
import { meshcoreRoleIcon, meshcoreRoleLabelKey, meshcoreRoleLabel } from './meshcoreRole';
import { useToast } from '../ToastContainer';

type DiscoverMode = 'nearby' | 'repeaters' | 'sensors';

const MOBILE_BREAKPOINT = 768;
const isMobileViewport = (): boolean =>
  typeof window !== 'undefined' && window.innerWidth <= MOBILE_BREAKPOINT;

interface MeshCoreNodesViewProps {
  nodes: MeshCoreNode[];
  contacts: MeshCoreContact[];
  onImportContact?: (advertBytes: number[]) => Promise<boolean>;
  onNavigateToDm?: (publicKey: string) => void;
  /** Toggle the server-side favorite flag for a node (issue #3588). When
   *  provided, each row shows a star toggle and favorited nodes pin to the
   *  top of the list. */
  onToggleFavorite?: (publicKey: string, isFavorite: boolean) => Promise<boolean>;
  /** Active node discovery (companion-only). When provided together with
   *  `canDiscover`, the list header shows a "Discover" menu. */
  onDiscoverNodes?: (mode: DiscoverMode) => Promise<{ returned: number; newCount: number } | null>;
  /** Gate for the Discover menu — connected companion device. */
  canDiscover?: boolean;
}

interface MergedRow {
  publicKey: string;
  name: string;
  advType?: number;
  rssi?: number;
  snr?: number;
  lastHeard?: number;
  hasPosition: boolean;
  isFavorite: boolean;
}

type SortField = 'name' | 'lastHeard';
type SortDirection = 'asc' | 'desc';

function mergeNodesAndContacts(
  nodes: MeshCoreNode[],
  contacts: MeshCoreContact[],
): MergedRow[] {
  const byKey = new Map<string, MergedRow>();
  for (const n of nodes) {
    if (!n.publicKey) continue;
    byKey.set(n.publicKey, {
      publicKey: n.publicKey,
      name: n.name || 'Unknown',
      advType: n.advType,
      rssi: n.rssi,
      snr: n.snr,
      lastHeard: n.lastHeard,
      hasPosition: false,
      isFavorite: n.isFavorite ?? false,
    });
  }
  for (const c of contacts) {
    if (!c.publicKey) continue;
    const existing = byKey.get(c.publicKey);
    const hasPos = typeof c.latitude === 'number' && typeof c.longitude === 'number';
    if (existing) {
      existing.name = existing.name === 'Unknown'
        ? (c.advName || c.name || existing.name)
        : existing.name;
      existing.rssi = existing.rssi ?? c.rssi;
      existing.snr = existing.snr ?? c.snr;
      existing.lastHeard = existing.lastHeard ?? c.lastSeen;
      existing.hasPosition = existing.hasPosition || hasPos;
      existing.advType = existing.advType ?? c.advType;
    } else {
      byKey.set(c.publicKey, {
        publicKey: c.publicKey,
        name: c.advName || c.name || 'Unknown',
        advType: c.advType,
        rssi: c.rssi,
        snr: c.snr,
        lastHeard: c.lastSeen,
        hasPosition: hasPos,
        isFavorite: false,
      });
    }
  }
  return Array.from(byKey.values());
}

function sortRows(rows: MergedRow[], field: SortField, direction: SortDirection): MergedRow[] {
  const dir = direction === 'asc' ? 1 : -1;
  const comparator = (a: MergedRow, b: MergedRow): number => {
    if (field === 'name') {
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) * dir;
    }
    const at = a.lastHeard ?? 0;
    const bt = b.lastHeard ?? 0;
    return (at - bt) * dir;
  };
  // Pin favorites to the top, mirroring the Meshtastic node list
  // (useProcessedNodes): sort favorites and non-favorites independently by the
  // chosen field/direction, then concatenate favorites first.
  const favorites = rows.filter(r => r.isFavorite).sort(comparator);
  const nonFavorites = rows.filter(r => !r.isFavorite).sort(comparator);
  return [...favorites, ...nonFavorites];
}

export const MeshCoreNodesView: React.FC<MeshCoreNodesViewProps> = ({
  nodes,
  contacts,
  onImportContact,
  onNavigateToDm,
  onToggleFavorite,
  onDiscoverNodes,
  canDiscover,
}) => {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const [favoriteBusy, setFavoriteBusy] = useState<string | null>(null);

  const handleToggleFavorite = useCallback(async (publicKey: string, next: boolean) => {
    if (!onToggleFavorite || favoriteBusy) return;
    setFavoriteBusy(publicKey);
    try {
      const ok = await onToggleFavorite(publicKey, next);
      if (!ok) {
        showToast(t('meshcore.favorite.failed', 'Failed to update favorite'), 'error');
      }
    } finally {
      setFavoriteBusy(null);
    }
  }, [onToggleFavorite, favoriteBusy, showToast, t]);
  const [selected, setSelected] = useState<string | null>(null);
  const [discoverMenuOpen, setDiscoverMenuOpen] = useState(false);
  const [discovering, setDiscovering] = useState<DiscoverMode | null>(null);
  const [sortField, setSortField] = useState<SortField>('lastHeard');
  const [sortDirection, setSortDirection] = useState<SortDirection>('desc');
  const [mobileShowContent, setMobileShowContent] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [importDialogOpen, setImportDialogOpen] = useState(false);
  const [importHex, setImportHex] = useState('');
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);

  const handleImport = useCallback(async () => {
    if (!onImportContact || importing) return;
    const hex = importHex.trim().replace(/^meshcore:\/\//i, '').replace(/\s+/g, '');
    if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length < 2 || hex.length % 2 !== 0) {
      setImportError(t('meshcore.import_contact.invalid_hex', 'Invalid hex — paste the full exported contact blob.'));
      return;
    }
    const bytes: number[] = [];
    for (let i = 0; i < hex.length; i += 2) {
      bytes.push(parseInt(hex.substring(i, i + 2), 16));
    }
    setImporting(true);
    setImportError(null);
    try {
      const ok = await onImportContact(bytes);
      if (ok) {
        setImportDialogOpen(false);
        setImportHex('');
      } else {
        setImportError(t('meshcore.import_contact.failed', 'Import failed — invalid advert data or device not connected.'));
      }
    } finally {
      setImporting(false);
    }
  }, [onImportContact, importing, importHex, t]);

  useEffect(() => {
    const onResize = () => {
      if (!isMobileViewport()) setMobileShowContent(false);
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const handleSelectNode = useCallback((key: string) => {
    setSelected(key);
    if (isMobileViewport()) setMobileShowContent(true);
  }, []);

  // Same toast contract as the Settings-view discovery buttons — results
  // surface here too because responders land directly in this list.
  const handleDiscover = useCallback(async (mode: DiscoverMode) => {
    if (!onDiscoverNodes || discovering) return;
    setDiscoverMenuOpen(false);
    setDiscovering(mode);
    try {
      const result = await onDiscoverNodes(mode);
      if (result) {
        showToast(
          t('meshcore.discover.result', '{{returned}} contacts returned ({{new}} new)', {
            returned: result.returned,
            new: result.newCount,
          }),
          'success',
        );
      } else {
        showToast(t('meshcore.discover.failed', 'Discovery failed'), 'error');
      }
    } finally {
      setDiscovering(null);
    }
  }, [onDiscoverNodes, discovering, showToast, t]);

  const merged = useMemo(() => mergeNodesAndContacts(nodes, contacts), [nodes, contacts]);
  const sorted = useMemo(
    () => sortRows(merged, sortField, sortDirection),
    [merged, sortField, sortDirection],
  );
  const rows = useMemo(() => {
    if (!searchQuery.trim()) return sorted;
    const q = searchQuery.toLowerCase();
    return sorted.filter(r =>
      r.name.toLowerCase().includes(q) || r.publicKey.toLowerCase().includes(q));
  }, [sorted, searchQuery]);

  const mobileClass = mobileShowContent ? 'mobile-show-content' : 'mobile-show-list';
  const selectedRow = rows.find(r => r.publicKey === selected);

  return (
    <div className={`meshcore-two-pane ${mobileClass}`}>
      <div className="meshcore-list-pane">
        <div className="meshcore-list-pane-header">
          <span>{t('meshcore.nav.nodes', 'Nodes')}</span>
          <span className="pane-count">{rows.length}</span>
          {onImportContact && (
            <button
              type="button"
              className="btn-secondary"
              style={{ fontSize: '0.8em', padding: '0.15rem 0.5rem', marginLeft: '0.5rem' }}
              onClick={() => { setImportHex(''); setImportError(null); setImportDialogOpen(true); }}
            >
              {t('meshcore.import_contact.button', 'Import')}
            </button>
          )}
          {onDiscoverNodes && canDiscover && (
            <div className="mc-discover-menu-anchor">
              <button
                type="button"
                className="btn-secondary"
                style={{ fontSize: '0.8em', padding: '0.15rem 0.5rem', marginLeft: '0.5rem' }}
                onClick={() => setDiscoverMenuOpen((open) => !open)}
                disabled={discovering !== null}
                aria-haspopup="menu"
                aria-expanded={discoverMenuOpen}
              >
                {discovering
                  ? t('meshcore.discover.running', 'Discovering…')
                  : t('meshcore.discover.button', 'Discover')}
              </button>
              {discoverMenuOpen && (
                <>
                  <div
                    className="mc-discover-menu-backdrop"
                    onClick={() => setDiscoverMenuOpen(false)}
                  />
                  <div className="mc-discover-menu" role="menu">
                    <button type="button" role="menuitem" onClick={() => void handleDiscover('nearby')}>
                      {t('meshcore.discover.nearby', 'Discover Nearby Nodes')}
                    </button>
                    <button type="button" role="menuitem" onClick={() => void handleDiscover('repeaters')}>
                      {t('meshcore.discover.repeaters', 'Discover Repeaters')}
                    </button>
                    <button type="button" role="menuitem" onClick={() => void handleDiscover('sensors')}>
                      {t('meshcore.discover.sensors', 'Discover Sensors')}
                    </button>
                  </div>
                </>
              )}
            </div>
          )}
          <div className="sort-controls meshcore-sort-controls">
            <select
              aria-label={t('meshcore.sort_by', 'Sort by')}
              title={t('meshcore.sort_by', 'Sort by')}
              value={sortField}
              onChange={(e) => setSortField(e.target.value as SortField)}
              className="sort-dropdown"
            >
              <option value="lastHeard">{t('meshcore.sort_last_heard', 'Last heard')}</option>
              <option value="name">{t('meshcore.sort_name', 'Name')}</option>
            </select>
            <button
              type="button"
              className="sort-direction-btn"
              onClick={() => setSortDirection((d) => (d === 'asc' ? 'desc' : 'asc'))}
              title={sortDirection === 'asc'
                ? t('meshcore.ascending', 'Ascending')
                : t('meshcore.descending', 'Descending')}
              aria-label={sortDirection === 'asc'
                ? t('meshcore.ascending', 'Ascending')
                : t('meshcore.descending', 'Descending')}
            >
              {sortDirection === 'asc' ? '↑' : '↓'}
            </button>
          </div>
        </div>
        <div className="meshcore-search-bar">
          <input
            type="text"
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            placeholder={t('meshcore.search_nodes', 'Search nodes…')}
            className="meshcore-search-input"
          />
          {searchQuery && (
            <button
              type="button"
              className="meshcore-search-clear"
              onClick={() => setSearchQuery('')}
              aria-label={t('common.clear', 'Clear')}
            >
              ×
            </button>
          )}
        </div>
        <div className="meshcore-list-pane-body">
          {rows.length === 0 ? (
            <div className="meshcore-empty-state">
              {searchQuery
                ? t('meshcore.no_search_results', 'No nodes match your search')
                : t('meshcore.no_nodes', 'No nodes seen yet')}
            </div>
          ) : rows.map(row => {
            const roleIcon = meshcoreRoleIcon(row.advType);
            return (
            // Wrapper div (not a button) so the details quick-access can be a
            // real sibling <button> — nested buttons are invalid HTML.
            <div
              key={row.publicKey}
              className={`mc-node-row mc-node-row--split ${selected === row.publicKey ? 'selected' : ''}`}
            >
              <button
                type="button"
                className="mc-node-row-main"
                onClick={() => handleSelectNode(row.publicKey)}
                onDoubleClick={onNavigateToDm ? () => onNavigateToDm(row.publicKey) : undefined}
              >
                <div className="mc-node-row-name">
                  {roleIcon && (
                    <span
                      className="mc-node-role-icon"
                      role="img"
                      aria-label={t(meshcoreRoleLabelKey(row.advType), meshcoreRoleLabel(row.advType))}
                      title={t(meshcoreRoleLabelKey(row.advType), meshcoreRoleLabel(row.advType))}
                    >
                      {roleIcon}
                    </span>
                  )}
                  <span className="mc-node-row-display-name">{row.name}</span>
                </div>
                <div className="mc-node-row-meta">
                  {typeof row.rssi === 'number' && <span>RSSI {row.rssi}</span>}
                  {typeof row.snr === 'number' && <span>SNR {row.snr}</span>}
                  {row.lastHeard && (
                    <span>{new Date(row.lastHeard).toLocaleTimeString()}</span>
                  )}
                  {row.hasPosition && <span>📍</span>}
                </div>
                <div className="mc-node-row-key">
                  {row.publicKey.substring(0, 16)}…
                </div>
              </button>
              {onToggleFavorite && (
                <button
                  type="button"
                  className={`mc-node-row-favorite-btn${row.isFavorite ? ' is-favorite' : ''}`}
                  title={row.isFavorite
                    ? t('meshcore.favorite.remove', 'Remove from favorites')
                    : t('meshcore.favorite.add', 'Add to favorites')}
                  aria-label={row.isFavorite
                    ? t('meshcore.favorite.remove', 'Remove from favorites')
                    : t('meshcore.favorite.add', 'Add to favorites')}
                  aria-pressed={row.isFavorite}
                  disabled={favoriteBusy === row.publicKey}
                  onClick={() => void handleToggleFavorite(row.publicKey, !row.isFavorite)}
                >
                  {row.isFavorite ? '★' : '☆'}
                </button>
              )}
              {onNavigateToDm && (
                <button
                  type="button"
                  className="mc-node-row-details-btn"
                  title={t('meshcore.node_row.details', 'More details')}
                  aria-label={t('meshcore.node_row.details', 'More details')}
                  onClick={() => onNavigateToDm(row.publicKey)}
                >
                  ›
                </button>
              )}
            </div>
            );
          })}
        </div>
      </div>
      <div className="meshcore-main-pane">
        {mobileShowContent && (
          <div className="meshcore-mobile-back-header">
            <button
              type="button"
              className="meshcore-mobile-back-btn"
              onClick={() => setMobileShowContent(false)}
            >
              ◀ {t('common.back', 'Back')}
            </button>
            {selectedRow && (
              <span className="meshcore-mobile-back-title">{selectedRow.name}</span>
            )}
          </div>
        )}
        <MeshCoreMap contacts={contacts} selectedPublicKey={selected} onNavigateToDm={onNavigateToDm} />
      </div>
      {importDialogOpen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={t('meshcore.import_contact.dialog_title', 'Import Contact')}
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.55)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 1000,
          }}
          onClick={(e) => { if (e.target === e.currentTarget && !importing) setImportDialogOpen(false); }}
        >
          <div
            style={{
              background: 'var(--ctp-base, #1e1e2e)',
              color: 'var(--ctp-text, #cdd6f4)',
              padding: '1.25rem 1.5rem',
              borderRadius: '8px',
              maxWidth: '32rem',
              width: '90%',
              boxShadow: '0 4px 20px rgba(0,0,0,0.5)',
            }}
          >
            <h3 style={{ marginTop: 0 }}>
              {t('meshcore.import_contact.dialog_title', 'Import Contact')}
            </h3>
            <p style={{ marginBottom: '0.75rem' }}>
              {t(
                'meshcore.import_contact.dialog_hint',
                'Paste the hex-encoded signed advert blob or a meshcore:// URL exported from another node.',
              )}
            </p>
            <textarea
              value={importHex}
              onChange={(e) => setImportHex(e.target.value)}
              disabled={importing}
              placeholder="e.g. 04a3b7c2d1..."
              rows={4}
              style={{
                width: '100%',
                padding: '0.5rem',
                marginBottom: '0.5rem',
                fontFamily: 'var(--font-mono, monospace)',
                fontSize: '0.85em',
                boxSizing: 'border-box',
                resize: 'vertical',
              }}
              autoFocus
            />
            {importError && (
              <div style={{ color: 'var(--ctp-red)', marginBottom: '0.75rem' }} role="alert">
                {importError}
              </div>
            )}
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.5rem' }}>
              <button
                type="button"
                className="btn-secondary"
                onClick={() => setImportDialogOpen(false)}
                disabled={importing}
              >
                {t('meshcore.import_contact.cancel', 'Cancel')}
              </button>
              <button
                type="button"
                className="btn-primary"
                onClick={handleImport}
                disabled={importing || importHex.trim().length === 0}
              >
                {importing
                  ? t('meshcore.import_contact.importing', 'Importing…')
                  : t('meshcore.import_contact.import', 'Import')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
