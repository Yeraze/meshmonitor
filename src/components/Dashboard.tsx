import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  DragEndEvent,
} from '@dnd-kit/core';
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import './Dashboard.css';
import { type TemperatureUnit } from '../utils/temperature';
import { logger } from '../utils/logger';
import api from '../services/api';
import { useCsrfFetch } from '../hooks/useCsrfFetch';
import { useSolarEstimatesLatest } from '../hooks/useTelemetry';
import { getDeviceRoleName } from '../utils/deviceRole';
import TelemetryChart, { getTelemetryLabel, type FavoriteChart, type NodeInfo } from './TelemetryChart';
import { type TelemetryData } from '../hooks/useTelemetry';
import NodeStatusWidget from './NodeStatusWidget';
import TracerouteWidget from './TracerouteWidget';
import AddWidgetModal, { type WidgetType } from './AddWidgetModal';

interface DashboardProps {
  temperatureUnit?: TemperatureUnit;
  telemetryHours?: number;
  favoriteTelemetryStorageDays?: number;
  baseUrl: string;
  currentNodeId?: string | null;
  canEdit?: boolean;
}

// Custom widget types for node status and traceroute
interface NodeStatusWidgetConfig {
  id: string;
  type: 'nodeStatus';
  nodeIds: string[];
}

interface TracerouteWidgetConfig {
  id: string;
  type: 'traceroute';
  targetNodeId: string | null;
}

type CustomWidget = NodeStatusWidgetConfig | TracerouteWidgetConfig;

type SortOption = 'custom' | 'node-asc' | 'node-desc' | 'type-asc' | 'type-desc';

