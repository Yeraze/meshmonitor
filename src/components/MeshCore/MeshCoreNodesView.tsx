import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { MeshCoreVirtualList } from './MeshCoreVirtualList';
import NodeQuickAgeFilter from '../NodeQuickAgeFilter';
import { useNodeQuickAgeFilter } from '../../hooks/useNodeQuickAgeFilter';
import { useTranslation } from 'react-i18next';
import { MeshCoreNode } from './hooks/useMeshCore';
import { MeshCoreContact } from '../../utils/meshcoreHelpers';
import { AdvancedNodeFilterPopup, type NodeFilterFeature } from '../AdvancedNodeFilterPopup/AdvancedNodeFilterPopup';
import { NodeSortControls } from '../nodes/NodeSortControls';
import { NodeStatChips } from '../nodes/NodeStatChips';
import { ExportMenuButton } from '../nodes/ExportMenuButton';
import { RoleDistributionSummary } from '../nodes/RoleDistributionSummary';
import { RoleGroupHeader } from '../nodes/RoleGroupHeader';
import { usePersistedListSort } from '../../hooks/usePersistedListSort';
import { usePersistedNodeFilters } from '../../hooks/usePersistedNodeFilters';
import { useNodeRoleGrouping } from '../../hooks/useNodeRoleGrouping';
import { passesNodeFilters, DEFAULT_NODE_FILTERS } from '../../utils/nodeAdvancedFilter';
import { sortByKey, orderFavoritesFirst } from '../../utils/nodeSort';
import { exportNodeList } from '../../utils/nodeExport';
import { readGroupNodesByRole, writeGroupNodesByRole, type GroupedNodeListItem } from '../../utils/nodeGrouping';
import {
  mergeNodesAndContacts,
  meshcoreNodeSortKey,
  toMeshCoreFilterSubject,
  MESHCORE_NODE_SORT_FIELDS,
  MESHCORE_NODE_EXPORT_COLUMNS,
  MESHCORE_ROLE_FILTER_OPTIONS,
  type MeshCoreNodeRow,
} from '../../utils/meshcoreNodeRows';
import type { SortField } from '../../types/ui';
import { MeshCoreMap } from './MeshCoreMap';
import { meshcoreRoleIconName, meshcoreRoleLabelKey, meshcoreRoleLabel, isMeshCoreInfrastructureAdvType } from './meshcoreRole';
import { useToast } from '../ToastContainer';
import { useSettings } from '../../contexts/SettingsContext';
import { useSource } from '../../contexts/SourceContext';
import { useNodeDisplaySettings } from '../../hooks/useNodeDisplaySettings';
import { calculateNodeOpacity } from '../../utils/nodeDimming';
import { isMeshCoreRowComplete } from '../../utils/meshcoreNodeCompleteness';
import { meshcoreAgeCutoffMs, isWithinMeshcoreAge, meshcoreLastHeardMs } from '../../utils/meshcoreAge';
import { formatTimeOrDate } from '../../utils/datetime';
import { UiIcon } from '../icons';
import type { SecurityFilter } from '../../types/ui';
import { indexNodeFields, mergeNodeFields } from '../../utils/meshcoreNodeFieldMerge';
import styles from './MeshCoreNodesView.module.css';
import { isMobileLayoutViewport } from '../../utils/sidebarWidth';

type DiscoverMode = 'nearby' | 'repeaters' | 'sensors';

/** Shared filter popup sections MeshCore supports (the rest are Meshtastic-only). */
const MESHCORE_FILTER_FEATURES: Partial<Record<NodeFilterFeature, boolean>> = {
  security: true, telemetry: false, environment: false, pki: false, remoteAdmin: false,
  mqtt: false, favoriteLocked: false, hiddenFromMap: false, powerSource: false, channels: false,
  position: true, unknown: true, ignored: true, favorites: true, hops: true, roles: true,
};

