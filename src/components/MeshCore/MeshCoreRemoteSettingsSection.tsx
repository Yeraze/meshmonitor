import React, { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ConfigSection } from '../shared/config/ConfigSection';
import { RepeaterSettingsForm } from './RepeaterSettingsForm';
import { MESHCORE_DOCS } from './meshcoreDocs';
import type {
  MeshCoreActions,
  RemoteSettingsGroup,
  RepeaterSettingsPatch,
  RepeaterSettingsValues,
} from './hooks/useMeshCore';
import type { LoraParams } from '../../utils/loraAirtime';
import styles from './RepeaterSettingsForm.module.css';

export interface MeshCoreRemoteSettingsSectionProps {
  publicKey: string;
  deviceType: 'repeater' | 'room';
  actions: Pick<MeshCoreActions, 'readRemoteSettings' | 'saveRemoteSettings'>;
  /** Hops to the target, or null when no path is known (commands flood). */
  pathHops: number | null;
  /** This source's radio: the target shares it, so it sizes the cost line. */
  radio?: Partial<LoraParams> | null;
  disabled?: boolean;
}

/**
 * Structured settings for a remote Repeater / Room Server (#6256 P10): the
 * same `RepeaterSettingsForm` as the local Repeater page in remote mode. It
 * reads nothing until the user presses a group's Read button, and saves only
 * the fields that changed.
 */
export const MeshCoreRemoteSettingsSection: React.FC<MeshCoreRemoteSettingsSectionProps> = ({
  publicKey,
  deviceType,
  actions,
  pathHops,
  radio,
  disabled = false,
}) => {
  const { t } = useTranslation();
  const [values, setValues] = useState<RepeaterSettingsValues>({});
  const [guestPasswordSet, setGuestPasswordSet] = useState(false);
  const [firmware, setFirmware] = useState<string | null>(null);
  const [loadedGroups, setLoadedGroups] = useState<Set<RemoteSettingsGroup>>(() => new Set());
  const [readingGroup, setReadingGroup] = useState<RemoteSettingsGroup | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const describe = useCallback((code: string | undefined, error: string, retryAfterSeconds?: number) => {
    switch (code) {
      case 'ADMIN_SESSION_REQUIRED':
        return t('meshcore.repeater.remote_err_session', 'Log in as admin first. Settings never log in on their own.');
      case 'REMOTE_SETTINGS_BUSY':
        return t('meshcore.repeater.remote_err_busy', 'Another settings read or save is still running on this node.');
      case 'REMOTE_SETTINGS_BUDGET':
        return t('meshcore.repeater.remote_err_budget', {
          minutes: Math.max(1, Math.ceil((retryAfterSeconds ?? 60) / 60)),
          defaultValue: 'This source has sent its 40 settings commands for these 10 minutes. Try again in about {{minutes}} min.',
        });
      case 'SOURCE_NOT_CONNECTED':
        return t('meshcore.repeater.remote_err_disconnected', 'Connect this source first.');
      default:
        return error;
    }
  }, [t]);

  const readGroup = useCallback(async (group: RemoteSettingsGroup) => {
    setReadingGroup(group);
    setMessage(null);
    try {
      const result = await actions.readRemoteSettings(publicKey, [group]);
      if (!result.ok) {
        setMessage(describe(result.code, result.error, result.retryAfterSeconds));
        return;
      }
      const data = result.data;
      setValues((v) => ({ ...v, ...data.values }));
      if (group === 'access') setGuestPasswordSet(data.guestPasswordSet);
      if (data.firmware) setFirmware(data.firmware);
      setLoadedGroups((g) => new Set(g).add(group));
      if (data.stoppedAt) {
        setMessage(t('meshcore.repeater.remote_read_stopped', {
          key: data.stoppedAt,
          defaultValue: 'The read stopped at {{key}}: no reply. The rest were not read.',
        }));
      }
    } finally {
      setReadingGroup(null);
    }
  }, [actions, publicKey, describe, t]);

  const save = useCallback(async (patch: RepeaterSettingsPatch) => {
    setMessage(null);
    const result = await actions.saveRemoteSettings(publicKey, patch);
    if (!result.ok) {
      setMessage(describe(result.code, result.error, result.retryAfterSeconds));
      return null;
    }
    if (result.data.values) setValues((v) => ({ ...v, ...result.data.values }));
    if (typeof result.data.guestPasswordSet === 'boolean') setGuestPasswordSet(result.data.guestPasswordSet);
    return result.data;
  }, [actions, publicKey, describe]);

  return (
    <div className="mrc-remote-settings" data-testid="remote-settings-section">
      <ConfigSection
        title={t('meshcore.repeater.remote_title', 'Settings')}
        docsUrl={`${MESHCORE_DOCS}#remote-settings`}
        description={t('meshcore.repeater.remote_hint', 'Read and change this node\'s settings without typing commands. Nothing is read until you press Read; every value costs radio time.')}
        canWrite={!disabled}
        collapsible
        defaultCollapsed
      >
        {message && (
          <p className={styles.err} role="alert" data-testid="remote-settings-message">{message}</p>
        )}
        <RepeaterSettingsForm
          mode="remote"
          deviceType={deviceType}
          values={values}
          guestPasswordSet={guestPasswordSet}
          firmwareVersion={firmware}
          radio={radio}
          canWrite={!disabled}
          disabled={disabled}
          loadedGroups={loadedGroups}
          readingGroup={readingGroup}
          onReadGroup={(g) => void readGroup(g)}
          pathHops={pathHops}
          onSave={save}
        />
      </ConfigSection>
    </div>
  );
};
