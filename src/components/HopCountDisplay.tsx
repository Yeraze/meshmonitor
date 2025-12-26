import React from 'react';
import { useTranslation } from 'react-i18next';

interface HopCountDisplayProps {
  hopStart?: number;
  hopLimit?: number;
  rxSnr?: number;
  rxRssi?: number;
  relayNode?: number;
  viaMqtt?: boolean;
  onClick?: () => void;
}

/**
 * Display hop count for mesh messages
 * Shows hop count calculated as (hopStart - hopLimit)
 * For direct messages (0 hops), shows SNR/RSSI instead if available
 * Only renders when both hop values are available and result is valid
 * When relayNode is present and onClick provided, the hop count is clickable
 */
const HopCountDisplay: React.FC<HopCountDisplayProps> = ({
  hopStart,
  hopLimit,
  rxSnr,
  rxRssi,
  relayNode,
  viaMqtt,
  onClick,
}) => {
  const { t } = useTranslation();

  // MQTT indicator component
  const MqttIndicator = viaMqtt ? (
    <span
      style={{ marginLeft: '4px', opacity: 0.8 }}
      title={t('messages.via_mqtt')}
      aria-label={t('messages.via_mqtt')}
      role="img"
    >
      🌐
    </span>
  ) : null;

  // Return null if either hop value is missing (but show MQTT indicator if present)
  if (hopStart === undefined || hopLimit === undefined) {
    return MqttIndicator;
  }

  const hopCount = hopStart - hopLimit;

  // Guard against malformed data (negative hop counts)
  if (hopCount < 0) {
    return MqttIndicator;
  }

  // Check if this hop count is clickable (has relay node info)
  // relayNode is undefined/null when not set by the firmware, 0 is a valid relay byte (node ending in 0x00)
  const isClickable = relayNode !== undefined && relayNode !== null && onClick !== undefined;

  const clickableStyle: React.CSSProperties = isClickable
    ? {
        cursor: 'pointer',
        textDecoration: 'underline',
        textDecorationStyle: 'dotted',
        color: 'var(--primary-color)',
      }
    : {};

  // For direct messages (0 hops), show SNR/RSSI if available
  if (hopCount === 0 && (rxSnr != null || rxRssi != null)) {
    const parts: string[] = [];
    if (rxSnr != null) {
      parts.push(`${rxSnr.toFixed(1)} dB`);
    }
    if (rxRssi != null) {
      parts.push(`${rxRssi} dBm`);
    }
    return (
      <>
        <span style={{ fontSize: '0.75em', marginLeft: '4px', opacity: 0.7 }} title={t('messages.signal_info')}>
          ({parts.join(' / ')})
        </span>
        {MqttIndicator}
      </>
    );
  }

  return (
    <>
      <span
        style={{ fontSize: '0.75em', marginLeft: '4px', opacity: isClickable ? 1 : 0.7, ...clickableStyle }}
        onClick={isClickable ? onClick : undefined}
        title={isClickable ? t('messages.click_for_relay') : undefined}
      >
        ({t('messages.hops', { count: hopCount })})
      </span>
      {MqttIndicator}
    </>
  );
};

export default HopCountDisplay;
