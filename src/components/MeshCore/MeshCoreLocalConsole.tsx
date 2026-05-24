/**
 * MeshCoreLocalConsole
 *
 * Console for the LOCALLY connected MeshCore node. Mounted from the
 * MeshCore configuration view so a user can poke at the device they're
 * directly attached to (the same way they'd use the remote console for
 * a distant repeater).
 *
 * No auth / credential layer — the connection is physical (USB serial or
 * direct TCP), so there is no admin password concept. The HTTP route
 * separately gates this on `configuration:write`.
 *
 * Behavior is driven by the connected firmware (server-side dispatch in
 * MeshCoreManager.sendLocalCliCommand):
 *   - Repeater / Room Server → device's native text CLI.
 *   - Companion → small synthetic CLI (ver, stats, clock, advert, help).
 *
 * The command catalog adapts to the device type so users see buttons for
 * commands that actually work on their hardware.
 */

import React, { useCallback, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import type { MeshCoreActions } from './hooks/useMeshCore';
import { CliConsoleBody, type ActionCommand, type CliConsoleBodyHandle } from './CliConsoleBody';
import { MeshCoreAclManager } from './MeshCoreAclManager';
import './MeshCoreRemoteConsole.css';

/** Verbs that the synthetic Companion CLI implements. Keep in sync with
 *  MeshCoreManager.runSyntheticLocalCli. */
const COMPANION_ACTION_CATALOG: ActionCommand[] = [
  { key: 'ver',    labelKey: 'meshcore.localConsole.action.ver',    defaultLabel: 'Version', command: 'ver' },
  { key: 'stats',  labelKey: 'meshcore.localConsole.action.stats',  defaultLabel: 'Stats',   command: 'stats' },
  { key: 'clock',  labelKey: 'meshcore.localConsole.action.clock',  defaultLabel: 'Clock',   command: 'clock' },
  { key: 'advert', labelKey: 'meshcore.localConsole.action.advert', defaultLabel: 'Send advert', command: 'advert' },
  { key: 'help',   labelKey: 'meshcore.localConsole.action.help',   defaultLabel: 'Help',    command: 'help' },
];

/** Repeater / Room Server firmware: the native serial CLI handles a
 *  much larger command set. We surface the same safe verbs as the
 *  remote-Repeater console for consistency, plus a danger Reboot. */
const REPEATER_ACTION_CATALOG: ActionCommand[] = [
  { key: 'ver',       labelKey: 'meshcore.remoteConsole.action.ver',       defaultLabel: 'Version',  command: 'ver' },
  { key: 'stats',     labelKey: 'meshcore.remoteConsole.action.stats',     defaultLabel: 'Stats',    command: 'stats' },
  { key: 'neighbors', labelKey: 'meshcore.remoteConsole.action.neighbors', defaultLabel: 'Neighbors', command: 'neighbors' },
  { key: 'clock',     labelKey: 'meshcore.remoteConsole.action.clock',     defaultLabel: 'Clock',    command: 'clock' },
  { key: 'advert',    labelKey: 'meshcore.remoteConsole.action.advert',    defaultLabel: 'Send advert', command: 'advert' },
  { key: 'reboot',    labelKey: 'meshcore.remoteConsole.action.reboot',    defaultLabel: 'Reboot',   command: 'reboot', danger: true },
];

interface MeshCoreLocalConsoleProps {
  /** Display name of the local device — shown in the danger-confirm
   *  modal. Falls back to "this device" when no name is set. */
  deviceName?: string;
  /** Owning source id — used as the targetId so the transcript resets
   *  when the user switches sources. */
  sourceId: string;
  /** MeshCore device type from status.deviceType (0=Unknown, 1=Companion,
   *  2=Repeater, 3=RoomServer). Drives the command catalog. */
  deviceType?: number;
  /** Whether the source is currently connected. Disables the console
   *  when false — sending to a disconnected source would just timeout. */
  connected: boolean;
  actions: Pick<MeshCoreActions, 'sendLocalCliCommand'>;
}

export const MeshCoreLocalConsole: React.FC<MeshCoreLocalConsoleProps> = ({
  deviceName,
  sourceId,
  deviceType,
  connected,
  actions,
}) => {
  const { t } = useTranslation();

  const targetName = deviceName || t('meshcore.localConsole.default_target', 'this device');

  // Repeater (2) and RoomServer (3) share the same catalog. Companion (1)
  // gets the synthetic catalog. Unknown (0) shows no quick actions —
  // the user can still type free-form commands.
  const actionCatalog = useMemo<ActionCommand[]>(() => {
    if (deviceType === 2 || deviceType === 3) return REPEATER_ACTION_CATALOG;
    if (deviceType === 1) return COMPANION_ACTION_CATALOG;
    return [];
  }, [deviceType]);

  const runCommand = useCallback(
    (text: string, opts?: { confirm?: boolean }) => actions.sendLocalCliCommand(text, opts),
    [actions],
  );

  // ACL management is meaningful on Repeater (2) and Room Server (3)
  // local firmware. Companion has no ACL concept.
  const showAcl = connected && (deviceType === 2 || deviceType === 3);
  const bodyRef = useRef<CliConsoleBodyHandle | null>(null);

  return (
    <section className="meshcore-remote-console" aria-label={t('meshcore.localConsole.title', 'Device console')}>
      <header className="mrc-header">
        <h3 className="mrc-title">{t('meshcore.localConsole.title', 'Device console')}</h3>
        <div className="mrc-status">
          {connected ? (
            <span className="mrc-status-chip mrc-status-ok">
              {t('meshcore.localConsole.connected', 'Connected')}
            </span>
          ) : (
            <span className="mrc-status-chip mrc-status-idle">
              {t('meshcore.localConsole.disconnected', 'Not connected')}
            </span>
          )}
        </div>
      </header>

      <CliConsoleBody
        ref={bodyRef}
        targetId={sourceId}
        targetName={targetName}
        runCommand={runCommand}
        actionCatalog={connected ? actionCatalog : []}
        disabled={!connected}
        disabledPlaceholder={t('meshcore.localConsole.disconnected_placeholder', 'Connect the source to send commands')}
        placeholder={
          deviceType === 1
            ? t(
                'meshcore.localConsole.companion_placeholder',
                'Type a command (ver, stats, clock, advert, help)',
              )
            : t(
                'meshcore.localConsole.repeater_placeholder',
                'Type a CLI command (ver, stats, neighbors, advert…)',
              )
        }
        emptyTextDisabled={t(
          'meshcore.localConsole.empty_disconnected',
          'Connect the source to begin sending commands.',
        )}
        emptyTextEnabled={t(
          'meshcore.localConsole.empty_connected',
          'Type a command below and press Send.',
        )}
      />

      {showAcl && <MeshCoreAclManager bodyRef={bodyRef} />}
    </section>
  );
};
