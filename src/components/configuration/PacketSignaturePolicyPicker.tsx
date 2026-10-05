import React, { useId } from 'react';
import { useTranslation } from 'react-i18next';
import { UiIcon } from '../icons';
import {
  PacketSignaturePolicy,
  PACKET_SIGNATURE_POLICIES,
  PACKET_SIGNATURE_POLICY_MIN_FIRMWARE_LABEL,
  isPacketSignaturePolicy,
  supportsPacketSignaturePolicy,
} from '../../utils/packetSignaturePolicy';
import { parseFirmwareVersion } from '../../utils/firmwareVersion';
import styles from './PacketSignaturePolicyPicker.module.css';

export interface PacketSignaturePolicyPickerProps {
  /** The policy the node holds, or null when it could not be read. */
  loadedPolicy: number | null;
  /** The policy picked in the form, or null while nothing is known. */
  value: number | null;
  onChange: (policy: number) => void;
  /** The node's firmware version, or null/undefined when we do not have it. */
  firmwareVersion: string | null | undefined;
  /** Disable for a reason of the caller's own (a save in flight, say). */
  disabled?: boolean;
}

const OPTION_KEYS: Record<number, string> = {
  [PacketSignaturePolicy.COMPATIBLE]: 'signature_policy.option_compatible',
  [PacketSignaturePolicy.BALANCED]: 'signature_policy.option_balanced',
  [PacketSignaturePolicy.STRICT]: 'signature_policy.option_strict',
};

const DESCRIPTION_KEYS: Record<number, string> = {
  [PacketSignaturePolicy.COMPATIBLE]: 'signature_policy.description_compatible',
  [PacketSignaturePolicy.BALANCED]: 'signature_policy.description_balanced',
  [PacketSignaturePolicy.STRICT]: 'signature_policy.description_strict',
};

/**
 * The "Protection Level" control: `SecurityConfig.packet_signature_policy`.
 *
 * It never guesses. A node below firmware 2.8.0, a node whose firmware we do
 * not know, and a node whose policy could not be read all get a disabled
 * control with the reason beside it, never a default of Compatible.
 */
export const PacketSignaturePolicyPicker: React.FC<PacketSignaturePolicyPickerProps> = ({
  loadedPolicy,
  value,
  onChange,
  firmwareVersion,
  disabled = false,
}) => {
  const { t } = useTranslation();
  const selectId = useId();
  const reasonId = useId();

  const firmwareKnown = parseFirmwareVersion(firmwareVersion) !== null;
  const firmwareOk = supportsPacketSignaturePolicy(firmwareVersion);
  const policyKnown = isPacketSignaturePolicy(loadedPolicy);

  let reason: string | null = null;
  if (!firmwareKnown) {
    reason = t('signature_policy.reason_firmware_unknown', { version: PACKET_SIGNATURE_POLICY_MIN_FIRMWARE_LABEL });
  } else if (!firmwareOk) {
    reason = t('signature_policy.reason_firmware_too_old', {
      version: PACKET_SIGNATURE_POLICY_MIN_FIRMWARE_LABEL,
      current: firmwareVersion,
    });
  } else if (!policyKnown) {
    reason = t('signature_policy.reason_policy_unknown');
  }

  const locked = reason !== null;
  // Show a policy only when we know the node's own. Otherwise the control
  // reads "Unknown", so nobody takes a blank form for Compatible.
  const shown = !locked && isPacketSignaturePolicy(value) ? value : null;

  return (
    <div className="setting-item">
      <label htmlFor={selectId}>
        {t('signature_policy.label')}
        <span className="setting-description">{t('signature_policy.description')}</span>
      </label>
      <select
        id={selectId}
        className={`setting-input ${styles.select}`}
        value={shown === null ? '' : String(shown)}
        onChange={(e) => onChange(Number(e.target.value))}
        disabled={locked || disabled}
        aria-describedby={locked ? reasonId : undefined}
      >
        {shown === null && <option value="">{t('signature_policy.option_unknown')}</option>}
        {PACKET_SIGNATURE_POLICIES.map((policy) => (
          <option key={policy} value={String(policy)}>
            {t(OPTION_KEYS[policy])}
          </option>
        ))}
      </select>

      {locked ? (
        <span id={reasonId} className={styles.reason} data-testid="signature-policy-reason">
          {reason}
        </span>
      ) : (
        shown !== null && <span className={styles.reason}>{t(DESCRIPTION_KEYS[shown])}</span>
      )}

      {shown === PacketSignaturePolicy.BALANCED && (
        <div className={styles.warning} role="note" data-testid="signature-policy-balanced-warning">
          <span className={styles.warningIcon}><UiIcon name="alert" /></span>
          <div className={styles.warningBody}>
            <p>{t('signature_policy.balanced_warning')}</p>
          </div>
        </div>
      )}

      {shown === PacketSignaturePolicy.STRICT && (
        <div className={styles.danger} role="alert" data-testid="signature-policy-strict-warning">
          <span className={styles.warningIcon}><UiIcon name="securityAlert" /></span>
          <div className={styles.warningBody}>
            <p className={styles.warningTitle}>{t('signature_policy.strict_warning_title')}</p>
            <p>{t('signature_policy.strict_warning_intro')}</p>
            <ul>
              <li>{t('signature_policy.strict_drops_old_peers')}</li>
              <li>{t('signature_policy.strict_drops_unicasts')}</li>
              <li>{t('signature_policy.strict_drops_large_broadcasts')}</li>
            </ul>
            <p>{t('signature_policy.strict_warning_relay')}</p>
          </div>
        </div>
      )}

      {!locked && <span className={styles.reason}>{t('signature_policy.reboot_note')}</span>}
    </div>
  );
};

export default PacketSignaturePolicyPicker;