const SORT_OPTION_KEYS: Record<string, [string, string]> = {
  lastHeard: ['nodes.sort_updated', 'Sort: Updated'],
  longName: ['nodes.sort_name', 'Sort: Name'],
  id: ['nodes.sort_id', 'Sort: ID'],
  snr: ['nodes.sort_signal', 'Sort: Signal'],
  battery: ['nodes.sort_charge', 'Sort: Charge'],
  uptime: ['nodes.sort_uptime', 'Sort: Uptime'],
  hops: ['nodes.sort_hops', 'Sort: Hops'],
};

/** localStorage key for the desktop list-pane collapse preference (mirrors
 *  the Meshtastic `collapse-nodes-btn` toggle, but MeshCore's is per-browser
 *  persisted rather than session-only — see MeshCoreNodesView collapse
 *  toggle below). */
const LIST_COLLAPSED_STORAGE_KEY = 'meshcore-list-collapsed';

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
  /**
   * True while the FIRST contacts snapshot fetch is still in flight.
   * Forwarded to the embedded `MeshCoreMap` to show a loading overlay
   * instead of an apparently-empty map during initial connect.
   */
  mapIsLoading?: boolean;
  /** True when this MeshCore source is in strict receive-only mode (#4547
   *  Phase 2). Plumbed here in WP1; WP3 wires the actual gating (the
   *  Discover menu's three items disabled + tooltip). */
  receiveOnly?: boolean;
  /** True for a MeshCore Repeater (serial CLI) source (#5500). Its node list
   *  comes only from the repeater's `neighbors` table, so the empty state
   *  says why it may stay short or empty. */
  isRepeaterSource?: boolean;
  /**
   * #5964: Node Details' Show on Map. When set, the view selects this node
   * (which centres and zooms the map on it), shows the map pane on a phone,
   * and opens the node's popup once. Changing the value repeats that.
   */
  focusPublicKey?: string | null;
  /** Lowercase public keys on the ignore list. `nodes`/`contacts` arrive
   *  unfiltered; ignored rows are hidden unless "show ignored" is on (#6259). */
  ignoredKeys?: ReadonlySet<string>;
}

