import React, { useState, useMemo, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
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
import { useSettings } from '../../contexts/SettingsContext';

// Telemetry types that should show solar by default (power/environmental)
const SOLAR_DEFAULT_ON_TYPES = new Set([
  'batteryLevel', 'voltage', 'ch1Voltage', 'ch1Current',
  'ch2Voltage', 'ch2Current', 'ch3Voltage', 'ch3Current',
  'ch4Voltage', 'ch4Current', 'ch5Voltage', 'ch5Current',
  'ch6Voltage', 'ch6Current', 'ch7Voltage', 'ch7Current',
  'ch8Voltage', 'ch8Current', 'temperature', 'humidity', 'pressure',
]);

const Dashboard: React.FC<DashboardProps> = React.memo(
  ({
    temperatureUnit = 'C',
    telemetryHours: _telemetryHours = 24,
    favoriteTelemetryStorageDays = 7,
    baseUrl,
    currentNodeId = null,
    canEdit = true,
  }) => {
    const { t } = useTranslation();
    const csrfFetch = useCsrfFetch();
    const { solarMonitoringEnabled, preferredDashboardSortOption } = useSettings();

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
      solarVisibility,
      setSolarVisibility,
      loading,
      error,
    } = useDashboardData();

    // Get solar visibility for a specific chart (uses type-based default if not set)
    const getSolarVisibility = useCallback((nodeId: string, telemetryType: string): boolean => {
      const key = `${nodeId}-${telemetryType}`;
      if (key in solarVisibility) {
        return solarVisibility[key];
      }
      // Default based on telemetry type
      return SOLAR_DEFAULT_ON_TYPES.has(telemetryType);
    }, [solarVisibility]);

    // Toggle solar visibility for a specific chart and save to server
    const handleToggleSolar = useCallback(async (nodeId: string, telemetryType: string, show: boolean) => {
      const key = `${nodeId}-${telemetryType}`;
      const newSolarVisibility = {
        ...solarVisibility,
        [key]: show,
      };

      // Update local state immediately
      setSolarVisibility(newSolarVisibility);

      // Save to server
      try {
        await csrfFetch(`${baseUrl}/api/settings`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ dashboardSolarVisibility: JSON.stringify(newSolarVisibility) }),
        });
      } catch (err) {
        logger.error('Error saving solar visibility:', err);
      }
    }, [solarVisibility, setSolarVisibility, csrfFetch, baseUrl]);

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
      defaultSortOption: preferredDashboardSortOption,
    });

    // Widgets hook
    const { addWidget, removeWidget, addNodeToWidget, removeNodeFromWidget, selectTracerouteNode } = useCustomWidgets({
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
    const handleDragEnd = useCallback(
      async (event: DragEndEvent) => {
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
      },
      [filteredAndSortedFavorites, setCustomOrder, setSortOption, csrfFetch, baseUrl]
    );

    // Remove favorite
    const removeFavorite = useCallback(
      async (nodeId: string, telemetryType: string) => {
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
      },
      [favorites, setFavorites, baseUrl, csrfFetch]
    );

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
            solarMonitoringEnabled={solarMonitoringEnabled}
            getSolarVisibility={getSolarVisibility}
            onToggleSolar={handleToggleSolar}
          />
        )}

        {!hasContent && (
          <div className="dashboard-empty">
            <h2>{t('dashboard.empty_title')}</h2>
            <p>{t('dashboard.empty_description')}</p>
          </div>
        )}
      </div>
    );
  }
);

Dashboard.displayName = 'Dashboard';

export default Dashboard;
