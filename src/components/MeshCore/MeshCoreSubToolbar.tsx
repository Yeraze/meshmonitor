import React from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../../contexts/AuthContext';

export type MeshCoreView = 'nodes' | 'channels' | 'rooms' | 'dms' | 'telemetry' | 'packets' | 'info' | 'configuration' | 'automations' | 'settings';

interface MeshCoreSubToolbarProps {
  view: MeshCoreView;
  onSelect: (view: MeshCoreView) => void;
  expanded: boolean;
  onToggleExpanded: () => void;
  /** When false, the Info entry is suppressed (no source context — it would have no data). */
  showInfo?: boolean;
}

interface Item {
  id: MeshCoreView;
  icon: string;
  labelKey: string;
  fallback: string;
}

const ITEMS: Item[] = [
  { id: 'nodes', icon: '🛰', labelKey: 'meshcore.nav.nodes', fallback: 'Nodes' },
  { id: 'channels', icon: '💬', labelKey: 'meshcore.nav.channels', fallback: 'Channels' },
  { id: 'rooms', icon: '🏠', labelKey: 'meshcore.nav.rooms', fallback: 'Rooms' },
  { id: 'dms', icon: '📧', labelKey: 'meshcore.nav.dms', fallback: 'Direct Messages' },
  { id: 'telemetry', icon: '📊', labelKey: 'meshcore.nav.telemetry', fallback: 'Telemetry' },
  { id: 'packets', icon: '📡', labelKey: 'meshcore.nav.packets', fallback: 'Packet Monitor' },
  { id: 'info', icon: 'ℹ', labelKey: 'meshcore.nav.info', fallback: 'Node Info' },
  { id: 'configuration', icon: '📡', labelKey: 'meshcore.nav.configuration', fallback: 'Configuration' },
  { id: 'automations', icon: '🤖', labelKey: 'meshcore.nav.automations', fallback: 'Automations' },
  { id: 'settings', icon: '⚙', labelKey: 'meshcore.nav.settings', fallback: 'Settings' },
];

export const MeshCoreSubToolbar: React.FC<MeshCoreSubToolbarProps> = ({
  view,
  onSelect,
  expanded,
  onToggleExpanded,
  showInfo = true,
}) => {
  const { t } = useTranslation();
  const { hasPermission } = useAuth();
  const canReadConfig = hasPermission('configuration', 'read');
  const canReadAutomation = hasPermission('automation', 'read');
  const canReadPackets = hasPermission('packetmonitor', 'read');

  return (
    <aside className={`meshcore-sub-toolbar ${expanded ? 'expanded' : 'collapsed'}`}>
      {ITEMS.map(item => {
        if (item.id === 'configuration' && !canReadConfig) return null;
        if (item.id === 'automations' && !canReadAutomation) return null;
        if (item.id === 'packets' && !canReadPackets) return null;
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
            <span className="icon">{item.icon}</span>
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
        {expanded ? '◀' : '▶'}
      </button>
    </aside>
  );
};
