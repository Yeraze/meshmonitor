import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
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
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import './Dashboard.css';
import { type TemperatureUnit, formatTemperature, getTemperatureUnit } from '../utils/temperature';
import { logger } from '../utils/logger';
import api from '../services/api';
import { useCsrfFetch } from '../hooks/useCsrfFetch';
import { getDeviceRoleName } from '../utils/deviceRole';

interface TelemetryData {
  id?: number;
  nodeId: string;
  nodeNum: number;
  telemetryType: string;
  timestamp: number;
  value: number;
  unit?: string;
  createdAt: number;
}

interface FavoriteChart {
  nodeId: string;
  telemetryType: string;
}

interface NodeInfo {
  nodeNum: number;
  user?: {
    id: string;
    longName?: string;
    shortName?: string;
    hwModel?: number;
    role?: number | string;
  };
  deviceMetrics?: {
    batteryLevel?: number | null;
    voltage?: number | null;
    channelUtilization?: number | null;
    airUtilTx?: number | null;
  };
  lastHeard?: number;
  snr?: number;
  rssi?: number;
}

interface ChartData {
  timestamp: number;
  value: number;
  time: string;
}

interface DashboardProps {
  temperatureUnit?: TemperatureUnit;
  telemetryHours?: number;
  baseUrl: string;
}

type SortOption = 'custom' | 'node-asc' | 'node-desc' | 'type-asc' | 'type-desc';

interface SortableChartItemProps {
  id: string;
  favorite: FavoriteChart;
  data: TelemetryData[];
  node: NodeInfo | undefined;
  temperatureUnit: TemperatureUnit;
  globalTimeRange: [number, number] | null;
  onRemove: (nodeId: string, telemetryType: string) => void;
  getTelemetryLabel: (type: string) => string;
  getColor: (type: string) => string;
  prepareChartData: (data: TelemetryData[], isTemperature: boolean) => ChartData[];
}

