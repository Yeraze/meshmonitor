import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Map, MessageSquare, Home, Mail, BarChart3, Activity, Info, Satellite, Bot,
  Bell, Settings, ChevronLeft, ChevronRight,
} from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import { useSettings } from '../../contexts/SettingsContext';

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
}

const ITEMS: Item[] = [
  { id: 'nodes', labelKey: 'meshcore.nav.nodes', fallback: 'Nodes' },
  { id: 'channels', labelKey: 'meshcore.nav.channels', fallback: 'Channels' },
  { id: 'rooms', labelKey: 'meshcore.nav.rooms', fallback: 'Rooms' },
  // id/key remain 'dms' for backward-compat; the visible label was renamed to
  // 'Node Details' to reflect the view's full scope (#3867).
  { id: 'dms', labelKey: 'meshcore.nav.dms', fallback: 'Node Details' },
  { id: 'telemetry', labelKey: 'meshcore.nav.telemetry', fallback: 'Telemetry' },
  { id: 'packets', labelKey: 'meshcore.nav.packets', fallback: 'Packet Monitor' },
  { id: 'info', labelKey: 'meshcore.nav.info', fallback: 'Node Info' },
  { id: 'configuration', labelKey: 'meshcore.nav.configuration', fallback: 'Configuration' },
  { id: 'automations', labelKey: 'meshcore.nav.automations', fallback: 'Automations' },
  { id: 'notifications', labelKey: 'meshcore.nav.notifications', fallback: 'Notifications' },
  { id: 'settings', labelKey: 'meshcore.nav.settings', fallback: 'Settings' },
];

// Lucide icon components — chosen to match the main sidebar (Sidebar.tsx) for
// shared concepts: nodes→Map, channels→MessageSquare, dms→Mail (messages),
// packets→Activity (packetmonitor), info→Info, configuration→Satellite,
// automations→Bot (automation), settings→Settings.
const LUCIDE_ICONS: Record<MeshCoreView, React.ReactNode> = {
  nodes: <Map size={20} />,
  channels: <MessageSquare size={20} />,
  rooms: <Home size={20} />,
  dms: <Mail size={20} />,
  telemetry: <BarChart3 size={20} />,
  packets: <Activity size={20} />,
  info: <Info size={20} />,
  configuration: <Satellite size={20} />,
  automations: <Bot size={20} />,
  notifications: <Bell size={20} />,
  settings: <Settings size={20} />,
};

// Emoji fallbacks for the 'emoji' icon style, aligned with the main sidebar's
// emoji for shared concepts so both navs look identical in either mode.
const EMOJI_ICONS: Record<MeshCoreView, string> = {
  nodes: '🗺️',
  channels: '💬',
  rooms: '🏠',
  dms: '📧',
  telemetry: '📊',
  packets: '📈',
  info: 'ℹ️',
  configuration: '📡',
  automations: '🤖',
  notifications: '🔔',
  settings: '⚙️',
};

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
  const { iconStyle } = useSettings();
  const isAuthenticated = authStatus?.authenticated ?? false;
  const canReadConfig = hasPermission('configuration', 'read');
  const canReadAutomation = hasPermission('automation', 'read');
  const canReadPackets = hasPermission('packetmonitor', 'read');

  // Mirror Sidebar.tsx: honor the global icon-style setting so MeshCore renders
  // the same lucide icons (default) or emoji fallbacks as the rest of the app.
  const renderIcon = useMemo(() => {
    const useEmoji = iconStyle === 'emoji';
    return (id: MeshCoreView) => useEmoji
      ? <span style={{ fontSize: '1.1rem' }}>{EMOJI_ICONS[id]}</span>
      : LUCIDE_ICONS[id];
  }, [iconStyle]);

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
              {renderIcon(item.id)}
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
        {expanded ? <ChevronLeft size={18} /> : <ChevronRight size={18} />}
      </button>
    </aside>
  );
};