const Dashboard: React.FC<DashboardProps> = React.memo(({
  temperatureUnit = 'C',
  telemetryHours: _telemetryHours = 24,
  favoriteTelemetryStorageDays = 7,
  baseUrl,
  currentNodeId = null,
  canEdit = true,
}) => {
  const { t } = useTranslation();
  const csrfFetch = useCsrfFetch();
  const [favorites, setFavorites] = useState<FavoriteChart[]>([]);
  const [customOrder, setCustomOrder] = useState<string[]>([]);
  const [nodes, setNodes] = useState<Map<string, NodeInfo>>(new Map());
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  // Custom widgets state
  const [customWidgets, setCustomWidgets] = useState<CustomWidget[]>([]);
  const [showAddWidgetModal, setShowAddWidgetModal] = useState(false);

  // Unified dashboard order (contains all item IDs - widgets and charts)
  const [dashboardOrder, setDashboardOrder] = useState<string[]>([]);

  // Track telemetry data from charts for global time range calculation
  const [telemetryDataMap, setTelemetryDataMap] = useState<Map<string, TelemetryData[]>>(new Map());

  // Days to view control (defaults to all available, max is favoriteTelemetryStorageDays)
  const [daysToView, setDaysToView] = useState<number>(() => {
    try {
      const savedDaysToView = localStorage.getItem('telemetryDaysToView');
      if (savedDaysToView) {
        const parsed = parseInt(savedDaysToView);
        return Math.min(favoriteTelemetryStorageDays, Math.max(1, parsed));
      }
    } catch (error) {
      logger.error('Error loading days to view from Local Storage:', error);
    }
    return favoriteTelemetryStorageDays;
  });

  // Filter and sort state
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [selectedNode, setSelectedNode] = useState<string>('all');
  const [selectedType, setSelectedType] = useState<string>('all');
  const [selectedRoles, setSelectedRoles] = useState<Set<string>>(new Set());
  const [roleDropdownOpen, setRoleDropdownOpen] = useState<boolean>(false);
  const [sortOption, setSortOption] = useState<SortOption>('custom');

  // Fetch solar estimates using TanStack Query hook
  const { data: solarEstimates } = useSolarEstimatesLatest({
    baseUrl,
    limit: 500,
    enabled: true,
  });

  // Toggle callbacks
  const handleToggleRoleDropdown = useCallback(() => {
    setRoleDropdownOpen(!roleDropdownOpen);
  }, [roleDropdownOpen]);

  const handleClearRoleFilter = useCallback(() => {
    setSelectedRoles(new Set());
  }, []);

  const handleToggleRole = useCallback((role: string, checked: boolean) => {
    const newRoles = new Set(selectedRoles);
    if (checked) {
      newRoles.add(role);
    } else {
      newRoles.delete(role);
    }
    setSelectedRoles(newRoles);
  }, [selectedRoles]);

  // Drag and drop sensors
  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

  // Ref for role dropdown
  const roleDropdownRef = useRef<HTMLDivElement>(null);

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (roleDropdownRef.current && !roleDropdownRef.current.contains(event.target as Node)) {
        setRoleDropdownOpen(false);
      }
    };

    if (roleDropdownOpen) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => {
        document.removeEventListener('mousedown', handleClickOutside);
      };
    }
  }, [roleDropdownOpen]);

  // Save daysToView to localStorage whenever it changes
  useEffect(() => {
    try {
      localStorage.setItem('telemetryDaysToView', daysToView.toString());
    } catch (error) {
      logger.error('Error saving days to view to Local Storage:', error);
    }
  }, [daysToView]);

  // Fetch favorites and node information (telemetry is fetched by individual charts)
  useEffect(() => {
    const fetchFavoritesAndNodes = async () => {
      try {
        setLoading(true);

        // Fetch favorites, custom order, and custom widgets from settings
        const settings = await api.get<{
          telemetryFavorites?: string;
          telemetryCustomOrder?: string;
          dashboardWidgets?: string;
          dashboardOrder?: string;
        }>('/api/settings');
        const favoritesArray: FavoriteChart[] = settings.telemetryFavorites
          ? JSON.parse(settings.telemetryFavorites)
          : [];

        const serverCustomOrder: string[] = settings.telemetryCustomOrder
          ? JSON.parse(settings.telemetryCustomOrder)
          : [];

        // Load custom widgets from settings
        const widgetsArray: CustomWidget[] = settings.dashboardWidgets
          ? JSON.parse(settings.dashboardWidgets)
          : [];
        setCustomWidgets(widgetsArray);

        setFavorites(favoritesArray);

        // Load custom order - prioritize localStorage over server
        let finalCustomOrder: string[] = [];
        try {
          const localStorageOrder = localStorage.getItem('telemetryCustomOrder');
          if (localStorageOrder) {
            const localOrder = JSON.parse(localStorageOrder);
            finalCustomOrder = localOrder.length > 0 ? localOrder : serverCustomOrder;
          } else {
            finalCustomOrder = serverCustomOrder;
          }
        } catch (error) {
          logger.error('Error loading custom order from Local Storage:', error);
          finalCustomOrder = serverCustomOrder;
        }

        setCustomOrder(finalCustomOrder);

        // Save the final order to localStorage if not already there
        try {
          localStorage.setItem('telemetryCustomOrder', JSON.stringify(finalCustomOrder));
        } catch (error) {
          logger.error('Error saving custom order to Local Storage:', error);
        }

        // Load unified dashboard order - prioritize localStorage over server
        const serverDashboardOrder: string[] = settings.dashboardOrder
          ? JSON.parse(settings.dashboardOrder)
          : [];
        let finalDashboardOrder: string[] = [];
        try {
          const localDashboardOrder = localStorage.getItem('dashboardOrder');
          if (localDashboardOrder) {
            const localOrder = JSON.parse(localDashboardOrder);
            finalDashboardOrder = localOrder.length > 0 ? localOrder : serverDashboardOrder;
          } else {
            finalDashboardOrder = serverDashboardOrder;
          }
        } catch (error) {
          logger.error('Error loading dashboard order from Local Storage:', error);
          finalDashboardOrder = serverDashboardOrder;
        }
        setDashboardOrder(finalDashboardOrder);

        // Fetch node information
        const nodesData = await api.get<NodeInfo[]>('/api/nodes');
        const nodesMap = new Map<string, NodeInfo>();
        nodesData.forEach((node: NodeInfo) => {
          if (node.user?.id) {
            nodesMap.set(node.user.id, node);
          }
        });
        setNodes(nodesMap);

        setError(null);
      } catch (err) {
        logger.error('Error in Dashboard:', err);
        setError(err instanceof Error ? err.message : 'Failed to load dashboard data');
      } finally {
        setLoading(false);
      }
    };

    fetchFavoritesAndNodes();
    // Refresh favorites/nodes every 30 seconds (telemetry is handled by individual hooks)
    const interval = setInterval(fetchFavoritesAndNodes, 30000);

    return () => clearInterval(interval);
  }, [baseUrl]);

  // Callback for charts to report their data (for global time range)
  const handleDataLoaded = useCallback((key: string, data: TelemetryData[]) => {
    setTelemetryDataMap(prev => {
      const next = new Map(prev);
      next.set(key, data);
      return next;
    });
  }, []);

  // Calculate global time range across all telemetry data
  const globalTimeRange = useMemo((): [number, number] | null => {
    let minTime = Infinity;
    let maxTime = -Infinity;

    telemetryDataMap.forEach(data => {
      data.forEach(item => {
        if (item.timestamp < minTime) minTime = item.timestamp;
        if (item.timestamp > maxTime) maxTime = item.timestamp;
      });
    });

    if (minTime === Infinity || maxTime === -Infinity) {
      return null;
    }

    return [minTime, maxTime];
  }, [telemetryDataMap]);

  const globalMinTime = globalTimeRange ? globalTimeRange[0] : undefined;

  // Save dashboard order to localStorage and server
  const saveDashboardOrder = useCallback(async (newOrder: string[]) => {
    setDashboardOrder(newOrder);

    // Save to Local Storage
    try {
      localStorage.setItem('dashboardOrder', JSON.stringify(newOrder));
    } catch (error) {
      logger.error('Error saving dashboard order to Local Storage:', error);
    }

    // Save to server
    try {
      await csrfFetch(`${baseUrl}/api/settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dashboardOrder: JSON.stringify(newOrder) }),
      });
    } catch (error) {
      logger.error('Error saving dashboard order:', error);
    }
  }, [baseUrl, csrfFetch]);

  // Get unique nodes for filter dropdown
  const getUniqueNodes = useMemo(() => {
    const uniqueNodes = new Map<string, string>();
    favorites.forEach(fav => {
      const node = nodes.get(fav.nodeId);
      const nodeName = node?.user?.longName || node?.user?.shortName || fav.nodeId;
      uniqueNodes.set(fav.nodeId, nodeName);
    });
    return Array.from(uniqueNodes.entries()).sort((a, b) => a[1].localeCompare(b[1]));
  }, [favorites, nodes]);

  // Get unique telemetry types for filter dropdown
  const getUniqueTelemetryTypes = useMemo(() => {
    const uniqueTypes = new Set<string>();
    favorites.forEach(fav => uniqueTypes.add(fav.telemetryType));
    return Array.from(uniqueTypes).sort();
  }, [favorites]);

  // Get unique device roles for filter dropdown
  const getUniqueDeviceRoles = useMemo(() => {
    const uniqueRoles = new Map<string, string>();
    favorites.forEach(fav => {
      const node = nodes.get(fav.nodeId);
      if (node?.user?.role !== undefined) {
        const roleName = getDeviceRoleName(node.user.role);
        uniqueRoles.set(roleName, roleName);
      }
    });
    return Array.from(uniqueRoles.values()).sort();
  }, [favorites, nodes]);

  // Filter and sort favorites
  const filteredAndSortedFavorites = useMemo(() => {
    let result = [...favorites];

    // Apply filters
    if (searchQuery) {
      const query = searchQuery.toLowerCase();
      result = result.filter(fav => {
        const node = nodes.get(fav.nodeId);
        const nodeName = (node?.user?.longName || node?.user?.shortName || fav.nodeId).toLowerCase();
        const typeName = getTelemetryLabel(fav.telemetryType).toLowerCase();
        return nodeName.includes(query) || typeName.includes(query);
      });
    }

    if (selectedNode !== 'all') {
      result = result.filter(fav => fav.nodeId === selectedNode);
    }

    if (selectedType !== 'all') {
      result = result.filter(fav => fav.telemetryType === selectedType);
    }

    if (selectedRoles.size > 0) {
      result = result.filter(fav => {
        const node = nodes.get(fav.nodeId);
        if (!node?.user?.role) return false;
        const roleName = getDeviceRoleName(node.user.role);
        return selectedRoles.has(roleName);
      });
    }

    // Apply sorting
    if (sortOption === 'custom' && customOrder.length > 0) {
      result.sort((a, b) => {
        const keyA = `${a.nodeId}-${a.telemetryType}`;
        const keyB = `${b.nodeId}-${b.telemetryType}`;
        const indexA = customOrder.indexOf(keyA);
        const indexB = customOrder.indexOf(keyB);
        if (indexA === -1 && indexB === -1) return 0;
        if (indexA === -1) return 1;
        if (indexB === -1) return -1;
        return indexA - indexB;
      });
    } else if (sortOption === 'node-asc') {
      result.sort((a, b) => {
        const nodeA = nodes.get(a.nodeId);
        const nodeB = nodes.get(b.nodeId);
        const nameA = (nodeA?.user?.longName || nodeA?.user?.shortName || a.nodeId).toLowerCase();
        const nameB = (nodeB?.user?.longName || nodeB?.user?.shortName || b.nodeId).toLowerCase();
        return nameA.localeCompare(nameB);
      });
    } else if (sortOption === 'node-desc') {
      result.sort((a, b) => {
        const nodeA = nodes.get(a.nodeId);
        const nodeB = nodes.get(b.nodeId);
        const nameA = (nodeA?.user?.longName || nodeA?.user?.shortName || a.nodeId).toLowerCase();
        const nameB = (nodeB?.user?.longName || nodeB?.user?.shortName || b.nodeId).toLowerCase();
        return nameB.localeCompare(nameA);
      });
    } else if (sortOption === 'type-asc') {
      result.sort((a, b) => getTelemetryLabel(a.telemetryType).localeCompare(getTelemetryLabel(b.telemetryType)));
    } else if (sortOption === 'type-desc') {
      result.sort((a, b) => getTelemetryLabel(b.telemetryType).localeCompare(getTelemetryLabel(a.telemetryType)));
    }

    return result;
  }, [favorites, nodes, searchQuery, selectedNode, selectedType, selectedRoles, sortOption, customOrder]);

  // Create unified ordered list of all items (widgets + charts)
  type UnifiedItem =
    | { type: 'widget'; widget: CustomWidget }
    | { type: 'chart'; favorite: FavoriteChart };

  const unifiedOrderedItems = useMemo((): UnifiedItem[] => {
    // Build list of all items with their IDs
    const widgetItems: UnifiedItem[] = customWidgets.map(w => ({ type: 'widget' as const, widget: w }));
    const chartItems: UnifiedItem[] = filteredAndSortedFavorites.map(f => ({ type: 'chart' as const, favorite: f }));
    const allItems = [...widgetItems, ...chartItems];

    // If we have a saved dashboard order, sort by it
    if (dashboardOrder.length > 0 && sortOption === 'custom') {
      allItems.sort((a, b) => {
        const idA = a.type === 'widget' ? a.widget.id : `${a.favorite.nodeId}-${a.favorite.telemetryType}`;
        const idB = b.type === 'widget' ? b.widget.id : `${b.favorite.nodeId}-${b.favorite.telemetryType}`;
        const indexA = dashboardOrder.indexOf(idA);
        const indexB = dashboardOrder.indexOf(idB);
        if (indexA === -1 && indexB === -1) return 0;
        if (indexA === -1) return 1;
        if (indexB === -1) return -1;
        return indexA - indexB;
      });
    }

    return allItems;
  }, [customWidgets, filteredAndSortedFavorites, dashboardOrder, sortOption]);

  // Handle drag end - unified ordering for all items
  // Uses unifiedOrderedItems to get the current display order
  const handleDragEnd = useCallback(async (event: DragEndEvent) => {
    const { active, over } = event;

    if (over && active.id !== over.id) {
      // Get current order from unifiedOrderedItems (already sorted correctly)
      const currentOrder = unifiedOrderedItems.map(item =>
        item.type === 'widget' ? item.widget.id : `${item.favorite.nodeId}-${item.favorite.telemetryType}`
      );

      // Find indices in the current order
      const oldIndex = currentOrder.indexOf(String(active.id));
      const newIndex = currentOrder.indexOf(String(over.id));

      if (oldIndex !== -1 && newIndex !== -1) {
        const newOrder = arrayMove(currentOrder, oldIndex, newIndex);
        await saveDashboardOrder(newOrder);
        setSortOption('custom');
      }
    }
  }, [unifiedOrderedItems, saveDashboardOrder]);

  const removeFavorite = useCallback(async (nodeId: string, telemetryType: string) => {
    try {
      const newFavorites = favorites.filter(f => !(f.nodeId === nodeId && f.telemetryType === telemetryType));

      // Update local state
      setFavorites(newFavorites);

      // Remove from telemetry data map
      const key = `${nodeId}-${telemetryType}`;
      setTelemetryDataMap(prev => {
        const next = new Map(prev);
        next.delete(key);
        return next;
      });

      // Save to server
      await csrfFetch(`${baseUrl}/api/settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ telemetryFavorites: JSON.stringify(newFavorites) }),
      });
    } catch (error) {
      logger.error('Error removing favorite:', error);
      // Revert on error
      window.location.reload();
    }
  }, [favorites, baseUrl, csrfFetch]);

  // Save custom widgets to server
  const saveWidgets = useCallback(async (widgets: CustomWidget[]) => {
    try {
      await csrfFetch(`${baseUrl}/api/settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dashboardWidgets: JSON.stringify(widgets) }),
      });
    } catch (error) {
      logger.error('Error saving widgets:', error);
    }
  }, [baseUrl, csrfFetch]);

  // Add a new widget
  const handleAddWidget = useCallback((type: WidgetType) => {
    const id = `widget-${Date.now()}`;
    let newWidget: CustomWidget;

    if (type === 'nodeStatus') {
      newWidget = { id, type: 'nodeStatus', nodeIds: [] };
    } else {
      newWidget = { id, type: 'traceroute', targetNodeId: null };
    }

    const newWidgets = [...customWidgets, newWidget];
    setCustomWidgets(newWidgets);
    saveWidgets(newWidgets);
  }, [customWidgets, saveWidgets]);

  // Remove a widget
  const handleRemoveWidget = useCallback((widgetId: string) => {
    const newWidgets = customWidgets.filter(w => w.id !== widgetId);
    setCustomWidgets(newWidgets);
    saveWidgets(newWidgets);
  }, [customWidgets, saveWidgets]);

  // Add node to NodeStatus widget
  const handleAddNodeToWidget = useCallback((widgetId: string, nodeId: string) => {
    const newWidgets = customWidgets.map(w => {
      if (w.id === widgetId && w.type === 'nodeStatus') {
        return { ...w, nodeIds: [...w.nodeIds, nodeId] };
      }
      return w;
    });
    setCustomWidgets(newWidgets);
    saveWidgets(newWidgets);
  }, [customWidgets, saveWidgets]);

  // Remove node from NodeStatus widget
  const handleRemoveNodeFromWidget = useCallback((widgetId: string, nodeId: string) => {
    const newWidgets = customWidgets.map(w => {
      if (w.id === widgetId && w.type === 'nodeStatus') {
        return { ...w, nodeIds: w.nodeIds.filter(id => id !== nodeId) };
      }
      return w;
    });
    setCustomWidgets(newWidgets);
    saveWidgets(newWidgets);
  }, [customWidgets, saveWidgets]);

  // Set target node for Traceroute widget
  const handleSelectTracerouteNode = useCallback((widgetId: string, nodeId: string) => {
    const newWidgets = customWidgets.map(w => {
      if (w.id === widgetId && w.type === 'traceroute') {
        return { ...w, targetNodeId: nodeId };
      }
      return w;
    });
    setCustomWidgets(newWidgets);
    saveWidgets(newWidgets);
  }, [customWidgets, saveWidgets]);

  if (loading) {
    return <div className="dashboard-loading">{t('dashboard.loading')}</div>;
  }

  if (error) {
    return <div className="dashboard-error">{t('dashboard.error', { error })}</div>;
  }

  const hours = daysToView * 24;
  const hasContent = favorites.length > 0 || customWidgets.length > 0;

  return (
    <div className="dashboard">
      <div className="dashboard-header-section">
        <div>
          <h2 className="dashboard-title">{t('dashboard.title')}</h2>
          <p className="dashboard-subtitle">
            {favorites.length > 0
              ? t('dashboard.subtitle_with_data', { days: daysToView })
              : t('dashboard.subtitle_empty')}
          </p>
        </div>
        <button
          className="dashboard-add-widget-btn"
          onClick={() => setShowAddWidgetModal(true)}
          title={t('dashboard.add_widget_title')}
        >
          {t('dashboard.add_widget_button')}
        </button>
      </div>

      <AddWidgetModal
        isOpen={showAddWidgetModal}
        onClose={() => setShowAddWidgetModal(false)}
        onAddWidget={handleAddWidget}
      />

      <div className="dashboard-controls">
        <div className="dashboard-filters">
          <div className="dashboard-filter-group">
            <label htmlFor="daysToView" style={{ marginRight: '0.5rem', fontWeight: '500' }}>
              {t('dashboard.days_to_view')}
            </label>
            <input
              type="number"
              id="daysToView"
              className="dashboard-number-input"
              min="1"
              max={favoriteTelemetryStorageDays}
              value={daysToView}
              onChange={e =>
                setDaysToView(Math.min(favoriteTelemetryStorageDays, Math.max(1, parseInt(e.target.value) || 1)))
              }
              style={{
                width: '80px',
                padding: '0.5rem',
                border: '1px solid #45475a',
                borderRadius: '4px',
                backgroundColor: '#1e1e2e',
                color: '#cdd6f4',
              }}
            />
          </div>

          <input
            type="text"
            className="dashboard-search"
            placeholder={t('dashboard.search_placeholder')}
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
          />

          <select
            className="dashboard-filter-select"
            value={selectedNode}
            onChange={e => setSelectedNode(e.target.value)}
          >
            <option value="all">{t('dashboard.all_nodes')}</option>
            {getUniqueNodes.map(([nodeId, nodeName]) => (
              <option key={nodeId} value={nodeId}>
                {nodeName}
              </option>
            ))}
          </select>

          <select
            className="dashboard-filter-select"
            value={selectedType}
            onChange={e => setSelectedType(e.target.value)}
          >
            <option value="all">{t('dashboard.all_types')}</option>
            {getUniqueTelemetryTypes.map(type => (
              <option key={type} value={type}>
                {getTelemetryLabel(type)}
              </option>
            ))}
          </select>

          <div className="dashboard-role-filter-dropdown" ref={roleDropdownRef}>
            <div className="dashboard-role-filter-button" onClick={handleToggleRoleDropdown}>
              <span>
                {selectedRoles.size === 0 ? t('dashboard.device_roles_all') : t('dashboard.device_roles_selected', { count: selectedRoles.size })}
              </span>
              <span className="dashboard-dropdown-arrow">{roleDropdownOpen ? '▲' : '▼'}</span>
            </div>
            {roleDropdownOpen && (
              <div className="dashboard-role-dropdown-content">
                {getUniqueDeviceRoles.length > 0 ? (
                  <>
                    <label className="dashboard-role-checkbox-label">
                      <input type="checkbox" checked={selectedRoles.size === 0} onChange={handleClearRoleFilter} />
                      <span>{t('dashboard.all_roles')}</span>
                    </label>
                    <div className="dashboard-role-divider" />
                    {getUniqueDeviceRoles.map(role => (
                      <label key={role} className="dashboard-role-checkbox-label">
                        <input
                          type="checkbox"
                          checked={selectedRoles.has(role)}
                          onChange={e => handleToggleRole(role, e.target.checked)}
                        />
                        <span>{role}</span>
                      </label>
                    ))}
                  </>
                ) : (
                  <span className="dashboard-no-roles">{t('dashboard.no_roles')}</span>
                )}
              </div>
            )}
          </div>
        </div>

        <div className="dashboard-sort">
          <label htmlFor="sort-select">{t('dashboard.sort_by')}</label>
          <select
            id="sort-select"
            className="dashboard-sort-select"
            value={sortOption}
            onChange={e => setSortOption(e.target.value as SortOption)}
          >
            <option value="custom">{t('dashboard.sort_custom')}</option>
            <option value="node-asc">{t('dashboard.sort_node_asc')}</option>
            <option value="node-desc">{t('dashboard.sort_node_desc')}</option>
            <option value="type-asc">{t('dashboard.sort_type_asc')}</option>
            <option value="type-desc">{t('dashboard.sort_type_desc')}</option>
          </select>
        </div>
      </div>

      {hasContent && (
        <>
          <div className="dashboard-results-info">
            {customWidgets.length > 0 && t(customWidgets.length !== 1 ? 'dashboard.widget_count_plural' : 'dashboard.widget_count', { count: customWidgets.length })}
            {customWidgets.length > 0 && favorites.length > 0 && ', '}
            {favorites.length > 0 && t(favorites.length !== 1 ? 'dashboard.chart_count_plural' : 'dashboard.chart_count', { shown: filteredAndSortedFavorites.length, total: favorites.length })}
          </div>

          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
            <SortableContext
              items={unifiedOrderedItems.map(item =>
                item.type === 'widget' ? item.widget.id : `${item.favorite.nodeId}-${item.favorite.telemetryType}`
              )}
              strategy={verticalListSortingStrategy}
            >
              <div className="dashboard-grid">
                {unifiedOrderedItems.map(item => {
                  if (item.type === 'widget') {
                    const widget = item.widget;
                    if (widget.type === 'nodeStatus') {
                      return (
                        <NodeStatusWidget
                          key={widget.id}
                          id={widget.id}
                          nodeIds={widget.nodeIds}
                          nodes={nodes}
                          onRemove={() => handleRemoveWidget(widget.id)}
                          onAddNode={(nodeId) => handleAddNodeToWidget(widget.id, nodeId)}
                          onRemoveNode={(nodeId) => handleRemoveNodeFromWidget(widget.id, nodeId)}
                          canEdit={canEdit}
                        />
                      );
                    } else if (widget.type === 'traceroute') {
                      return (
                        <TracerouteWidget
                          key={widget.id}
                          id={widget.id}
                          targetNodeId={widget.targetNodeId}
                          currentNodeId={currentNodeId}
                          nodes={nodes}
                          onRemove={() => handleRemoveWidget(widget.id)}
                          onSelectNode={(nodeId) => handleSelectTracerouteNode(widget.id, nodeId)}
                          canEdit={canEdit}
                        />
                      );
                    }
                    return null;
                  } else {
                    const favorite = item.favorite;
                    const key = `${favorite.nodeId}-${favorite.telemetryType}`;
                    const node = nodes.get(favorite.nodeId);

                    return (
                      <TelemetryChart
                        key={key}
                        id={key}
                        favorite={favorite}
                        node={node}
                        temperatureUnit={temperatureUnit}
                        hours={hours}
                        baseUrl={baseUrl}
                        globalTimeRange={globalTimeRange}
                        globalMinTime={globalMinTime}
                        solarEstimates={solarEstimates || new Map()}
                        onRemove={removeFavorite}
                        onDataLoaded={handleDataLoaded}
                      />
                    );
                  }
                })}
              </div>
            </SortableContext>
          </DndContext>
        </>
      )}

      {!hasContent && (
        <div className="dashboard-empty">
          <h2>{t('dashboard.empty_title')}</h2>
          <p>{t('dashboard.empty_description')}</p>
        </div>
      )}
    </div>
  );
});

Dashboard.displayName = 'Dashboard';

export default Dashboard;
