/**
 * DashboardSidebar — lists source cards with status, node counts, and admin kebab menu.
 */

import React, { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { version } from '../../../package.json';
import type { DashboardSource, SourceStatus } from '../../hooks/useDashboardData';

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
  /** Mobile drawer state — on desktop the sidebar is always visible. */
  mobileOpen?: boolean;
  /** Called to close the drawer on mobile (after selecting a source or tapping backdrop). */
  onMobileClose?: () => void;
}

function getStatusInfo(
  source: DashboardSource,
  status: SourceStatus | null | undefined,
): { dotClass: string; label: string } {
  if (!source.enabled) {
    return { dotClass: 'disabled', label: 'Disabled' };
  }
  if (!status) {
    return { dotClass: 'disconnected', label: 'Connecting' };
  }
  if (status.connected) {
    return { dotClass: 'connected', label: 'Connected' };
  }
  return { dotClass: 'connecting', label: 'Connecting' };
}

interface KebabMenuProps {
  sourceId: string;
  sourceEnabled: boolean;
  onEdit: (id: string) => void;
  onToggle: (id: string, enabled: boolean) => void;
  onDelete: (id: string) => void;
}

const KebabMenu: React.FC<KebabMenuProps> = ({
  sourceId,
  sourceEnabled,
  onEdit,
  onToggle,
  onDelete,
}) => {
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
        aria-label="Source options"
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
            Edit
          </button>
          <button
            className="dashboard-kebab-item"
            onClick={(e) => {
              e.stopPropagation();
              setOpen(false);
              onToggle(sourceId, !sourceEnabled);
            }}
          >
            {sourceEnabled ? 'Disable' : 'Enable'}
          </button>
          <button
            className="dashboard-kebab-item danger"
            onClick={(e) => {
              e.stopPropagation();
              setOpen(false);
              onDelete(sourceId);
            }}
          >
            Delete
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
  mobileOpen = false,
  onMobileClose,
}) => {
  const navigate = useNavigate();

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
        Sources
        {isAdmin && (
          <button
            className="dashboard-add-source-btn"
            style={{ marginLeft: 8, padding: '2px 8px', fontSize: 11 }}
            onClick={onAddSource}
          >
            + Add
          </button>
        )}
      </div>

      {sources.map((source) => {
        const status = statusMap.get(source.id);
        const { dotClass, label } = getStatusInfo(source, status);
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
              {source.type !== 'meshtastic_tcp' && source.type !== 'meshtastic_mqtt' && (
                <span className="dashboard-source-card-badge">{source.type}</span>
              )}
              {(() => {
                const vn = (source.config as any)?.virtualNode;
                return vn?.enabled ? (
                  <span className="dashboard-source-card-badge" title="Virtual Node">
                    VN:{vn.port}
                  </span>
                ) : null;
              })()}
              {isAdmin && (
                <KebabMenu
                  sourceId={source.id}
                  sourceEnabled={source.enabled}
                  onEdit={onEditSource}
                  onToggle={onToggleSource}
                  onDelete={onDeleteSource}
                />
              )}
            </div>

            <div className="dashboard-source-card-status">
              <span className={`dashboard-status-dot ${dotClass}`} />
              <span>{label}</span>
            </div>

            <div className="dashboard-source-card-actions">
              {isAuthenticated ? (
                <span className="dashboard-node-count">{nodeCount} nodes</span>
              ) : (
                <span className="dashboard-lock-icon">🔒</span>
              )}
              <button
                className="dashboard-open-btn"
                disabled={!source.enabled}
                onClick={(e) => {
                  e.stopPropagation();
                  navigate(`/source/${source.id}`);
                }}
              >
                Open →
              </button>
            </div>
          </div>
        );
      })}

      <div className="dashboard-sidebar-links">
        <button
          className="dashboard-sidebar-link dashboard-sidebar-link--active"
          onClick={() => navigate('/unified/messages')}
        >
          💬 Unified Messages
        </button>
        <button
          className="dashboard-sidebar-link dashboard-sidebar-link--active"
          onClick={() => navigate('/unified/telemetry')}
        >
          📡 Unified Telemetry
        </button>
      </div>

      <div className="dashboard-sidebar-footer">
        <span className="dashboard-sidebar-version">v{version}</span>
        <div className="dashboard-sidebar-footer-icons">
          {isAdmin && (
            <>
              <button
                className="dashboard-sidebar-footer-btn"
                title="Users"
                onClick={() => navigate('/users')}
              >
                👥
              </button>
              <button
                className="dashboard-sidebar-footer-btn"
                title="Settings"
                onClick={() => navigate('/settings')}
              >
                ⚙️
              </button>
            </>
          )}
          <button
            className="dashboard-sidebar-footer-btn"
            title="News"
            disabled
          >
            📰
          </button>
          <a
            className="dashboard-sidebar-footer-btn"
            href="https://github.com/Yeraze/meshmonitor"
            target="_blank"
            rel="noopener noreferrer"
            title="GitHub"
          >
            🐙
          </a>
          <a
            className="dashboard-sidebar-footer-btn"
            href="https://meshmonitor.org"
            target="_blank"
            rel="noopener noreferrer"
            title="Website"
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
