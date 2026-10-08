import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { SourceNav, type SourceNavItem } from '../nav/SourceNav';
import {
  DEVICE_CONFIGURATION_NAV_ENTRY,
  SOURCE_SETTINGS_NAV_ENTRY,
  sharedSourceNavPresentation,
  type SharedSourceNavEntry,
} from '../nav/sourceNavEntries';
import styles from './MeshCoreSubToolbar.module.css';

import { useMeshCoreViewAccess, type MeshCoreView } from './meshCoreViewAccess';

export type { MeshCoreView } from './meshCoreViewAccess';

interface MeshCoreSubToolbarProps {
  view: MeshCoreView;
  onSelect: (view: MeshCoreView) => void;
  expanded: boolean;
  onToggleExpanded: () => void;
  /** Shared "Pin sidebar" state (#5481); the toggle shows when both are set. */
  pinned?: boolean;
  onTogglePin?: () => void;
  /** When false, the Info entry is suppressed (no source context — it would have no data). */
  showInfo?: boolean;
  /** Per-view unread indicator flags — renders a red dot on the icon (#3891). */
  unread?: Partial<Record<MeshCoreView, boolean>>;
}

interface Item extends SharedSourceNavEntry {
  id: MeshCoreView;
}

const ITEMS: Item[] = [
  { id: 'nodes', labelKey: 'meshcore.nav.nodes', fallback: 'Nodes', icon: 'nodes' },
  { id: 'channels', labelKey: 'meshcore.nav.channels', fallback: 'Channels', icon: 'channels' },
  { id: 'rooms', labelKey: 'meshcore.nav.rooms', fallback: 'Rooms', icon: 'home' },
  // id/key remain 'dms' for backward-compat; the visible label was renamed to
  // 'Node Details' to reflect the view's full scope (#3867).
  { id: 'dms', labelKey: 'meshcore.nav.dms', fallback: 'Node Details', icon: 'directMessages' },
  { id: 'telemetry', labelKey: 'meshcore.nav.telemetry', fallback: 'Telemetry', icon: 'telemetry' },
  { id: 'packets', labelKey: 'meshcore.nav.packets', fallback: 'Packet Monitor', icon: 'activity' },
  { id: 'info', labelKey: 'meshcore.nav.info', fallback: 'Node Info', icon: 'info' },
  // Shared with every source type (#5683): never spell the icon or label here.
  { id: 'configuration', ...DEVICE_CONFIGURATION_NAV_ENTRY },
  { id: 'automations', labelKey: 'meshcore.nav.automations', fallback: 'Automations', icon: 'bot' },
  { id: 'notifications', labelKey: 'meshcore.nav.notifications', fallback: 'Notifications', icon: 'notifications' },
  { id: 'settings', ...SOURCE_SETTINGS_NAV_ENTRY },
];

/**
 * MeshCore's per-source nav. Presentation is delegated to the shared
 * {@link SourceNav} (#4473) so this and the Meshtastic sidebar can no longer
 * drift; what stays here is MeshCore's own item list, permission gating and
 * view-local selection state.
 */
export const MeshCoreSubToolbar: React.FC<MeshCoreSubToolbarProps> = ({
  view,
  onSelect,
  expanded,
  onToggleExpanded,
  pinned,
  onTogglePin,
  showInfo = true,
  unread = {},
}) => {
  const { t } = useTranslation();
  // One rule set for the nav and the page (#5666): see meshCoreViewAccess.ts.
  const visibleViews = useMeshCoreViewAccess(showInfo);

  const items = useMemo<SourceNavItem[]>(() => {
    return ITEMS.filter(item => visibleViews.includes(item.id)).map(item => ({
      id: item.id,
      ...sharedSourceNavPresentation(item, t),
      onClick: () => onSelect(item.id),
      unread: unread[item.id] ?? false,
    }));
  }, [t, onSelect, unread, visibleViews]);

  return (
    <SourceNav
      className={styles.subToolbar}
      sections={[{ items }]}
      activeId={view}
      collapsed={!expanded}
      mobileVariant="bottom-bar"
      onToggleCollapsed={onToggleExpanded}
      pinned={pinned}
      onTogglePin={onTogglePin}
      pinLabel={t('nav.pin_sidebar', 'Pin sidebar')}
      unpinLabel={t('nav.unpin_sidebar', 'Unpin sidebar')}
      collapseLabel={t('meshcore.nav.collapse', 'Collapse')}
      expandLabel={t('meshcore.nav.expand', 'Expand')}
      ariaLabel={t('meshcore.nav.label', 'MeshCore navigation')}
    />
  );
};