const SortableChartItem: React.FC<SortableChartItemProps> = React.memo(({
  id,
  favorite,
  data,
  node,
  temperatureUnit,
  globalTimeRange,
  onRemove,
  getTelemetryLabel,
  getColor,
  prepareChartData,
}) => {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id });

  const handleRemoveClick = useCallback(() => {
    onRemove(favorite.nodeId, favorite.telemetryType);
  }, [favorite.nodeId, favorite.telemetryType, onRemove]);

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  // Format node name with both longName and shortName
  let nodeName = '';
  if (node?.user) {
    if (node.user.longName && node.user.shortName) {
      nodeName = `${node.user.longName} (${node.user.shortName})`;
    } else if (node.user.longName) {
      nodeName = node.user.longName;
    } else if (node.user.shortName) {
      nodeName = node.user.shortName;
    } else {
      nodeName = favorite.nodeId;
    }
  } else {
    nodeName = favorite.nodeId;
  }

  if (data.length === 0) {
    return (
      <div ref={setNodeRef} style={style} className="dashboard-chart-container">
        <div className="dashboard-chart-header">
          <div className="dashboard-drag-handle" {...attributes} {...listeners}>
            ⋮⋮
          </div>
          <h3 className="dashboard-chart-title">
            {nodeName} - {getTelemetryLabel(favorite.telemetryType)}
          </h3>
          <button
            className="dashboard-remove-btn"
            onClick={handleRemoveClick}
            aria-label="Remove from dashboard"
          >
            ✕
          </button>
        </div>
        <div className="dashboard-no-data">No data available</div>
      </div>
    );
  }

  const isTemperature = favorite.telemetryType === 'temperature';
  const chartData = prepareChartData(data, isTemperature);
  const unit = isTemperature ? getTemperatureUnit(temperatureUnit) : (data[0]?.unit || '');
  const color = getColor(favorite.telemetryType);

  return (
    <div ref={setNodeRef} style={style} className="dashboard-chart-container">
      <div className="dashboard-chart-header">
        <div className="dashboard-drag-handle" {...attributes} {...listeners}>
          ⋮⋮
        </div>
        <h3 className="dashboard-chart-title">
          {nodeName} - {getTelemetryLabel(favorite.telemetryType)} {unit && `(${unit})`}
        </h3>
        <button
          className="dashboard-remove-btn"
          onClick={handleRemoveClick}
          aria-label="Remove from dashboard"
        >
          ✕
        </button>
      </div>

      <ResponsiveContainer width="100%" height={200}>
        <LineChart data={chartData} margin={{ top: 5, right: 20, bottom: 5, left: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#ccc" />
          <XAxis
            dataKey="timestamp"
            type="number"
            domain={globalTimeRange || ['dataMin', 'dataMax']}
            tick={{ fontSize: 12 }}
            tickFormatter={(timestamp) => new Date(timestamp).toLocaleTimeString([], {
              hour: '2-digit',
              minute: '2-digit'
            })}
          />
          <YAxis
            tick={{ fontSize: 12 }}
            domain={['auto', 'auto']}
          />
          <Tooltip
            contentStyle={{
              backgroundColor: '#1e1e2e',
              border: '1px solid #45475a',
              borderRadius: '4px',
              color: '#cdd6f4'
            }}
            labelStyle={{ color: '#cdd6f4' }}
            labelFormatter={(value) => {
              const date = new Date(value);
              return date.toLocaleString([], {
                month: 'short',
                day: 'numeric',
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit'
              });
            }}
          />
          <Line
            type="monotone"
            dataKey="value"
            stroke={color}
            strokeWidth={2}
            dot={{ fill: color, r: 3 }}
            activeDot={{ r: 5 }}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
});

SortableChartItem.displayName = 'SortableChartItem';

const Dashboard: React.FC<DashboardProps> = React.memo(({ temperatureUnit = 'C', telemetryHours = 24, baseUrl }) => {
  const csrfFetch = useCsrfFetch();
  const [favorites, setFavorites] = useState<FavoriteChart[]>([]);
  const [customOrder, setCustomOrder] = useState<string[]>([]);
  const [telemetryData, setTelemetryData] = useState<Map<string, TelemetryData[]>>(new Map());
  const [nodes, setNodes] = useState<Map<string, NodeInfo>>(new Map());
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  // Filter and sort state
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [selectedNode, setSelectedNode] = useState<string>('all');
  const [selectedType, setSelectedType] = useState<string>('all');
  const [selectedRoles, setSelectedRoles] = useState<Set<string>>(new Set());
  const [roleDropdownOpen, setRoleDropdownOpen] = useState<boolean>(false);
  const [sortOption, setSortOption] = useState<SortOption>('custom');

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

  // Fetch favorites and node information
  useEffect(() => {
    const fetchFavoritesAndNodes = async () => {
      try {
        setLoading(true);

        // Fetch favorites and custom order from settings
        const settings = await api.get<{ telemetryFavorites?: string; telemetryCustomOrder?: string }>('/api/settings');
        const favoritesArray: FavoriteChart[] = settings.telemetryFavorites
          ? JSON.parse(settings.telemetryFavorites)
          : [];

        const serverCustomOrder: string[] = settings.telemetryCustomOrder
          ? JSON.parse(settings.telemetryCustomOrder)
          : [];

        setFavorites(favoritesArray);

        // Load custom order - prioritize localStorage over server
        let finalCustomOrder: string[] = [];
        try {
          const localStorageOrder = localStorage.getItem('telemetryCustomOrder');
          if (localStorageOrder) {
            const localOrder = JSON.parse(localStorageOrder);
            // Use localStorage if it has data, otherwise use server order
            finalCustomOrder = localOrder.length > 0 ? localOrder : serverCustomOrder;
          } else {
            // No localStorage data, use server order
            finalCustomOrder = serverCustomOrder;
          }
        } catch (error) {
          logger.error('Error loading custom order from Local Storage:', error);
          // Fallback to server order on error
          finalCustomOrder = serverCustomOrder;
        }

        setCustomOrder(finalCustomOrder);

        // Save the final order to localStorage if not already there
        try {
          localStorage.setItem('telemetryCustomOrder', JSON.stringify(finalCustomOrder));
        } catch (error) {
          logger.error('Error saving custom order to Local Storage:', error);
        }

        // Fetch node information
        const nodesData = await api.get<NodeInfo[]>('/api/nodes');
        const nodesMap = new Map<string, NodeInfo>();
        nodesData.forEach((node: NodeInfo) => {
          if (node.user?.id) {
            nodesMap.set(node.user.id, node);
          }
        });
        setNodes(nodesMap);

        // Fetch telemetry data for each favorite
        const telemetryMap = new Map<string, TelemetryData[]>();

        await Promise.all(
          favoritesArray.map(async (favorite) => {
            try {
              const data: TelemetryData[] = await api.get(`/api/telemetry/${favorite.nodeId}?hours=${telemetryHours}`);
              // Filter to only get the specific telemetry type
              const filteredData = data.filter(d => d.telemetryType === favorite.telemetryType);
              const key = `${favorite.nodeId}-${favorite.telemetryType}`;
              telemetryMap.set(key, filteredData);
            } catch (err) {
              logger.error(`Error fetching telemetry for ${favorite.nodeId}:`, err);
            }
          })
        );

        setTelemetryData(telemetryMap);
        setError(null);
      } catch (err) {
        logger.error('Error in Dashboard:', err);
        setError(err instanceof Error ? err.message : 'Failed to load dashboard data');
      } finally {
        setLoading(false);
      }
    };

    fetchFavoritesAndNodes();
    const interval = setInterval(fetchFavoritesAndNodes, 30000); // Refresh every 30 seconds

    return () => clearInterval(interval);
  }, [telemetryHours, baseUrl]);

  const prepareChartData = (data: TelemetryData[], isTemperature: boolean = false): ChartData[] => {
    return data
      .sort((a, b) => a.timestamp - b.timestamp)
      .map(item => ({
        timestamp: item.timestamp,
        value: isTemperature ? formatTemperature(item.value, 'C', temperatureUnit) : item.value,
        time: new Date(item.timestamp).toLocaleTimeString([], {
          hour: '2-digit',
          minute: '2-digit'
        })
      }));
  };

  const getTelemetryLabel = (type: string): string => {
    const labels: { [key: string]: string } = {
      batteryLevel: 'Battery Level',
      voltage: 'Voltage',
      channelUtilization: 'Channel Utilization',
      airUtilTx: 'Air Utilization (TX)',
      temperature: 'Temperature',
      humidity: 'Humidity',
      pressure: 'Barometric Pressure',
      ch1Voltage: 'Channel 1 Voltage',
      ch1Current: 'Channel 1 Current'
    };
    return labels[type] || type;
  };

  const getColor = (type: string): string => {
    const colors: { [key: string]: string } = {
      batteryLevel: '#82ca9d',
      voltage: '#8884d8',
      channelUtilization: '#ffc658',
      airUtilTx: '#ff7c7c',
      temperature: '#ff8042',
      humidity: '#00c4cc',
      pressure: '#a28dff',
      ch1Voltage: '#d084d8',
      ch1Current: '#ff6b9d'
    };
    return colors[type] || '#8884d8';
  };

  // Calculate global time range across all telemetry data
  const getGlobalTimeRange = (): [number, number] | null => {
    let minTime = Infinity;
    let maxTime = -Infinity;

    telemetryData.forEach((data) => {
      data.forEach((item) => {
        if (item.timestamp < minTime) minTime = item.timestamp;
        if (item.timestamp > maxTime) maxTime = item.timestamp;
      });
    });

    if (minTime === Infinity || maxTime === -Infinity) {
      return null;
    }

    return [minTime, maxTime];
  };

  // Handle drag end
  const handleDragEnd = async (event: DragEndEvent) => {
    const { active, over } = event;

    if (over && active.id !== over.id) {
      const oldIndex = filteredAndSortedFavorites.findIndex(f => `${f.nodeId}-${f.telemetryType}` === active.id);
      const newIndex = filteredAndSortedFavorites.findIndex(f => `${f.nodeId}-${f.telemetryType}` === over.id);

      const newOrder = arrayMove(filteredAndSortedFavorites, oldIndex, newIndex);
      const newCustomOrder = newOrder.map(f => `${f.nodeId}-${f.telemetryType}`);

      setCustomOrder(newCustomOrder);
      setSortOption('custom');

      // Save to Local Storage
      try {
        localStorage.setItem('telemetryCustomOrder', JSON.stringify(newCustomOrder));
      } catch (error) {
        logger.error('Error saving custom order to Local Storage:', error);
      }

      // Save to server
      try {
        await csrfFetch(`${baseUrl}/api/settings`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ telemetryCustomOrder: JSON.stringify(newCustomOrder) })
        });
      } catch (error) {
        logger.error('Error saving custom order:', error);
      }
    }
  };

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
  }, [favorites, nodes, searchQuery, selectedNode, selectedType, selectedRoles, sortOption, customOrder, getTelemetryLabel]);

  const removeFavorite = async (nodeId: string, telemetryType: string) => {
    try {
      const newFavorites = favorites.filter(
        f => !(f.nodeId === nodeId && f.telemetryType === telemetryType)
      );

      // Update local state
      setFavorites(newFavorites);

      // Remove from telemetry data
      const key = `${nodeId}-${telemetryType}`;
      const newTelemetryData = new Map(telemetryData);
      newTelemetryData.delete(key);
      setTelemetryData(newTelemetryData);

      // Save to server
      await csrfFetch(`${baseUrl}/api/settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ telemetryFavorites: JSON.stringify(newFavorites) })
      });
    } catch (error) {
      logger.error('Error removing favorite:', error);
      // Revert on error
      window.location.reload();
    }
  };

  if (loading) {
    return <div className="dashboard-loading">Loading dashboard...</div>;
  }

  if (error) {
    return <div className="dashboard-error">Error: {error}</div>;
  }

  if (favorites.length === 0) {
    return (
      <div className="dashboard-empty">
        <h2>No Favorites Yet</h2>
        <p>Star telemetry charts in the Nodes tab to see them here</p>
      </div>
    );
  }

  // Get global time range for all charts
  const globalTimeRange = getGlobalTimeRange();

  return (
    <div className="dashboard">
      <div className="dashboard-header-section">
        <div>
          <h2 className="dashboard-title">Telemetry Dashboard</h2>
          <p className="dashboard-subtitle">Showing last {telemetryHours} hours of favorited telemetry</p>
        </div>
      </div>

      <div className="dashboard-controls">
        <div className="dashboard-filters">
          <input
            type="text"
            className="dashboard-search"
            placeholder="Search nodes or telemetry types..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />

          <select
            className="dashboard-filter-select"
            value={selectedNode}
            onChange={(e) => setSelectedNode(e.target.value)}
          >
            <option value="all">All Nodes</option>
            {getUniqueNodes.map(([nodeId, nodeName]) => (
              <option key={nodeId} value={nodeId}>{nodeName}</option>
            ))}
          </select>

          <select
            className="dashboard-filter-select"
            value={selectedType}
            onChange={(e) => setSelectedType(e.target.value)}
          >
            <option value="all">All Types</option>
            {getUniqueTelemetryTypes.map((type) => (
              <option key={type} value={type}>{getTelemetryLabel(type)}</option>
            ))}
          </select>

          <div className="dashboard-role-filter-dropdown" ref={roleDropdownRef}>
            <div
              className="dashboard-role-filter-button"
              onClick={handleToggleRoleDropdown}
            >
              <span>
                {selectedRoles.size === 0
                  ? 'Device Roles: All'
                  : `Device Roles: ${selectedRoles.size} selected`}
              </span>
              <span className="dashboard-dropdown-arrow">{roleDropdownOpen ? '▲' : '▼'}</span>
            </div>
            {roleDropdownOpen && (
              <div className="dashboard-role-dropdown-content">
                {getUniqueDeviceRoles.length > 0 ? (
                  <>
                    <label className="dashboard-role-checkbox-label">
                      <input
                        type="checkbox"
                        checked={selectedRoles.size === 0}
                        onChange={handleClearRoleFilter}
                      />
                      <span>All Roles</span>
                    </label>
                    <div className="dashboard-role-divider" />
                    {getUniqueDeviceRoles.map((role) => (
                      <label key={role} className="dashboard-role-checkbox-label">
                        <input
                          type="checkbox"
                          checked={selectedRoles.has(role)}
                          onChange={(e) => handleToggleRole(role, e.target.checked)}
                        />
                        <span>{role}</span>
                      </label>
                    ))}
                  </>
                ) : (
                  <span className="dashboard-no-roles">No roles available</span>
                )}
              </div>
            )}
          </div>
        </div>

        <div className="dashboard-sort">
          <label htmlFor="sort-select">Sort by:</label>
          <select
            id="sort-select"
            className="dashboard-sort-select"
            value={sortOption}
            onChange={(e) => setSortOption(e.target.value as SortOption)}
          >
            <option value="custom">Custom Order (Drag & Drop)</option>
            <option value="node-asc">Node Name (A-Z)</option>
            <option value="node-desc">Node Name (Z-A)</option>
            <option value="type-asc">Telemetry Type (A-Z)</option>
            <option value="type-desc">Telemetry Type (Z-A)</option>
          </select>
        </div>
      </div>

      <div className="dashboard-results-info">
        Showing {filteredAndSortedFavorites.length} of {favorites.length} chart{favorites.length !== 1 ? 's' : ''}
      </div>

      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragEnd={handleDragEnd}
      >
        <SortableContext
          items={filteredAndSortedFavorites.map(f => `${f.nodeId}-${f.telemetryType}`)}
          strategy={verticalListSortingStrategy}
        >
          <div className="dashboard-grid">
            {filteredAndSortedFavorites.map((favorite) => {
              const key = `${favorite.nodeId}-${favorite.telemetryType}`;
              const data = telemetryData.get(key) || [];
              const node = nodes.get(favorite.nodeId);

              return (
                <SortableChartItem
                  key={key}
                  id={key}
                  favorite={favorite}
                  data={data}
                  node={node}
                  temperatureUnit={temperatureUnit}
                  globalTimeRange={globalTimeRange}
                  onRemove={removeFavorite}
                  getTelemetryLabel={getTelemetryLabel}
                  getColor={getColor}
                  prepareChartData={prepareChartData}
                />
              );
            })}
          </div>
        </SortableContext>
      </DndContext>
    </div>
  );
});

Dashboard.displayName = 'Dashboard';

export default Dashboard;