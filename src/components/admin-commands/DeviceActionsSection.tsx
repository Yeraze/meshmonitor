import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { UiIcon, type UiIconName } from '../icons';
import { TypedConfirmDialog } from '../common/TypedConfirmDialog';
import styles from './DeviceActionsSection.module.css';

/** Seconds the node waits before it powers off. Matches the reboot default. */
const SHUTDOWN_DELAY_SECONDS = 5;

type DeviceAction = 'shutdown' | 'enterDfuMode' | 'factoryResetConfig' | 'factoryResetDevice';

/** DFU and the factory resets go to the local node only; the server enforces it too. */
const LOCAL_ONLY: ReadonlySet<DeviceAction> = new Set<DeviceAction>([
  'enterDfuMode',
  'factoryResetConfig',
  'factoryResetDevice',
]);

/** Locale key stem and icon per action. */
const ACTIONS: ReadonlyArray<{ id: DeviceAction; key: string; icon: UiIconName }> = [
  { id: 'shutdown', key: 'shutdown', icon: 'power' },
  { id: 'enterDfuMode', key: 'dfu', icon: 'download' },
  { id: 'factoryResetConfig', key: 'reset_config', icon: 'refresh' },
  { id: 'factoryResetDevice', key: 'reset_device', icon: 'delete' },
];

export interface DeviceActionsNode {
  nodeNum: number;
  nodeId: string;
  shortName: string;
  isLocal: boolean;
}

export interface DeviceActionsSectionProps {
  /** The node the Admin Commands tab is managing, or null when none is picked. */
  node: DeviceActionsNode | null;
  /**
   * `canShutdown` from this node's device metadata. null means the metadata
   * has not been loaded for this node, so nothing is known.
   */
  canShutdown: boolean | null;
  /** Blocks every action (a command is running, or remote admin is off). */
  disabled: boolean;
  /** Tooltip that says why `disabled` is set. */
  disabledReason?: string;
  executeCommand: (command: string, params?: Record<string, unknown>) => Promise<unknown>;
}

/**
 * Shutdown, DFU and factory reset (#5614, #5615).
 *
 * Each action sends one admin packet and is never retried. The dialog says
 * what the node loses; after a send, a notice says what to expect, because a
 * local DFU, reset or shutdown takes this source offline.
 */
export const DeviceActionsSection: React.FC<DeviceActionsSectionProps> = ({
  node,
  canShutdown,
  disabled,
  disabledReason,
  executeCommand,
}) => {
  const { t } = useTranslation();
  const [pending, setPending] = useState<DeviceAction | null>(null);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState<{ action: DeviceAction; wasLocal: boolean; name: string } | null>(null);

  // A notice about one node must not sit under another.
  const nodeNum = node?.nodeNum ?? null;
  useEffect(() => {
    setSent(null);
    setPending(null);
  }, [nodeNum]);

  const isLocal = node?.isLocal ?? false;
  // What the user types: the short name, or the node id when it has none.
  const confirmWord = node ? node.shortName.trim() || node.nodeId : '';
  const name = confirmWord;

  const blockedReason = (action: DeviceAction): string | null => {
    if (!node) return t('admin_commands.please_select_node');
    if (LOCAL_ONLY.has(action) && !isLocal) return t('device_actions.local_only_note');
    if (action === 'shutdown' && canShutdown === false) return t('device_actions.shutdown.cannot_note');
    return null;
  };

  // Resets always need the typed name. Shutdown needs it only for a remote
  // node, which stays off until someone walks to it.
  const needsTypedConfirm = (action: DeviceAction): boolean =>
    action === 'factoryResetConfig' || action === 'factoryResetDevice' || (action === 'shutdown' && !isLocal);

  const handleConfirm = async () => {
    if (!pending || !node) return;
    const action = pending;
    setBusy(true);
    try {
      await executeCommand(action, action === 'shutdown' ? { seconds: SHUTDOWN_DELAY_SECONDS } : {});
      setSent({ action, wasLocal: isLocal, name });
    } catch {
      // executeCommand already showed the error.
    } finally {
      setBusy(false);
      setPending(null);
    }
  };

  const pendingKey = pending ? ACTIONS.find((a) => a.id === pending)!.key : null;
  const sentKey = sent ? ACTIONS.find((a) => a.id === sent.action)!.key : null;

  return (
    <div className={styles.group} data-testid="device-actions">
      <h3 className={styles.heading}>
        <UiIcon name="alert" /> {t('device_actions.title')}
      </h3>
      <p className={styles.intro}>{t('device_actions.intro')}</p>

      <ul className={styles.list}>
        {ACTIONS.map(({ id, key, icon }) => {
          const reason = blockedReason(id);
          const isDisabled = disabled || reason !== null;
          return (
            <li key={id} className={styles.item}>
              <button
                type="button"
                className={styles.button}
                data-testid={`device-action-${id}`}
                onClick={() => setPending(id)}
                disabled={isDisabled}
                title={reason ?? (disabled ? disabledReason : undefined)}
              >
                <UiIcon name={icon} /> {t(`device_actions.${key}.button`)}
              </button>
              <div className={styles.notes}>
                <span>{t(`device_actions.${key}.note`)}</span>
                {reason && (
                  <span className={styles.blocked} data-testid={`device-action-${id}-blocked`}>
                    {reason}
                  </span>
                )}
              </div>
            </li>
          );
        })}
      </ul>

      {sent && sentKey && (
        <div className={styles.sent} role="status" data-testid="device-action-sent">
          <strong>{t(`device_actions.${sentKey}.sent_title`, { name: sent.name })}</strong>
          <span>
            {t(
              sent.action === 'shutdown' && !sent.wasLocal
                ? 'device_actions.shutdown.sent_remote'
                : `device_actions.${sentKey}.sent_local`,
              { name: sent.name, seconds: SHUTDOWN_DELAY_SECONDS },
            )}
          </span>
        </div>
      )}

      {pending && pendingKey && node && (
        <TypedConfirmDialog
          isOpen
          danger
          busy={busy}
          title={t(`device_actions.${pendingKey}.confirm_title`, { name })}
          confirmLabel={t(`device_actions.${pendingKey}.confirm_label`)}
          confirmWord={needsTypedConfirm(pending) ? confirmWord : undefined}
          onConfirm={handleConfirm}
          onCancel={() => setPending(null)}
        >
          <p>{t(`device_actions.${pendingKey}.confirm_body`, { name, seconds: SHUTDOWN_DELAY_SECONDS })}</p>
          {(pending === 'factoryResetConfig' || pending === 'factoryResetDevice') && (
            <>
              <p>{t('device_actions.reset_wipes_heading')}</p>
              <ul>
                <li>{t('device_actions.reset_wipes_settings')}</li>
                <li>{t('device_actions.reset_wipes_channels')}</li>
                <li>{t('device_actions.reset_wipes_nodedb')}</li>
                <li>{t('device_actions.reset_wipes_network')}</li>
                {pending === 'factoryResetDevice' && <li>{t('device_actions.reset_wipes_identity')}</li>}
              </ul>
              <p>{t(`device_actions.${pendingKey}.keeps`)}</p>
              <p className={styles.warn}>{t('device_actions.reset_drop_warning')}</p>
            </>
          )}
          {pending === 'shutdown' && !isLocal && (
            <p className={styles.warn}>{t('device_actions.shutdown.remote_warning')}</p>
          )}
        </TypedConfirmDialog>
      )}
    </div>
  );
};

export default DeviceActionsSection;
