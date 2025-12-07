import React, { useState, useMemo, useCallback } from 'react';
import { arrayMove } from '@dnd-kit/sortable';
import { DragEndEvent } from '@dnd-kit/core';
import '../Dashboard.css';
import { logger } from '../../utils/logger';
import { useCsrfFetch } from '../../hooks/useCsrfFetch';
import { useSolarEstimatesLatest } from '../../hooks/useTelemetry';
import { type TelemetryData } from '../../hooks/useTelemetry';
import AddWidgetModal from '../AddWidgetModal';
import { DashboardHeader, DashboardFilters, DashboardGrid } from './components';
import { useDashboardData, useDashboardFilters, useCustomWidgets } from './hooks';
import { type DashboardProps } from './types';

const Dashboard: React.FC<DashboardProps> = React.memo(({
  temperatureUnit = 'C',
  telemetryHours: _telemetryHours = 24,
  favoriteTelemetryStorageDays = 7,
  baseUrl,
  currentNodeId = null,
  canEdit = true,
}) => {
  const csrfFetch = useCsrfFetch();
  
  // Modal state
  const [showAddWidgetModal, setShowAddWidgetModal] = useState(false);

  // Track telemetry data from charts for global time range calculation
  const [telemetryDataMap, setTelemetryDataMap] = useState<Map<string, TelemetryData[]>>(new Map());

  // Data fetching hook
  const {
    favorites,
    setFavorites,
    customOrder,
    setCustomOrder,
    nodes,
    customWidgets,
    setCustomWidgets,
    loading,
    error,
  } = useDashboardData();

  // Filters hook
  const {
    searchQuery,
    setSearchQuery,
    selectedNode,
    setSelectedNode,
    selectedType,
    setSelectedType,
    selectedRoles,
    sortOption,
    setSortOption,
    daysToView,
    setDaysToView,
    roleDropdownOpen,
    handleToggleRoleDropdown,
    handleClearRoleFilter,
    handleToggleRole,
    filteredAndSortedFavorites,
    uniqueNodes,
    uniqueTelemetryTypes,
    uniqueDeviceRoles,
  } = useDashboardFilters({
    favorites,
    nodes,
    customOrder,
    favoriteTelemetryStorageDays,
  });

  // Widgets hook
  const {
    addWidget,
    removeWidget,
    addNodeToWidget,
    removeNodeFromWidget,
    selectTracerouteNode,
  } = useCustomWidgets({
    baseUrl,
    customWidgets,
    setCustomWidgets,
  });

  // Fetch solar estimates using TanStack Query hook
  const { data: solarEstimates } = useSolarEstimatesLatest({
    baseUrl,
    limit: 500,
    enabled: true,
  });

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

  // Handle drag end
  const handleDragEnd = useCallback(async (event: DragEndEvent) => {
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
      } catch (err) {
        logger.error('Error saving custom order to Local Storage:', err);
      }

      // Save to server
      try {
        await csrfFetch(`${baseUrl}/api/settings`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ telemetryCustomOrder: JSON.stringify(newCustomOrder) }),
        });
      } catch (err) {
        logger.error('Error saving custom order:', err);
      }
    }
  }, [filteredAndSortedFavorites, setCustomOrder, setSortOption, csrfFetch, baseUrl]);

  // Remove favorite
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
    } catch (err) {
      logger.error('Error removing favorite:', err);
      // Revert on error
      window.location.reload();
    }
  }, [favorites, setFavorites, baseUrl, csrfFetch]);

  if (loading) {
    return <div className="dashboard-loading">Loading dashboard...</div>;
  }

  if (error) {
    return <div className="dashboard-error">Error: {error}</div>;
  }

  const hours = daysToView * 24;
  const hasContent = favorites.length > 0 || customWidgets.length > 0;

  return (
    <div className="dashboard">
      <DashboardHeader
        favoritesCount={favorites.length}
        daysToView={daysToView}
        onAddWidgetClick={() => setShowAddWidgetModal(true)}
      />

      <AddWidgetModal
        isOpen={showAddWidgetModal}
        onClose={() => setShowAddWidgetModal(false)}
        onAddWidget={addWidget}
      />

      <DashboardFilters
        daysToView={daysToView}
        maxDays={favoriteTelemetryStorageDays}
        onDaysToViewChange={setDaysToView}
        searchQuery={searchQuery}
        onSearchChange={setSearchQuery}
        selectedNode={selectedNode}
        onNodeChange={setSelectedNode}
        uniqueNodes={uniqueNodes}
        selectedType={selectedType}
        onTypeChange={setSelectedType}
        uniqueTypes={uniqueTelemetryTypes}
        selectedRoles={selectedRoles}
        uniqueRoles={uniqueDeviceRoles}
        roleDropdownOpen={roleDropdownOpen}
        onToggleRoleDropdown={handleToggleRoleDropdown}
        onClearRoleFilter={handleClearRoleFilter}
        onToggleRole={handleToggleRole}
        sortOption={sortOption}
        onSortChange={setSortOption}
      />

      {hasContent && (
        <DashboardGrid
          customWidgets={customWidgets}
          onRemoveWidget={removeWidget}
          onAddNodeToWidget={addNodeToWidget}
          onRemoveNodeFromWidget={removeNodeFromWidget}
          onSelectTracerouteNode={selectTracerouteNode}
          favorites={filteredAndSortedFavorites}
          nodes={nodes}
          currentNodeId={currentNodeId}
          temperatureUnit={temperatureUnit}
          hours={hours}
          baseUrl={baseUrl}
          globalTimeRange={globalTimeRange}
          globalMinTime={globalMinTime}
          solarEstimates={solarEstimates || new Map()}
          onRemoveFavorite={removeFavorite}
          onDataLoaded={handleDataLoaded}
          onDragEnd={handleDragEnd}
          widgetsCount={customWidgets.length}
          favoritesCount={favorites.length}
          filteredCount={filteredAndSortedFavorites.length}
          canEdit={canEdit}
        />
      )}

      {!hasContent && (
        <div className="dashboard-empty">
          <h2>No Widgets or Favorites Yet</h2>
          <p>Click &quot;+ Add Widget&quot; above or star telemetry charts in the Nodes tab</p>
        </div>
      )}
    </div>
  );
});

Dashboard.displayName = 'Dashboard';

export default Dashboard;
