import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useToast } from './ToastContainer';
import { useCsrfFetch } from '../hooks/useCsrfFetch';
import { useSourceQuery } from '../hooks/useSourceQuery';
import { DEVICE_ROLES } from '../utils/deviceRole';
import { getHardwareModelName } from '../utils/hardwareModel';
import { useSaveBar } from '../hooks/useSaveBar';
import { UiIcon } from './icons';

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
  hopsAway?: number;
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

/**
 * How one filter combines with the others (#5230).
 *
 * `'or'` is the historical behaviour and the default: the filter joins a union,
 * so selecting channels can only ever WIDEN the candidate pool. `'and'` makes
 * it a scope — the node must match it whatever else it matches — which is what
 * "only trace nodes heard on LongTurbo" needs.
 */
type FilterMode = 'or' | 'and';

// Must match CHANNEL_DB_OFFSET in src/server/constants/meshtastic.ts. Channel
// ids at or above it are Channel Database entries, not device channel slots.
const CHANNEL_DB_OFFSET = 100;

/** Coerce a server value to a mode; matches the backend's parse, default 'or'. */
const asFilterMode = (raw: unknown): FilterMode => (raw === 'and' ? 'and' : 'or');

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
  filterNodesMode: FilterMode;
  filterChannelsMode: FilterMode;
  filterRolesMode: FilterMode;
  filterHwModelsMode: FilterMode;
  filterRegexMode: FilterMode;
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

/**
 * Per-filter AND/OR switch (#5230).
 *
 * `OR` keeps the filter in the union — it can only widen the pool. `AND` turns
 * it into a scope the node must also satisfy. Rendered inside the collapsible
 * section header, so clicks are stopped from reaching the collapse handler.
 */
