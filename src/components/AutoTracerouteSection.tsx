import React, { useState, useEffect, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useToast } from './ToastContainer';
import { useCsrfFetch } from '../hooks/useCsrfFetch';
import { DEVICE_ROLES } from '../utils/deviceRole';
import { getHardwareModelName } from '../utils/hardwareModel';

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
  hwModel?: number;
  channel?: number;
  user?: {
    id: string;
    longName: string;
    shortName: string;
    role?: string;
  };
}

interface FilterSettings {
  enabled: boolean;
  nodeNums: number[];
  filterChannels: number[];
  filterRoles: number[];
  filterHwModels: number[];
  filterNameRegex: string;
  filterNodesEnabled: boolean;
  filterChannelsEnabled: boolean;
  filterRolesEnabled: boolean;
  filterHwModelsEnabled: boolean;
  filterRegexEnabled: boolean;
  expirationHours: number;
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
  const [filterChannels, setFilterChannels] = useState<number[]>([]);
  const [filterRoles, setFilterRoles] = useState<number[]>([]);
  const [filterHwModels, setFilterHwModels] = useState<number[]>([]);
  const [filterNameRegex, setFilterNameRegex] = useState('.*');

  // Individual filter enabled flags
  const [filterNodesEnabled, setFilterNodesEnabled] = useState(true);
  const [filterChannelsEnabled, setFilterChannelsEnabled] = useState(true);
  const [filterRolesEnabled, setFilterRolesEnabled] = useState(true);
  const [filterHwModelsEnabled, setFilterHwModelsEnabled] = useState(true);
  const [filterRegexEnabled, setFilterRegexEnabled] = useState(true);

  // Expiration hours - how long before re-tracerouting a node
  const [expirationHours, setExpirationHours] = useState(24);

  const [availableNodes, setAvailableNodes] = useState<Node[]>([]);
  const [searchTerm, setSearchTerm] = useState('');

  // Initial state tracking for change detection
  const [initialSettings, setInitialSettings] = useState<FilterSettings | null>(null);

