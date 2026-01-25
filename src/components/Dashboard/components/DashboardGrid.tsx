import React from 'react';
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
import { SortableContext, sortableKeyboardCoordinates, verticalListSortingStrategy } from '@dnd-kit/sortable';
import TelemetryChart from '../../TelemetryChart';
import PacketRateChart, { isPacketRateType } from '../../PacketRateChart';
import SmartHopsChart, { isSmartHopsType } from '../../SmartHopsChart';
import LinkQualityChart, { isLinkQualityType } from '../../LinkQualityChart';
import NodeStatusWidget from '../../NodeStatusWidget';
import TracerouteWidget from '../../TracerouteWidget';
import {
  type CustomWidget,
  type FavoriteChart,
  type NodeInfo,
  type TelemetryData,
  type TemperatureUnit,
} from '../types';

interface DashboardGridProps {
  // Widgets
  customWidgets: CustomWidget[];
  onRemoveWidget: (widgetId: string) => void;
  onAddNodeToWidget: (widgetId: string, nodeId: string) => void;
  onRemoveNodeFromWidget: (widgetId: string, nodeId: string) => void;
  onSelectTracerouteNode: (widgetId: string, nodeId: string) => void;

  // Charts
  favorites: FavoriteChart[];
  nodes: Map<string, NodeInfo>;
  currentNodeId: string | null;
  temperatureUnit: TemperatureUnit;
  hours: number;
  baseUrl: string;
  globalTimeRange: [number, number] | null;
  globalMinTime: number | undefined;
  solarEstimates: Map<number, number>;
  onRemoveFavorite: (nodeId: string, telemetryType: string) => void;
  onDataLoaded: (key: string, data: TelemetryData[]) => void;

  // Drag and drop
  onDragEnd: (event: DragEndEvent) => void;

  // Stats
  widgetsCount: number;
  favoritesCount: number;
  filteredCount: number;

  // Permissions
  canEdit?: boolean;

  // Solar monitoring
  solarMonitoringEnabled?: boolean;
  getSolarVisibility?: (nodeId: string, telemetryType: string) => boolean;
  onToggleSolar?: (nodeId: string, telemetryType: string, show: boolean) => void;
}

const DashboardGrid: React.FC<DashboardGridProps> = ({
  customWidgets,
  onRemoveWidget,
  onAddNodeToWidget,
  onRemoveNodeFromWidget,
  onSelectTracerouteNode,
  favorites,
  nodes,
  currentNodeId,
  temperatureUnit,
  hours,
  baseUrl,
  globalTimeRange,
  globalMinTime,
  solarEstimates,
  onRemoveFavorite,
  onDataLoaded,
  onDragEnd,
  widgetsCount,
  favoritesCount,
  filteredCount,
  canEdit = true,
  solarMonitoringEnabled = false,
  getSolarVisibility,
  onToggleSolar,
}) => {
  const { t } = useTranslation();

  // Drag and drop sensors
  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

  return (
    <>
      <div className="dashboard-results-info">
        {widgetsCount > 0 &&
          t(widgetsCount !== 1 ? 'dashboard.widget_count_plural' : 'dashboard.widget_count', { count: widgetsCount })}
        {widgetsCount > 0 && favoritesCount > 0 && ', '}
        {favoritesCount > 0 &&
          t(favoritesCount !== 1 ? 'dashboard.chart_count_plural' : 'dashboard.chart_count', {
            shown: filteredCount,
            total: favoritesCount,
          })}
      </div>

      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <SortableContext
          items={[...customWidgets.map(w => w.id), ...favorites.map(f => `${f.nodeId}-${f.telemetryType}`)]}
          strategy={verticalListSortingStrategy}
        >
          <div className="dashboard-grid">
            {/* Custom Widgets */}
            {customWidgets.map(widget => {
              if (widget.type === 'nodeStatus') {
                return (
                  <NodeStatusWidget
                    key={widget.id}
                    id={widget.id}
                    nodeIds={widget.nodeIds}
                    nodes={nodes}
                    onRemove={() => onRemoveWidget(widget.id)}
                    onAddNode={nodeId => onAddNodeToWidget(widget.id, nodeId)}
                    onRemoveNode={nodeId => onRemoveNodeFromWidget(widget.id, nodeId)}
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
                    onRemove={() => onRemoveWidget(widget.id)}
                    onSelectNode={nodeId => onSelectTracerouteNode(widget.id, nodeId)}
                    canEdit={canEdit}
                  />
                );
              }
              return null;
            })}

            {/* Telemetry Charts */}
            {favorites.map(favorite => {
              const key = `${favorite.nodeId}-${favorite.telemetryType}`;
              const node = nodes.get(favorite.nodeId);

              // Use PacketRateChart for packet rate types
              if (isPacketRateType(favorite.telemetryType)) {
                return (
                  <PacketRateChart
                    key={key}
                    id={key}
                    favorite={favorite}
                    node={node}
                    hours={hours}
                    baseUrl={baseUrl}
                    globalTimeRange={globalTimeRange}
                    onRemove={onRemoveFavorite}
                  />
                );
              }

              // Use SmartHopsChart for smart hops type
              if (isSmartHopsType(favorite.telemetryType)) {
                return (
                  <SmartHopsChart
                    key={key}
                    id={key}
                    favorite={favorite}
                    node={node}
                    hours={hours}
                    baseUrl={baseUrl}
                    globalTimeRange={globalTimeRange}
                    onRemove={onRemoveFavorite}
                  />
                );
              }

              // Use LinkQualityChart for link quality type
              if (isLinkQualityType(favorite.telemetryType)) {
                return (
                  <LinkQualityChart
                    key={key}
                    id={key}
                    favorite={favorite}
                    node={node}
                    hours={hours}
                    baseUrl={baseUrl}
                    globalTimeRange={globalTimeRange}
                    onRemove={onRemoveFavorite}
                  />
                );
              }

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
                  solarEstimates={solarEstimates}
                  onRemove={onRemoveFavorite}
                  onDataLoaded={onDataLoaded}
                  showSolar={getSolarVisibility ? getSolarVisibility(favorite.nodeId, favorite.telemetryType) : true}
                  onToggleSolar={onToggleSolar}
                  solarMonitoringEnabled={solarMonitoringEnabled}
                />
              );
            })}
          </div>
        </SortableContext>
      </DndContext>
    </>
  );
};

export default DashboardGrid;
