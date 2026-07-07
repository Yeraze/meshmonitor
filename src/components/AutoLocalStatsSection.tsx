import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useToast } from './ToastContainer';
import { useCsrfFetch } from '../hooks/useCsrfFetch';
import { useSourceQuery } from '../hooks/useSourceQuery';
import { DEVICE_ROLES } from '../utils/deviceRole';
import { useSaveBar } from '../hooks/useSaveBar';

interface AutoLocalStatsSectionProps {
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
  hopsAway?: number;
  role?: number;
  isFavorite?: boolean;
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
  filterRoles: number[];
  filterNameRegex: string;
  filterNodesEnabled: boolean;
  filterRolesEnabled: boolean;
  filterFavoriteEnabled: boolean;
  filterRegexEnabled: boolean;
  filterLastHeardEnabled: boolean;
  filterLastHeardHours: number;
  scheduleEnabled: boolean;
  scheduleStart: string;
  scheduleEnd: string;
}

const DEFAULT_INTERVAL = 60;

const AutoLocalStatsSection: React.FC<AutoLocalStatsSectionProps> = ({
  intervalMinutes,
  baseUrl,
  onIntervalChange,
}) => {
  const { t } = useTranslation();
  const csrfFetch = useCsrfFetch();
  const sourceQuery = useSourceQuery();
  const { showToast } = useToast();
  const [localEnabled, setLocalEnabled] = useState(intervalMinutes > 0);
  const [localInterval, setLocalInterval] = useState(intervalMinutes > 0 ? intervalMinutes : DEFAULT_INTERVAL);
  const [hasChanges, setHasChanges] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  // Node filter states
  const [filterEnabled, setFilterEnabled] = useState(false);
  const [selectedNodeNums, setSelectedNodeNums] = useState<number[]>([]);
  const [filterRoles, setFilterRoles] = useState<number[]>([]);
  const [filterNameRegex, setFilterNameRegex] = useState('.*');

  // Individual filter enabled flags
  const [filterNodesEnabled, setFilterNodesEnabled] = useState(true);
  const [filterRolesEnabled, setFilterRolesEnabled] = useState(true);
  const [filterFavoriteEnabled, setFilterFavoriteEnabled] = useState(false);
  const [filterRegexEnabled, setFilterRegexEnabled] = useState(true);

  // Last heard filter
  const [filterLastHeardEnabled, setFilterLastHeardEnabled] = useState(true);
  const [filterLastHeardHours, setFilterLastHeardHours] = useState(168);

  // Schedule time window
  const [scheduleEnabled, setScheduleEnabled] = useState(false);
  const [scheduleStart, setScheduleStart] = useState('00:00');
  const [scheduleEnd, setScheduleEnd] = useState('00:00');

  const [availableNodes, setAvailableNodes] = useState<Node[]>([]);
  const [searchTerm, setSearchTerm] = useState('');

  const [initialSettings, setInitialSettings] = useState<FilterSettings | null>(null);
  // Per-source interval baseline (the interval is stored per-source, so the
  // global prop can read 0 even when a per-source value is set — see #2914).
  const [initialInterval, setInitialInterval] = useState<number | null>(null);

  const [expandedSections, setExpandedSections] = useState({
    nodes: false,
    roles: false,
    regex: false,
    lastHeard: false,
  });

  // Sync local state from the prop until the per-source GET resolves.
  useEffect(() => {
    if (initialInterval !== null) return;
    setLocalEnabled(intervalMinutes > 0);
    setLocalInterval(intervalMinutes > 0 ? intervalMinutes : DEFAULT_INTERVAL);
  }, [intervalMinutes, initialInterval]);

  // Fetch available nodes
  useEffect(() => {
    const fetchNodes = async () => {
      try {
        const response = await csrfFetch(`${baseUrl}/api/nodes${sourceQuery}`);
        if (response.ok) {
          setAvailableNodes(await response.json());
        }
      } catch (error) {
        console.error('Failed to fetch nodes:', error);
      }
    };
    void fetchNodes();
  }, [baseUrl, csrfFetch, sourceQuery]);

  // Fetch filter + general settings together
  useEffect(() => {
    const fetchAllSettings = async () => {
      try {
        const [filterResponse, settingsResponse] = await Promise.all([
          csrfFetch(`${baseUrl}/api/settings/remote-localstats-nodes${sourceQuery}`),
          csrfFetch(`${baseUrl}/api/settings${sourceQuery}`),
        ]);

        if (!filterResponse.ok) return;
        const data: FilterSettings = await filterResponse.json();
        setFilterEnabled(data.enabled);
        setSelectedNodeNums(data.nodeNums || []);
        setFilterRoles(data.filterRoles || []);
        setFilterNameRegex(data.filterNameRegex || '.*');
        setFilterNodesEnabled(data.filterNodesEnabled !== false);
        setFilterRolesEnabled(data.filterRolesEnabled !== false);
        setFilterFavoriteEnabled(data.filterFavoriteEnabled === true);
        setFilterRegexEnabled(data.filterRegexEnabled !== false);
        setFilterLastHeardEnabled(data.filterLastHeardEnabled !== false);
        setFilterLastHeardHours(data.filterLastHeardHours || 168);

        let schedEnabled = false;
        let schedStart = '00:00';
        let schedEnd = '00:00';
        let persistedInterval: number | null = null;
        if (settingsResponse.ok) {
          const settingsData = await settingsResponse.json();
          schedEnabled = settingsData.remoteLocalStatsScheduleEnabled === 'true';
          schedStart = settingsData.remoteLocalStatsScheduleStart || '00:00';
          schedEnd = settingsData.remoteLocalStatsScheduleEnd || '00:00';
          if (settingsData.remoteLocalStatsIntervalMinutes !== undefined) {
            const parsed = parseInt(String(settingsData.remoteLocalStatsIntervalMinutes), 10);
            if (!isNaN(parsed) && parsed >= 0) persistedInterval = parsed;
          }
        }
        setScheduleEnabled(schedEnabled);
        setScheduleStart(schedStart);
        setScheduleEnd(schedEnd);

        const baselineInterval = persistedInterval ?? intervalMinutes;
        setInitialInterval(baselineInterval);
        setLocalEnabled(baselineInterval > 0);
        setLocalInterval(baselineInterval > 0 ? baselineInterval : DEFAULT_INTERVAL);

        setInitialSettings({
          ...data,
          scheduleEnabled: schedEnabled,
          scheduleStart: schedStart,
          scheduleEnd: schedEnd,
        });
      } catch (error) {
        console.error('Failed to fetch remote LocalStats settings:', error);
      }
    };
    void fetchAllSettings();
  }, [baseUrl, csrfFetch, sourceQuery]);

  // Reset baselines when the source changes.
  useEffect(() => {
    setInitialSettings(null);
    setInitialInterval(null);
  }, [sourceQuery]);

  // Change detection
  useEffect(() => {
    if (!initialSettings) return;
    const currentInterval = localEnabled ? localInterval : 0;
    const baselineInterval = initialInterval ?? intervalMinutes;
    const sortedEq = (a: number[], b: number[]) =>
      JSON.stringify([...a].sort()) === JSON.stringify([...(b || [])].sort());

    const changed =
      currentInterval !== baselineInterval ||
      filterEnabled !== initialSettings.enabled ||
      !sortedEq(selectedNodeNums, initialSettings.nodeNums || []) ||
      !sortedEq(filterRoles, initialSettings.filterRoles || []) ||
      filterNameRegex !== (initialSettings.filterNameRegex || '.*') ||
      filterNodesEnabled !== (initialSettings.filterNodesEnabled !== false) ||
      filterRolesEnabled !== (initialSettings.filterRolesEnabled !== false) ||
      filterFavoriteEnabled !== (initialSettings.filterFavoriteEnabled === true) ||
      filterRegexEnabled !== (initialSettings.filterRegexEnabled !== false) ||
      filterLastHeardEnabled !== (initialSettings.filterLastHeardEnabled !== false) ||
      filterLastHeardHours !== (initialSettings.filterLastHeardHours || 168) ||
      scheduleEnabled !== (initialSettings.scheduleEnabled || false) ||
      scheduleStart !== (initialSettings.scheduleStart || '00:00') ||
      scheduleEnd !== (initialSettings.scheduleEnd || '00:00');
    setHasChanges(changed);
  }, [localEnabled, localInterval, intervalMinutes, initialInterval, filterEnabled, selectedNodeNums, filterRoles, filterNameRegex,
      filterNodesEnabled, filterRolesEnabled, filterFavoriteEnabled, filterRegexEnabled,
      filterLastHeardEnabled, filterLastHeardHours, scheduleEnabled, scheduleStart, scheduleEnd, initialSettings]);

  const resetChanges = useCallback(() => {
    const baselineInterval = initialInterval ?? intervalMinutes;
    setLocalEnabled(baselineInterval > 0);
    setLocalInterval(baselineInterval > 0 ? baselineInterval : DEFAULT_INTERVAL);
    if (initialSettings) {
      setFilterEnabled(initialSettings.enabled);
      setSelectedNodeNums(initialSettings.nodeNums || []);
      setFilterRoles(initialSettings.filterRoles || []);
      setFilterNameRegex(initialSettings.filterNameRegex || '.*');
      setFilterNodesEnabled(initialSettings.filterNodesEnabled !== false);
      setFilterRolesEnabled(initialSettings.filterRolesEnabled !== false);
      setFilterFavoriteEnabled(initialSettings.filterFavoriteEnabled === true);
      setFilterRegexEnabled(initialSettings.filterRegexEnabled !== false);
      setFilterLastHeardEnabled(initialSettings.filterLastHeardEnabled !== false);
      setFilterLastHeardHours(initialSettings.filterLastHeardHours || 168);
      setScheduleEnabled(initialSettings.scheduleEnabled || false);
      setScheduleStart(initialSettings.scheduleStart || '00:00');
      setScheduleEnd(initialSettings.scheduleEnd || '00:00');
    }
  }, [intervalMinutes, initialInterval, initialSettings]);

  const getNodeRole = (node: Node): number | undefined => {
    if (node.role !== undefined && node.role !== null) return node.role;
    if (node.user?.role !== undefined && node.user?.role !== null) {
      return typeof node.user.role === 'string' ? parseInt(node.user.role) : undefined;
    }
    return undefined;
  };

  const availableRolesInNodes = useMemo(() => {
    const roles = new Set<number>();
    availableNodes.forEach(node => {
      const role = getNodeRole(node);
      if (role !== undefined) roles.add(role);
    });
    return Array.from(roles).sort((a, b) => a - b);
  }, [availableNodes]);

  // Preview of nodes matching the current filters (mirrors backend union logic)
  const matchingNodes = useMemo(() => {
    if (!filterEnabled) return [];

    let candidatePool = availableNodes;
    if (filterLastHeardEnabled) {
      const cutoff = Math.floor(Date.now() / 1000) - (filterLastHeardHours * 3600);
      candidatePool = candidatePool.filter(n => n.lastHeard != null && n.lastHeard >= cutoff);
    }

    let regexMatcher: RegExp | null = null;
    if (filterRegexEnabled && filterNameRegex && filterNameRegex !== '.*') {
      try { regexMatcher = new RegExp(filterNameRegex, 'i'); } catch { /* invalid */ }
    }
    const hasAnyFilter =
      (filterNodesEnabled && selectedNodeNums.length > 0) ||
      (filterRolesEnabled && filterRoles.length > 0) ||
      filterFavoriteEnabled ||
      (filterRegexEnabled && regexMatcher !== null);

    if (!hasAnyFilter) return candidatePool;

    return candidatePool.filter(n => {
      if (filterNodesEnabled && selectedNodeNums.includes(n.nodeNum)) return true;
      if (filterRolesEnabled && filterRoles.length > 0) {
        const role = getNodeRole(n);
        if (role !== undefined && filterRoles.includes(role)) return true;
      }
      if (filterFavoriteEnabled && n.isFavorite === true) return true;
      if (filterRegexEnabled && regexMatcher !== null) {
        const name = n.longName || n.user?.longName || n.shortName || n.user?.shortName || n.nodeId || '';
        if (regexMatcher.test(name)) return true;
      }
      return false;
    });
  }, [filterEnabled, selectedNodeNums, filterRoles, filterNameRegex, availableNodes,
      filterNodesEnabled, filterRolesEnabled, filterFavoriteEnabled, filterRegexEnabled,
      filterLastHeardEnabled, filterLastHeardHours]);

  const [debouncedMatchingNodes, setDebouncedMatchingNodes] = useState<Node[]>([]);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    debounceTimerRef.current = setTimeout(() => setDebouncedMatchingNodes(matchingNodes), 1000);
    return () => { if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current); };
  }, [matchingNodes]);

  const handleSaveForSaveBar = useCallback(async () => {
    setIsSaving(true);
    try {
      const intervalToSave = localEnabled ? localInterval : 0;
      const intervalResponse = await csrfFetch(`${baseUrl}/api/settings${sourceQuery}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          remoteLocalStatsIntervalMinutes: intervalToSave,
          remoteLocalStatsScheduleEnabled: scheduleEnabled.toString(),
          remoteLocalStatsScheduleStart: scheduleStart,
          remoteLocalStatsScheduleEnd: scheduleEnd,
        })
      });
      if (!intervalResponse.ok) {
        if (intervalResponse.status === 403) { showToast(t('automation.insufficient_permissions'), 'error'); return; }
        throw new Error(`Server returned ${intervalResponse.status}`);
      }

      const filterResponse = await csrfFetch(`${baseUrl}/api/settings/remote-localstats-nodes${sourceQuery}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          enabled: filterEnabled,
          nodeNums: selectedNodeNums,
          filterRoles,
          filterNameRegex,
          filterNodesEnabled,
          filterRolesEnabled,
          filterFavoriteEnabled,
          filterRegexEnabled,
          filterLastHeardEnabled,
          filterLastHeardHours,
        })
      });
      if (!filterResponse.ok) {
        if (filterResponse.status === 403) { showToast(t('automation.insufficient_permissions'), 'error'); return; }
        throw new Error(`Server returned ${filterResponse.status}`);
      }

      onIntervalChange(intervalToSave);
      setInitialInterval(intervalToSave);
      setInitialSettings({
        enabled: filterEnabled,
        nodeNums: selectedNodeNums,
        filterRoles,
        filterNameRegex,
        filterNodesEnabled,
        filterRolesEnabled,
        filterFavoriteEnabled,
        filterRegexEnabled,
        filterLastHeardEnabled,
        filterLastHeardHours,
        scheduleEnabled,
        scheduleStart,
        scheduleEnd,
      });
      setHasChanges(false);
      showToast(t('automation.auto_localstats.settings_saved_restart'), 'success');
    } catch (error) {
      console.error('Failed to save remote LocalStats settings:', error);
      showToast(t('automation.settings_save_failed'), 'error');
    } finally {
      setIsSaving(false);
    }
  }, [localEnabled, localInterval, filterEnabled, selectedNodeNums, filterRoles, filterNameRegex,
      filterNodesEnabled, filterRolesEnabled, filterFavoriteEnabled, filterRegexEnabled,
      filterLastHeardEnabled, filterLastHeardHours, scheduleEnabled, scheduleStart, scheduleEnd,
      baseUrl, csrfFetch, showToast, t, onIntervalChange, sourceQuery]);

  useSaveBar({
    id: 'auto-localstats',
    sectionName: t('automation.auto_localstats.title'),
    hasChanges,
    isSaving,
    onSave: handleSaveForSaveBar,
    onDismiss: resetChanges
  });

  const filteredNodes = useMemo(() => {
    if (!searchTerm.trim()) return availableNodes;
    const lowerSearch = searchTerm.toLowerCase().trim();
    return availableNodes.filter(node => {
      const longName = (node.user?.longName || node.longName || '').toLowerCase();
      const shortName = (node.user?.shortName || node.shortName || '').toLowerCase();
      const nodeId = (node.user?.id || node.nodeId || '').toLowerCase();
      return longName.includes(lowerSearch) || shortName.includes(lowerSearch) || nodeId.includes(lowerSearch);
    });
  }, [availableNodes, searchTerm]);

  const handleNodeToggle = (nodeNum: number) => {
    setSelectedNodeNums(prev => prev.includes(nodeNum) ? prev.filter(n => n !== nodeNum) : [...prev, nodeNum]);
  };
  const handleSelectAll = () => setSelectedNodeNums(Array.from(new Set([...selectedNodeNums, ...filteredNodes.map(n => n.nodeNum)])));
  const handleDeselectAll = () => {
    const filteredNums = new Set(filteredNodes.map(n => n.nodeNum));
    setSelectedNodeNums(selectedNodeNums.filter(num => !filteredNums.has(num)));
  };
  const toggleSection = (section: keyof typeof expandedSections) => setExpandedSections(prev => ({ ...prev, [section]: !prev[section] }));
  const toggleRole = (value: number) => setFilterRoles(prev => prev.includes(value) ? prev.filter(v => v !== value) : [...prev, value]);

  const sectionHeaderStyle: React.CSSProperties = {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    padding: '0.5rem 0.75rem', background: 'var(--ctp-surface0)',
    border: '1px solid var(--ctp-surface2)', borderRadius: '4px', cursor: 'pointer', marginBottom: '0.5rem',
  };
  const badgeStyle: React.CSSProperties = {
    background: 'var(--ctp-blue)', color: 'var(--ctp-base)',
    padding: '0.1rem 0.5rem', borderRadius: '10px', fontSize: '11px', fontWeight: '600',
  };

  return (
    <>
      <div className="automation-section-header" style={{
        display: 'flex', alignItems: 'center', marginBottom: '1.5rem',
        padding: '1rem 1.25rem', background: 'var(--ctp-surface1)',
        border: '1px solid var(--ctp-surface2)', borderRadius: '8px'
      }}>
        <h2 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          <input
            type="checkbox"
            checked={localEnabled}
            onChange={(e) => setLocalEnabled(e.target.checked)}
            style={{ width: 'auto', margin: 0, cursor: 'pointer' }}
          />
          {t('automation.auto_localstats.title')}
          <a
            href="https://meshmonitor.org/features/automation#auto-localstats"
            target="_blank"
            rel="noopener noreferrer"
            style={{ fontSize: '1.2rem', color: '#89b4fa', textDecoration: 'none', marginLeft: '0.5rem' }}
            title={t('automation.view_docs')}
          >
            ?
          </a>
        </h2>
      </div>

      <div className="settings-section" style={{ opacity: localEnabled ? 1 : 0.5, transition: 'opacity 0.2s' }}>
        <p style={{ marginBottom: '1rem', color: '#666', lineHeight: '1.5', marginLeft: '1.75rem' }}>
          {t('automation.auto_localstats.description')}
        </p>

        <div className="setting-item" style={{ marginTop: '1rem' }}>
          <label htmlFor="remoteLocalStatsInterval">
            {t('automation.auto_localstats.interval')}
            <span className="setting-description">{t('automation.auto_localstats.interval_description')}</span>
          </label>
          <input
            id="remoteLocalStatsInterval"
            type="number"
            min="5"
            max="1440"
            value={localInterval}
            onChange={(e) => setLocalInterval(Math.max(5, parseInt(e.target.value) || 5))}
            disabled={!localEnabled}
            className="setting-input"
          />
        </div>

        {/* Schedule Time Window */}
        <div className="setting-item" style={{ marginTop: '1rem' }}>
          <div style={{ display: 'flex', alignItems: 'center' }}>
            <input
              type="checkbox"
              id="remoteLocalStatsScheduleEnabled"
              checked={scheduleEnabled}
              onChange={(e) => setScheduleEnabled(e.target.checked)}
              disabled={!localEnabled}
              style={{ width: 'auto', margin: 0, marginRight: '0.5rem', cursor: 'pointer' }}
            />
            <label htmlFor="remoteLocalStatsScheduleEnabled" style={{ margin: 0, cursor: 'pointer' }}>
              {t('automation.auto_localstats.schedule_window')}
              <span className="setting-description" style={{ display: 'block', marginTop: '0.25rem' }}>
                {t('automation.auto_localstats.schedule_window_description')}
              </span>
            </label>
          </div>
          {scheduleEnabled && localEnabled && (
            <div style={{ display: 'flex', gap: '1rem', marginTop: '0.75rem', marginLeft: '1.75rem', alignItems: 'center' }}>
              <label style={{ margin: 0, fontSize: '13px' }}>
                {t('automation.schedule.starting_at')}
                <input type="time" value={scheduleStart} onChange={(e) => setScheduleStart(e.target.value)} style={{ marginLeft: '0.5rem' }} className="setting-input" />
              </label>
              <label style={{ margin: 0, fontSize: '13px' }}>
                {t('automation.schedule.ending_at')}
                <input type="time" value={scheduleEnd} onChange={(e) => setScheduleEnd(e.target.value)} style={{ marginLeft: '0.5rem' }} className="setting-input" />
              </label>
            </div>
          )}
        </div>

        {/* Node Filter Section */}
        <div className="setting-item" style={{ marginTop: '2rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', marginBottom: '0.75rem' }}>
            <input
              type="checkbox"
              id="remoteLocalStatsNodeFilter"
              checked={filterEnabled}
              onChange={(e) => setFilterEnabled(e.target.checked)}
              disabled={!localEnabled}
              style={{ width: 'auto', margin: 0, marginRight: '0.5rem', cursor: 'pointer' }}
            />
            <label htmlFor="remoteLocalStatsNodeFilter" style={{ margin: 0, cursor: 'pointer' }}>
              {t('automation.auto_localstats.limit_to_nodes')}
              <span className="setting-description" style={{ display: 'block', marginTop: '0.25rem' }}>
                {t('automation.auto_localstats.filter_description')}
              </span>
            </label>
          </div>

          {filterEnabled && localEnabled && (
            <div style={{
              marginTop: '1rem', marginLeft: '1.75rem', padding: '1rem',
              background: 'var(--ctp-surface0)', border: '1px solid var(--ctp-surface2)',
              borderRadius: '6px', display: 'flex', gap: '1rem'
            }}>
              <div style={{ flex: 1, minWidth: 0 }}>

                {/* Specific Nodes Filter */}
                <div style={{ marginBottom: '0.5rem', opacity: filterNodesEnabled ? 1 : 0.5, transition: 'opacity 0.2s' }}>
                  <div style={sectionHeaderStyle} onClick={() => toggleSection('nodes')}>
                    <span style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                      <input type="checkbox" checked={filterNodesEnabled}
                        onChange={(e) => { e.stopPropagation(); setFilterNodesEnabled(e.target.checked); }}
                        onClick={(e) => e.stopPropagation()} style={{ width: 'auto', margin: 0, cursor: 'pointer' }} />
                      <span>{expandedSections.nodes ? '▼' : '▶'}</span>
                      {t('automation.auto_localstats.specific_nodes')}
                      {filterNodesEnabled && selectedNodeNums.length > 0 && (<span style={badgeStyle}>{selectedNodeNums.length}</span>)}
                    </span>
                  </div>
                  {expandedSections.nodes && (
                    <div style={{ padding: '0.5rem', background: 'var(--ctp-base)', borderRadius: '4px' }}>
                      <input type="text" placeholder={t('automation.auto_localstats.search_nodes')} value={searchTerm}
                        onChange={(e) => setSearchTerm(e.target.value)}
                        style={{ width: '100%', padding: '0.5rem', marginBottom: '0.5rem', background: 'var(--ctp-surface0)', border: '1px solid var(--ctp-surface2)', borderRadius: '4px', color: 'var(--ctp-text)' }} />
                      <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '0.5rem' }}>
                        <button onClick={handleSelectAll} className="btn-secondary" style={{ padding: '0.3rem 0.6rem', fontSize: '11px' }}>{t('common.select_all')}</button>
                        <button onClick={handleDeselectAll} className="btn-secondary" style={{ padding: '0.3rem 0.6rem', fontSize: '11px' }}>{t('common.deselect_all')}</button>
                      </div>
                      <div style={{ maxHeight: '200px', overflowY: 'auto', border: '1px solid var(--ctp-surface2)', borderRadius: '4px' }}>
                        {filteredNodes.length === 0 ? (
                          <div style={{ padding: '0.5rem', textAlign: 'center', color: 'var(--ctp-subtext0)', fontSize: '12px' }}>
                            {searchTerm ? t('automation.auto_localstats.no_nodes_match') : t('automation.auto_localstats.no_nodes_available')}
                          </div>
                        ) : (
                          filteredNodes.map(node => (
                            <div key={node.nodeNum}
                              style={{ padding: '0.4rem 0.6rem', borderBottom: '1px solid var(--ctp-surface1)', display: 'flex', alignItems: 'center', cursor: 'pointer', fontSize: '12px' }}
                              onClick={() => handleNodeToggle(node.nodeNum)}>
                              <input type="checkbox" checked={selectedNodeNums.includes(node.nodeNum)}
                                onChange={() => handleNodeToggle(node.nodeNum)} onClick={(e) => e.stopPropagation()}
                                style={{ width: 'auto', margin: 0, marginRight: '0.5rem', cursor: 'pointer' }} />
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

                {/* Role Filter */}
                <div style={{ marginBottom: '0.5rem', opacity: filterRolesEnabled ? 1 : 0.5, transition: 'opacity 0.2s' }}>
                  <div style={sectionHeaderStyle} onClick={() => toggleSection('roles')}>
                    <span style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                      <input type="checkbox" checked={filterRolesEnabled}
                        onChange={(e) => { e.stopPropagation(); setFilterRolesEnabled(e.target.checked); }}
                        onClick={(e) => e.stopPropagation()} style={{ width: 'auto', margin: 0, cursor: 'pointer' }} />
                      <span>{expandedSections.roles ? '▼' : '▶'}</span>
                      {t('automation.auto_localstats.filter_by_role')}
                      {filterRolesEnabled && filterRoles.length > 0 && (<span style={badgeStyle}>{filterRoles.length}</span>)}
                    </span>
                  </div>
                  {expandedSections.roles && (
                    <div style={{ padding: '0.5rem', background: 'var(--ctp-base)', borderRadius: '4px', display: 'flex', flexWrap: 'wrap', gap: '0.5rem' }}>
                      {availableRolesInNodes.length === 0 ? (
                        <span style={{ color: 'var(--ctp-subtext0)', fontSize: '12px' }}>{t('automation.auto_localstats.no_roles_available')}</span>
                      ) : (
                        availableRolesInNodes.map(roleNum => {
                          const count = availableNodes.filter(n => getNodeRole(n) === roleNum).length;
                          const roleName = DEVICE_ROLES[roleNum] || `Role ${roleNum}`;
                          return (
                            <label key={roleNum} style={{ display: 'flex', alignItems: 'center', gap: '0.25rem', cursor: 'pointer', fontSize: '12px' }}>
                              <input type="checkbox" checked={filterRoles.includes(roleNum)} onChange={() => toggleRole(roleNum)} style={{ width: 'auto', margin: 0 }} />
                              {roleName} ({count})
                            </label>
                          );
                        })
                      )}
                    </div>
                  )}
                </div>

                {/* Favorite Filter (toggle, no sub-options) */}
                <div style={{ marginBottom: '0.5rem' }}>
                  <div style={sectionHeaderStyle}>
                    <span style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                      <input type="checkbox" checked={filterFavoriteEnabled}
                        onChange={(e) => setFilterFavoriteEnabled(e.target.checked)}
                        style={{ width: 'auto', margin: 0, cursor: 'pointer' }} />
                      {t('automation.auto_localstats.filter_by_favorite')}
                    </span>
                  </div>
                </div>

                {/* Name Regex Filter */}
                <div style={{ marginBottom: '0.5rem', opacity: filterRegexEnabled ? 1 : 0.5, transition: 'opacity 0.2s' }}>
                  <div style={sectionHeaderStyle} onClick={() => toggleSection('regex')}>
                    <span style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                      <input type="checkbox" checked={filterRegexEnabled}
                        onChange={(e) => { e.stopPropagation(); setFilterRegexEnabled(e.target.checked); }}
                        onClick={(e) => e.stopPropagation()} style={{ width: 'auto', margin: 0, cursor: 'pointer' }} />
                      <span>{expandedSections.regex ? '▼' : '▶'}</span>
                      {t('automation.auto_localstats.filter_by_name')}
                      {filterRegexEnabled && filterNameRegex !== '.*' && (<span style={badgeStyle}>1</span>)}
                    </span>
                  </div>
                  {expandedSections.regex && (
                    <div style={{ padding: '0.5rem', background: 'var(--ctp-base)', borderRadius: '4px' }}>
                      <input type="text" value={filterNameRegex} onChange={(e) => setFilterNameRegex(e.target.value)} placeholder=".*"
                        style={{ width: '100%', padding: '0.5rem', marginBottom: '0.25rem', background: 'var(--ctp-surface0)', border: '1px solid var(--ctp-surface2)', borderRadius: '4px', color: 'var(--ctp-text)', fontFamily: 'monospace', fontSize: '12px' }} />
                      <div style={{ fontSize: '11px', color: 'var(--ctp-subtext0)' }}>{t('automation.auto_localstats.regex_help')}</div>
                    </div>
                  )}
                </div>

                {/* Last Heard Filter */}
                <div style={{ marginBottom: '0.5rem', opacity: filterLastHeardEnabled ? 1 : 0.5, transition: 'opacity 0.2s' }}>
                  <div style={sectionHeaderStyle} onClick={() => toggleSection('lastHeard')}>
                    <span style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                      <input type="checkbox" checked={filterLastHeardEnabled}
                        onChange={(e) => { e.stopPropagation(); setFilterLastHeardEnabled(e.target.checked); }}
                        onClick={(e) => e.stopPropagation()} style={{ width: 'auto', margin: 0, cursor: 'pointer' }} />
                      <span>{expandedSections.lastHeard ? '▼' : '▶'}</span>
                      {t('automation.auto_localstats.filter_by_last_heard')}
                      {filterLastHeardEnabled && (<span style={badgeStyle}>{filterLastHeardHours}h</span>)}
                    </span>
                  </div>
                  {expandedSections.lastHeard && (
                    <div style={{ padding: '0.5rem', background: 'var(--ctp-base)', borderRadius: '4px' }}>
                      <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '12px' }}>
                        {t('automation.auto_localstats.last_heard_within')}
                        <input type="number" value={filterLastHeardHours}
                          onChange={(e) => setFilterLastHeardHours(Math.max(1, parseInt(e.target.value) || 1))}
                          min={1} style={{ width: '80px', padding: '2px 4px' }} />
                        {t('automation.auto_localstats.hours')}
                      </label>
                    </div>
                  )}
                </div>
              </div>

              {/* Right column: matching nodes preview */}
              <div style={{ width: '280px', flexShrink: 0, background: 'var(--ctp-base)', border: '1px solid var(--ctp-surface2)', borderRadius: '6px', display: 'flex', flexDirection: 'column' }}>
                <div style={{ padding: '0.5rem 0.75rem', borderBottom: '1px solid var(--ctp-surface2)', background: 'var(--ctp-surface1)', borderRadius: '6px 6px 0 0', fontSize: '13px', fontWeight: 500 }}>
                  {t('automation.auto_localstats.matching_nodes', { count: debouncedMatchingNodes.length })} / {availableNodes.length} {t('common.total')}
                </div>
                <div style={{ flex: 1, overflowY: 'auto', maxHeight: '400px', padding: '0.25rem' }}>
                  {debouncedMatchingNodes.length === 0 ? (
                    <div style={{ padding: '1rem', textAlign: 'center', color: 'var(--ctp-subtext0)', fontSize: '12px' }}>
                      {t('automation.auto_localstats.no_nodes_match_filters')}
                    </div>
                  ) : (
                    debouncedMatchingNodes.map(node => (
                      <div key={node.nodeNum}
                        style={{ padding: '0.35rem 0.5rem', borderBottom: '1px solid var(--ctp-surface1)', fontSize: '12px', color: 'var(--ctp-text)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}
                        title={node.user?.longName || node.longName || node.user?.shortName || node.shortName || node.nodeId || 'Unknown'}>
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

export default AutoLocalStatsSection;
