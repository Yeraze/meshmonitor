/**
 * MeshCoreCompanionRemoteConsole (#5867)
 *
 * CLI console for another Companion (fw 1.18.0+). There is no login: the
 * target runs our commands only if ITS contact entry for this radio has the
 * remote-CLI bit (0x10). Without it the target stays silent and the command
 * times out. Every command is a DM out and a reply back, so it is blocked in
 * receive-only mode and when the radio does not hold the contact.
 */
import React, { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import type { MeshCoreActions } from './hooks/useMeshCore';
import { CliConsoleBody, type ActionCommand } from './CliConsoleBody';
import { useSource } from '../../contexts/SourceContext';
import './MeshCoreRemoteConsole.css';
import styles from './MeshCoreCompanionCli.module.css';

/** Read-only verbs a 1.18 companion's CLI answers, plus a danger Reboot. */
const COMPANION_REMOTE_ACTION_CATALOG: ActionCommand[] = [
  { key: 'ver',    labelKey: 'meshcore.remoteConsole.action.ver',    defaultLabel: 'Version', command: 'ver' },
  { key: 'radio',  labelKey: 'meshcore.localConsole.action.radio',   defaultLabel: 'Radio',   command: 'get radio' },
  { key: 'tx',     labelKey: 'meshcore.localConsole.action.tx',      defaultLabel: 'TX power', command: 'get tx' },
  { key: 'name',   labelKey: 'meshcore.companionConsole.action.name', defaultLabel: 'Name',   command: 'get name' },
  { key: 'reboot', labelKey: 'meshcore.remoteConsole.action.reboot', defaultLabel: 'Reboot',  command: 'reboot', danger: true },
];

interface MeshCoreCompanionRemoteConsoleProps {
  publicKey: string;
  contactName: string;
  actions: Pick<MeshCoreActions, 'sendCliCommand'>;
  receiveOnly?: boolean;
  notOnDevice?: boolean;
}

export const MeshCoreCompanionRemoteConsole: React.FC<MeshCoreCompanionRemoteConsoleProps> = ({
  publicKey,
  contactName,
  actions,
  receiveOnly = false,
  notOnDevice = false,
}) => {
  const { t } = useTranslation();
  const { sourceId } = useSource();
  const blocked = receiveOnly || notOnDevice;
  const runCommand = useCallback(
    (text: string, opts?: { confirm?: boolean }) => actions.sendCliCommand(publicKey, text, opts),
    [actions, publicKey],
  );

  return (
    <section className="meshcore-remote-console" aria-label={t('meshcore.companionConsole.title', 'Remote console')}>
      <header className="mrc-header">
        <h3 className="mrc-title">{t('meshcore.companionConsole.title', 'Remote console')}</h3>
      </header>
      <p className={styles.hint}>
        {t(
          'meshcore.companionConsole.hint',
          'Needs firmware 1.18.0 on both radios. The other companion answers only if it allows remote CLI for this radio; otherwise the command times out.',
        )}
      </p>
      <CliConsoleBody
        targetId={publicKey}
        targetName={contactName}
        history={sourceId ? { sourceId, target: publicKey } : undefined}
        runCommand={runCommand}
        actionCatalog={blocked ? [] : COMPANION_REMOTE_ACTION_CATALOG}
        disabled={blocked}
        disabledPlaceholder={receiveOnly
          ? t('meshcore.receive_only.control_tooltip', 'Receive-only mode is on for this MeshCore source. Turn it off in MeshCore Settings to use this.')
          : t('meshcore.not_on_device.control_tooltip', "This node is not in the radio's contact list. Add it to the radio first.")}
        placeholder={t('meshcore.companionConsole.placeholder', 'Type a CLI command (ver, get radio, get name, set tz.offset…)')}
        emptyTextDisabled={t('meshcore.companionConsole.empty_disabled', 'Commands to this contact are unavailable right now.')}
        emptyTextEnabled={t('meshcore.companionConsole.empty_enabled', 'Each command is sent over the air as a direct message.')}
      />
    </section>
  );
};