export const MeshCoreNodesView: React.FC<MeshCoreNodesViewProps> = ({
  nodes,
  contacts,
  onImportContact,
  onNavigateToDm,
  onToggleFavorite,
  onDiscoverNodes,
  canDiscover,
  mapIsLoading,
  receiveOnly = false,
  isRepeaterSource = false,
  focusPublicKey = null,
  ignoredKeys,
}) => {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const { timeFormat, dateFormat } = useSettings();
  const { sourceId } = useSource();
  const {
    maxNodeAgeHours,
    maxInfraNodeAgeHours,
    hideIncompleteNodes,
    nodeDimmingEnabled,
    nodeDimmingStartHours,
    nodeDimmingMinOpacity,
  } = useNodeDisplaySettings(sourceId);
  // Nodes tab quick age filter (#5387): a view-only override. When picked it
  // replaces BOTH the companion and the infrastructure window, since the
  // viewer asked for "nodes heard in the last N"; null = the two settings.
  const [quickAgeHours] = useNodeQuickAgeFilter();
  const companionAgeHours = quickAgeHours ?? maxNodeAgeHours;
  const infraAgeHours = quickAgeHours ?? maxInfraNodeAgeHours;
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
  // Seeded from `focusPublicKey` so a Show on Map jump mounts the map on the
  // node straight away, rather than mounting elsewhere and remounting.
  const [selected, setSelected] = useState<string | null>(focusPublicKey);
  // #5964: the node whose popup the map should open once it draws it.
  const [pendingPopupKey, setPendingPopupKey] = useState<string | null>(focusPublicKey);
  const clearPendingPopup = useCallback(() => setPendingPopupKey(null), []);
  const [discoverMenuOpen, setDiscoverMenuOpen] = useState(false);
  const [discovering, setDiscovering] = useState<DiscoverMode | null>(null);
  const {
    field: sortField,
    direction: sortDirection,
    setField: setSortField,
    toggleDirection: toggleSortDirection,
  } = usePersistedListSort<SortField>('meshcoreNodesSort', MESHCORE_NODE_SORT_FIELDS, {
    field: 'lastHeard',
    direction: 'desc',
  });
  const [nodeFilters, setNodeFilters] = usePersistedNodeFilters('meshcoreNodeFilters');
  // P7a #6254: the shared Security filter (signature failed / name reuse). Local
  // to this view so it never leaks into the Meshtastic Nodes tab.
  const [securityFilter, setSecurityFilter] = useState<SecurityFilter>('all');
  const [filterPopupOpen, setFilterPopupOpen] = useState(false);
  const [groupByRole, setGroupByRole] = useState<boolean>(() => readGroupNodesByRole());
  const toggleGroupByRole = useCallback(() => {
    setGroupByRole((v) => {
      writeGroupNodesByRole(!v);
      return !v;
    });
  }, []);
  // On a phone the map shows first, with the list a tap away (#5968), as on
  // Meshtastic, whose node list starts collapsed there.
  const [mobileShowContent, setMobileShowContent] = useState(() => isMobileLayoutViewport());
  // Desktop list-pane collapse toggle (mirrors NodesTab's `collapse-nodes-btn`
  // / MeshCoreDirectMessagesView's `meshcore-collapse-btn`). Persisted so the
  // preference survives reloads on desktop; always false on mobile — the
  // mobile layout doesn't have a "thin bar" collapsed state, it swaps the
  // whole pane via `mobileShowContent` instead (see handleToggleListCollapse).
  const [isListCollapsed, setIsListCollapsed] = useState<boolean>(() => {
    if (isMobileLayoutViewport()) return false;
    try {
      return localStorage.getItem(LIST_COLLAPSED_STORAGE_KEY) === 'true';
    } catch {
      return false;
    }
  });
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
      if (!isMobileLayoutViewport()) {
        setMobileShowContent(false);
      } else {
        // Mobile has no "thin bar" collapsed state — force the list content
        // back on so a desktop-collapsed preference doesn't leave the pane
        // blank after resizing/rotating into the mobile breakpoint.
        setIsListCollapsed(false);
      }
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // Persist the desktop collapse preference. Skipped while at the mobile
  // breakpoint so the forced reset above (mobile always uncollapsed) never
  // clobbers the saved desktop preference.
  useEffect(() => {
    if (isMobileLayoutViewport()) return;
    try {
      localStorage.setItem(LIST_COLLAPSED_STORAGE_KEY, String(isListCollapsed));
    } catch {
      // best-effort — ignore storage errors (e.g. private browsing quota)
    }
  }, [isListCollapsed]);

  // A later Show on Map while this view stays mounted.
  useEffect(() => {
    if (!focusPublicKey) return;
    setSelected(focusPublicKey);
    setPendingPopupKey(focusPublicKey);
    if (isMobileLayoutViewport()) setMobileShowContent(true);
  }, [focusPublicKey]);

  const handleSelectNode = useCallback((key: string) => {
    setSelected(key);
    if (isMobileLayoutViewport()) setMobileShowContent(true);
  }, []);

  const handleToggleListCollapse = useCallback(() => {
    if (isMobileLayoutViewport()) {
      // No thin-bar concept on mobile — reveal the full map (all contacts,
      // no node selected) instead, matching the desktop "shrink the sidebar"
      // intent as closely as the mobile single-pane layout allows.
      setMobileShowContent(true);
      return;
    }
    setIsListCollapsed((c) => !c);
  }, []);

  // Same toast contract as the Settings-view discovery buttons — results
  // surface here too because responders land directly in this list.
  const handleDiscover = useCallback(async (mode: DiscoverMode) => {
    if (!onDiscoverNodes || discovering) return;
    if (receiveOnly) return;
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
  }, [onDiscoverNodes, discovering, receiveOnly, showToast, t]);

  const merged = useMemo(() => mergeNodesAndContacts(nodes, contacts, ignoredKeys), [nodes, contacts, ignoredKeys]);

  /** Favorites and the operator's own node are never hidden by the age cutoff
   *  (parity with useProcessedNodes.ts:194 + #4412 Phase 4 spec §2 D6). Uses
   *  the `isLocal` flag (#4438), not a name/advName substring match — the
   *  `(local)` suffix stays as display text, but is no longer the predicate,
   *  so a stranger who names their device `Foo (local)` is not exempted. */
  const isAgeExempt = useCallback((r: MeshCoreNodeRow): boolean =>
    r.isFavorite || r.isLocal, []);

  const aged = useMemo(() => {
    // Date.now() is read inside the memo, so the cutoff refreshes on every
    // nodes/contacts poll (`merged` changes) rather than freezing at mount —
    // the same property useProcessedNodes relies on.
    const cutoffMs = meshcoreAgeCutoffMs(companionAgeHours);
    // #4899: repeaters and room servers (advType 2/3) get a SEPARATE, usually
    // longer cutoff. They re-flood-advertise on a long, often multi-day
    // interval and never send DMs, so a stale `lastHeard` doesn't mean the node
    // left the mesh — aging them off the companion window just makes fixed
    // infrastructure vanish while its DB row/position stay intact. A value of
    // 0 means "never expire" (show regardless of age, like favorites).
    const infraNever = infraAgeHours <= 0;
    const infraCutoffMs = infraNever ? 0 : meshcoreAgeCutoffMs(infraAgeHours);
    // The companion window itself can be "never / show all" (#4947) — stealthy
    // MeshCore companions may go days/weeks between adverts, so 0 keeps them all.
    const companionNever = companionAgeHours <= 0;
    return merged.filter(r => {
      if (isAgeExempt(r)) return true;
      // #6258: no advertised name or unknown type. Favorites/local are exempt above.
      if (hideIncompleteNodes
        && !isMeshCoreRowComplete({ rawName: r.hasName ? r.name : null, advType: r.advType })) {
        return false;
      }
      if (isMeshCoreInfrastructureAdvType(r.advType)) {
        return infraNever || isWithinMeshcoreAge(r, infraCutoffMs);
      }
      return companionNever || isWithinMeshcoreAge(r, cutoffMs);
    });
  }, [merged, companionAgeHours, infraAgeHours, isAgeExempt, hideIncompleteNodes]);

  // #6258: map-marker dimming only (the list is never dimmed). The window end is
  // the row's configured window from settings (not the quick filter); window 0
  // (show all) yields no dimming. The local node is never dimmed.
  const opacityByKey = useMemo(() => {
    const map = new Map<string, number>();
    if (!nodeDimmingEnabled) return map;
    const nowMs = Date.now();
    for (const r of aged) {
      if (r.isLocal) continue;
      const windowHours = isMeshCoreInfrastructureAdvType(r.advType)
        ? maxInfraNodeAgeHours
        : maxNodeAgeHours;
      if (windowHours <= 0) continue;
      const heardMs = meshcoreLastHeardMs(r);
      const opacity = calculateNodeOpacity(
        heardMs == null ? undefined : heardMs / 1000,
        true,
        nodeDimmingStartHours,
        nodeDimmingMinOpacity,
        windowHours,
        nowMs,
      );
      if (opacity < 1) map.set(r.publicKey, opacity);
    }
    return map;
  }, [aged, nodeDimmingEnabled, nodeDimmingStartHours, nodeDimmingMinOpacity, maxNodeAgeHours, maxInfraNodeAgeHours]);

  // Advanced filter (shared predicate). The list and the map both use this set.
  const filtered = useMemo(
    () => aged.filter((r) => passesNodeFilters(toMeshCoreFilterSubject(r), nodeFilters, { securityFilter })),
    [aged, nodeFilters, securityFilter],
  );
  const searched = useMemo(() => {
    if (!searchQuery.trim()) return filtered;
    const q = searchQuery.toLowerCase();
    return filtered.filter(r =>
      r.name.toLowerCase().includes(q) || r.publicKey.toLowerCase().includes(q));
  }, [filtered, searchQuery]);

  // Favorites pin to the top, each part sorted by the chosen field.
  const orderRows = useCallback(
    (xs: MeshCoreNodeRow[]) =>
      orderFavoritesFirst(xs, (part) => sortByKey(part, (r) => meshcoreNodeSortKey(r, sortField), sortDirection)),
    [sortField, sortDirection],
  );
  const flatOrdered = useMemo(() => orderRows(searched), [orderRows, searched]);
  const { items, distribution, toggleCollapsed } = useNodeRoleGrouping(
    searched, orderRows, groupByRole, flatOrdered,
  );
  const rows = flatOrdered;

  const filtersActive = useMemo(
    () => JSON.stringify(nodeFilters) !== JSON.stringify(DEFAULT_NODE_FILTERS) || securityFilter !== 'all',
    [nodeFilters, securityFilter],
  );
  const roleOptions = useMemo(
    () => MESHCORE_ROLE_FILTER_OPTIONS.map((o) => ({ value: o.value, label: t(meshcoreRoleLabelKey(o.value), o.label) })),
    [t],
  );
  const sortOptions = useMemo(
    () => MESHCORE_NODE_SORT_FIELDS.map((f) => ({ value: f, label: t(SORT_OPTION_KEYS[f][0], SORT_OPTION_KEYS[f][1]) })),
    [t],
  );
  const handleExport = useCallback((format: 'csv' | 'html') => {
    exportNodeList(format, MESHCORE_NODE_EXPORT_COLUMNS, rows, {
      filenamePrefix: 'meshcore-nodes',
      title: t('meshcore.nav.nodes', 'Nodes'),
    });
  }, [rows, t]);

  /** The map gets the same filtered set as the list (#4412 Phase 4 §3.4d)
   *  — a local contact with no matching `MeshCoreNode` row is also kept, so
   *  the map's centering / polar-grid origin never loses the local node.
   *  Uses `isLocal` (#4438), not the `(local)` naming convention. */
  const visibleKeys = useMemo(() => new Set(filtered.map(r => r.publicKey)), [filtered]);
  // First Heard, battery, #5578 advert-position fields and the P7a advert
  // signature live on the durable node rows; one shared merge copies them
  // across for the map popup (S8).
  const nodeFieldIndex = useMemo(() => indexNodeFields(nodes), [nodes]);
  const visibleContacts = useMemo(
    () => contacts
      .filter(c => visibleKeys.has(c.publicKey) || c.isLocal === true)
      .map(raw => mergeNodeFields(raw, nodeFieldIndex)),
    [contacts, visibleKeys, nodeFieldIndex],
  );

  const mobileClass = mobileShowContent ? 'mobile-show-content' : 'mobile-show-list';
  const selectedRow = rows.find(r => r.publicKey === selected);

  return (
    <div className={`meshcore-two-pane ${mobileClass}`}>
      <div className={`meshcore-list-pane ${isListCollapsed ? 'collapsed' : ''}`}>
        {/* Two rows so a 320px pane never clips Discover (#5936): title and
            actions on top, age filter and sort below. */}
        <div className={`meshcore-list-pane-header ${styles.header}`}>
          <div className={styles.row}>
          <button
            type="button"
            className="meshcore-collapse-btn"
            onClick={handleToggleListCollapse}
            title={isListCollapsed
              ? t('nodes.expand_node_list', 'Expand node list')
              : t('nodes.collapse_node_list', 'Collapse node list')}
            aria-label={isListCollapsed
              ? t('nodes.expand_node_list', 'Expand node list')
              : t('nodes.collapse_node_list', 'Collapse node list')}
            aria-expanded={!isListCollapsed}
          >
            <UiIcon name={isListCollapsed ? 'forward' : 'back'} size={18} />
          </button>
          {!isListCollapsed && (
          <>
          <span>{t('meshcore.nav.nodes', 'Nodes')}</span>
          <span className="pane-count">{rows.length}</span>
          <span className={styles.actions}>
          {onImportContact && (
            <button
              type="button"
              className={`btn-secondary ${styles.actionBtn}`}
              onClick={() => { setImportHex(''); setImportError(null); setImportDialogOpen(true); }}
            >
              {t('meshcore.import_contact.button', 'Import')}
            </button>
          )}
          {onDiscoverNodes && canDiscover && (
            <div className="mc-discover-menu-anchor">
              <button
                type="button"
                className={`btn-secondary ${styles.actionBtn}`}
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
                  <div className={`mc-discover-menu ${styles.discoverMenu}`} role="menu">
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => void handleDiscover('nearby')}
                      disabled={receiveOnly}
                      title={receiveOnly ? t('meshcore.receive_only.control_tooltip', 'Receive-only mode is on for this MeshCore source. Turn it off in MeshCore Settings to use this.') : undefined}
                    >
                      {t('meshcore.discover.nearby', 'Discover Nearby Nodes')}
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => void handleDiscover('repeaters')}
                      disabled={receiveOnly}
                      title={receiveOnly ? t('meshcore.receive_only.control_tooltip', 'Receive-only mode is on for this MeshCore source. Turn it off in MeshCore Settings to use this.') : undefined}
                    >
                      {t('meshcore.discover.repeaters', 'Discover Repeaters')}
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => void handleDiscover('sensors')}
                      disabled={receiveOnly}
                      title={receiveOnly ? t('meshcore.receive_only.control_tooltip', 'Receive-only mode is on for this MeshCore source. Turn it off in MeshCore Settings to use this.') : undefined}
                    >
                      {t('meshcore.discover.sensors', 'Discover Sensors')}
                    </button>
                  </div>
                </>
              )}
            </div>
          )}
          </span>
          </>
          )}
          </div>
          {!isListCollapsed && (
          <div className={`${styles.row} ${styles.toolbar}`}>
          <NodeQuickAgeFilter settingsHours={maxNodeAgeHours} variant="meshcore" />
          <NodeSortControls
            className="meshcore-sort-controls"
            ariaLabel={t('meshcore.sort_by', 'Sort by')}
            value={sortField}
            direction={sortDirection}
            options={sortOptions}
            onChange={setSortField}
            onToggleDirection={toggleSortDirection}
          />
          <div className={styles.tools}>
            <button
              type="button"
              className={`sort-direction-btn${filtersActive ? ` ${styles.active}` : ''}`}
              onClick={() => setFilterPopupOpen(true)}
              aria-pressed={filtersActive}
              title={t('nodes.filter_title', 'Filter nodes')}
              aria-label={t('common.filter', 'Filter')}
            >
              <UiIcon name="filter" />
            </button>
            <button
              type="button"
              className={`sort-direction-btn${groupByRole ? ` ${styles.active}` : ''}`}
              onClick={toggleGroupByRole}
              aria-pressed={groupByRole}
              title={t('nodes.group_by_role_title', 'Group nodes by role')}
              aria-label={t('nodes.group_by_role', 'Group by Role')}
            >
              <UiIcon name="list" />
            </button>
            <ExportMenuButton disabled={rows.length === 0} onExport={handleExport} />
          </div>
          </div>
          )}
        </div>
        {!isListCollapsed && (
        <>
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
              <UiIcon name="close" size={16} />
            </button>
          )}
        </div>
        {groupByRole && distribution && <RoleDistributionSummary distribution={distribution} />}
        <MeshCoreVirtualList
          items={items}
          getKey={item => (item.type === 'header' ? `group:${item.category}` : item.node.publicKey)}
          estimateSize={76}
          empty={(
            <div className="meshcore-empty-state">
              {searchQuery
                ? t('meshcore.no_search_results', 'No nodes match your search')
                : filtersActive && aged.length > 0
                  ? t('meshcore.nodes.no_filter_results', 'No nodes match the current filters')
                : isRepeaterSource
                  ? t(
                    'meshcore.no_nodes_repeater',
                    'No nodes yet. A repeater reports its direct (zero-hop) repeater neighbours, read from its neighbors table every 5 minutes. Other nodes appear only when the firmware is built with MESH_PACKET_LOGGING, which lets MeshMonitor read the adverts the repeater hears.',
                  )
                  : t('meshcore.no_nodes', 'No nodes seen yet')}
            </div>
          )}
          renderRow={(item: GroupedNodeListItem<MeshCoreNodeRow>) => {
            if (item.type === 'header') {
              return (
                <RoleGroupHeader
                  category={item.category}
                  count={item.count}
                  collapsed={item.collapsed}
                  onToggle={toggleCollapsed}
                />
              );
            }
            const row = item.node;
            const roleIcon = meshcoreRoleIconName(row.advType);
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
                      <UiIcon name={roleIcon} size={16} />
                    </span>
                  )}
                  <span className="mc-node-row-display-name">{row.name}</span>
                </div>
                <div className="mc-node-row-meta">
                  <NodeStatChips
                    rssi={row.rssi}
                    snr={row.snr}
                    voltage={typeof row.batteryMv === 'number' && row.batteryMv > 0 ? row.batteryMv / 1000 : null}
                    hops={row.pathLen}
                  />
                  {row.lastHeard && (
                    <span>{formatTimeOrDate(new Date(row.lastHeard), timeFormat, dateFormat)}</span>
                  )}
                  {row.hasPosition && <span><UiIcon name="location" size={14} /></span>}
                  {isRepeaterSource && row.isRepeaterNeighbor && (
                    <span title={t('meshcore.nodes.repeater_neighbor_hint', "Listed in this repeater's neighbours table (heard directly).")}>
                      {t('meshcore.nodes.repeater_neighbor', 'Neighbour')}
                    </span>
                  )}
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
                  <UiIcon name={row.isFavorite ? 'favorite' : 'favoriteOff'} size={17} />
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
                  <UiIcon name="forward" size={16} />
                </button>
              )}
            </div>
            );
          }}
        />
        </>
        )}
      </div>
      <div className="meshcore-main-pane">
        {mobileShowContent && (
          <div className="meshcore-mobile-back-header">
            <button
              type="button"
              className="meshcore-mobile-back-btn"
              onClick={() => setMobileShowContent(false)}
            >
              <UiIcon name="list" size={16} /> {t('nodes.node_list', 'Node list')}
            </button>
            {selectedRow && (
              <span className="meshcore-mobile-back-title">{selectedRow.name}</span>
            )}
          </div>
        )}
        <MeshCoreMap
          contacts={visibleContacts}
          markerOpacityByKey={opacityByKey}
          nodeAgeHours={companionAgeHours}
          selectedPublicKey={selected}
          onNavigateToDm={onNavigateToDm}
          isLoading={mapIsLoading}
          resizeTrigger={`${isListCollapsed}-${mobileShowContent}`}
          pendingPopupPublicKey={pendingPopupKey}
          onPendingPopupHandled={clearPendingPopup}
        />
      </div>
      <AdvancedNodeFilterPopup
        isOpen={filterPopupOpen}
        nodeFilters={nodeFilters}
        securityFilter={securityFilter}
        onSecurityFilterChange={setSecurityFilter}
        onNodeFiltersChange={setNodeFilters}
        onClose={() => setFilterPopupOpen(false)}
        features={MESHCORE_FILTER_FEATURES}
        roleOptions={roleOptions}
      />
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
              background: 'var(--color-bg)',
              color: 'var(--color-text)',
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
              <div style={{ color: 'var(--color-error)', marginBottom: '0.75rem' }} role="alert">
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
