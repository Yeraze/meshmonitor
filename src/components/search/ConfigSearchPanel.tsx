/**
 * The configuration palette's body: builds the searchable surfaces for the
 * viewer and renders the modal (#5182).
 *
 * Split from `ConfigSearchHost` so the section catalogue and the modal load
 * as a lazy chunk on the first open, not with every page that hosts the
 * shortcut.
 */
import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../../contexts/AuthContext';
import { useSource } from '../../contexts/SourceContext';
import { useHealth } from '../../hooks/useHealth';
import { buildConfigSurfaces } from './configSections';
import ConfigSearchModal from './ConfigSearchModal';

export interface ConfigSearchPanelProps {
  /** Base URL for the health probe, matching what the app already passes. */
  baseUrl: string;
  isOpen: boolean;
  onClose: () => void;
}

const ConfigSearchPanel: React.FC<ConfigSearchPanelProps> = ({ baseUrl, isOpen, onClose }) => {
  const { t } = useTranslation();
  const { authStatus, hasPermission } = useAuth();
  // sourceType (#5277 P2 WP3) gates settings-coverage-mqtt to MQTT-only
  // sources — without it the palette would never surface that section, even
  // while viewing an MQTT source (settingsNavItems drops it silently).
  const { sourceId, sourceType } = useSource();

  // Shares TanStack's ['health', baseUrl] cache with App's own poll, so this is
  // a cache read rather than a second request. It only decides whether two
  // conditional sections (Database Maintenance, Firmware Updates) are offered.
  const { data: health } = useHealth({ baseUrl, refetchInterval: 60000 });

  const isAdmin = authStatus?.user?.isAdmin ?? false;
  // Mirrors SettingsTab's own gate: the tab hosts global and per-source panels
  // behind one mostly-unscoped permission, so anySource matches the server.
  const canWriteSettings = hasPermission('settings', 'write', { anySource: true });
  // Sections that moved onto Settings keep their own grant (#5683 follow-up):
  // the palette offers them to the viewers the page shows them to.
  const canReadSources = hasPermission('sources', 'read');
  const canReadConfiguration = hasPermission('configuration', 'read');

  const surfaces = useMemo(
    () =>
      buildConfigSurfaces(t, {
        sourceId,
        sourceType,
        isAdmin,
        canWriteSettings,
        canUseAdmin: isAdmin,
        canReadSources,
        canReadConfiguration,
        databaseType: health?.databaseType ?? null,
        firmwareOtaEnabled: health?.firmwareOtaEnabled ?? false,
      }),
    [t, sourceId, sourceType, isAdmin, canWriteSettings, canReadSources, canReadConfiguration, health?.databaseType, health?.firmwareOtaEnabled],
  );

  return <ConfigSearchModal isOpen={isOpen} onClose={onClose} surfaces={surfaces} />;
};

export default ConfigSearchPanel;