  // Expanded sections state
  const [expandedSections, setExpandedSections] = useState({
    nodes: false,
    channels: false,
    roles: false,
    hwModels: false,
    regex: false,
  });

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
          const data: FilterSettings = await response.json();
          setFilterEnabled(data.enabled);
          setSelectedNodeNums(data.nodeNums || []);
          setFilterChannels(data.filterChannels || []);
          setFilterRoles(data.filterRoles || []);
          setFilterHwModels(data.filterHwModels || []);
          setFilterNameRegex(data.filterNameRegex || '.*');
          // Load individual filter enabled flags (default to true for backward compatibility)
          setFilterNodesEnabled(data.filterNodesEnabled !== false);
          setFilterChannelsEnabled(data.filterChannelsEnabled !== false);
          setFilterRolesEnabled(data.filterRolesEnabled !== false);
          setFilterHwModelsEnabled(data.filterHwModelsEnabled !== false);
          setFilterRegexEnabled(data.filterRegexEnabled !== false);
          // Load expiration hours (default to 24 if not set)
          setExpirationHours(data.expirationHours || 24);
          setInitialSettings(data);
        }
      } catch (error) {
        console.error('Failed to fetch filter settings:', error);
      }
    };
    fetchFilterSettings();
  }, [baseUrl, csrfFetch]);

  // Check if any settings have changed
  useEffect(() => {
    if (!initialSettings) return;

    const currentInterval = localEnabled ? localInterval : 0;
    const intervalChanged = currentInterval !== intervalMinutes;
    const filterEnabledChanged = filterEnabled !== initialSettings.enabled;
    const nodesChanged = JSON.stringify([...selectedNodeNums].sort()) !== JSON.stringify([...(initialSettings.nodeNums || [])].sort());
    const channelsChanged = JSON.stringify([...filterChannels].sort()) !== JSON.stringify([...(initialSettings.filterChannels || [])].sort());
    const rolesChanged = JSON.stringify([...filterRoles].sort()) !== JSON.stringify([...(initialSettings.filterRoles || [])].sort());
    const hwModelsChanged = JSON.stringify([...filterHwModels].sort()) !== JSON.stringify([...(initialSettings.filterHwModels || [])].sort());
    const regexChanged = filterNameRegex !== (initialSettings.filterNameRegex || '.*');

    // Check individual filter enabled flag changes
    const filterNodesEnabledChanged = filterNodesEnabled !== (initialSettings.filterNodesEnabled !== false);
    const filterChannelsEnabledChanged = filterChannelsEnabled !== (initialSettings.filterChannelsEnabled !== false);
    const filterRolesEnabledChanged = filterRolesEnabled !== (initialSettings.filterRolesEnabled !== false);
    const filterHwModelsEnabledChanged = filterHwModelsEnabled !== (initialSettings.filterHwModelsEnabled !== false);
    const filterRegexEnabledChanged = filterRegexEnabled !== (initialSettings.filterRegexEnabled !== false);

    // Check expiration hours change
    const expirationHoursChanged = expirationHours !== (initialSettings.expirationHours || 24);

    const changed = intervalChanged || filterEnabledChanged || nodesChanged || channelsChanged || rolesChanged || hwModelsChanged || regexChanged ||
      filterNodesEnabledChanged || filterChannelsEnabledChanged || filterRolesEnabledChanged || filterHwModelsEnabledChanged || filterRegexEnabledChanged ||
      expirationHoursChanged;
    setHasChanges(changed);
  }, [localEnabled, localInterval, intervalMinutes, filterEnabled, selectedNodeNums, filterChannels, filterRoles, filterHwModels, filterNameRegex, initialSettings,
      filterNodesEnabled, filterChannelsEnabled, filterRolesEnabled, filterHwModelsEnabled, filterRegexEnabled, expirationHours]);

  // Helper to get role from node (could be at top level or in user object)
  const getNodeRole = (node: Node): number | undefined => {
    if (node.role !== undefined && node.role !== null) return node.role;
    if (node.user?.role !== undefined && node.user?.role !== null) {
      // user.role might be a string like "0" or "1"
      return typeof node.user.role === 'string' ? parseInt(node.user.role) : undefined;
    }
    return undefined;
  };

  // Helper to get hwModel from node (could be at top level or in user object)
  const getNodeHwModel = (node: Node): number | undefined => {
    if (node.hwModel !== undefined && node.hwModel !== null) return node.hwModel;
    // hwModel is in user object in the API response
    const userAny = node.user as { hwModel?: number } | undefined;
    if (userAny?.hwModel !== undefined && userAny?.hwModel !== null) return userAny.hwModel;
    return undefined;
  };

  // Get unique values from nodes for filter options
  const availableChannels = useMemo(() => {
    const channels = new Set<number>();
    availableNodes.forEach(node => {
      if (node.channel !== undefined && node.channel !== null) {
        channels.add(node.channel);
      }
    });
    return Array.from(channels).sort((a, b) => a - b);
  }, [availableNodes]);

  const availableRolesInNodes = useMemo(() => {
    const roles = new Set<number>();
    availableNodes.forEach(node => {
      const role = getNodeRole(node);
      if (role !== undefined) {
        roles.add(role);
      }
    });
    return Array.from(roles).sort((a, b) => a - b);
  }, [availableNodes]);

  const availableHwModelsInNodes = useMemo(() => {
    const models = new Set<number>();
    availableNodes.forEach(node => {
      const hwModel = getNodeHwModel(node);
      if (hwModel !== undefined) {
        models.add(hwModel);
      }
    });
    return Array.from(models).sort((a, b) => a - b);
  }, [availableNodes]);

  // Get nodes matching current filters (for preview)
  const matchingNodes = useMemo(() => {
    if (!filterEnabled) return availableNodes;

    const matchingNodeNums = new Set<number>();

    // Add specific nodes (only if this filter is enabled)
    if (filterNodesEnabled) {
      selectedNodeNums.forEach(num => matchingNodeNums.add(num));
    }

    // Add nodes matching channel filter (only if this filter is enabled)
    if (filterChannelsEnabled && filterChannels.length > 0) {
      availableNodes.filter(n => filterChannels.includes(n.channel ?? -1))
        .forEach(n => matchingNodeNums.add(n.nodeNum));
    }

    // Add nodes matching role filter (only if this filter is enabled)
    if (filterRolesEnabled && filterRoles.length > 0) {
      availableNodes.filter(n => {
        const role = getNodeRole(n);
        return role !== undefined && filterRoles.includes(role);
      }).forEach(n => matchingNodeNums.add(n.nodeNum));
    }

    // Add nodes matching hardware model filter (only if this filter is enabled)
    if (filterHwModelsEnabled && filterHwModels.length > 0) {
      availableNodes.filter(n => {
        const hwModel = getNodeHwModel(n);
        return hwModel !== undefined && filterHwModels.includes(hwModel);
      }).forEach(n => matchingNodeNums.add(n.nodeNum));
    }

    // Add nodes matching regex (only if this filter is enabled and regex is not default)
    if (filterRegexEnabled && filterNameRegex && filterNameRegex !== '.*') {
      try {
        const regex = new RegExp(filterNameRegex, 'i');
        availableNodes.filter(n => {
          const name = n.longName || n.user?.longName || n.shortName || n.user?.shortName || n.nodeId || '';
          return regex.test(name);
        }).forEach(n => matchingNodeNums.add(n.nodeNum));
      } catch {
        // Invalid regex, ignore
      }
    } else if (filterRegexEnabled && filterNameRegex === '.*') {
      // Match all - add all nodes
      availableNodes.forEach(n => matchingNodeNums.add(n.nodeNum));
    }

    // Return full node objects for matching node nums
    return availableNodes.filter(n => matchingNodeNums.has(n.nodeNum));
  }, [filterEnabled, selectedNodeNums, filterChannels, filterRoles, filterHwModels, filterNameRegex, availableNodes,
      filterNodesEnabled, filterChannelsEnabled, filterRolesEnabled, filterHwModelsEnabled, filterRegexEnabled]);

  // Debounced matching nodes for preview (1 second delay)
  const [debouncedMatchingNodes, setDebouncedMatchingNodes] = useState<Node[]>([]);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    // Clear any existing timer
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
    }

    // Set new timer for 1 second delay
    debounceTimerRef.current = setTimeout(() => {
      setDebouncedMatchingNodes(matchingNodes);
    }, 1000);

    // Cleanup on unmount or when matchingNodes changes
    return () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }
    };
  }, [matchingNodes]);

  // Initialize debounced nodes on first render
  useEffect(() => {
    if (debouncedMatchingNodes.length === 0 && matchingNodes.length > 0) {
      setDebouncedMatchingNodes(matchingNodes);
    }
  }, [matchingNodes, debouncedMatchingNodes.length]);

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
          nodeNums: selectedNodeNums,
          filterChannels,
          filterRoles,
          filterHwModels,
          filterNameRegex,
          filterNodesEnabled,
          filterChannelsEnabled,
          filterRolesEnabled,
          filterHwModelsEnabled,
          filterRegexEnabled,
          expirationHours,
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
      setInitialSettings({
        enabled: filterEnabled,
        nodeNums: selectedNodeNums,
        filterChannels,
        filterRoles,
        filterHwModels,
        filterNameRegex,
        filterNodesEnabled,
        filterChannelsEnabled,
        filterRolesEnabled,
        filterHwModelsEnabled,
        filterRegexEnabled,
        expirationHours,
      });

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

  const toggleSection = (section: keyof typeof expandedSections) => {
    setExpandedSections(prev => ({ ...prev, [section]: !prev[section] }));
  };

  const toggleArrayValue = (_arr: number[], value: number, setter: React.Dispatch<React.SetStateAction<number[]>>) => {
    setter(prev => prev.includes(value) ? prev.filter(v => v !== value) : [...prev, value]);
  };

  // Styles for collapsible sections
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
            ?
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

        <div className="setting-item" style={{ marginTop: '1rem' }}>
          <label htmlFor="expirationHours">
            {t('automation.auto_traceroute.expiration_hours')}
            <span className="setting-description">
              {t('automation.auto_traceroute.expiration_hours_description')}
            </span>
          </label>
          <input
            id="expirationHours"
            type="number"
            min="1"
            max="168"
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
              id="nodeFilter"
              checked={filterEnabled}
              onChange={(e) => setFilterEnabled(e.target.checked)}
              disabled={!localEnabled}
              style={{ width: 'auto', margin: 0, marginRight: '0.5rem', cursor: 'pointer' }}
            />
            <label htmlFor="nodeFilter" style={{ margin: 0, cursor: 'pointer' }}>
              {t('automation.auto_traceroute.limit_to_nodes')}
              <span className="setting-description" style={{ display: 'block', marginTop: '0.25rem' }}>
                {t('automation.auto_traceroute.filter_description')}
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
              display: 'flex',
              gap: '1rem'
            }}>
              {/* Left column: Filter settings */}
              <div style={{ flex: 1, minWidth: 0 }}>

              {/* Specific Nodes Filter */}
              <div style={{ marginBottom: '0.5rem', opacity: filterNodesEnabled ? 1 : 0.5, transition: 'opacity 0.2s' }}>
                <div
                  style={sectionHeaderStyle}
                  onClick={() => toggleSection('nodes')}
                >
                  <span style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                    <input
                      type="checkbox"
                      checked={filterNodesEnabled}
                      onChange={(e) => {
                        e.stopPropagation();
                        setFilterNodesEnabled(e.target.checked);
                      }}
                      onClick={(e) => e.stopPropagation()}
                      style={{ width: 'auto', margin: 0, cursor: 'pointer' }}
                    />
                    <span>{expandedSections.nodes ? '▼' : '▶'}</span>
                    {t('automation.auto_traceroute.specific_nodes')}
                    {filterNodesEnabled && selectedNodeNums.length > 0 && (
                      <span style={badgeStyle}>{selectedNodeNums.length}</span>
                    )}
                  </span>
                </div>
                {expandedSections.nodes && (
                  <div style={{ padding: '0.5rem', background: 'var(--ctp-base)', borderRadius: '4px' }}>
                    <input
                      type="text"
                      placeholder={t('automation.auto_traceroute.search_nodes')}
                      value={searchTerm}
                      onChange={(e) => setSearchTerm(e.target.value)}
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
                          {searchTerm ? t('automation.auto_traceroute.no_nodes_match') : t('automation.auto_traceroute.no_nodes_available')}
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

              {/* Channel Filter */}
              <div style={{ marginBottom: '0.5rem', opacity: filterChannelsEnabled ? 1 : 0.5, transition: 'opacity 0.2s' }}>
                <div
                  style={sectionHeaderStyle}
                  onClick={() => toggleSection('channels')}
                >
                  <span style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                    <input
                      type="checkbox"
                      checked={filterChannelsEnabled}
                      onChange={(e) => {
                        e.stopPropagation();
                        setFilterChannelsEnabled(e.target.checked);
                      }}
                      onClick={(e) => e.stopPropagation()}
                      style={{ width: 'auto', margin: 0, cursor: 'pointer' }}
                    />
                    <span>{expandedSections.channels ? '▼' : '▶'}</span>
                    {t('automation.auto_traceroute.filter_by_channel')}
                    {filterChannelsEnabled && filterChannels.length > 0 && (
                      <span style={badgeStyle}>{filterChannels.length}</span>
                    )}
                  </span>
                </div>
                {expandedSections.channels && (
                  <div style={{ padding: '0.5rem', background: 'var(--ctp-base)', borderRadius: '4px', display: 'flex', flexWrap: 'wrap', gap: '0.5rem' }}>
                    {availableChannels.length === 0 ? (
                      <span style={{ color: 'var(--ctp-subtext0)', fontSize: '12px' }}>{t('automation.auto_traceroute.no_channels')}</span>
                    ) : (
                      availableChannels.map(channel => (
                        <label key={channel} style={{ display: 'flex', alignItems: 'center', gap: '0.25rem', cursor: 'pointer', fontSize: '12px' }}>
                          <input
                            type="checkbox"
                            checked={filterChannels.includes(channel)}
                            onChange={() => toggleArrayValue(filterChannels, channel, setFilterChannels)}
                            style={{ width: 'auto', margin: 0 }}
                          />
                          Ch {channel} ({availableNodes.filter(n => n.channel === channel).length})
                        </label>
                      ))
                    )}
                  </div>
                )}
              </div>

              {/* Role Filter */}
              <div style={{ marginBottom: '0.5rem', opacity: filterRolesEnabled ? 1 : 0.5, transition: 'opacity 0.2s' }}>
                <div
                  style={sectionHeaderStyle}
                  onClick={() => toggleSection('roles')}
                >
                  <span style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                    <input
                      type="checkbox"
                      checked={filterRolesEnabled}
                      onChange={(e) => {
                        e.stopPropagation();
                        setFilterRolesEnabled(e.target.checked);
                      }}
                      onClick={(e) => e.stopPropagation()}
                      style={{ width: 'auto', margin: 0, cursor: 'pointer' }}
                    />
                    <span>{expandedSections.roles ? '▼' : '▶'}</span>
                    {t('automation.auto_traceroute.filter_by_role')}
                    {filterRolesEnabled && filterRoles.length > 0 && (
                      <span style={badgeStyle}>{filterRoles.length}</span>
                    )}
                  </span>
                </div>
                {expandedSections.roles && (
                  <div style={{ padding: '0.5rem', background: 'var(--ctp-base)', borderRadius: '4px', display: 'flex', flexWrap: 'wrap', gap: '0.5rem' }}>
                    {availableRolesInNodes.length === 0 ? (
                      <span style={{ color: 'var(--ctp-subtext0)', fontSize: '12px' }}>{t('automation.auto_traceroute.no_roles_available')}</span>
                    ) : (
                      availableRolesInNodes.map(roleNum => {
                        const count = availableNodes.filter(n => getNodeRole(n) === roleNum).length;
                        const roleName = DEVICE_ROLES[roleNum] || `Role ${roleNum}`;
                        return (
                          <label key={roleNum} style={{ display: 'flex', alignItems: 'center', gap: '0.25rem', cursor: 'pointer', fontSize: '12px' }}>
                            <input
                              type="checkbox"
                              checked={filterRoles.includes(roleNum)}
                              onChange={() => toggleArrayValue(filterRoles, roleNum, setFilterRoles)}
                              style={{ width: 'auto', margin: 0 }}
                            />
                            {roleName} ({count})
                          </label>
                        );
                      })
                    )}
                  </div>
                )}
              </div>

              {/* Hardware Model Filter */}
              <div style={{ marginBottom: '0.5rem', opacity: filterHwModelsEnabled ? 1 : 0.5, transition: 'opacity 0.2s' }}>
                <div
                  style={sectionHeaderStyle}
                  onClick={() => toggleSection('hwModels')}
                >
                  <span style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                    <input
                      type="checkbox"
                      checked={filterHwModelsEnabled}
                      onChange={(e) => {
                        e.stopPropagation();
                        setFilterHwModelsEnabled(e.target.checked);
                      }}
                      onClick={(e) => e.stopPropagation()}
                      style={{ width: 'auto', margin: 0, cursor: 'pointer' }}
                    />
                    <span>{expandedSections.hwModels ? '▼' : '▶'}</span>
                    {t('automation.auto_traceroute.filter_by_hardware')}
                    {filterHwModelsEnabled && filterHwModels.length > 0 && (
                      <span style={badgeStyle}>{filterHwModels.length}</span>
                    )}
                  </span>
                </div>
                {expandedSections.hwModels && (
                  <div style={{ padding: '0.5rem', background: 'var(--ctp-base)', borderRadius: '4px', maxHeight: '200px', overflowY: 'auto' }}>
                    {availableHwModelsInNodes.length === 0 ? (
                      <span style={{ color: 'var(--ctp-subtext0)', fontSize: '12px' }}>{t('automation.auto_traceroute.no_hardware_available')}</span>
                    ) : (
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem' }}>
                        {availableHwModelsInNodes.map(hwModel => {
                          const count = availableNodes.filter(n => getNodeHwModel(n) === hwModel).length;
                          return (
                            <label key={hwModel} style={{ display: 'flex', alignItems: 'center', gap: '0.25rem', cursor: 'pointer', fontSize: '12px' }}>
                              <input
                                type="checkbox"
                                checked={filterHwModels.includes(hwModel)}
                                onChange={() => toggleArrayValue(filterHwModels, hwModel, setFilterHwModels)}
                                style={{ width: 'auto', margin: 0 }}
                              />
                              {getHardwareModelName(hwModel)} ({count})
                            </label>
                          );
                        })}
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* Name Regex Filter */}
              <div style={{ marginBottom: '0.5rem', opacity: filterRegexEnabled ? 1 : 0.5, transition: 'opacity 0.2s' }}>
                <div
                  style={sectionHeaderStyle}
                  onClick={() => toggleSection('regex')}
                >
                  <span style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                    <input
                      type="checkbox"
                      checked={filterRegexEnabled}
                      onChange={(e) => {
                        e.stopPropagation();
                        setFilterRegexEnabled(e.target.checked);
                      }}
                      onClick={(e) => e.stopPropagation()}
                      style={{ width: 'auto', margin: 0, cursor: 'pointer' }}
                    />
                    <span>{expandedSections.regex ? '▼' : '▶'}</span>
                    {t('automation.auto_traceroute.filter_by_name')}
                    {filterRegexEnabled && filterNameRegex !== '.*' && (
                      <span style={badgeStyle}>1</span>
                    )}
                  </span>
                </div>
                {expandedSections.regex && (
                  <div style={{ padding: '0.5rem', background: 'var(--ctp-base)', borderRadius: '4px' }}>
                    <input
                      type="text"
                      value={filterNameRegex}
                      onChange={(e) => setFilterNameRegex(e.target.value)}
                      placeholder=".*"
                      style={{
                        width: '100%',
                        padding: '0.5rem',
                        marginBottom: '0.25rem',
                        background: 'var(--ctp-surface0)',
                        border: '1px solid var(--ctp-surface2)',
                        borderRadius: '4px',
                        color: 'var(--ctp-text)',
                        fontFamily: 'monospace',
                        fontSize: '12px'
                      }}
                    />
                    <div style={{ fontSize: '11px', color: 'var(--ctp-subtext0)' }}>
                      {t('automation.auto_traceroute.regex_help')}
                    </div>
                  </div>
                )}
              </div>
              </div>

              {/* Right column: Matching nodes preview */}
              <div style={{
                width: '280px',
                flexShrink: 0,
                background: 'var(--ctp-base)',
                border: '1px solid var(--ctp-surface2)',
                borderRadius: '6px',
                display: 'flex',
                flexDirection: 'column'
              }}>
                <div style={{
                  padding: '0.5rem 0.75rem',
                  borderBottom: '1px solid var(--ctp-surface2)',
                  background: 'var(--ctp-surface1)',
                  borderRadius: '6px 6px 0 0',
                  fontSize: '13px',
                  fontWeight: 500
                }}>
                  {t('automation.auto_traceroute.matching_nodes', { count: debouncedMatchingNodes.length })} / {availableNodes.length} {t('common.total')}
                </div>
                <div style={{
                  flex: 1,
                  overflowY: 'auto',
                  maxHeight: '400px',
                  padding: '0.25rem'
                }}>
                  {debouncedMatchingNodes.length === 0 ? (
                    <div style={{
                      padding: '1rem',
                      textAlign: 'center',
                      color: 'var(--ctp-subtext0)',
                      fontSize: '12px'
                    }}>
                      {t('automation.auto_traceroute.no_nodes_match_filters')}
                    </div>
                  ) : (
                    debouncedMatchingNodes.map(node => (
                      <div
                        key={node.nodeNum}
                        style={{
                          padding: '0.35rem 0.5rem',
                          borderBottom: '1px solid var(--ctp-surface1)',
                          fontSize: '12px',
                          color: 'var(--ctp-text)',
                          whiteSpace: 'nowrap',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis'
                        }}
                        title={node.user?.longName || node.longName || node.user?.shortName || node.shortName || node.nodeId || 'Unknown'}
                      >
                        {node.user?.longName || node.longName || node.user?.shortName || node.shortName || node.nodeId || 'Unknown'}
                      </div>
                    ))
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  );
};

export default AutoTracerouteSection;
