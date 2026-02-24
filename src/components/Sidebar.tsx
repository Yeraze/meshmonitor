import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import './Sidebar.css';
import { TabType } from '../types/ui';
import { ResourceType } from '../types/permission';
import packageJson from '../../package.json';

interface UnreadCountsData {
  channels?: {[channelId: number]: number};
  directMessages?: {[nodeId: string]: number};
}

interface SidebarProps {
  activeTab: TabType;
  setActiveTab: (tab: TabType) => void;
  hasPermission: (resource: ResourceType, action: 'read' | 'write') => boolean;
  isAdmin: boolean;
  isAuthenticated: boolean;
  unreadCounts: { [key: number]: number };
  unreadCountsData?: UnreadCountsData | null;
  onMessagesClick: () => void;
  onChannelsClick?: () => void;
  onNewsClick?: () => void;
  baseUrl: string;
  connectedNodeName?: string;
  meshcoreEnabled?: boolean;
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
  baseUrl,
  connectedNodeName,
  meshcoreEnabled
}) => {
  const { t } = useTranslation();
  // Start collapsed (narrow/icon-only) by default for cleaner desktop UI
  const [isCollapsed, setIsCollapsed] = useState(true);
  // Pin state persisted to localStorage - when pinned, sidebar won't auto-collapse on nav click
  const [isPinned, setIsPinned] = useState(() => {
    const saved = localStorage.getItem('sidebar-pinned');
    return saved === 'true';
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

  // Check if user has permission to read ANY channel
  const hasAnyChannelPermission = () => {
    for (let i = 0; i < 8; i++) {
      if (hasPermission(`channel_${i}` as ResourceType, 'read')) {
        return true;
      }
    }
    return false;
  };

  // Update CSS custom property when sidebar collapse state changes
  React.useEffect(() => {
    const updateSidebarWidth = () => {
      const isMobile = window.matchMedia('(max-width: 768px)').matches;
      const baseCollapsedWidth = isMobile ? 48 : 60;
      const baseExpandedWidth = 240;
      const baseWidth = isCollapsed ? baseCollapsedWidth : baseExpandedWidth;
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

  const NavItem: React.FC<{
    id: TabType;
    label: string;
    icon: string;
    onClick?: () => void;
    showNotification?: boolean;
  }> = ({ id, label, icon, onClick, showNotification }) => {
    const handleClick = () => {
      // Auto-collapse sidebar when navigation item is clicked (if expanded and not pinned)
      if (!isCollapsed && !isPinned) {
        setIsCollapsed(true);
      }
      // Execute the custom onClick or default setActiveTab
      if (onClick) {
        onClick();
      } else {
        setActiveTab(id);
      }
    };

    return (
      <button
        className={`sidebar-nav-item ${activeTab === id ? 'active' : ''}`}
        onClick={handleClick}
        title={isCollapsed ? label : ''}
      >
        <span className="nav-icon">{icon}</span>
        {!isCollapsed && <span className="nav-label">{label}</span>}
        {showNotification && <span className="nav-notification-dot"></span>}
      </button>
    );
  };

  const SectionHeader: React.FC<{ title: string }> = ({ title }) => (
    !isCollapsed ? <div className="sidebar-section-header">{title}</div> : null
  );

  return (
    <aside className={`sidebar ${isCollapsed ? 'collapsed' : ''}`}>
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

      <nav className="sidebar-nav">
        <SectionHeader title={t('nav.section_main')} />
        <div className="sidebar-section">
          <NavItem id="nodes" label={t('nav.nodes')} icon="🗺️" />
          {hasAnyChannelPermission() && (
            <NavItem
              id="channels"
              label={t('nav.channels')}
              icon="💬"
              onClick={onChannelsClick}
              showNotification={
                unreadCountsData?.channels
                  ? Object.values(unreadCountsData.channels).some(count => count > 0)
                  : false
              }
            />
          )}
          {hasPermission('messages', 'read') && (
            <NavItem
              id="messages"
              label={t('nav.messages')}
              icon="✉️"
              onClick={onMessagesClick}
              showNotification={
                unreadCountsData?.directMessages
                  ? Object.values(unreadCountsData.directMessages).some(count => count > 0)
                  : false
              }
            />
          )}
          {hasPermission('info', 'read') && (
            <NavItem id="info" label={t('nav.info')} icon="ℹ️" />
          )}
          {hasPermission('dashboard', 'read') && (
            <NavItem id="dashboard" label={t('nav.dashboard')} icon="📊" />
          )}
          {meshcoreEnabled && hasPermission('meshcore', 'read') && (
            <NavItem id="meshcore" label={t('nav.meshcore', 'MeshCore')} icon="📶" />
          )}
        </div>

        <SectionHeader title={t('nav.section_configuration')} />
        <div className="sidebar-section">
          {hasPermission('settings', 'read') && (
            <NavItem id="settings" label={t('nav.settings')} icon="⚙️" />
          )}
          {hasPermission('automation', 'read') && (
            <NavItem id="automation" label={t('nav.automation')} icon="🤖" />
          )}
          {hasPermission('configuration', 'read') && (
            <NavItem id="configuration" label={t('nav.device')} icon="📡" />
          )}
          {isAuthenticated && (
            <NavItem id="notifications" label={t('nav.notifications')} icon="🔔" />
          )}
        </div>

        {(isAdmin || hasPermission('audit', 'read') || hasPermission('security', 'read')) && (
          <>
            <SectionHeader title={t('nav.section_admin')} />
            <div className="sidebar-section">
              {isAdmin && (
                <>
                  <NavItem id="users" label={t('nav.users')} icon="👥" />
                  <NavItem id="admin" label={t('nav.admin_commands')} icon="⚡" />
                </>
              )}
              {hasPermission('audit', 'read') && (
                <NavItem id="audit" label={t('nav.audit_log')} icon="📋" />
              )}
              {hasPermission('security', 'read') && (
                <NavItem id="security" label={t('nav.security')} icon="🔐" />
              )}
            </div>
          </>
        )}
      </nav>

      <div className="sidebar-footer">
        {!isCollapsed && (
          <>
            <span className="version-text">v{packageJson.version}</span>
            <button
              className="news-link"
              onClick={onNewsClick}
              title={t('news.view_news')}
            >
              <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
                <path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-5 14H7v-2h7v2zm3-4H7v-2h10v2zm0-4H7V7h10v2z"/>
              </svg>
            </button>
            <a
              href="https://github.com/Yeraze/meshmonitor"
              target="_blank"
              rel="noopener noreferrer"
              className="github-link"
              title={t('common.view_on_github')}
            >
              <svg viewBox="0 0 16 16" width="20" height="20" fill="currentColor">
                <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"></path>
              </svg>
            </a>
          </>
        )}
        {isCollapsed && (
          <>
            <button
              className="news-link"
              onClick={onNewsClick}
              title={t('news.view_news')}
            >
              <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
                <path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-5 14H7v-2h7v2zm3-4H7v-2h10v2zm0-4H7V7h10v2z"/>
              </svg>
            </button>
            <a
              href="https://github.com/Yeraze/meshmonitor"
              target="_blank"
              rel="noopener noreferrer"
              className="github-link"
              title={t('common.view_on_github')}
            >
              <svg viewBox="0 0 16 16" width="20" height="20" fill="currentColor">
                <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"></path>
              </svg>
            </a>
          </>
        )}
      </div>

      <div className="sidebar-controls">
        {!isCollapsed && (
          <button
            className={`sidebar-pin ${isPinned ? 'pinned' : ''}`}
            onClick={togglePin}
            title={isPinned ? t('nav.unpin_sidebar') : t('nav.pin_sidebar')}
          >
            📌
          </button>
        )}
        <button
          className="sidebar-toggle"
          onClick={() => setIsCollapsed(!isCollapsed)}
          title={isCollapsed ? t('nav.expand_sidebar') : t('nav.collapse_sidebar')}
        >
          {isCollapsed ? '▶' : '◀'}
        </button>
      </div>
    </aside>
  );
};

export default Sidebar;