const FilterModeToggle: React.FC<{
  mode: FilterMode;
  onChange: (mode: FilterMode) => void;
  label: string;
  testId: string;
}> = ({ mode, onChange, label, testId }) => (
  <span
    style={{ display: 'inline-flex', border: '1px solid var(--color-surface-active)', borderRadius: '4px', overflow: 'hidden' }}
    onClick={(e) => e.stopPropagation()}
    role="group"
    aria-label={label}
    data-testid={testId}
  >
    {(['or', 'and'] as FilterMode[]).map((m) => (
      <button
        key={m}
        type="button"
        aria-pressed={mode === m}
        onClick={(e) => { e.stopPropagation(); onChange(m); }}
        style={{
          padding: '0 0.35rem',
          fontSize: '10px',
          lineHeight: '16px',
          border: 'none',
          cursor: 'pointer',
          background: mode === m ? 'var(--color-accent)' : 'transparent',
          color: mode === m ? 'var(--color-accent-text)' : 'var(--color-text-subtle)',
        }}
      >
        {m.toUpperCase()}
      </button>
    ))}
  </span>
);

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

  // Per-filter combine mode (#5230). Defaults to 'or' so an install that has
  // never touched these keeps exactly the selection it had before.
  const [filterNodesMode, setFilterNodesMode] = useState<FilterMode>('or');
  const [filterChannelsMode, setFilterChannelsMode] = useState<FilterMode>('or');
  const [filterRolesMode, setFilterRolesMode] = useState<FilterMode>('or');
  const [filterHwModelsMode, setFilterHwModelsMode] = useState<FilterMode>('or');
  const [filterRegexMode, setFilterRegexMode] = useState<FilterMode>('or');

  // nodes.channel -> display name, for the channel picker.
  const [channelNames, setChannelNames] = useState<Map<number, string>>(new Map());

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
    void fetchNodes();
  }, [baseUrl, csrfFetch, sourceQuery]);

  /**
   * Names for the channel picker (#5230).
   *
   * `nodes.channel` mixes two id spaces: 0-7 are the device's own channel slots,
   * and anything >= CHANNEL_DB_OFFSET is `offset + channel_database.id` — the
   * server-side decryption entries used for MQTT and bridged traffic. On a real
   * install the virtual ids dominate, so a picker that renders "Ch 102" is
   * unusable for the case this feature exists to serve: operators who name
   * channels after presets and want to scope to one of them.
   */
  useEffect(() => {
    const fetchChannelNames = async () => {
      const names = new Map<number, string>();
      try {
        const [deviceRes, dbRes] = await Promise.all([
          csrfFetch(`${baseUrl}/api/channels${sourceQuery}`),
          csrfFetch(`${baseUrl}/api/channel-database`),
        ]);
        if (deviceRes.ok) {
          const rows = await deviceRes.json();
          if (Array.isArray(rows)) {
            rows.forEach((c: { id?: number; name?: string }) => {
              if (typeof c?.id === 'number' && c.name) names.set(c.id, c.name);
            });
          }
        }
        if (dbRes.ok) {
          // Always the `{ success, count, data }` envelope — see
          // _channelDatabaseHandlers.getAllChannelsHandler.
          const body = await dbRes.json();
          const rows = body?.data;
          if (Array.isArray(rows)) {
            rows.forEach((c: { id?: number; name?: string }) => {
              if (typeof c?.id === 'number' && c.name) names.set(CHANNEL_DB_OFFSET + c.id, c.name);
            });
          }
        }
      } catch {
        // Names are a convenience; the picker still works off raw ids.
      }
      setChannelNames(names);
    };
    void fetchChannelNames();
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
          // Combine modes — anything but an explicit 'and' reads as 'or'.
          setFilterNodesMode(asFilterMode(data.filterNodesMode));
          setFilterChannelsMode(asFilterMode(data.filterChannelsMode));
          setFilterRolesMode(asFilterMode(data.filterRolesMode));
          setFilterHwModelsMode(asFilterMode(data.filterHwModelsMode));
          setFilterRegexMode(asFilterMode(data.filterRegexMode));
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
    void fetchAllSettings();
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
    void fetchTracerouteLog();

    // Refresh every 30 seconds if auto-traceroute is enabled
    const intervalId = setInterval(() => {
      if (localEnabled) {
        void fetchTracerouteLog();
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

    // Combine-mode changes (#5230)
    const modesChanged =
      filterNodesMode !== asFilterMode(initialSettings.filterNodesMode) ||
      filterChannelsMode !== asFilterMode(initialSettings.filterChannelsMode) ||
      filterRolesMode !== asFilterMode(initialSettings.filterRolesMode) ||
      filterHwModelsMode !== asFilterMode(initialSettings.filterHwModelsMode) ||
      filterRegexMode !== asFilterMode(initialSettings.filterRegexMode);
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
      modesChanged || filterNodesEnabledChanged || filterChannelsEnabledChanged || filterRolesEnabledChanged || filterHwModelsEnabledChanged || filterRegexEnabledChanged ||
      filterLastHeardEnabledChanged || filterLastHeardHoursChanged || filterHopsEnabledChanged || filterHopsMinChanged || filterHopsMaxChanged ||
      expirationHoursChanged || sortByHopsChanged || scheduleEnabledChanged || scheduleStartChanged || scheduleEndChanged;
    setHasChanges(changed);
  }, [localEnabled, localInterval, intervalMinutes, initialInterval, filterEnabled, selectedNodeNums, filterChannels, filterRoles, filterHwModels, filterNameRegex, initialSettings,
      filterNodesEnabled, filterChannelsEnabled, filterRolesEnabled, filterHwModelsEnabled,
      filterNodesMode, filterChannelsMode, filterRolesMode, filterHwModelsMode, filterRegexMode, filterRegexEnabled,
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
      setFilterNodesMode(asFilterMode(initialSettings.filterNodesMode));
      setFilterChannelsMode(asFilterMode(initialSettings.filterChannelsMode));
      setFilterRolesMode(asFilterMode(initialSettings.filterRolesMode));
      setFilterHwModelsMode(asFilterMode(initialSettings.filterHwModelsMode));
      setFilterRegexMode(asFilterMode(initialSettings.filterRegexMode));
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

  /** "LongTurbo", or "Ch 3" / "DB #45" when the name is not known. */
  const channelLabel = useCallback((channel: number): string => {
    const name = channelNames.get(channel);
    if (name) return name;
    return channel >= CHANNEL_DB_OFFSET ? `DB #${channel - CHANNEL_DB_OFFSET}` : `Ch ${channel}`;
  }, [channelNames]);

  /**
   * Nodes we have never decoded a channel for. Under an 'and' channel scope
   * these are all excluded — "heard on LongTurbo" cannot be true of a node with
   * no known channel — and on a real install this is a large bucket, so the
   * count is surfaced rather than left as a silent collapse in the preview.
   */
  const nodesWithoutChannel = useMemo(
    () => availableNodes.filter(n => n.channel === undefined || n.channel === null).length,
    [availableNodes]
  );

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

    // Apply AND pre-filters (last heard, hop range) to narrow the candidate pool first
    let candidatePool = availableNodes;

    if (filterLastHeardEnabled) {
      const lastHeardCutoff = Math.floor(Date.now() / 1000) - (filterLastHeardHours * 3600);
      candidatePool = candidatePool.filter(n =>
        n.lastHeard != null && n.lastHeard >= lastHeardCutoff
      );
    }

    if (filterHopsEnabled) {
      candidatePool = candidatePool.filter(n => {
        const hops = n.hopsAway ?? 1;
        return hops >= filterHopsMin && hops <= filterHopsMax;
      });
    }

    /**
     * Mirror of the backend's per-filter combine logic (#5230), so the preview
     * count below shows what auto-traceroute will actually do. If these two
     * drift, the preview becomes a confident lie — which is worse than no
     * preview, because the user tunes against it.
     *
     * A filter participates only when enabled AND configured: an 'and' filter
     * with nothing selected is one the user has not filled in, not a scope that
     * excludes everything.
     */
    let regexMatcherForCheck: RegExp | null = null;
    if (filterRegexEnabled && filterNameRegex && filterNameRegex !== '.*') {
      try { regexMatcherForCheck = new RegExp(filterNameRegex, 'i'); } catch { /* invalid */ }
    }

    const nodeName = (n: Node) => n.longName || n.user?.longName || n.shortName || n.user?.shortName || n.nodeId || '';

    const active: Array<{ mode: FilterMode; matches: (n: Node) => boolean }> = [];
    if (filterNodesEnabled && selectedNodeNums.length > 0) {
      active.push({ mode: filterNodesMode, matches: (n) => selectedNodeNums.includes(n.nodeNum) });
    }
    if (filterChannelsEnabled && filterChannels.length > 0) {
      active.push({
        mode: filterChannelsMode,
        matches: (n) => n.channel != null && filterChannels.includes(n.channel),
      });
    }
    if (filterRolesEnabled && filterRoles.length > 0) {
      active.push({
        mode: filterRolesMode,
        matches: (n) => { const r = getNodeRole(n); return r !== undefined && filterRoles.includes(r); },
      });
    }
    if (filterHwModelsEnabled && filterHwModels.length > 0) {
      active.push({
        mode: filterHwModelsMode,
        matches: (n) => { const h = getNodeHwModel(n); return h !== undefined && filterHwModels.includes(h); },
      });
    }
    // `.*` is NOT a participating filter, matching the backend, which only
    // compiles a matcher when the pattern is non-default. The old preview
    // treated it as a match-all OR member — and since the regex filter is
    // enabled with `.*` by DEFAULT, that silently neutralised every other OR
    // filter: picking a channel showed the whole mesh as matching while the
    // scheduler traced only the channel. The preview now says what will happen.
    if (filterRegexEnabled && regexMatcherForCheck !== null) {
      const re = regexMatcherForCheck;
      active.push({ mode: filterRegexMode, matches: (n) => re.test(nodeName(n)) });
    }

    if (active.length === 0) {
      // Only the always-AND filters are doing anything.
      return candidatePool;
    }

    const andFilters = active.filter(f => f.mode === 'and');
    const orFilters = active.filter(f => f.mode === 'or');

    return candidatePool.filter(n => {
      if (!andFilters.every(f => f.matches(n))) return false;
      if (orFilters.length > 0 && !orFilters.some(f => f.matches(n))) return false;
      return true;
    });

  }, [filterEnabled, selectedNodeNums, filterChannels, filterRoles, filterHwModels, filterNameRegex, availableNodes,
      filterNodesEnabled, filterChannelsEnabled, filterRolesEnabled, filterHwModelsEnabled, filterRegexEnabled,
      filterNodesMode, filterChannelsMode, filterRolesMode, filterHwModelsMode, filterRegexMode,
      filterLastHeardEnabled, filterLastHeardHours, filterHopsEnabled, filterHopsMin, filterHopsMax]);

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
          filterNodesMode,
          filterChannelsMode,
          filterRolesMode,
          filterHwModelsMode,
          filterRegexMode,
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
        filterNodesMode,
        filterChannelsMode,
        filterRolesMode,
        filterHwModelsMode,
        filterRegexMode,
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
  }, [localEnabled, localInterval, filterEnabled, selectedNodeNums, filterChannels, filterRoles, filterHwModels, filterNameRegex, filterNodesEnabled, filterChannelsEnabled, filterRolesEnabled, filterHwModelsEnabled, filterRegexEnabled, filterNodesMode, filterChannelsMode, filterRolesMode, filterHwModelsMode, filterRegexMode, filterLastHeardEnabled, filterLastHeardHours, filterHopsEnabled, filterHopsMin, filterHopsMax, expirationHours, sortByHops, scheduleEnabled, scheduleStart, scheduleEnd, baseUrl, csrfFetch, showToast, t, onIntervalChange, sourceQuery]);

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
    background: 'var(--color-surface)',
    border: '1px solid var(--color-surface-active)',
    borderRadius: '4px',
    cursor: 'pointer',
    marginBottom: '0.5rem',
  };

  const badgeStyle: React.CSSProperties = {
    background: 'var(--color-accent)',
    color: 'var(--color-bg)',
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
        background: 'var(--color-surface-hover)',
        border: '1px solid var(--color-surface-active)',
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
              background: 'var(--color-surface)',
              border: '1px solid var(--color-surface-active)',
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
                    <span><UiIcon name={expandedSections.nodes ? 'chevronDown' : 'forward'} /></span>
                    {t('automation.auto_traceroute.specific_nodes')}
                    {filterNodesEnabled && selectedNodeNums.length > 0 && (
                      <span style={badgeStyle}>{selectedNodeNums.length}</span>
                    )}
                    <FilterModeToggle
                      mode={filterNodesMode}
                      onChange={setFilterNodesMode}
                      label={t('automation.auto_traceroute.combine_mode')}
                      testId="traceroute-mode-nodes"
                    />
                  </span>
                </div>
                {expandedSections.nodes && (
                  <div style={{ padding: '0.5rem', background: 'var(--color-bg)', borderRadius: '4px' }}>
                    <input
                      type="text"
                      placeholder={t('automation.auto_traceroute.search_nodes')}
                      value={searchTerm}
                      onChange={(e) => setSearchTerm(e.target.value)}
                      style={{
                        width: '100%',
                        padding: '0.5rem',
                        marginBottom: '0.5rem',
                        background: 'var(--color-surface)',
                        border: '1px solid var(--color-surface-active)',
                        borderRadius: '4px',
                        color: 'var(--color-text)'
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
                    <div style={{ maxHeight: '200px', overflowY: 'auto', border: '1px solid var(--color-surface-active)', borderRadius: '4px' }}>
                      {filteredNodes.length === 0 ? (
                        <div style={{ padding: '0.5rem', textAlign: 'center', color: 'var(--color-text-subtle)', fontSize: '12px' }}>
                          {searchTerm ? t('automation.auto_traceroute.no_nodes_match') : t('automation.auto_traceroute.no_nodes_available')}
                        </div>
                      ) : (
                        filteredNodes.map(node => (
                          <div
                            key={node.nodeNum}
                            style={{
                              padding: '0.4rem 0.6rem',
                              borderBottom: '1px solid var(--color-surface-hover)',
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
                            <span style={{ color: 'var(--color-text)' }}>
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
                    <span><UiIcon name={expandedSections.channels ? 'chevronDown' : 'forward'} /></span>
                    {t('automation.auto_traceroute.filter_by_channel')}
                    {filterChannelsEnabled && filterChannels.length > 0 && (
                      <span style={badgeStyle}>{filterChannels.length}</span>
                    )}
                    <FilterModeToggle
                      mode={filterChannelsMode}
                      onChange={setFilterChannelsMode}
                      label={t('automation.auto_traceroute.combine_mode')}
                      testId="traceroute-mode-channels"
                    />
                  </span>
                </div>
                {expandedSections.channels && (
                  <div style={{ padding: '0.5rem', background: 'var(--color-bg)', borderRadius: '4px', display: 'flex', flexWrap: 'wrap', gap: '0.5rem' }}>
                    {availableChannels.length === 0 ? (
                      <span style={{ color: 'var(--color-text-subtle)', fontSize: '12px' }}>{t('automation.auto_traceroute.no_channels')}</span>
                    ) : (
                      availableChannels.map(channel => (
                        <label key={channel} style={{ display: 'flex', alignItems: 'center', gap: '0.25rem', cursor: 'pointer', fontSize: '12px' }}>
                          <input
                            type="checkbox"
                            checked={filterChannels.includes(channel)}
                            onChange={() => toggleArrayValue(filterChannels, channel, setFilterChannels)}
                            style={{ width: 'auto', margin: 0 }}
                          />
                          {channelLabel(channel)} ({availableNodes.filter(n => n.channel === channel).length})
                        </label>
                      ))
                    )}
                    {/* An AND-scoped channel filter excludes every node we have
                        never decoded a channel for. On a real mesh that is a
                        large bucket, so say so here rather than let the preview
                        count collapse for no visible reason (#5230). */}
                    {filterChannelsMode === 'and' && nodesWithoutChannel > 0 && (
                      <div
                        style={{ flexBasis: '100%', fontSize: '11px', color: 'var(--color-warning)' }}
                        data-testid="traceroute-channel-unknown-warning"
                      >
                        {t('automation.auto_traceroute.channel_unknown_excluded', { count: nodesWithoutChannel })}
                      </div>
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
                    <span><UiIcon name={expandedSections.roles ? 'chevronDown' : 'forward'} /></span>
                    {t('automation.auto_traceroute.filter_by_role')}
                    {filterRolesEnabled && filterRoles.length > 0 && (
                      <span style={badgeStyle}>{filterRoles.length}</span>
                    )}
                    <FilterModeToggle
                      mode={filterRolesMode}
                      onChange={setFilterRolesMode}
                      label={t('automation.auto_traceroute.combine_mode')}
                      testId="traceroute-mode-roles"
                    />
                  </span>
                </div>
                {expandedSections.roles && (
                  <div style={{ padding: '0.5rem', background: 'var(--color-bg)', borderRadius: '4px', display: 'flex', flexWrap: 'wrap', gap: '0.5rem' }}>
                    {availableRolesInNodes.length === 0 ? (
                      <span style={{ color: 'var(--color-text-subtle)', fontSize: '12px' }}>{t('automation.auto_traceroute.no_roles_available')}</span>
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
                    <span><UiIcon name={expandedSections.hwModels ? 'chevronDown' : 'forward'} /></span>
                    {t('automation.auto_traceroute.filter_by_hardware')}
                    {filterHwModelsEnabled && filterHwModels.length > 0 && (
                      <span style={badgeStyle}>{filterHwModels.length}</span>
                    )}
                    <FilterModeToggle
                      mode={filterHwModelsMode}
                      onChange={setFilterHwModelsMode}
                      label={t('automation.auto_traceroute.combine_mode')}
                      testId="traceroute-mode-hwmodels"
                    />
                  </span>
                </div>
                {expandedSections.hwModels && (
                  <div style={{ padding: '0.5rem', background: 'var(--color-bg)', borderRadius: '4px', maxHeight: '200px', overflowY: 'auto' }}>
                    {availableHwModelsInNodes.length === 0 ? (
                      <span style={{ color: 'var(--color-text-subtle)', fontSize: '12px' }}>{t('automation.auto_traceroute.no_hardware_available')}</span>
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
                    <span><UiIcon name={expandedSections.regex ? 'chevronDown' : 'forward'} /></span>
                    {t('automation.auto_traceroute.filter_by_name')}
                    {filterRegexEnabled && filterNameRegex !== '.*' && (
                      <span style={badgeStyle}>1</span>
                    )}
                    <FilterModeToggle
                      mode={filterRegexMode}
                      onChange={setFilterRegexMode}
                      label={t('automation.auto_traceroute.combine_mode')}
                      testId="traceroute-mode-regex"
                    />
                  </span>
                </div>
                {expandedSections.regex && (
                  <div style={{ padding: '0.5rem', background: 'var(--color-bg)', borderRadius: '4px' }}>
                    <input
                      type="text"
                      value={filterNameRegex}
                      onChange={(e) => setFilterNameRegex(e.target.value)}
                      placeholder=".*"
                      style={{
                        width: '100%',
                        padding: '0.5rem',
                        marginBottom: '0.25rem',
                        background: 'var(--color-surface)',
                        border: '1px solid var(--color-surface-active)',
                        borderRadius: '4px',
                        color: 'var(--color-text)',
                        fontFamily: 'monospace',
                        fontSize: '12px'
                      }}
                    />
                    <div style={{ fontSize: '11px', color: 'var(--color-text-subtle)' }}>
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
                    <span><UiIcon name={expandedSections.lastHeard ? 'chevronDown' : 'forward'} /></span>
                    {t('automation.auto_traceroute.filter_by_last_heard')}
                    {filterLastHeardEnabled && (
                      <span style={badgeStyle}>{filterLastHeardHours}h</span>
                    )}
                  </span>
                </div>
                {expandedSections.lastHeard && (
                  <div style={{ padding: '0.5rem', background: 'var(--color-bg)', borderRadius: '4px' }}>
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
                    <span><UiIcon name={expandedSections.hops ? 'chevronDown' : 'forward'} /></span>
                    {t('automation.auto_traceroute.filter_by_hops')}
                    {filterHopsEnabled && (
                      <span style={badgeStyle}>{filterHopsMin}-{filterHopsMax}</span>
                    )}
                  </span>
                </div>
                {expandedSections.hops && (
                  <div style={{ padding: '0.5rem', background: 'var(--color-bg)', borderRadius: '4px', display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '12px' }}>
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
                background: 'var(--color-bg)',
                border: '1px solid var(--color-surface-active)',
                borderRadius: '6px',
                display: 'flex',
                flexDirection: 'column'
              }}>
                <div style={{
                  padding: '0.5rem 0.75rem',
                  borderBottom: '1px solid var(--color-surface-active)',
                  background: 'var(--color-surface-hover)',
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
                      color: 'var(--color-text-subtle)',
                      fontSize: '12px'
                    }}>
                      {t('automation.auto_traceroute.no_nodes_match_filters')}
                    </div>
                  ) : (
                    debouncedMatchingNodes.map(node => (
                      <div
                        key={node.nodeNum}
                        data-testid={`traceroute-match-${node.nodeNum}`}
                        style={{
                          padding: '0.35rem 0.5rem',
                          borderBottom: '1px solid var(--color-surface-hover)',
                          fontSize: '12px',
                          color: 'var(--color-text)',
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
            <h4 style={{ marginBottom: '0.75rem', color: 'var(--color-text)' }}>
              {t('automation.auto_traceroute.recent_log')}
            </h4>
            <div style={{
              border: '1px solid var(--color-surface-active)',
              borderRadius: '6px',
              overflow: 'hidden',
              marginLeft: '1.75rem'
            }}>
              {tracerouteLog.length === 0 ? (
                <div style={{
                  padding: '1rem',
                  textAlign: 'center',
                  color: 'var(--color-text-subtle)',
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
                    <tr style={{ background: 'var(--color-surface-hover)' }}>
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
                      <tr key={entry.id} style={{ borderTop: '1px solid var(--color-surface-hover)' }}>
                        <td style={{ padding: '0.4rem 0.75rem', color: 'var(--color-text-subtle)' }}>
                          {new Date(entry.timestamp).toLocaleString()}
                        </td>
                        <td style={{ padding: '0.4rem 0.75rem', color: 'var(--color-text)' }}>
                          {entry.toNodeName || `!${entry.toNodeNum.toString(16).padStart(8, '0')}`}
                        </td>
                        <td style={{ padding: '0.4rem 0.75rem', textAlign: 'center' }}>
                          {entry.success === null ? (
                            <span style={{
                              color: 'var(--color-warning)',
                              fontSize: '14px'
                            }} title={t('automation.auto_traceroute.status_pending')}>
                              <UiIcon name="time" />
                            </span>
                          ) : entry.success ? (
                            <span style={{
                              color: 'var(--color-success)',
                              fontSize: '14px'
                            }} title={t('automation.auto_traceroute.status_success')}>
                              <UiIcon name="check" />
                            </span>
                          ) : (
                            <span style={{
                              color: 'var(--color-error)',
                              fontSize: '14px'
                            }} title={t('automation.auto_traceroute.status_failed')}>
                              <UiIcon name="error" />
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
