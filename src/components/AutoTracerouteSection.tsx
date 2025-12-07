import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useToast } from './ToastContainer';
import { useCsrfFetch } from '../hooks/useCsrfFetch';

interface AutoTracerouteSectionProps {
  intervalMinutes: number;
  baseUrl: string;
  onIntervalChange: (minutes: number) => void;
}

interface Node {
  nodeNum: number;
  nodeId?: string;
  longName?: string;
  shortName?: string;
  lastHeard?: number;
  role?: number;
  user?: {
    id: string;
    longName: string;
    shortName: string;
    role?: string;
  };
}

const AutoTracerouteSection: React.FC<AutoTracerouteSectionProps> = ({
  intervalMinutes,
  baseUrl,
  onIntervalChange,
}) => {
  const { t } = useTranslation();
  const csrfFetch = useCsrfFetch();
  const { showToast } = useToast();
  const [localEnabled, setLocalEnabled] = useState(intervalMinutes > 0);
  const [localInterval, setLocalInterval] = useState(intervalMinutes > 0 ? intervalMinutes : 3);
  const [hasChanges, setHasChanges] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  // Node filter states
  const [filterEnabled, setFilterEnabled] = useState(false);
  const [selectedNodeNums, setSelectedNodeNums] = useState<number[]>([]);
  const [availableNodes, setAvailableNodes] = useState<Node[]>([]);
  const [searchTerm, setSearchTerm] = useState('');
  const [initialFilterEnabled, setInitialFilterEnabled] = useState(false);
  const [initialSelectedNodes, setInitialSelectedNodes] = useState<number[]>([]);

  // Update local state when props change
  useEffect(() => {
    setLocalEnabled(intervalMinutes > 0);
    setLocalInterval(intervalMinutes > 0 ? intervalMinutes : 3);
  }, [intervalMinutes]);

  // Fetch available nodes
  useEffect(() => {
    const fetchNodes = async () => {
      try {
        const response = await csrfFetch(`${baseUrl}/api/nodes`);
        if (response.ok) {
          const data = await response.json();
          setAvailableNodes(data);
        }
      } catch (error) {
        console.error('Failed to fetch nodes:', error);
      }
    };
    fetchNodes();
  }, [baseUrl, csrfFetch]);

  // Fetch current filter settings
  useEffect(() => {
    const fetchFilterSettings = async () => {
      try {
        const response = await csrfFetch(`${baseUrl}/api/settings/traceroute-nodes`);
        if (response.ok) {
          const data = await response.json();
          setFilterEnabled(data.enabled);
          setSelectedNodeNums(data.nodeNums);
          setInitialFilterEnabled(data.enabled);
          setInitialSelectedNodes(data.nodeNums);
        }
      } catch (error) {
        console.error('Failed to fetch filter settings:', error);
      }
    };
    fetchFilterSettings();
  }, [baseUrl, csrfFetch]);

  // Check if any settings have changed
  useEffect(() => {
    const currentInterval = localEnabled ? localInterval : 0;
    const intervalChanged = currentInterval !== intervalMinutes;
    const filterEnabledChanged = filterEnabled !== initialFilterEnabled;
    const nodesChanged = JSON.stringify([...selectedNodeNums].sort()) !== JSON.stringify([...initialSelectedNodes].sort());
    const changed = intervalChanged || filterEnabledChanged || nodesChanged;
    setHasChanges(changed);
  }, [localEnabled, localInterval, intervalMinutes, filterEnabled, selectedNodeNums, initialFilterEnabled, initialSelectedNodes]);

  const handleSave = async () => {
    setIsSaving(true);
    try {
      const intervalToSave = localEnabled ? localInterval : 0;

      // Save traceroute interval
      const intervalResponse = await csrfFetch(`${baseUrl}/api/settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tracerouteIntervalMinutes: intervalToSave
        })
      });

      if (!intervalResponse.ok) {
        if (intervalResponse.status === 403) {
          showToast(t('automation.insufficient_permissions'), 'error');
          return;
        }
        throw new Error(`Server returned ${intervalResponse.status}`);
      }

      // Save node filter settings
      const filterResponse = await csrfFetch(`${baseUrl}/api/settings/traceroute-nodes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          enabled: filterEnabled,
          nodeNums: selectedNodeNums
        })
      });

      if (!filterResponse.ok) {
        if (filterResponse.status === 403) {
          showToast(t('automation.insufficient_permissions'), 'error');
          return;
        }
        throw new Error(`Server returned ${filterResponse.status}`);
      }

      // Update parent state and local tracking after successful API calls
      onIntervalChange(intervalToSave);
      setInitialFilterEnabled(filterEnabled);
      setInitialSelectedNodes(selectedNodeNums);

      setHasChanges(false);
      showToast(t('automation.auto_traceroute.settings_saved_restart'), 'success');
    } catch (error) {
      console.error('Failed to save auto-traceroute settings:', error);
      showToast(t('automation.settings_save_failed'), 'error');
    } finally {
      setIsSaving(false);
    }
  };

  // Filter nodes based on search term
  const filteredNodes = React.useMemo(() => {
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
    // Add all filtered nodes to selection (preserving any already selected)
    const newSelection = new Set([...selectedNodeNums, ...filteredNodes.map(n => n.nodeNum)]);
    setSelectedNodeNums(Array.from(newSelection));
  };

  const handleDeselectAll = () => {
    // Remove only the filtered nodes from selection
    const filteredNums = new Set(filteredNodes.map(n => n.nodeNum));
    setSelectedNodeNums(selectedNodeNums.filter(num => !filteredNums.has(num)));
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
          {t('automation.auto_traceroute.title')}
          <a
            href="https://meshmonitor.org/features/automation#auto-traceroute"
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
            ❓
          </a>
        </h2>
        <button
          onClick={handleSave}
          disabled={!hasChanges || isSaving}
          className="btn-primary"
          style={{
            padding: '0.5rem 1.5rem',
            fontSize: '14px',
            opacity: hasChanges ? 1 : 0.5,
            cursor: hasChanges ? 'pointer' : 'not-allowed'
          }}
        >
          {isSaving ? t('automation.saving') : t('automation.save_changes')}
        </button>
      </div>

      <div className="settings-section" style={{ opacity: localEnabled ? 1 : 0.5, transition: 'opacity 0.2s' }}>
        <p style={{ marginBottom: '1rem', color: '#666', lineHeight: '1.5', marginLeft: '1.75rem' }}>
          {t('automation.auto_traceroute.description')}
        </p>

        <div className="setting-item" style={{ marginTop: '1rem' }}>
          <label htmlFor="tracerouteInterval">
            {t('automation.auto_traceroute.interval')}
            <span className="setting-description">
              {t('automation.auto_traceroute.interval_description')}
            </span>
          </label>
          <input
            id="tracerouteInterval"
            type="number"
            min="1"
            max="60"
            value={localInterval}
            onChange={(e) => setLocalInterval(parseInt(e.target.value))}
            disabled={!localEnabled}
            className="setting-input"
          />
        </div>

        {/* Node Filter Section */}
        <div className="setting-item" style={{ marginTop: '2rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', marginBottom: '0.75rem' }}>
            <input
              type="checkbox"
              id="nodeFilter"
              checked={filterEnabled}
              onChange={(e) => setFilterEnabled(e.target.checked)}
              disabled={!localEnabled}
              style={{ width: 'auto', margin: 0, marginRight: '0.5rem', cursor: 'pointer' }}
            />
            <label htmlFor="nodeFilter" style={{ margin: 0, cursor: 'pointer' }}>
              {t('automation.auto_traceroute.limit_to_nodes')}
              <span className="setting-description" style={{ display: 'block', marginTop: '0.25rem' }}>
                {t('automation.auto_traceroute.limit_to_nodes_description')}
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
              borderRadius: '6px'
            }}>
              {/* Search bar */}
              <input
                type="text"
                placeholder={t('automation.auto_traceroute.search_nodes')}
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                style={{
                  width: '100%',
                  padding: '0.5rem',
                  marginBottom: '0.75rem',
                  background: 'var(--ctp-base)',
                  border: '1px solid var(--ctp-surface2)',
                  borderRadius: '4px',
                  color: 'var(--ctp-text)'
                }}
              />

              {/* Select/Deselect buttons */}
              <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '0.75rem' }}>
                <button
                  onClick={handleSelectAll}
                  className="btn-secondary"
                  style={{ padding: '0.4rem 0.8rem', fontSize: '12px' }}
                >
                  {t('common.select_all')}
                </button>
                <button
                  onClick={handleDeselectAll}
                  className="btn-secondary"
                  style={{ padding: '0.4rem 0.8rem', fontSize: '12px' }}
                >
                  {t('common.deselect_all')}
                </button>
              </div>

              {/* Node list */}
              <div style={{
                maxHeight: '300px',
                overflowY: 'auto',
                border: '1px solid var(--ctp-surface2)',
                borderRadius: '4px',
                background: 'var(--ctp-base)'
              }}>
                {filteredNodes.length === 0 ? (
                  <div style={{ padding: '1rem', textAlign: 'center', color: 'var(--ctp-subtext0)' }}>
                    {searchTerm ? t('automation.auto_traceroute.no_nodes_match') : t('automation.auto_traceroute.no_nodes_available')}
                  </div>
                ) : (
                  filteredNodes.map(node => (
                    <div
                      key={node.nodeNum}
                      style={{
                        padding: '0.5rem 0.75rem',
                        borderBottom: '1px solid var(--ctp-surface1)',
                        display: 'flex',
                        alignItems: 'center',
                        cursor: 'pointer',
                        transition: 'background 0.1s'
                      }}
                      onMouseEnter={(e) => e.currentTarget.style.background = 'var(--ctp-surface0)'}
                      onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
                      onClick={() => handleNodeToggle(node.nodeNum)}
                    >
                      <input
                        type="checkbox"
                        checked={selectedNodeNums.includes(node.nodeNum)}
                        onChange={() => handleNodeToggle(node.nodeNum)}
                        style={{ width: 'auto', margin: 0, marginRight: '0.75rem', cursor: 'pointer' }}
                        onClick={(e) => e.stopPropagation()}
                      />
                      <div style={{ flex: 1 }}>
                        <div style={{ fontWeight: '500', color: 'var(--ctp-text)' }}>
                          {node.user?.longName || node.longName || node.user?.shortName || node.shortName || node.user?.id || node.nodeId || 'Unknown'}
                        </div>
                        {(node.user?.longName || node.longName || node.user?.shortName || node.shortName) && (
                          <div style={{ fontSize: '12px', color: 'var(--ctp-subtext0)' }}>
                            {node.user?.id || node.nodeId}
                          </div>
                        )}
                      </div>
                    </div>
                  ))
                )}
              </div>

              {/* Selection count */}
              <div style={{ marginTop: '0.75rem', fontSize: '13px', color: 'var(--ctp-subtext0)' }}>
                {t('automation.auto_traceroute.selected_count', { count: selectedNodeNums.length })}
                {selectedNodeNums.length === 0 && filterEnabled && (
                  <span style={{ color: 'var(--ctp-yellow)', marginLeft: '0.5rem' }}>
                    ({t('automation.auto_traceroute.all_nodes_eligible')})
                  </span>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  );
};

export default AutoTracerouteSection;
