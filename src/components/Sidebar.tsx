import React, { useState } from 'react';
import './Sidebar.css';
import { TabType } from '../types/ui';
import { ResourceType, PermissionAction } from '../types/permission';

interface SidebarProps {
  activeTab: TabType;
  setActiveTab: (tab: TabType) => void;
  hasPermission: (resource: ResourceType, action: PermissionAction) => boolean;
  isAdmin: boolean;
  unreadCounts: { [key: number]: number };
  onMessagesClick: () => void;
}

const Sidebar: React.FC<SidebarProps> = ({
  activeTab,
  setActiveTab,
  hasPermission,
  isAdmin,
  unreadCounts,
  onMessagesClick
}) => {
  const [isCollapsed, setIsCollapsed] = useState(false);

  const NavItem: React.FC<{
    id: TabType;
    label: string;
    icon: string;
    onClick?: () => void;
    showNotification?: boolean;
  }> = ({ id, label, icon, onClick, showNotification }) => (
    <button
      className={`sidebar-nav-item ${activeTab === id ? 'active' : ''}`}
      onClick={onClick || (() => setActiveTab(id))}
      title={isCollapsed ? label : ''}
    >
      <span className="nav-icon">{icon}</span>
      {!isCollapsed && <span className="nav-label">{label}</span>}
      {showNotification && <span className="nav-notification-dot"></span>}
    </button>
  );

  const SectionHeader: React.FC<{ title: string }> = ({ title }) => (
    !isCollapsed ? <div className="sidebar-section-header">{title}</div> : null
  );

  return (
    <aside className={`sidebar ${isCollapsed ? 'collapsed' : ''}`}>
      <nav className="sidebar-nav">
        <SectionHeader title="Main" />
        <div className="sidebar-section">
          <NavItem id="nodes" label="Nodes" icon="🗺️" />
          {hasPermission('channels', 'read') && (
            <NavItem
              id="channels"
              label="Channels"
              icon="💬"
              showNotification={Object.entries(unreadCounts).some(
                ([channel, count]) => parseInt(channel) !== -1 && count > 0
              )}
            />
          )}
          {hasPermission('messages', 'read') && (
            <NavItem
              id="messages"
              label="Messages"
              icon="✉️"
              onClick={onMessagesClick}
              showNotification={unreadCounts[-1] > 0}
            />
          )}
          {hasPermission('info', 'read') && (
            <NavItem id="info" label="Info" icon="ℹ️" />
          )}
          {hasPermission('dashboard', 'read') && (
            <NavItem id="dashboard" label="Dashboard" icon="📊" />
          )}
        </div>

        <SectionHeader title="Configuration" />
        <div className="sidebar-section">
          {hasPermission('settings', 'read') && (
            <NavItem id="settings" label="Settings" icon="⚙️" />
          )}
          {hasPermission('automation', 'read') && (
            <NavItem id="automation" label="Automation" icon="🤖" />
          )}
          {hasPermission('configuration', 'read') && (
            <NavItem id="configuration" label="Device" icon="📡" />
          )}
        </div>

        {(isAdmin || hasPermission('audit', 'read')) && (
          <>
            <SectionHeader title="Admin" />
            <div className="sidebar-section">
              {isAdmin && (
                <NavItem id="users" label="Users" icon="👥" />
              )}
              {hasPermission('audit', 'read') && (
                <NavItem id="audit" label="Audit Log" icon="📋" />
              )}
            </div>
          </>
        )}
      </nav>

      <div className="sidebar-footer">
        {!isCollapsed && (
          <>
            <span className="version-text">v2.2.0</span>
            <a
              href="https://github.com/Yeraze/meshmonitor"
              target="_blank"
              rel="noopener noreferrer"
              className="github-link"
              title="View on GitHub"
            >
              <svg viewBox="0 0 16 16" width="20" height="20" fill="currentColor">
                <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"></path>
              </svg>
            </a>
          </>
        )}
        {isCollapsed && (
          <a
            href="https://github.com/Yeraze/meshmonitor"
            target="_blank"
            rel="noopener noreferrer"
            className="github-link"
            title="View on GitHub"
          >
            <svg viewBox="0 0 16 16" width="20" height="20" fill="currentColor">
              <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"></path>
            </svg>
          </a>
        )}
      </div>

      <button
        className="sidebar-toggle"
        onClick={() => setIsCollapsed(!isCollapsed)}
        title={isCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
      >
        {isCollapsed ? '▶' : '◀'}
      </button>
    </aside>
  );
};

export default Sidebar;
