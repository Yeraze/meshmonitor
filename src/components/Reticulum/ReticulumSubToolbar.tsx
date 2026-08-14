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
import { type UiIconName } from '../icons';
import { SourceNav, type SourceNavItem } from '../nav/SourceNav';
import type { ReticulumView } from '../../types/reticulum';
import styles from './ReticulumSubToolbar.module.css';

export type { ReticulumView };

interface ReticulumSubToolbarProps {
  view: ReticulumView;
  onSelect: (view: ReticulumView) => void;
  expanded: boolean;
  onToggleExpanded: () => void;
}

interface Item {
  id: ReticulumView;
  labelKey: string;
  fallback: string;
  icon: UiIconName;
}

const ITEMS: Item[] = [
  { id: 'destinations', labelKey: 'reticulum.nav.destinations', fallback: 'Destinations', icon: 'identity' },
  // 'dms' (Phase 2 WP5) sits right after destinations — both are "who's out
  // there" surfaces — and before the more plumbing-flavored
  // interfaces/info/settings pages.
  { id: 'dms', labelKey: 'reticulum.nav.dms', fallback: 'Messages', icon: 'messages' },
  { id: 'interfaces', labelKey: 'reticulum.nav.interfaces', fallback: 'Interfaces', icon: 'network' },
  { id: 'info', labelKey: 'reticulum.nav.info', fallback: 'Info', icon: 'info' },
  { id: 'settings', labelKey: 'reticulum.nav.settings', fallback: 'Settings', icon: 'settings' },
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
}) => {
  const { t } = useTranslation();

  const items = useMemo<SourceNavItem[]>(() => (
    ITEMS.map(item => ({
      id: item.id,
      label: t(item.labelKey, item.fallback),
      icon: item.icon,
      onClick: () => onSelect(item.id),
    }))
  ), [t, onSelect]);

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
    />
  );
};

export default ReticulumSubToolbar;
