import React from 'react';
import { useTranslation } from 'react-i18next';
import { UiIcon, batteryIconName } from '../icons';

export interface NodeStatChipsProps {
  snr?: number | null;
  rssi?: number | null;
  batteryLevel?: number | null;
  voltage?: number | null;
  hops?: number | null;
  /** Appended inside the hops chip (e.g. a channel hint). */
  hopsSuffix?: React.ReactNode;
  /** Extra chips rendered after the standard ones. */
  children?: React.ReactNode;
}

/** The `.stat` chips (SNR, RSSI, battery, voltage, hops) of a node row. */
export const NodeStatChips: React.FC<NodeStatChipsProps> = ({
  snr,
  rssi,
  batteryLevel,
  voltage,
  hops,
  hopsSuffix,
  children,
}) => {
  const { t } = useTranslation();
  return (
    <>
      {snr != null && (
        <span className="stat" title={t('nodes.snr')}>
          <UiIcon name="wifi" size={14} /> {snr.toFixed(1)}dB
        </span>
      )}
      {rssi != null && (
        <span className="stat" title={t('nodes.rssi')}>
          <UiIcon name="radioSignal" size={14} /> {rssi}dBm
        </span>
      )}
      {batteryLevel != null && (
        <span className="stat" title={batteryLevel === 101 ? t('nodes.plugged_in') : t('nodes.battery_level')}>
          <UiIcon name={batteryIconName(batteryLevel)} size={14} /> {batteryLevel === 101 ? t('nodes.plugged_in') : `${batteryLevel}%`}
        </span>
      )}
      {voltage != null && (
        <span className="stat" title={t('nodes.voltage')}>
          <UiIcon name="zap" size={14} /> {voltage.toFixed(2)}V
        </span>
      )}
      {hops != null && hops < 999 && (
        <span className="stat" title={t('nodes.hops_away')}>
          <UiIcon name="link" size={14} /> {hops} {t('nodes.hop', { count: hops })}
          {hopsSuffix}
        </span>
      )}
      {children}
    </>
  );
};
