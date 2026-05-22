/**
 * MeshCoreTelemetryView — Dashboard-style favorite-telemetry view for a
 * MeshCore source. Mounts the shared per-source `Dashboard` component
 * with the MeshCore data-source adapter so a user's starred MeshCore
 * charts (from any DM or node view) land in one place.
 *
 * Closes the "I can favorit graphs also in meshcore, but where does it
 * show up" gap from #3139.
 */
import React from 'react';
import Dashboard from '../Dashboard/Dashboard';
import { meshcoreDashboardSource } from '../Dashboard/dataSources';
import { useSettings } from '../../contexts/SettingsContext';
import { useAuth } from '../../contexts/AuthContext';

interface MeshCoreTelemetryViewProps {
  baseUrl: string;
}

export const MeshCoreTelemetryView: React.FC<MeshCoreTelemetryViewProps> = ({ baseUrl }) => {
  const { temperatureUnit, telemetryVisualizationHours, favoriteTelemetryStorageDays } = useSettings();
  const { hasPermission } = useAuth();

  return (
    <Dashboard
      baseUrl={baseUrl}
      dataSource={meshcoreDashboardSource}
      temperatureUnit={temperatureUnit}
      telemetryHours={telemetryVisualizationHours}
      favoriteTelemetryStorageDays={favoriteTelemetryStorageDays}
      canEdit={hasPermission('dashboard', 'write')}
    />
  );
};

export default MeshCoreTelemetryView;
