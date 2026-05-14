import React from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../../contexts/AuthContext';

export type MeshCoreView = 'nodes' | 'channels' | 'dms' | 'configuration' | 'settings';

interface MeshCoreSubToolbarProps {
  view: MeshCoreView;
  onSelect: (view: MeshCoreView) => void;
  expanded: boolean;
  onToggleExpanded: () => void;
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
  { id: 'dms', icon: '📧', labelKey: 'meshcore.nav.dms', fallback: 'Direct Messages' },
  { id: 'configuration', icon: '📡', labelKey: 'meshcore.nav.configuration', fallback: 'Configuration' },
  { id: 'settings', icon: '⚙', labelKey: 'meshcore.nav.settings', fallback: 'Settings' },
];

export const MeshCoreSubToolbar: React.FC<MeshCoreSubToolbarProps> = ({
  view,
  onSelect,
  expanded,
  onToggleExpanded,
}) => {
  const { t } = useTranslation();
  const { hasPermission } = useAuth();
  const canReadConfig = hasPermission('configuration', 'read');

  return (
    <aside className={`meshcore-sub-toolbar ${expanded ? 'expanded' : 'collapsed'}`}>
      {ITEMS.map(item => {
        if (item.id === 'configuration' && !canReadConfig) return null;
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
