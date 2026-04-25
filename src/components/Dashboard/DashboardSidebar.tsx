/**
 * DashboardSidebar — lists source cards with status, node counts, and admin kebab menu.
 */

import React, { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { version } from '../../../package.json';
import type { DashboardSource, SourceStatus } from '../../hooks/useDashboardData';
import { UNIFIED_SOURCE_ID } from '../../hooks/useDashboardData';

interface DashboardSidebarProps {
  sources: DashboardSource[];
  statusMap: Map<string, SourceStatus | null>;
  nodeCounts: Map<string, number>;
  selectedSourceId: string | null;
  onSelectSource: (id: string) => void;
  isAdmin: boolean;
  isAuthenticated: boolean;
  onAddSource: () => void;
  onEditSource: (id: string) => void;
  onToggleSource: (id: string, enabled: boolean) => void;
  onDeleteSource: (id: string) => void;
  /** Called when user clicks Connect on a source with autoConnect=false (issue #2773). */
  onConnectSource?: (id: string) => void;
  /** Called when user clicks Disconnect (kebab) on a source with autoConnect=false. */
  onDisconnectSource?: (id: string) => void;
  /** Source IDs currently awaiting a /connect POST — used to show "Connecting..." feedback. */
  connectingIds?: Set<string>;
  /** Mobile drawer state — on desktop the sidebar is always visible. */
  mobileOpen?: boolean;
  /** Called to close the drawer on mobile (after selecting a source or tapping backdrop). */
  onMobileClose?: () => void;
  /** Opens the News popup when the footer news button is clicked. */
  onNewsClick?: () => void;
}

function getStatusInfo(
  source: DashboardSource,
  status: SourceStatus | null | undefined,
  t: (key: string) => string,
): { dotClass: string; label: string } {
  if (!source.enabled) {
    return { dotClass: 'disabled', label: t('source.status_disabled') };
  }
  const autoConnectDisabled = (source.config as any)?.autoConnect === false;
  if (autoConnectDisabled && (!status || !status.connected)) {
    // autoConnect=false → source is enabled but manager isn't running until the
    // user explicitly connects (issue #2773). Show a distinct "idle" state
    // instead of a misleading "connecting" dot.
    return { dotClass: 'disabled', label: t('source.status_idle') };
  }
  if (!status) {
    return { dotClass: 'disconnected', label: t('source.status_connecting') };
  }
  if (status.connected) {
    return { dotClass: 'connected', label: t('source.status_connected') };
  }
  return { dotClass: 'connecting', label: t('source.status_connecting') };
}

interface KebabMenuProps {
  sourceId: string;
  sourceEnabled: boolean;
  /** When true, render a "Disconnect" item (manager running + autoConnect=false). */
  canDisconnect?: boolean;
  onEdit: (id: string) => void;
  onToggle: (id: string, enabled: boolean) => void;
  onDelete: (id: string) => void;
  onDisconnect?: (id: string) => void;
}

const KebabMenu: React.FC<KebabMenuProps> = ({
  sourceId,
  sourceEnabled,
  canDisconnect,
  onEdit,
  onToggle,
  onDelete,
  onDisconnect,
}) => {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function handleClickOutside(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [open]);

  return (
    <div ref={menuRef} style={{ position: 'relative' }}>
      <button
        className="dashboard-kebab-btn"
        aria-label={t('source.options')}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
      >
        ⋮
      </button>
      {open && (
        <div className="dashboard-kebab-menu">
          <button
            className="dashboard-kebab-item"
            onClick={(e) => {
              e.stopPropagation();
              setOpen(false);
              onEdit(sourceId);
            }}
          >
            {t('source.kebab.edit')}
          </button>
          <button
            className="dashboard-kebab-item"
            onClick={(e) => {
              e.stopPropagation();
              setOpen(false);
              onToggle(sourceId, !sourceEnabled);
            }}
          >
            {sourceEnabled ? t('source.kebab.disable') : t('source.kebab.enable')}
          </button>
          {canDisconnect && onDisconnect && (
            <button
              className="dashboard-kebab-item"
              onClick={(e) => {
                e.stopPropagation();
                setOpen(false);
                onDisconnect(sourceId);
              }}
            >
              {t('source.kebab.disconnect')}
            </button>
          )}
          <button
            className="dashboard-kebab-item danger"
            onClick={(e) => {
              e.stopPropagation();
              setOpen(false);
              onDelete(sourceId);
            }}
          >
            {t('source.kebab.delete')}
          </button>
        </div>
      )}
    </div>
  );
};

const DashboardSidebar: React.FC<DashboardSidebarProps> = ({
  sources,
  statusMap,
  nodeCounts,
  selectedSourceId,
  onSelectSource,
  isAdmin,
  isAuthenticated,
  onAddSource,
  onEditSource,
  onToggleSource,
  onDeleteSource,
  onConnectSource,
  onDisconnectSource,
  connectingIds,
  mobileOpen = false,
  onMobileClose,
  onNewsClick,
}) => {
  const navigate = useNavigate();
  const { t } = useTranslation();

  // On mobile, wrap source selection so the drawer auto-closes after tap.
  const handleSelectSource = (id: string) => {
    onSelectSource(id);
    onMobileClose?.();
  };

  return (
    <>
      {/* Mobile backdrop — only rendered (via CSS) on small screens when open. */}
      <div
        className={`dashboard-sidebar-backdrop${mobileOpen ? ' open' : ''}`}
        onClick={onMobileClose}
        aria-hidden="true"
      />
      <aside className={`dashboard-sidebar${mobileOpen ? ' mobile-open' : ''}`}>
      <div className="dashboard-sidebar-header">
        {t('source.header')}
        {isAdmin && (
          <button
            className="dashboard-add-source-btn"
            style={{ marginLeft: 8, padding: '2px 8px', fontSize: 11 }}
            onClick={onAddSource}
          >
            {t('source.add_short')}
          </button>
        )}
      </div>

      {sources.map((source) => {
        const isUnified = source.id === UNIFIED_SOURCE_ID;
        const status = statusMap.get(source.id);
        const isConnecting = !isUnified && connectingIds?.has(source.id) === true;
        // Unified is a virtual aggregate — show "connected" dot whenever any
        // backing source is connected. There's nothing to connect to directly.
        const unifiedConnected = isUnified
          ? Array.from(statusMap.values()).some((s) => s?.connected === true)
          : false;
        const { dotClass, label } = isUnified
          ? unifiedConnected
            ? { dotClass: 'connected', label: t('source.status_connected') }
            : { dotClass: 'disconnected', label: t('source.status_disconnected') }
          : isConnecting
            ? { dotClass: 'connecting', label: t('source.status_connecting') }
            : getStatusInfo(source, status, t);
        const nodeCount = nodeCounts.get(source.id) ?? 0;
        const isSelected = selectedSourceId === source.id;

        // Show the Meshtastic logo as a faint watermark for any meshtastic-typed
        // source. Other source types render without a watermark.
        const isMeshtastic =
          source.type === 'meshtastic_tcp' || source.type === 'meshtastic_mqtt';
        const cardClassName =
          'dashboard-source-card' +
          (isSelected ? ' selected' : '') +
          (isMeshtastic ? ' has-meshtastic-watermark' : '');

        return (
          <div
            key={source.id}
            className={cardClassName}
            onClick={() => handleSelectSource(source.id)}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') handleSelectSource(source.id);
            }}
          >
            <div className="dashboard-source-card-header">
              <span className="dashboard-source-card-name" title={source.name}>
                {source.name}
              </span>
              {!isUnified && source.type !== 'meshtastic_tcp' && source.type !== 'meshtastic_mqtt' && (
                <span className="dashboard-source-card-badge">{source.type}</span>
              )}
              {!isUnified && (() => {
                const vn = (source.config as any)?.virtualNode;
                return vn?.enabled ? (
                  <span className="dashboard-source-card-badge" title={t('source.virtual_node_badge_title')}>
                    VN:{vn.port}
                  </span>
                ) : null;
              })()}
              {!isUnified && isAdmin && (
                <KebabMenu
                  sourceId={source.id}
                  sourceEnabled={source.enabled}
                  canDisconnect={
                    (source.config as any)?.autoConnect === false &&
                    status?.connected === true
                  }
                  onEdit={onEditSource}
                  onToggle={onToggleSource}
                  onDelete={onDeleteSource}
                  onDisconnect={onDisconnectSource}
                />
              )}
            </div>

            <div className="dashboard-source-card-status">
              <span className={`dashboard-status-dot ${dotClass}`} />
              <span>{label}</span>
            </div>

            <div className="dashboard-source-card-actions">
              {isAuthenticated ? (
                <span className="dashboard-node-count">{t('source.node_count', { count: nodeCount })}</span>
              ) : (
                <span className="dashboard-lock-icon">🔒</span>
              )}
              {!isUnified && isAdmin && source.enabled &&
                (source.config as any)?.autoConnect === false &&
                !status?.connected &&
                onConnectSource && (() => {
                  const pending = connectingIds?.has(source.id) === true;
                  return (
                    <button
                      className="dashboard-open-btn"
                      disabled={pending}
                      onClick={(e) => {
                        e.stopPropagation();
                        if (!pending) onConnectSource(source.id);
                      }}
                      title={t('source.connect_help')}
                    >
                      {pending ? t('source.connecting') : t('source.connect')}
                    </button>
                  );
                })()}
              {!isUnified && (
                <button
                  className="dashboard-open-btn"
                  disabled={!source.enabled}
                  onClick={(e) => {
                    e.stopPropagation();
                    navigate(`/source/${source.id}`);
                  }}
                >
                  {t('source.open')}
                </button>
              )}
            </div>
          </div>
        );
      })}

      <div className="dashboard-sidebar-links">
        <button
          className="dashboard-sidebar-link dashboard-sidebar-link--active"
          onClick={() => navigate('/unified/messages')}
        >
          {t('source.sidebar.unified_messages')}
        </button>
        <button
          className="dashboard-sidebar-link dashboard-sidebar-link--active"
          onClick={() => navigate('/unified/telemetry')}
        >
          {t('source.sidebar.unified_telemetry')}
        </button>
      </div>

      <div className="dashboard-sidebar-footer">
        <span className="dashboard-sidebar-version">v{version}</span>
        <div className="dashboard-sidebar-footer-icons">
          {isAdmin && (
            <>
              <button
                className="dashboard-sidebar-footer-btn"
                title={t('source.sidebar.users')}
                onClick={() => navigate('/users')}
              >
                👥
              </button>
              <button
                className="dashboard-sidebar-footer-btn"
                title={t('source.sidebar.settings')}
                onClick={() => navigate('/settings')}
              >
                ⚙️
              </button>
            </>
          )}
          <button
            className="dashboard-sidebar-footer-btn"
            title={t('source.sidebar.news')}
            onClick={onNewsClick}
            disabled={!onNewsClick}
          >
            📰
          </button>
          <a
            className="dashboard-sidebar-footer-btn"
            href="https://github.com/Yeraze/meshmonitor"
            target="_blank"
            rel="noopener noreferrer"
            title={t('source.sidebar.github')}
          >
            🐙
          </a>
          <a
            className="dashboard-sidebar-footer-btn"
            href="https://meshmonitor.org"
            target="_blank"
            rel="noopener noreferrer"
            title={t('source.sidebar.website')}
          >
            🔗
          </a>
        </div>
      </div>
    </aside>
    </>
  );
};

export default DashboardSidebar;
