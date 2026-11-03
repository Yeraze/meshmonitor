/**
 * MeshtasticRemoteCliConsole (#6154)
 *
 * Free-form remote-admin CLI console for a selected remote Meshtastic node.
 * The operator types ONLY the CLI arguments; the fixed prefix
 * `meshtastic --dest !xxxxxxxx` is shown ahead of the input, and the command
 * output is rendered in the transcript.
 *
 * Reuses the shared `CliConsoleBody` primitive (same component the MeshCore
 * consoles use), so the typed-name danger-confirm modal — gated on
 * DANGER_COMMAND_PATTERN — comes for free. The server enforces the same
 * danger guard with `confirm:true`, and relays the command to the node through
 * that source's Virtual Node.
 */

import React, { useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { CliConsoleBody, type CliRunResult } from '../MeshCore/CliConsoleBody';
import apiService, { ApiError } from '../../services/api';
import { MESHTASTIC_DANGER_COMMAND_PATTERN } from '../../utils/meshtasticCliDanger';
import styles from './MeshtasticRemoteCliConsole.module.css';

interface MeshtasticRemoteCliConsoleProps {
  /** Source that owns the node and its Virtual Node. */
  sourceId: string | null | undefined;
  /** Selected node id (`!xxxxxxxx`), or undefined when none is selected. */
  destNodeId?: string;
  /** Display name for the danger-confirm modal and log lines. */
  destNodeName?: string;
  /** True when the selected node is the local node (console is remote-only). */
  isLocalNode: boolean;
  /** True when remote admin is otherwise blocked (e.g. TX disabled). */
  disabled?: boolean;
}

export const MeshtasticRemoteCliConsole: React.FC<MeshtasticRemoteCliConsoleProps> = ({
  sourceId,
  destNodeId,
  destNodeName,
  isLocalNode,
  disabled = false,
}) => {
  const { t } = useTranslation();

  const consoleDisabled = disabled || isLocalNode || !destNodeId || !sourceId;
  const prefix = destNodeId ? `meshtastic --dest ${destNodeId}` : 'meshtastic --dest !xxxxxxxx';

  const runCommand = useCallback(
    async (text: string, opts?: { confirm?: boolean }): Promise<CliRunResult> => {
      if (!sourceId || !destNodeId) {
        return { ok: false, error: t('admin_commands.cli_console.no_node', 'Select a remote node first.') };
      }
      try {
        const data = await apiService.sendMeshtasticCli(sourceId, destNodeId, text, opts);
        return { ok: true, reply: data.output, elapsedMs: data.elapsedMs };
      } catch (err) {
        if (err instanceof ApiError) {
          const body = err.body as { output?: string } | undefined;
          const reply = body?.output && body.output.length > 0 ? body.output : err.message;
          return { ok: false, error: reply, code: err.code };
        }
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
    [sourceId, destNodeId, t],
  );

  const disabledPlaceholder = useMemo(() => {
    if (isLocalNode) return t('admin_commands.cli_console.local_disabled', 'The CLI console is remote-only — select a remote node.');
    if (!destNodeId) return t('admin_commands.cli_console.select_node', 'Select a remote node to begin.');
    if (disabled) return t('admin_commands.cli_console.blocked', 'Remote admin is currently disabled.');
    return undefined;
  }, [isLocalNode, destNodeId, disabled, t]);

  return (
    <section className={styles.console} aria-label={t('admin_commands.cli_console.title', 'Remote CLI console')}>
      <p className={styles.help}>
        {t(
          'admin_commands.cli_console.help',
          'Type Meshtastic CLI arguments; they run against the selected remote node through the Virtual Node. Every flag is passed through — destructive commands (--reboot, --factory-reset) ask you to confirm.',
        )}
      </p>
      <div className={styles.prefixRow}>
        <span className={styles.prefixLabel}>{t('admin_commands.cli_console.prefix_label', 'Command prefix')}</span>
        <code className={styles.prefix}>{prefix}</code>
      </div>
      <CliConsoleBody
        targetId={destNodeId ?? 'none'}
        targetName={destNodeName ?? destNodeId ?? ''}
        runCommand={runCommand}
        actionCatalog={[]}
        dangerPattern={MESHTASTIC_DANGER_COMMAND_PATTERN}
        disabled={consoleDisabled}
        disabledPlaceholder={disabledPlaceholder}
        placeholder={t('admin_commands.cli_console.input_placeholder', 'CLI arguments (e.g. --set device.role CLIENT)')}
        emptyTextEnabled={t('admin_commands.cli_console.empty_enabled', 'Type CLI arguments below and press Send.')}
        emptyTextDisabled={disabledPlaceholder}
      />
    </section>
  );
};

export default MeshtasticRemoteCliConsole;
