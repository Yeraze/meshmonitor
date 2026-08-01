import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import './Sidebar.css';
import { TabType } from '../types/ui';
import { ResourceType } from '../types/permission';
import { UiIcon, type UiIconName } from './icons';
import SidebarFooter from './SidebarFooter';
import { SourceNav, type SourceNavItem, type SourceNavSection } from './nav/SourceNav';

interface UnreadCountsData {
  channels?: {[channelId: number]: number};
  directMessages?: {[nodeId: string]: number};
}

interface SidebarProps {
  activeTab: TabType;
  setActiveTab: (tab: TabType) => void;
  hasPermission: (
    resource: ResourceType,
    action: 'read' | 'write',
    opts?: { sourceId?: string | null; anySource?: boolean }
  ) => boolean;
  isAdmin: boolean;
  isAuthenticated: boolean;
  unreadCounts: { [key: number]: number };
  unreadCountsData?: UnreadCountsData | null;
  onMessagesClick: () => void;
  onChannelsClick?: () => void;
  onNewsClick?: () => void;
  onSearchClick?: () => void;
  baseUrl: string;
  connectedNodeName?: string;
  packetLogEnabled?: boolean;
  /**
   * True when the user can read at least one virtual (Channel Database)
   * channel. Lets the Channels entry appear for virtual-channel-only users
   * (e.g. anonymous on an MQTT source with per-entry canRead grants) who hold
   * no physical channel_0..7 permission.
   */
  hasReadableVirtualChannels?: boolean;
  /**
   * When true (MQTT Bridge dashboard), hides Device Configuration and Remote
   * Administration entries. These device-level controls don't apply to data
   * sourced from an MQTT bridge.
   */
  mqttReadOnly?: boolean;
}

