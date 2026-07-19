import React from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../../contexts/AuthContext';
import { UiIcon, type UiIconName } from '../icons';

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

  return (
    <aside className={`meshcore-sub-toolbar ${expanded ? 'expanded' : 'collapsed'}`}>
      {ITEMS.map(item => {
        if (item.id === 'configuration' && !canReadConfig) return null;
        if (item.id === 'automations' && !canReadAutomation) return null;
        if (item.id === 'packets' && !canReadPackets) return null;
        // Notifications preferences are per-user — only meaningful when signed in.
        if (item.id === 'notifications' && !isAuthenticated) return null;
        // Info is per-source only — it reads /api/sources/:id/meshcore/info.
        if (item.id === 'info' && !showInfo) return null;
        const label = t(item.labelKey, item.fallback);
        return (
          <button
            key={item.id}
            className={`meshcore-sub-toolbar-item ${view === item.id ? 'active' : ''}`}
            onClick={() => onSelect(item.id)}
            title={!expanded ? label : undefined}
          >
            <span className="icon">
              <UiIcon name={item.icon} size={20} />
              {unread[item.id] && <span className="meshcore-nav-unread-dot" aria-hidden="true" />}
            </span>
            <span className="label">{label}</span>
          </button>
        );
      })}
      <div className="meshcore-sub-toolbar-spacer" />
      <button
        className="meshcore-sub-toolbar-toggle"
        onClick={onToggleExpanded}
        title={expanded
          ? t('meshcore.nav.collapse', 'Collapse')
          : t('meshcore.nav.expand', 'Expand')}
      >
        <UiIcon name={expanded ? 'back' : 'forward'} size={18} />
      </button>
    </aside>
  );
};
