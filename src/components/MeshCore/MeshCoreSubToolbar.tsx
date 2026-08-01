import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../../contexts/AuthContext';
import { type UiIconName } from '../icons';
import { SourceNav, type SourceNavItem } from '../nav/SourceNav';
import styles from './MeshCoreSubToolbar.module.css';

export type MeshCoreView = 'nodes' | 'channels' | 'rooms' | 'dms' | 'telemetry' | 'packets' | 'info' | 'configuration' | 'automations' | 'notifications' | 'settings';

interface MeshCoreSubToolbarProps {
  view: MeshCoreView;
  onSelect: (view: MeshCoreView) => void;
  expanded: boolean;
  onToggleExpanded: () => void;
  /** When false, the Info entry is suppressed (no source context — it would have no data). */
  showInfo?: boolean;
  /** Per-view unread indicator flags — renders a red dot on the icon (#3891). */
  unread?: Partial<Record<MeshCoreView, boolean>>;
}

interface Item {
  id: MeshCoreView;
  labelKey: string;
  fallback: string;
  icon: UiIconName;
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
  { id: 'configuration', labelKey: 'meshcore.nav.configuration', fallback: 'Configuration', icon: 'configuration' },
  { id: 'automations', labelKey: 'meshcore.nav.automations', fallback: 'Automations', icon: 'bot' },
  { id: 'notifications', labelKey: 'meshcore.nav.notifications', fallback: 'Notifications', icon: 'notifications' },
  { id: 'settings', labelKey: 'meshcore.nav.settings', fallback: 'Settings', icon: 'settings' },
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
  showInfo = true,
  unread = {},
}) => {
  const { t } = useTranslation();
  const { authStatus, hasPermission } = useAuth();
  const isAuthenticated = authStatus?.authenticated ?? false;
  const canReadConfig = hasPermission('configuration', 'read');
  const canReadAutomation = hasPermission('automation', 'read');
  const canReadPackets = hasPermission('packetmonitor', 'read');

  const items = useMemo<SourceNavItem[]>(() => {
    return ITEMS.filter(item => {
      if (item.id === 'configuration' && !canReadConfig) return false;
      if (item.id === 'automations' && !canReadAutomation) return false;
      if (item.id === 'packets' && !canReadPackets) return false;
      // Notifications preferences are per-user — only meaningful when signed in.
      if (item.id === 'notifications' && !isAuthenticated) return false;
      // Info is per-source only — it reads /api/sources/:id/meshcore/info.
      if (item.id === 'info' && !showInfo) return false;
      return true;
    }).map(item => ({
      id: item.id,
      label: t(item.labelKey, item.fallback),
      icon: item.icon,
      onClick: () => onSelect(item.id),
      unread: unread[item.id] ?? false,
    }));
  }, [t, onSelect, unread, showInfo, canReadConfig, canReadAutomation, canReadPackets, isAuthenticated]);

  return (
    <SourceNav
      className={styles.subToolbar}
      sections={[{ items }]}
      activeId={view}
      collapsed={!expanded}
      mobileVariant="bottom-bar"
      onToggleCollapsed={onToggleExpanded}
      collapseLabel={t('meshcore.nav.collapse', 'Collapse')}
      expandLabel={t('meshcore.nav.expand', 'Expand')}
      ariaLabel={t('meshcore.nav.label', 'MeshCore navigation')}
    />
  );
};