const Sidebar: React.FC<SidebarProps> = ({
  activeTab,
  setActiveTab,
  hasPermission,
  isAdmin,
  isAuthenticated,
  unreadCountsData,
  onMessagesClick,
  onChannelsClick,
  onNewsClick,
  onSearchClick,
  baseUrl,
  connectedNodeName,
  packetLogEnabled,
  hasReadableVirtualChannels = false,
  mqttReadOnly = false,
}) => {
  const { t } = useTranslation();

  // Pin state persisted to localStorage - when pinned, sidebar won't auto-collapse on nav click
  const [isPinned, setIsPinned] = useState(() => {
    const saved = localStorage.getItem('sidebar-pinned');
    return saved === 'true';
  });
  // Start collapsed (narrow/icon-only) by default for cleaner desktop UI, but if
  // the sidebar was pinned expanded, honor that on load instead of rendering
  // collapsed-with-pin-selected.
  const [isCollapsed, setIsCollapsed] = useState(() => {
    return localStorage.getItem('sidebar-pinned') !== 'true';
  });

  // Persist pin state to localStorage
  const togglePin = () => {
    const newPinned = !isPinned;
    setIsPinned(newPinned);
    localStorage.setItem('sidebar-pinned', String(newPinned));
    // When pinning, expand the sidebar if collapsed
    if (newPinned && isCollapsed) {
      setIsCollapsed(false);
    }
  };

  // Check if user has permission to read ANY channel — a physical slot
  // (channel_0..7) or a virtual (Channel Database) channel.
  const hasAnyChannelPermission = () => {
    for (let i = 0; i < 8; i++) {
      if (hasPermission(`channel_${i}` as ResourceType, 'read')) {
        return true;
      }
    }
    return hasReadableVirtualChannels;
  };

  // Check if user has permission to search anything (DMs, channels, or meshcore)
  const hasAnySearchPermission = () => {
    if (hasPermission('messages', 'read')) return true;
    return hasAnyChannelPermission();
  };

  // Update CSS custom property when sidebar collapse state changes
  React.useEffect(() => {
    const updateSidebarWidth = () => {
      // Mirrors the two mobile media queries in App.css — keep in sync.
      const isMobile =
        window.matchMedia('(max-width: 768px)').matches ||
        window.matchMedia('(max-height: 500px) and (orientation: landscape)').matches;

      if (isMobile) {
        // The nav is a bottom bar on phones (#4473 phase 2), so it occupies no
        // horizontal space at all. Everything positioned off `--sidebar-width`
        // (app-main, header, banners, save bar, the map/list split) correctly
        // spans the full width once this is 0; vertical room for the bar is
        // reserved separately via `--app-nav-bar-height`.
        document.documentElement.style.setProperty('--sidebar-width', '0px');
        return;
      }

      const baseWidth = isCollapsed ? 60 : 240;
      // Use calc() to include safe-area-inset-left for iPhone notch in landscape
      document.documentElement.style.setProperty(
        '--sidebar-width',
        `calc(${baseWidth}px + env(safe-area-inset-left, 0px))`
      );
    };

    updateSidebarWidth();
    window.addEventListener('resize', updateSidebarWidth);
    return () => window.removeEventListener('resize', updateSidebarWidth);
  }, [isCollapsed]);

  /**
   * Build a SourceNav item. Navigation still auto-collapses an unpinned
   * sidebar, and still defaults to `setActiveTab(id)` when no custom handler is
   * given — SourceNav owns presentation only (#4473).
   */
  const navItem = (
    id: TabType,
    label: string,
    iconName: UiIconName,
    opts: { onClick?: () => void; unread?: boolean } = {}
  ): SourceNavItem => ({
    id,
    label,
    icon: iconName,
    unread: opts.unread,
    onClick: () => {
      if (!isCollapsed && !isPinned) {
        setIsCollapsed(true);
      }
      if (opts.onClick) {
        opts.onClick();
      } else {
        setActiveTab(id);
      }
    },
  });

  const mainItems: SourceNavItem[] = [
    /* Labelled "Map" (#4325) — the tab is the map + node list, and the Map icon
       never matched the old "Nodes" label. The `nodes` tab id and the
       `nav.nodes` locale key are deliberately unchanged: the id is part of the
       route (/source/:id/nodes) so renaming it would break existing bookmarks,
       and the key is what every locale file is already translated against. Same
       divergence as `nav.messages`, which reads "Node Details". */
    navItem('nodes', t('nav.nodes'), 'nodes'),
    ...(hasAnyChannelPermission()
      ? [navItem('channels', t('nav.channels'), 'channels', {
          onClick: onChannelsClick,
          unread: unreadCountsData?.channels
            ? Object.values(unreadCountsData.channels).some(count => count > 0)
            : false,
        })]
      : []),
    ...(hasPermission('messages', 'read')
      ? [navItem('messages', t('nav.messages'), 'directMessages', {
          onClick: onMessagesClick,
          unread: unreadCountsData?.directMessages
            ? Object.values(unreadCountsData.directMessages).some(count => count > 0)
            : false,
        })]
      : []),
    /* Search opens an overlay rather than switching tabs, so its id never
       matches activeTab and it simply never renders active. */
    ...(onSearchClick && hasAnySearchPermission()
      ? [navItem('search' as TabType, t('nav.search'), 'search', { onClick: onSearchClick })]
      : []),
    ...(hasPermission('info', 'read') ? [navItem('info', t('nav.info'), 'info')] : []),
    ...(hasPermission('dashboard', 'read') ? [navItem('dashboard', t('nav.dashboard'), 'dashboard')] : []),
    ...(packetLogEnabled && hasPermission('packetmonitor', 'read')
      ? [navItem('packetmonitor', t('nav.packet_monitor', 'Packet Monitor'), 'activity')]
      : []),
  ];

  const configItems: SourceNavItem[] = [
    /* 'settings' is sourcey (Phase 6 #4416); this nav link guards the whole
       Settings tab, most of whose routes are unscoped, so anySource mirrors the
       server's union check. */
    ...(hasPermission('settings', 'read', { anySource: true })
      ? [navItem('settings', t('nav.settings'), 'settings')]
      : []),
    ...(!mqttReadOnly && hasPermission('automation', 'read')
      ? [navItem('automation', t('nav.automation'), 'bot')]
      : []),
    ...(!mqttReadOnly && hasPermission('configuration', 'read')
      ? [navItem('configuration', t('nav.device'), 'configuration')]
      : []),
    /* MQTT Bridge sources have no device-config surface; surface a dedicated
       bridge Configuration page instead. */
    ...(mqttReadOnly && hasPermission('sources', 'read')
      ? [navItem('mqtt-config', t('nav.mqtt_bridge_config', 'Configuration'), 'configuration')]
      : []),
    ...(isAuthenticated ? [navItem('notifications', t('nav.notifications'), 'notifications')] : []),
  ];

  const adminItems: SourceNavItem[] = [
    ...(isAdmin ? [navItem('users', t('nav.users'), 'users')] : []),
    ...(isAdmin && !mqttReadOnly ? [navItem('admin', t('nav.admin_commands'), 'zap')] : []),
    ...(hasPermission('audit', 'read') ? [navItem('audit', t('nav.audit_log'), 'reports')] : []),
    ...(hasPermission('security', 'read') ? [navItem('security', t('nav.security'), 'security')] : []),
  ];

  const sections: SourceNavSection[] = [
    { title: t('nav.section_main'), items: mainItems },
    { title: t('nav.section_configuration'), items: configItems },
    ...(adminItems.length > 0
      ? [{ title: t('nav.section_admin'), items: adminItems }]
      : []),
  ];

  return (
    <SourceNav
      className={`sidebar ${isCollapsed ? 'collapsed' : ''}`}
      sections={sections}
      activeId={activeTab}
      collapsed={isCollapsed}
      /* Phones get the same scrollable bottom bar as MeshCore (#4473 phase 2).
         The app shell reserves room for it via `--sidebar-width: 0` plus
         `--app-nav-bar-height` — see updateSidebarWidth() below and App.css. */
      mobileVariant="bottom-bar"
      ariaLabel={t('nav.section_main')}
      header={
        <div className="sidebar-header">
          <img src={`${baseUrl}/logo.png`} alt="MeshMonitor Logo" className="sidebar-logo" />
          {!isCollapsed && (
            <div className="sidebar-header-text">
              <div className="sidebar-app-name">MeshMonitor</div>
              {connectedNodeName && (
                <div className="sidebar-node-name">{connectedNodeName}</div>
              )}
            </div>
          )}
        </div>
      }
      /* Pin/collapse controls sit in normal flow directly above the footer.
         They used to be absolutely positioned at a hardcoded `bottom: 70px`,
         which assumed the old three-item footer; the shared SidebarFooter
         (#4436) is taller — and much taller in the 60px collapsed rail, where
         its six icons wrap — so the controls landed on top of it. */
      controls={
        <div className="sidebar-controls">
          {!isCollapsed && (
            <button
              className={`sidebar-pin ${isPinned ? 'pinned' : ''}`}
              onClick={togglePin}
              title={isPinned ? t('nav.unpin_sidebar') : t('nav.pin_sidebar')}
            >
              <UiIcon name="pin" size={18} />
            </button>
          )}
          <button
            className="sidebar-toggle"
            onClick={() => setIsCollapsed(!isCollapsed)}
            title={isCollapsed ? t('nav.expand_sidebar') : t('nav.collapse_sidebar')}
          >
            <UiIcon name={isCollapsed ? 'forward' : 'back'} size={18} />
          </button>
        </div>
      }
      /* Shared footer (issue #4436) — same link set as the unified dashboard
         sidebar. Users/Settings clicks switch tabs here, matching the main-nav
         entries above. `narrowIcons` packs the icon row into the collapsed rail
         instead of letting it wrap one-icon-per-line. */
      footer={
        <SidebarFooter
          isAdmin={isAdmin}
          canReadSettings={hasPermission('settings', 'read', { anySource: true })}
          onUsersClick={() => setActiveTab('users')}
          onSettingsClick={() => setActiveTab('settings')}
          onNewsClick={onNewsClick}
          hideVersion={isCollapsed}
          narrowIcons={isCollapsed}
          pinToBottom
          hideOnCompactLandscape
        />
      }
    />
  );
};

export default Sidebar;
