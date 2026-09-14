/**
 * Mounts the configuration palette and owns its shortcut (#5182).
 *
 * Split from the modal so the two surfaces that can host it — the per-source
 * app and the standalone global settings page — each add one line rather than
 * repeating the state, the permission reads and the key handler.
 *
 * The shortcut is Ctrl/Cmd+comma, the conventional "preferences" chord. Ctrl+K
 * was already taken by message search, and the obvious palette chords collide
 * with the browser (Ctrl+Shift+P opens a private window in Firefox,
 * Ctrl+Shift+K opens its console).
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../../contexts/AuthContext';
import { useSource } from '../../contexts/SourceContext';
import { useHealth } from '../../hooks/useHealth';
import { buildConfigSurfaces } from './configSections';
import ConfigSearchModal from './ConfigSearchModal';

interface ConfigSearchHostProps {
  /** Base URL for the health probe, matching what the app already passes. */
  baseUrl?: string;
  /**
   * Lets the hosting surface open the palette from its own chrome (the sidebar
   * entry) as well as from the keyboard.
   */
  registerOpener?: (open: () => void) => void;
}

export const ConfigSearchHost: React.FC<ConfigSearchHostProps> = ({ baseUrl = '', registerOpener }) => {
  const { t } = useTranslation();
  const { authStatus, hasPermission } = useAuth();
  const { sourceId } = useSource();
  const [isOpen, setIsOpen] = useState(false);

  // Shares TanStack's ['health', baseUrl] cache with App's own poll, so this is
  // a cache read rather than a second request. It only decides whether two
  // conditional sections (Database Maintenance, Firmware Updates) are offered.
  const { data: health } = useHealth({ baseUrl, refetchInterval: 60000 });

  const isAdmin = authStatus?.user?.isAdmin ?? false;
  // Mirrors SettingsTab's own gate: the tab hosts global and per-source panels
  // behind one mostly-unscoped permission, so anySource matches the server.
  const canWriteSettings = hasPermission('settings', 'write', { anySource: true });

  const surfaces = useMemo(
    () =>
      buildConfigSurfaces(t, {
        sourceId,
        isAdmin,
        canWriteSettings,
        canUseAdmin: isAdmin,
        databaseType: health?.databaseType ?? null,
        firmwareOtaEnabled: health?.firmwareOtaEnabled ?? false,
      }),
    [t, sourceId, isAdmin, canWriteSettings, health?.databaseType, health?.firmwareOtaEnabled],
  );

  const open = useCallback(() => setIsOpen(true), []);
  const close = useCallback(() => setIsOpen(false), []);

  useEffect(() => {
    registerOpener?.(open);
  }, [registerOpener, open]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key === ',') {
        e.preventDefault();
        setIsOpen((prev) => !prev);
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, []);

  return <ConfigSearchModal isOpen={isOpen} onClose={close} surfaces={surfaces} />;
};

export default ConfigSearchHost;
