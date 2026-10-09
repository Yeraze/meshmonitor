/**
 * ReticulumSubToolbar — per-source nav for the Reticulum surface (#3960
 * Phase 1b WP2).
 *
 * Mirrors `MeshCoreSubToolbar`: a fixed item list rendered through the
 * shared `SourceNav` primitive (#4473), so presentation stays in lockstep
 * with every other per-source nav. Unlike MeshCore's toolbar this one has
 * no permission-gated items yet — `destinations`/`interfaces` read through
 * `nodes:read` (already required to mount the page at all, see
 * `ReticulumSourcePage`) and `info`/`settings` have no additional gate in
 * 1b. Revisit if a future WP adds a gated item (e.g. a settings write
 * permission).
 */
import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { SourceNav, type SourceNavItem } from '../nav/SourceNav';
import type { ReticulumView } from '../../types/reticulum';
import {
  DEVICE_CONFIGURATION_NAV_ENTRY,
  SOURCE_SETTINGS_NAV_ENTRY,
  sharedSourceNavPresentation,
  type SharedSourceNavEntry,
} from '../nav/sourceNavEntries';
import { GlobalSettingsLink } from '../nav/GlobalSettingsLink';
import styles from './ReticulumSubToolbar.module.css';

export type { ReticulumView };

interface ReticulumSubToolbarProps {
  view: ReticulumView;
  onSelect: (view: ReticulumView) => void;
  expanded: boolean;
  onToggleExpanded: () => void;
  /** Source connection mode; the 'configuration' item is shown only for 'own'
   *  mode (editable RNode radio config exists only when the bridge owns the
   *  radio), mirroring how MeshCore hides Meshtastic-only panels. */
  sourceMode?: string | null;
}

interface Item extends SharedSourceNavEntry {
  id: ReticulumView;
}

const ITEMS: Item[] = [
  { id: 'destinations', labelKey: 'reticulum.nav.destinations', fallback: 'Destinations', icon: 'identity' },
  // 'dms' (Phase 2 WP5) sits right after destinations — both are "who's out
  // there" surfaces — and before the more plumbing-flavored
  // interfaces/info/settings pages.
  { id: 'dms', labelKey: 'reticulum.nav.dms', fallback: 'Messages', icon: 'messages' },
  { id: 'interfaces', labelKey: 'reticulum.nav.interfaces', fallback: 'Interfaces', icon: 'network' },
  // 'paths' (Phase 4 WP4) — path table + probe + remote-fleet monitoring.
  // Not mode-gated: the path table exists in every mode (build spec §4.4).
  { id: 'paths', labelKey: 'reticulum.nav.paths', fallback: 'Paths', icon: 'route' },
  // 'map' (Phase 3) — peer positions shared via Sideband telemetry. Always shown.
  { id: 'map', labelKey: 'reticulum.nav.map', fallback: 'Map', icon: 'map' },
  // 'configuration' (Phase 3) — editable RNode radio config; own-mode only (filtered below).
  // Icon + label shared with every source type (#5683): never spell them here.
  { id: 'configuration', ...DEVICE_CONFIGURATION_NAV_ENTRY },
  { id: 'info', labelKey: 'reticulum.nav.info', fallback: 'Info', icon: 'info' },
  { id: 'settings', ...SOURCE_SETTINGS_NAV_ENTRY },
];

/**
 * Reticulum's per-source nav. Presentation is delegated to the shared
 * {@link SourceNav} (#4473); this component owns only the item list and
 * view-local selection state, mirroring `MeshCoreSubToolbar`.
 */
export const ReticulumSubToolbar: React.FC<ReticulumSubToolbarProps> = ({
  view,
  onSelect,
  expanded,
  onToggleExpanded,
  sourceMode,
}) => {
  const { t } = useTranslation();

  const items = useMemo<SourceNavItem[]>(() => (
    ITEMS
      // 'configuration' (editable RNode radio config) exists only in 'own' mode.
      .filter(item => item.id !== 'configuration' || sourceMode === 'own')
      .map(item => ({
        id: item.id,
        ...sharedSourceNavPresentation(item, t),
        onClick: () => onSelect(item.id),
      }))
  ), [t, onSelect, sourceMode]);

  return (
    <SourceNav
      className={styles.subToolbar}
      sections={[{ items }]}
      activeId={view}
      collapsed={!expanded}
      mobileVariant="bottom-bar"
      onToggleCollapsed={onToggleExpanded}
      collapseLabel={t('reticulum.nav.collapse', 'Collapse')}
      expandLabel={t('reticulum.nav.expand', 'Expand')}
      ariaLabel={t('reticulum.nav.label', 'Reticulum navigation')}
      /* The install-wide settings page, at the foot of the rail where the
         Meshtastic sidebar keeps its footer links (#5683 follow-up). */
      footer={<GlobalSettingsLink collapsed={!expanded} />}
    />
  );
};

export default ReticulumSubToolbar;
