import React from 'react';
import { useTranslation } from 'react-i18next';
import { UiIcon } from '../../icons';
import {
  MESHCORE_MAX_MESSAGE_BYTES_DM,
  MESHCORE_MAX_TEXT_BYTES,
} from '../../../utils/meshcoreMessageLimits';
import {
  MESHTASTIC_MAX_TEXT_BYTES,
  SPLIT_MAX_PARTS,
  SPLIT_PART_GAP_MS,
} from '../../../utils/messageSplitLimits';
import styles from './SplitLongMessagesField.module.css';

export interface SplitLongMessagesFieldProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  /** DOM id of the checkbox. */
  id: string;
  /** Targets one run sends to (channels). More than one adds the multiplied-airtime note. */
  perTargetCount?: number;
  /** Extra note under the warning, e.g. the 5-minute timer floor. */
  extraWarning?: string;
  /** Which protocol's byte cap the description states (#6330). Default MeshCore. */
  protocol?: 'meshcore' | 'meshtastic';
  /** Checkbox label override (the Meshtastic responder keeps its "Multiline" label). */
  label?: string;
}

/**
 * "Split long messages" toggle for automated senders on MeshCore (#6316) and
 * Meshtastic (#6330). One component for Auto Ack, Auto Responder, Timer
 * Triggers, Auto Announce and the Automation Engine, so the caps and the
 * airtime warning come from the shared limits modules and cannot drift from
 * the server.
 */
export const SplitLongMessagesField: React.FC<SplitLongMessagesFieldProps> = ({
  checked,
  onChange,
  disabled,
  id,
  perTargetCount,
  extraWarning,
  protocol = 'meshcore',
  label,
}) => {
  const { t } = useTranslation();
  const parts = SPLIT_MAX_PARTS;
  const seconds = SPLIT_PART_GAP_MS / 1000;
  const meshtastic = protocol === 'meshtastic';
  const channels = perTargetCount ?? 1;
  return (
    <div>
      <span className="setting-description">
        {meshtastic
          ? t(
            'automation.split_long.description_meshtastic',
            'A Meshtastic message holds {{max}} bytes. A longer message is cut to fit, ending in "...", unless you split it.',
            { max: MESHTASTIC_MAX_TEXT_BYTES },
          )
          : t(
            'automation.split_long.description',
            'A MeshCore message holds {{dm}} bytes in a DM. On a channel it holds {{max}} bytes minus your node name and 2 (155 for a 3-byte name, 127 for a 31-byte name). A longer message is cut to fit unless you split it.',
            { dm: MESHCORE_MAX_MESSAGE_BYTES_DM, max: MESHCORE_MAX_TEXT_BYTES },
          )}
      </span>
      <div className={styles.toggleRow}>
        <input
          type="checkbox"
          id={id}
          checked={checked}
          onChange={(e) => onChange(e.target.checked)}
          disabled={disabled}
        />
        <label htmlFor={id} className={styles.toggleLabel}>
          {label ?? t('automation.split_long.toggle', 'Split long messages')}
        </label>
      </div>
      <div className={styles.warning} role="note">
        <UiIcon name="alert" size={14} />
        <span>
          {t(
            'automation.split_long.warning',
            'Long messages go out as up to {{parts}} messages, {{seconds}} seconds apart, each marked like "(1/{{parts}})". Each one is repeated by every repeater in range.',
            { parts, seconds },
          )}
          {meshtastic && (
            <>
              {' '}
              {t(
                'automation.split_long.warning_meshtastic_queue',
                'Meshtastic replies, timers and announcements go through the outgoing queue, which also waits 30 seconds between sends.',
              )}
            </>
          )}
          {channels > 1 && (
            <>
              {' '}
              {t(
                'automation.split_long.warning_channels',
                'This run sends to {{count}} channels, so up to {{total}} messages per run.',
                { count: channels, total: channels * parts },
              )}
            </>
          )}
          {extraWarning ? ` ${extraWarning}` : ''}
        </span>
      </div>
    </div>
  );
};
