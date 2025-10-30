import React, { useState, useEffect } from 'react';
import { useToast } from './ToastContainer';
import { useCsrfFetch } from '../hooks/useCsrfFetch';

interface AutoTracerouteSectionProps {
  intervalMinutes: number;
  baseUrl: string;
  onIntervalChange: (minutes: number) => void;
}

interface Node {
  nodeNum: number;
  nodeId: string;
  longName: string;
  shortName: string;
  lastHeard?: number;
  role?: number;
}

const AutoTracerouteSection: React.FC<AutoTracerouteSectionProps> = ({
  intervalMinutes,
  baseUrl,
  onIntervalChange,
}) => {
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
          showToast('Insufficient permissions to save settings', 'error');
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
          showToast('Insufficient permissions to save settings', 'error');
          return;
        }
        throw new Error(`Server returned ${filterResponse.status}`);
      }

      // Update parent state and local tracking after successful API calls
      onIntervalChange(intervalToSave);
      setInitialFilterEnabled(filterEnabled);
      setInitialSelectedNodes(selectedNodeNums);

      setHasChanges(false);
      showToast('Settings saved! Container restart required for changes to take effect.', 'success');
    } catch (error) {
      console.error('Failed to save auto-traceroute settings:', error);
      showToast('Failed to save settings. Please try again.', 'error');
    } finally {
      setIsSaving(false);
    }
  };

  const handleNodeToggle = (nodeNum: number) => {
    setSelectedNodeNums(prev =>
      prev.includes(nodeNum)
        ? prev.filter(n => n !== nodeNum)
        : [...prev, nodeNum]
    );
  };

  const handleSelectAll = () => {
    setSelectedNodeNums(availableNodes.map(n => n.nodeNum));
  };

  const handleDeselectAll = () => {
    setSelectedNodeNums([]);
  };

  // Filter nodes based on search term
  const filteredNodes = availableNodes.filter(node =>
    node.longName?.toLowerCase().includes(searchTerm.toLowerCase()) ||
    node.shortName?.toLowerCase().includes(searchTerm.toLowerCase()) ||
    node.nodeId?.toLowerCase().includes(searchTerm.toLowerCase())
  );

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
          Auto Traceroute
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
            title="View Auto Traceroute Documentation"
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
          {isSaving ? 'Saving...' : 'Save Changes'}
        </button>
      </div>

      <div className="settings-section" style={{ opacity: localEnabled ? 1 : 0.5, transition: 'opacity 0.2s' }}>
        <p style={{ marginBottom: '1rem', color: '#666', lineHeight: '1.5', marginLeft: '1.75rem' }}>
          When enabled, automatically send traceroute requests to all active nodes at the configured interval.
          This helps maintain up-to-date network topology information. <strong>Requires container restart to take effect.</strong>
        </p>

        <div className="setting-item" style={{ marginTop: '1rem' }}>
          <label htmlFor="tracerouteInterval">
            Traceroute Interval (minutes)
            <span className="setting-description">
              How often to automatically send traceroutes to nodes. Default: 3 minutes
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
              Limit to Specific Nodes
              <span className="setting-description" style={{ display: 'block', marginTop: '0.25rem' }}>
                When enabled, only selected nodes will be tracerouted. When disabled, all nodes are eligible.
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
                placeholder="Search nodes..."
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
                  Select All
                </button>
                <button
                  onClick={handleDeselectAll}
                  className="btn-secondary"
                  style={{ padding: '0.4rem 0.8rem', fontSize: '12px' }}
                >
                  Deselect All
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
                    {searchTerm ? 'No nodes match your search' : 'No nodes available'}
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
                          {node.longName || node.shortName || 'Unknown'}
                        </div>
                        <div style={{ fontSize: '12px', color: 'var(--ctp-subtext0)' }}>
                          {node.nodeId}
                        </div>
                      </div>
                    </div>
                  ))
                )}
              </div>

              {/* Selection count */}
              <div style={{ marginTop: '0.75rem', fontSize: '13px', color: 'var(--ctp-subtext0)' }}>
                Selected: {selectedNodeNums.length} {selectedNodeNums.length === 1 ? 'node' : 'nodes'}
                {selectedNodeNums.length === 0 && filterEnabled && (
                  <span style={{ color: 'var(--ctp-yellow)', marginLeft: '0.5rem' }}>
                    (All nodes eligible when none selected)
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
