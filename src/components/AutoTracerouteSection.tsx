import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useToast } from './ToastContainer';
import { useCsrfFetch } from '../hooks/useCsrfFetch';
import { useSourceQuery } from '../hooks/useSourceQuery';
import { DEVICE_ROLES } from '../utils/deviceRole';
import { getHardwareModelName } from '../utils/hardwareModel';
import { useSaveBar } from '../hooks/useSaveBar';

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
  filterLastHeardEnabled: boolean;
  filterLastHeardHours: number;
  filterHopsEnabled: boolean;
  filterHopsMin: number;
  filterHopsMax: number;
  expirationHours: number;
  sortByHops: boolean;
  scheduleEnabled: boolean;
  scheduleStart: string;
  scheduleEnd: string;
}

interface TracerouteLogEntry {
  id: number;
  timestamp: number;
  toNodeNum: number;
  toNodeName: string | null;
  success: boolean | null;
}

const AutoTracerouteSection: React.FC<AutoTracerouteSectionProps> = ({
  intervalMinutes,
  baseUrl,
  onIntervalChange,
}) => {
  const { t } = useTranslation();
  const csrfFetch = useCsrfFetch();
  const sourceQuery = useSourceQuery();
  const { showToast } = useToast();
  const [localEnabled, setLocalEnabled] = useState(intervalMinutes > 0);
  const [localInterval, setLocalInterval] = useState(intervalMinutes > 0 ? intervalMinutes : 15);
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

  // Last heard filter
  const [filterLastHeardEnabled, setFilterLastHeardEnabled] = useState(true);
  const [filterLastHeardHours, setFilterLastHeardHours] = useState(168);

  // Hop range filter
  const [filterHopsEnabled, setFilterHopsEnabled] = useState(false);
  const [filterHopsMin, setFilterHopsMin] = useState(0);
  const [filterHopsMax, setFilterHopsMax] = useState(10);

  // Expiration hours - how long before re-tracerouting a node
  const [expirationHours, setExpirationHours] = useState(24);

  // Sort by hops - prioritize closer nodes for traceroute
  const [sortByHops, setSortByHops] = useState(false);

  // Schedule time window
  const [scheduleEnabled, setScheduleEnabled] = useState(false);
  const [scheduleStart, setScheduleStart] = useState('00:00');
  const [scheduleEnd, setScheduleEnd] = useState('00:00');

  // Auto-traceroute log
  const [tracerouteLog, setTracerouteLog] = useState<TracerouteLogEntry[]>([]);

  const [availableNodes, setAvailableNodes] = useState<Node[]>([]);
  const [searchTerm, setSearchTerm] = useState('');

  // Initial state tracking for change detection
  const [initialSettings, setInitialSettings] = useState<FilterSettings | null>(null);

  // Per-source interval baseline (separate from the global `intervalMinutes` prop).
  // The interval is stored as a per-source setting, so the global GET that powers
  // the prop returns 0 even when a per-source value is set — using the prop alone
  // makes the checkbox revert to "off" after reload (#2914).
  const [initialInterval, setInitialInterval] = useState<number | null>(null);

  // Expanded sections state
  const [expandedSections, setExpandedSections] = useState({
    nodes: false,
    channels: false,
    roles: false,
    hwModels: false,
    regex: false,
    lastHeard: false,
    hops: false,
  });

  // Update local state when props change.
  // Skip once the per-source GET has resolved — the per-source value is
  // authoritative and may differ from the global prop (#2914).
  useEffect(() => {
    if (initialInterval !== null) return;
    setLocalEnabled(intervalMinutes > 0);
    setLocalInterval(intervalMinutes > 0 ? intervalMinutes : 15);
  }, [intervalMinutes, initialInterval]);

  // Fetch available nodes
  useEffect(() => {
    const fetchNodes = async () => {
      try {
        const response = await csrfFetch(`${baseUrl}/api/nodes${sourceQuery}`);
        if (response.ok) {
          const data = await response.json();
          setAvailableNodes(data);
        }
      } catch (error) {
        console.error('Failed to fetch nodes:', error);
      }
    };
    fetchNodes();
  }, [baseUrl, csrfFetch, sourceQuery]);

  // Fetch current filter settings and schedule settings together to avoid race conditions
  useEffect(() => {
    const fetchAllSettings = async () => {
      try {
        const [filterResponse, settingsResponse] = await Promise.all([
          csrfFetch(`${baseUrl}/api/settings/traceroute-nodes${sourceQuery}`),
          csrfFetch(`${baseUrl}/api/settings${sourceQuery}`),
        ]);

        if (filterResponse.ok) {
          const data: FilterSettings = await filterResponse.json();
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
          setFilterLastHeardEnabled(data.filterLastHeardEnabled !== false);
          setFilterLastHeardHours(data.filterLastHeardHours || 168);
          setFilterHopsEnabled(data.filterHopsEnabled || false);
          setFilterHopsMin(data.filterHopsMin ?? 0);
          setFilterHopsMax(data.filterHopsMax ?? 10);
          // Load expiration hours (default to 24 if not set)
          setExpirationHours(data.expirationHours || 24);
          // Load sort by hops setting (default to false)
          setSortByHops(data.sortByHops || false);

          // Load schedule settings + per-source interval from general settings
          let schedEnabled = false;
          let schedStart = '00:00';
          let schedEnd = '00:00';
          let persistedInterval: number | null = null;
          if (settingsResponse.ok) {
            const settingsData = await settingsResponse.json();
            schedEnabled = settingsData.tracerouteScheduleEnabled === 'true';
            schedStart = settingsData.tracerouteScheduleStart || '00:00';
            schedEnd = settingsData.tracerouteScheduleEnd || '00:00';
            if (settingsData.tracerouteIntervalMinutes !== undefined) {
              const parsed = parseInt(String(settingsData.tracerouteIntervalMinutes), 10);
              if (!isNaN(parsed) && parsed >= 0) {
                persistedInterval = parsed;
              }
            }
          }
          setScheduleEnabled(schedEnabled);
          setScheduleStart(schedStart);
          setScheduleEnd(schedEnd);

          // Per-source interval is authoritative — apply it before unblocking
          // the prop-sync effect (#2914).
          const baselineInterval = persistedInterval ?? intervalMinutes;
          setInitialInterval(baselineInterval);
          setLocalEnabled(baselineInterval > 0);
          setLocalInterval(baselineInterval > 0 ? baselineInterval : 15);

          // Set initial settings once with all data
          setInitialSettings({
            ...data,
            scheduleEnabled: schedEnabled,
            scheduleStart: schedStart,
            scheduleEnd: schedEnd,
          });
        }
      } catch (error) {
        console.error('Failed to fetch settings:', error);
      }
    };
    fetchAllSettings();
  }, [baseUrl, csrfFetch, sourceQuery]);

  // Reset initial settings when the selected source changes so the
  // SaveBar change-detection compares against the new source's baseline.
  useEffect(() => {
    setInitialSettings(null);
    setInitialInterval(null);
  }, [sourceQuery]);

  // Fetch auto-traceroute log
  useEffect(() => {
    const fetchTracerouteLog = async () => {
      try {
        const response = await csrfFetch(`${baseUrl}/api/settings/traceroute-log${sourceQuery}`);
        if (response.ok) {
          const data = await response.json();
          setTracerouteLog(data.log || []);
        }
      } catch (error) {
        console.error('Failed to fetch traceroute log:', error);
      }
    };

    // Initial fetch
    fetchTracerouteLog();

    // Refresh every 30 seconds if auto-traceroute is enabled
    const intervalId = setInterval(() => {
      if (localEnabled) {
        fetchTracerouteLog();
      }
    }, 30000);

    return () => clearInterval(intervalId);
  }, [baseUrl, csrfFetch, localEnabled, sourceQuery]);

  // Check if any settings have changed
  useEffect(() => {
    if (!initialSettings) return;

    const currentInterval = localEnabled ? localInterval : 0;
    const baselineInterval = initialInterval ?? intervalMinutes;
    const intervalChanged = currentInterval !== baselineInterval;
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
    const filterLastHeardEnabledChanged = filterLastHeardEnabled !== (initialSettings.filterLastHeardEnabled !== false);
    const filterLastHeardHoursChanged = filterLastHeardHours !== (initialSettings.filterLastHeardHours || 168);
    const filterHopsEnabledChanged = filterHopsEnabled !== (initialSettings.filterHopsEnabled || false);
    const filterHopsMinChanged = filterHopsMin !== (initialSettings.filterHopsMin ?? 0);
    const filterHopsMaxChanged = filterHopsMax !== (initialSettings.filterHopsMax ?? 10);

    // Check expiration hours change
    const expirationHoursChanged = expirationHours !== (initialSettings.expirationHours || 24);

    // Check sort by hops change
    const sortByHopsChanged = sortByHops !== (initialSettings.sortByHops || false);

    // Check schedule changes
    const scheduleEnabledChanged = scheduleEnabled !== (initialSettings.scheduleEnabled || false);
    const scheduleStartChanged = scheduleStart !== (initialSettings.scheduleStart || '00:00');
    const scheduleEndChanged = scheduleEnd !== (initialSettings.scheduleEnd || '00:00');

    const changed = intervalChanged || filterEnabledChanged || nodesChanged || channelsChanged || rolesChanged || hwModelsChanged || regexChanged ||
      filterNodesEnabledChanged || filterChannelsEnabledChanged || filterRolesEnabledChanged || filterHwModelsEnabledChanged || filterRegexEnabledChanged ||
      filterLastHeardEnabledChanged || filterLastHeardHoursChanged || filterHopsEnabledChanged || filterHopsMinChanged || filterHopsMaxChanged ||
      expirationHoursChanged || sortByHopsChanged || scheduleEnabledChanged || scheduleStartChanged || scheduleEndChanged;
    setHasChanges(changed);
  }, [localEnabled, localInterval, intervalMinutes, initialInterval, filterEnabled, selectedNodeNums, filterChannels, filterRoles, filterHwModels, filterNameRegex, initialSettings,
      filterNodesEnabled, filterChannelsEnabled, filterRolesEnabled, filterHwModelsEnabled, filterRegexEnabled,
      filterLastHeardEnabled, filterLastHeardHours, filterHopsEnabled, filterHopsMin, filterHopsMax,
      expirationHours, sortByHops,
      scheduleEnabled, scheduleStart, scheduleEnd]);

  // Reset local state to initial settings (used by SaveBar dismiss)
  const resetChanges = useCallback(() => {
    const baselineInterval = initialInterval ?? intervalMinutes;
    setLocalEnabled(baselineInterval > 0);
    setLocalInterval(baselineInterval > 0 ? baselineInterval : 15);
    if (initialSettings) {
      setFilterEnabled(initialSettings.enabled);
      setSelectedNodeNums(initialSettings.nodeNums || []);
      setFilterChannels(initialSettings.filterChannels || []);
      setFilterRoles(initialSettings.filterRoles || []);
      setFilterHwModels(initialSettings.filterHwModels || []);
      setFilterNameRegex(initialSettings.filterNameRegex || '.*');
      setFilterNodesEnabled(initialSettings.filterNodesEnabled !== false);
      setFilterChannelsEnabled(initialSettings.filterChannelsEnabled !== false);
      setFilterRolesEnabled(initialSettings.filterRolesEnabled !== false);
      setFilterHwModelsEnabled(initialSettings.filterHwModelsEnabled !== false);
      setFilterRegexEnabled(initialSettings.filterRegexEnabled !== false);
      setFilterLastHeardEnabled(initialSettings.filterLastHeardEnabled !== false);
      setFilterLastHeardHours(initialSettings.filterLastHeardHours || 168);
      setFilterHopsEnabled(initialSettings.filterHopsEnabled || false);
      setFilterHopsMin(initialSettings.filterHopsMin ?? 0);
      setFilterHopsMax(initialSettings.filterHopsMax ?? 10);
      setExpirationHours(initialSettings.expirationHours || 24);
      setSortByHops(initialSettings.sortByHops || false);
      setScheduleEnabled(initialSettings.scheduleEnabled || false);
      setScheduleStart(initialSettings.scheduleStart || '00:00');
      setScheduleEnd(initialSettings.scheduleEnd || '00:00');
    }
  }, [intervalMinutes, initialInterval, initialSettings]);

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

  const handleSaveForSaveBar = useCallback(async () => {
    setIsSaving(true);
    try {
      const intervalToSave = localEnabled ? localInterval : 0;

      // Save traceroute interval and schedule settings
      const intervalResponse = await csrfFetch(`${baseUrl}/api/settings${sourceQuery}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tracerouteIntervalMinutes: intervalToSave,
          tracerouteScheduleEnabled: scheduleEnabled.toString(),
          tracerouteScheduleStart: scheduleStart,
          tracerouteScheduleEnd: scheduleEnd,
        })
      });

      if (!intervalResponse.ok) {
        if (intervalResponse.status === 403) {
          showToast(t('automation.insufficient_permissions'), 'error');
          return;
        }
        throw new Error(`Server returned ${intervalResponse.status}`);
      }

      // Save node filter settings (scoped to current source)
      const filterResponse = await csrfFetch(`${baseUrl}/api/settings/traceroute-nodes${sourceQuery}`, {
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
          filterLastHeardEnabled,
          filterLastHeardHours,
          filterHopsEnabled,
          filterHopsMin,
          filterHopsMax,
          expirationHours,
          sortByHops,
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
      setInitialInterval(intervalToSave);
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
        filterLastHeardEnabled,
        filterLastHeardHours,
        filterHopsEnabled,
        filterHopsMin,
        filterHopsMax,
        expirationHours,
        sortByHops,
        scheduleEnabled,
        scheduleStart,
        scheduleEnd,
      });

      setHasChanges(false);
      showToast(t('automation.auto_traceroute.settings_saved_restart'), 'success');
    } catch (error) {
      console.error('Failed to save auto-traceroute settings:', error);
      showToast(t('automation.settings_save_failed'), 'error');
    } finally {
      setIsSaving(false);
    }
  }, [localEnabled, localInterval, filterEnabled, selectedNodeNums, filterChannels, filterRoles, filterHwModels, filterNameRegex, filterNodesEnabled, filterChannelsEnabled, filterRolesEnabled, filterHwModelsEnabled, filterRegexEnabled, filterLastHeardEnabled, filterLastHeardHours, filterHopsEnabled, filterHopsMin, filterHopsMax, expirationHours, sortByHops, scheduleEnabled, scheduleStart, scheduleEnd, baseUrl, csrfFetch, showToast, t, onIntervalChange, sourceQuery]);

  // Register with SaveBar
  useSaveBar({
    id: 'auto-traceroute',
    sectionName: t('automation.auto_traceroute.title'),
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
            min="3"
            max="60"
            value={localInterval}
            onChange={(e) => setLocalInterval(Math.max(3, parseInt(e.target.value) || 3))}
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
            min="0"
            max="168"
            value={expirationHours}
            onChange={(e) => setExpirationHours(Math.max(0, parseInt(e.target.value) || 0))}
            disabled={!localEnabled}
            className="setting-input"
          />
        </div>

        {/* Sort by Hops Option */}
        <div className="setting-item" style={{ marginTop: '1rem' }}>
          <div style={{ display: 'flex', alignItems: 'center' }}>
            <input
              type="checkbox"
              id="sortByHops"
              checked={sortByHops}
              onChange={(e) => setSortByHops(e.target.checked)}
              disabled={!localEnabled}
              style={{ width: 'auto', margin: 0, marginRight: '0.5rem', cursor: 'pointer' }}
            />
            <label htmlFor="sortByHops" style={{ margin: 0, cursor: 'pointer' }}>
              {t('automation.auto_traceroute.sort_by_hops')}
              <span className="setting-description" style={{ display: 'block', marginTop: '0.25rem' }}>
                {t('automation.auto_traceroute.sort_by_hops_description')}
              </span>
            </label>
          </div>
        </div>

        {/* Schedule Time Window */}
        <div className="setting-item" style={{ marginTop: '1rem' }}>
          <div style={{ display: 'flex', alignItems: 'center' }}>
            <input
              type="checkbox"
              id="tracerouteScheduleEnabled"
              checked={scheduleEnabled}
              onChange={(e) => setScheduleEnabled(e.target.checked)}
              disabled={!localEnabled}
              style={{ width: 'auto', margin: 0, marginRight: '0.5rem', cursor: 'pointer' }}
            />
            <label htmlFor="tracerouteScheduleEnabled" style={{ margin: 0, cursor: 'pointer' }}>
              {t('automation.auto_traceroute.schedule_window')}
              <span className="setting-description" style={{ display: 'block', marginTop: '0.25rem' }}>
                {t('automation.auto_traceroute.schedule_window_description')}
              </span>
            </label>
          </div>
          {scheduleEnabled && localEnabled && (
            <div style={{ display: 'flex', gap: '1rem', marginTop: '0.75rem', marginLeft: '1.75rem', alignItems: 'center' }}>
              <label style={{ margin: 0, fontSize: '13px' }}>
                {t('automation.schedule.starting_at')}
                <input
                  type="time"
                  value={scheduleStart}
                  onChange={(e) => setScheduleStart(e.target.value)}
                  style={{ marginLeft: '0.5rem' }}
                  className="setting-input"
                />
              </label>
              <label style={{ margin: 0, fontSize: '13px' }}>
                {t('automation.schedule.ending_at')}
                <input
                  type="time"
                  value={scheduleEnd}
                  onChange={(e) => setScheduleEnd(e.target.value)}
                  style={{ marginLeft: '0.5rem' }}
                  className="setting-input"
                />
              </label>
            </div>
          )}
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

              {/* Last Heard Filter */}
              <div style={{ marginBottom: '0.5rem', opacity: filterLastHeardEnabled ? 1 : 0.5, transition: 'opacity 0.2s' }}>
                <div
                  style={sectionHeaderStyle}
                  onClick={() => toggleSection('lastHeard')}
                >
                  <span style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                    <input
                      type="checkbox"
                      checked={filterLastHeardEnabled}
                      onChange={(e) => {
                        e.stopPropagation();
                        setFilterLastHeardEnabled(e.target.checked);
                      }}
                      onClick={(e) => e.stopPropagation()}
                      style={{ width: 'auto', margin: 0, cursor: 'pointer' }}
                    />
                    <span>{expandedSections.lastHeard ? '▼' : '▶'}</span>
                    {t('automation.auto_traceroute.filter_by_last_heard')}
                    {filterLastHeardEnabled && (
                      <span style={badgeStyle}>{filterLastHeardHours}h</span>
                    )}
                  </span>
                </div>
                {expandedSections.lastHeard && (
                  <div style={{ padding: '0.5rem', background: 'var(--ctp-base)', borderRadius: '4px' }}>
                    <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '12px' }}>
                      {t('automation.auto_traceroute.last_heard_within')}
                      <input
                        type="number"
                        value={filterLastHeardHours}
                        onChange={(e) => setFilterLastHeardHours(Math.max(1, parseInt(e.target.value) || 1))}
                        min={1}
                        style={{ width: '80px', padding: '2px 4px' }}
                      />
                      {t('automation.auto_traceroute.hours')}
                    </label>
                  </div>
                )}
              </div>

              {/* Hop Range Filter */}
              <div style={{ marginBottom: '0.5rem', opacity: filterHopsEnabled ? 1 : 0.5, transition: 'opacity 0.2s' }}>
                <div
                  style={sectionHeaderStyle}
                  onClick={() => toggleSection('hops')}
                >
                  <span style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                    <input
                      type="checkbox"
                      checked={filterHopsEnabled}
                      onChange={(e) => {
                        e.stopPropagation();
                        setFilterHopsEnabled(e.target.checked);
                      }}
                      onClick={(e) => e.stopPropagation()}
                      style={{ width: 'auto', margin: 0, cursor: 'pointer' }}
                    />
                    <span>{expandedSections.hops ? '▼' : '▶'}</span>
                    {t('automation.auto_traceroute.filter_by_hops')}
                    {filterHopsEnabled && (
                      <span style={badgeStyle}>{filterHopsMin}-{filterHopsMax}</span>
                    )}
                  </span>
                </div>
                {expandedSections.hops && (
                  <div style={{ padding: '0.5rem', background: 'var(--ctp-base)', borderRadius: '4px', display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '12px' }}>
                    <label style={{ display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
                      {t('automation.auto_traceroute.min_hops')}
                      <input
                        type="number"
                        value={filterHopsMin}
                        onChange={(e) => setFilterHopsMin(Math.max(0, parseInt(e.target.value) || 0))}
                        min={0}
                        max={filterHopsMax}
                        style={{ width: '60px', padding: '2px 4px' }}
                      />
                    </label>
                    <span>—</span>
                    <label style={{ display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
                      {t('automation.auto_traceroute.max_hops')}
                      <input
                        type="number"
                        value={filterHopsMax}
                        onChange={(e) => setFilterHopsMax(Math.max(filterHopsMin, parseInt(e.target.value) || 0))}
                        min={filterHopsMin}
                        style={{ width: '60px', padding: '2px 4px' }}
                      />
                    </label>
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

        {/* Auto-Traceroute Log Section */}
        {localEnabled && (
          <div className="setting-item" style={{ marginTop: '2rem' }}>
            <h4 style={{ marginBottom: '0.75rem', color: 'var(--ctp-text)' }}>
              {t('automation.auto_traceroute.recent_log')}
            </h4>
            <div style={{
              border: '1px solid var(--ctp-surface2)',
              borderRadius: '6px',
              overflow: 'hidden',
              marginLeft: '1.75rem'
            }}>
              {tracerouteLog.length === 0 ? (
                <div style={{
                  padding: '1rem',
                  textAlign: 'center',
                  color: 'var(--ctp-subtext0)',
                  fontSize: '12px'
                }}>
                  {t('automation.auto_traceroute.no_log_entries')}
                </div>
              ) : (
                <table style={{
                  width: '100%',
                  borderCollapse: 'collapse',
                  fontSize: '12px'
                }}>
                  <thead>
                    <tr style={{ background: 'var(--ctp-surface1)' }}>
                      <th style={{ padding: '0.5rem 0.75rem', textAlign: 'left', fontWeight: 500 }}>
                        {t('automation.auto_traceroute.log_timestamp')}
                      </th>
                      <th style={{ padding: '0.5rem 0.75rem', textAlign: 'left', fontWeight: 500 }}>
                        {t('automation.auto_traceroute.log_destination')}
                      </th>
                      <th style={{ padding: '0.5rem 0.75rem', textAlign: 'center', fontWeight: 500 }}>
                        {t('automation.auto_traceroute.log_status')}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {tracerouteLog.map((entry) => (
                      <tr key={entry.id} style={{ borderTop: '1px solid var(--ctp-surface1)' }}>
                        <td style={{ padding: '0.4rem 0.75rem', color: 'var(--ctp-subtext0)' }}>
                          {new Date(entry.timestamp).toLocaleString()}
                        </td>
                        <td style={{ padding: '0.4rem 0.75rem', color: 'var(--ctp-text)' }}>
                          {entry.toNodeName || `!${entry.toNodeNum.toString(16).padStart(8, '0')}`}
                        </td>
                        <td style={{ padding: '0.4rem 0.75rem', textAlign: 'center' }}>
                          {entry.success === null ? (
                            <span style={{
                              color: 'var(--ctp-yellow)',
                              fontSize: '14px'
                            }} title={t('automation.auto_traceroute.status_pending')}>
                              ⏳
                            </span>
                          ) : entry.success ? (
                            <span style={{
                              color: 'var(--ctp-green)',
                              fontSize: '14px'
                            }} title={t('automation.auto_traceroute.status_success')}>
                              ✓
                            </span>
                          ) : (
                            <span style={{
                              color: 'var(--ctp-red)',
                              fontSize: '14px'
                            }} title={t('automation.auto_traceroute.status_failed')}>
                              ✗
                            </span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        )}
      </div>
    </>
  );
};

export default AutoTracerouteSection;
