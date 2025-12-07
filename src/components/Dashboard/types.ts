import { type TemperatureUnit } from '../../utils/temperature';
import { type TelemetryData } from '../../hooks/useTelemetry';
import { type FavoriteChart, type NodeInfo } from '../TelemetryChart';

// Custom widget types for node status and traceroute
export interface NodeStatusWidgetConfig {
  id: string;
  type: 'nodeStatus';
  nodeIds: string[];
}

export interface TracerouteWidgetConfig {
  id: string;
  type: 'traceroute';
  targetNodeId: string | null;
}

export type CustomWidget = NodeStatusWidgetConfig | TracerouteWidgetConfig;

export type SortOption = 'custom' | 'node-asc' | 'node-desc' | 'type-asc' | 'type-desc';

export interface DashboardProps {
  temperatureUnit?: TemperatureUnit;
  telemetryHours?: number;
  favoriteTelemetryStorageDays?: number;
  baseUrl: string;
  currentNodeId?: string | null;
  canEdit?: boolean;
}

export interface DashboardFiltersState {
  searchQuery: string;
  selectedNode: string;
  selectedType: string;
  selectedRoles: Set<string>;
  sortOption: SortOption;
  daysToView: number;
}

export interface DashboardDataState {
  favorites: FavoriteChart[];
  customOrder: string[];
  nodes: Map<string, NodeInfo>;
  customWidgets: CustomWidget[];
  telemetryDataMap: Map<string, TelemetryData[]>;
  loading: boolean;
  error: string | null;
}

// Re-export types from other modules for convenience
export type { FavoriteChart, NodeInfo };
export type { TelemetryData };
export type { TemperatureUnit };
