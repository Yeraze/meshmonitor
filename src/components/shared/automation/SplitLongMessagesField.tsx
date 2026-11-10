import React from 'react';
import { useTranslation } from 'react-i18next';
import { UiIcon } from '../../icons';
import {
  MESHCORE_SPLIT_MAX_PARTS,
  MESHCORE_SPLIT_PART_GAP_MS,
  MESHCORE_MAX_MESSAGE_BYTES_DM,
  MESHCORE_MAX_TEXT_BYTES,
} from '../../../utils/meshcoreMessageLimits';
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
}

/**
 * "Split long messages" toggle for MeshCore automated senders (#6316). One
 * component for Auto Ack, Auto Responder, Timer Triggers, Auto Announce and
 * the Automation Engine, so the caps and the airtime warning come from the
 * shared limits module and cannot drift from the server.
 */
export const SplitLongMessagesField: React.FC<SplitLongMessagesFieldProps> = ({
  checked,
  onChange,
  disabled,
  id,
  perTargetCount,
  extraWarning,
}) => {
  const { t } = useTranslation();
  const parts = MESHCORE_SPLIT_MAX_PARTS;
  const seconds = MESHCORE_SPLIT_PART_GAP_MS / 1000;
  const channels = perTargetCount ?? 1;
  return (
    <div>
      <span className="setting-description">
        {t(
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
          {t('automation.split_long.toggle', 'Split long messages')}
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
