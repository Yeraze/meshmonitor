import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useToast } from './ToastContainer';
import { useCsrfFetch } from '../hooks/useCsrfFetch';
import { useSaveBar } from '../hooks/useSaveBar';

interface AutoTimeSyncSectionProps {
  baseUrl: string;
}

interface Node {
  nodeNum: number;
  nodeId?: string;
  longName?: string;
  shortName?: string;
  lastHeard?: number;
  hasRemoteAdmin?: boolean;
  user?: {
    id: string;
    longName: string;
    shortName: string;
  };
}

interface TimeSyncSettings {
  enabled: boolean;
  nodeNums: number[];
  filterEnabled: boolean;
  expirationHours: number;
  intervalMinutes: number;
}

const AutoTimeSyncSection: React.FC<AutoTimeSyncSectionProps> = ({
  baseUrl,
}) => {
  const { t } = useTranslation();
  const csrfFetch = useCsrfFetch();
  const { showToast } = useToast();
  const [localEnabled, setLocalEnabled] = useState(false);
  const [localInterval, setLocalInterval] = useState(15);
  const [expirationHours, setExpirationHours] = useState(24);
  const [filterEnabled, setFilterEnabled] = useState(false);
  const [selectedNodeNums, setSelectedNodeNums] = useState<number[]>([]);
  const [hasChanges, setHasChanges] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  const [availableNodes, setAvailableNodes] = useState<Node[]>([]);
  const [searchTerm, setSearchTerm] = useState('');

  // Initial state tracking for change detection
  const [initialSettings, setInitialSettings] = useState<TimeSyncSettings | null>(null);

  // Expanded sections state
  const [nodeListExpanded, setNodeListExpanded] = useState(false);

  // Fetch available nodes (only those with remote admin)
  useEffect(() => {
    const fetchNodes = async () => {
      try {
        const response = await csrfFetch(`${baseUrl}/api/nodes`);
        if (response.ok) {
          const data = await response.json();
          // Filter to only nodes with remote admin capability
          setAvailableNodes(data.filter((n: Node) => n.hasRemoteAdmin));
        }
      } catch (error) {
        console.error('Failed to fetch nodes:', error);
      }
    };
    fetchNodes();
  }, [baseUrl, csrfFetch]);

  // Fetch current settings
  useEffect(() => {
    const fetchSettings = async () => {
      try {
        const response = await csrfFetch(`${baseUrl}/api/settings/time-sync-nodes`);
        if (response.ok) {
          const data: TimeSyncSettings = await response.json();
          setLocalEnabled(data.enabled);
          setLocalInterval(data.intervalMinutes || 15);
          setExpirationHours(data.expirationHours || 24);
          setFilterEnabled(data.filterEnabled || false);
          setSelectedNodeNums(data.nodeNums || []);
          setInitialSettings(data);
        }
      } catch (error) {
        console.error('Failed to fetch time sync settings:', error);
      }
    };
    fetchSettings();
  }, [baseUrl, csrfFetch]);

  // Check if any settings have changed
  useEffect(() => {
    if (!initialSettings) return;

    const enabledChanged = localEnabled !== initialSettings.enabled;
    const intervalChanged = localInterval !== (initialSettings.intervalMinutes || 15);
    const expirationChanged = expirationHours !== (initialSettings.expirationHours || 24);
    const filterEnabledChanged = filterEnabled !== (initialSettings.filterEnabled || false);
    const nodesChanged = JSON.stringify([...selectedNodeNums].sort()) !== JSON.stringify([...(initialSettings.nodeNums || [])].sort());

    const changed = enabledChanged || intervalChanged || expirationChanged || filterEnabledChanged || nodesChanged;
    setHasChanges(changed);
  }, [localEnabled, localInterval, expirationHours, filterEnabled, selectedNodeNums, initialSettings]);

  // Reset local state to initial settings (used by SaveBar dismiss)
  const resetChanges = useCallback(() => {
    if (initialSettings) {
      setLocalEnabled(initialSettings.enabled);
      setLocalInterval(initialSettings.intervalMinutes || 15);
      setExpirationHours(initialSettings.expirationHours || 24);
      setFilterEnabled(initialSettings.filterEnabled || false);
      setSelectedNodeNums(initialSettings.nodeNums || []);
    }
  }, [initialSettings]);

  const handleSaveForSaveBar = useCallback(async () => {
    setIsSaving(true);
    try {
      const response = await csrfFetch(`${baseUrl}/api/settings/time-sync-nodes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          enabled: localEnabled,
          nodeNums: selectedNodeNums,
          filterEnabled,
          expirationHours,
          intervalMinutes: localInterval,
        })
      });

      if (!response.ok) {
        if (response.status === 403) {
          showToast(t('automation.insufficient_permissions'), 'error');
          return;
        }
        throw new Error(`Server returned ${response.status}`);
      }

      // Update initial settings after successful save
      setInitialSettings({
        enabled: localEnabled,
        nodeNums: selectedNodeNums,
        filterEnabled,
        expirationHours,
        intervalMinutes: localInterval,
      });

      setHasChanges(false);
      showToast(t('automation.time_sync.settings_saved'), 'success');
    } catch (error) {
      console.error('Failed to save time sync settings:', error);
      showToast(t('automation.settings_save_failed'), 'error');
    } finally {
      setIsSaving(false);
    }
  }, [localEnabled, localInterval, expirationHours, filterEnabled, selectedNodeNums, baseUrl, csrfFetch, showToast, t]);

  // Register with SaveBar
  useSaveBar({
    id: 'auto-time-sync',
    sectionName: t('automation.time_sync.title'),
    hasChanges,
    isSaving,
    onSave: handleSaveForSaveBar,
    onDismiss: resetChanges
  });

  // Filter nodes based on search term
  const filteredNodes = useMemo(() => {
    if (!searchTerm.trim()) {
      return availableNodes;
    }
    const lowerSearch = searchTerm.toLowerCase().trim();
    return availableNodes.filter(node => {
      const longName = (node.user?.longName || node.longName || '').toLowerCase();
      const shortName = (node.user?.shortName || node.shortName || '').toLowerCase();
      const nodeId = (node.user?.id || node.nodeId || '').toLowerCase();
      return longName.includes(lowerSearch) ||
             shortName.includes(lowerSearch) ||
             nodeId.includes(lowerSearch);
    });
  }, [availableNodes, searchTerm]);

  const handleNodeToggle = (nodeNum: number) => {
    setSelectedNodeNums(prev =>
      prev.includes(nodeNum)
        ? prev.filter(n => n !== nodeNum)
        : [...prev, nodeNum]
    );
  };

  const handleSelectAll = () => {
    const newSelection = new Set([...selectedNodeNums, ...filteredNodes.map(n => n.nodeNum)]);
    setSelectedNodeNums(Array.from(newSelection));
  };

  const handleDeselectAll = () => {
    const filteredNums = new Set(filteredNodes.map(n => n.nodeNum));
    setSelectedNodeNums(selectedNodeNums.filter(num => !filteredNums.has(num)));
  };

  const sectionHeaderStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '0.5rem 0.75rem',
    background: 'var(--ctp-surface0)',
    border: '1px solid var(--ctp-surface2)',
    borderRadius: '4px',
    cursor: 'pointer',
    marginBottom: '0.5rem',
  };

  const badgeStyle: React.CSSProperties = {
    background: 'var(--ctp-blue)',
    color: 'var(--ctp-base)',
    padding: '0.1rem 0.5rem',
    borderRadius: '10px',
    fontSize: '11px',
    fontWeight: '600',
  };

  return (
    <>
      <div className="automation-section-header" style={{
        display: 'flex',
        alignItems: 'center',
        marginBottom: '1.5rem',
        padding: '1rem 1.25rem',
        background: 'var(--ctp-surface1)',
        border: '1px solid var(--ctp-surface2)',
        borderRadius: '8px'
      }}>
        <h2 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          <input
            type="checkbox"
            checked={localEnabled}
            onChange={(e) => setLocalEnabled(e.target.checked)}
            style={{ width: 'auto', margin: 0, cursor: 'pointer' }}
          />
          {t('automation.time_sync.title')}
          <a
            href="https://meshmonitor.org/features/automation#auto-time-sync"
            target="_blank"
            rel="noopener noreferrer"
            style={{
              fontSize: '1.2rem',
              color: '#89b4fa',
              textDecoration: 'none',
              marginLeft: '0.5rem'
            }}
            title={t('automation.view_docs')}
          >
            ?
          </a>
        </h2>
      </div>

      <div className="settings-section" style={{ opacity: localEnabled ? 1 : 0.5, transition: 'opacity 0.2s' }}>
        <p style={{ marginBottom: '1rem', color: '#666', lineHeight: '1.5', marginLeft: '1.75rem' }}>
          {t('automation.time_sync.description')}
        </p>

        <div className="setting-item" style={{ marginTop: '1rem' }}>
          <label htmlFor="timeSyncInterval">
            {t('automation.time_sync.interval')}
            <span className="setting-description">
              {t('automation.time_sync.interval_description')}
            </span>
          </label>
          <input
            id="timeSyncInterval"
            type="number"
            min="15"
            max="1440"
            value={localInterval}
            onChange={(e) => setLocalInterval(parseInt(e.target.value) || 15)}
            disabled={!localEnabled}
            className="setting-input"
          />
        </div>

        <div className="setting-item" style={{ marginTop: '1rem' }}>
          <label htmlFor="timeSyncExpiration">
            {t('automation.time_sync.expiration_hours')}
            <span className="setting-description">
              {t('automation.time_sync.expiration_hours_description')}
            </span>
          </label>
          <input
            id="timeSyncExpiration"
            type="number"
            min="1"
            max="24"
            value={expirationHours}
            onChange={(e) => setExpirationHours(parseInt(e.target.value) || 24)}
            disabled={!localEnabled}
            className="setting-input"
          />
        </div>

        {/* Node Filter Section */}
        <div className="setting-item" style={{ marginTop: '2rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', marginBottom: '0.75rem' }}>
            <input
              type="checkbox"
              id="timeSyncNodeFilter"
              checked={filterEnabled}
              onChange={(e) => setFilterEnabled(e.target.checked)}
              disabled={!localEnabled}
              style={{ width: 'auto', margin: 0, marginRight: '0.5rem', cursor: 'pointer' }}
            />
            <label htmlFor="timeSyncNodeFilter" style={{ margin: 0, cursor: 'pointer' }}>
              {t('automation.time_sync.limit_to_nodes')}
              <span className="setting-description" style={{ display: 'block', marginTop: '0.25rem' }}>
                {t('automation.time_sync.filter_description')}
              </span>
            </label>
          </div>

          {filterEnabled && localEnabled && (
            <div style={{
              marginTop: '1rem',
              marginLeft: '1.75rem',
              padding: '1rem',
              background: 'var(--ctp-surface0)',
              border: '1px solid var(--ctp-surface2)',
              borderRadius: '6px',
            }}>
              {/* Specific Nodes Filter */}
              <div style={{ marginBottom: '0.5rem' }}>
                <div
                  style={sectionHeaderStyle}
                  onClick={() => setNodeListExpanded(!nodeListExpanded)}
                >
                  <span style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                    <span>{nodeListExpanded ? '\u25BC' : '\u25B6'}</span>
                    {t('automation.time_sync.select_nodes')}
                    {selectedNodeNums.length > 0 && (
                      <span style={badgeStyle}>{selectedNodeNums.length}</span>
                    )}
                  </span>
                </div>
                {nodeListExpanded && (
                  <div style={{ padding: '0.5rem', background: 'var(--ctp-base)', borderRadius: '4px' }}>
                    <input
                      type="text"
                      placeholder={t('automation.time_sync.search_nodes')}
                      value={searchTerm}
                      onChange={(e) => setSearchTerm(e.target.value)}
                      onClick={(e) => e.stopPropagation()}
                      style={{
                        width: '100%',
                        padding: '0.5rem',
                        marginBottom: '0.5rem',
                        background: 'var(--ctp-surface0)',
                        border: '1px solid var(--ctp-surface2)',
                        borderRadius: '4px',
                        color: 'var(--ctp-text)'
                      }}
                    />
                    <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '0.5rem' }}>
                      <button onClick={handleSelectAll} className="btn-secondary" style={{ padding: '0.3rem 0.6rem', fontSize: '11px' }}>
                        {t('common.select_all')}
                      </button>
                      <button onClick={handleDeselectAll} className="btn-secondary" style={{ padding: '0.3rem 0.6rem', fontSize: '11px' }}>
                        {t('common.deselect_all')}
                      </button>
                    </div>
                    <div style={{ maxHeight: '200px', overflowY: 'auto', border: '1px solid var(--ctp-surface2)', borderRadius: '4px' }}>
                      {filteredNodes.length === 0 ? (
                        <div style={{ padding: '0.5rem', textAlign: 'center', color: 'var(--ctp-subtext0)', fontSize: '12px' }}>
                          {searchTerm ? t('automation.time_sync.no_nodes_match') : t('automation.time_sync.no_nodes_available')}
                        </div>
                      ) : (
                        filteredNodes.map(node => (
                          <div
                            key={node.nodeNum}
                            style={{
                              padding: '0.4rem 0.6rem',
                              borderBottom: '1px solid var(--ctp-surface1)',
                              display: 'flex',
                              alignItems: 'center',
                              cursor: 'pointer',
                              fontSize: '12px'
                            }}
                            onClick={() => handleNodeToggle(node.nodeNum)}
                          >
                            <input
                              type="checkbox"
                              checked={selectedNodeNums.includes(node.nodeNum)}
                              onChange={() => handleNodeToggle(node.nodeNum)}
                              style={{ width: 'auto', margin: 0, marginRight: '0.5rem', cursor: 'pointer' }}
                              onClick={(e) => e.stopPropagation()}
                            />
                            <span style={{ color: 'var(--ctp-text)' }}>
                              {node.user?.longName || node.longName || node.user?.shortName || node.shortName || node.nodeId || 'Unknown'}
                            </span>
                          </div>
                        ))
                      )}
                    </div>
                  </div>
                )}
              </div>

              {/* Stats panel */}
              <div style={{
                marginTop: '1rem',
                padding: '0.75rem',
                background: 'var(--ctp-base)',
                border: '1px solid var(--ctp-surface2)',
                borderRadius: '4px',
                fontSize: '12px'
              }}>
                <div style={{ color: 'var(--ctp-subtext0)' }}>
                  {t('automation.time_sync.eligible_nodes')}: <strong style={{ color: 'var(--ctp-text)' }}>
                    {filterEnabled ? selectedNodeNums.length : availableNodes.length}
                  </strong> / {availableNodes.length} {t('automation.time_sync.nodes_with_remote_admin')}
                </div>
              </div>
            </div>
          )}

          {/* Stats when filter is disabled */}
          {!filterEnabled && localEnabled && (
            <div style={{
              marginTop: '1rem',
              marginLeft: '1.75rem',
              padding: '0.75rem',
              background: 'var(--ctp-surface0)',
              border: '1px solid var(--ctp-surface2)',
              borderRadius: '4px',
              fontSize: '12px'
            }}>
              <div style={{ color: 'var(--ctp-subtext0)' }}>
                {t('automation.time_sync.eligible_nodes')}: <strong style={{ color: 'var(--ctp-text)' }}>
                  {availableNodes.length}
                </strong> {t('automation.time_sync.nodes_with_remote_admin')}
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  );
};

export default AutoTimeSyncSection;
