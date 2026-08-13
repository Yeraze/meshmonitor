import React from 'react';
import { useTranslation } from 'react-i18next';
import { UiIcon } from './icons';

interface HopCountDisplayProps {
  hopStart?: number;
  hopLimit?: number;
  rxSnr?: number;
  rxRssi?: number;
  /**
   * Last byte of the relaying node. No longer gates clickability (#4657) — the
   * hop count is clickable whenever `onClick` is wired — but callers still pass
   * it through to the packet-detail modal, so it stays part of the prop shape.
   */
  relayNode?: number;
  viaMqtt?: boolean;
  viaStoreForward?: boolean;
  xeddsaSigned?: boolean;
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
  viaMqtt,
  viaStoreForward,
  xeddsaSigned,
  onClick,
}) => {
  const { t } = useTranslation();

  // XEdDSA signing indicator (firmware 2.8+): green shield shown when the
  // receiving node cryptographically verified the broadcast's signature,
  // matching the official mobile clients' verified-signature indicator.
  const SignedIndicator = xeddsaSigned ? (
    <span
      style={{ marginLeft: '4px', opacity: 0.9, color: 'var(--success-color, #16a34a)' }}
      title={t('messages.xeddsa_signed', 'Cryptographically signed (XEdDSA)')}
      aria-label={t('messages.xeddsa_signed', 'Cryptographically signed (XEdDSA)')}
      role="img"
    >
      🛡️
    </span>
  ) : null;

  // Store & Forward indicator component
  const StoreForwardIndicator = viaStoreForward ? (
    <span
      style={{ marginLeft: '4px', opacity: 0.8 }}
      title={t('messages.via_store_forward', 'Received via Store & Forward')}
      aria-label={t('messages.via_store_forward', 'Received via Store & Forward')}
      role="img"
    >
      <UiIcon name="package" size={14} />
    </span>
  ) : null;

  // MQTT indicator component
  const MqttIndicator = viaMqtt ? (
    <span
      style={{ marginLeft: '4px', opacity: 0.8 }}
      title={t('messages.via_mqtt')}
      aria-label={t('messages.via_mqtt')}
      role="img"
    >
      <UiIcon name="network" size={14} />
    </span>
  ) : null;

  // Return null if either hop value is missing (but show indicators if present)
  if (hopStart === undefined || hopLimit === undefined) {
    return <>{SignedIndicator}{StoreForwardIndicator}{MqttIndicator}</>;
  }

  const hopCount = hopStart - hopLimit;

  // Guard against malformed data (negative hop counts)
  if (hopCount < 0) {
    return <>{SignedIndicator}{StoreForwardIndicator}{MqttIndicator}</>;
  }

  // The hop count opens a packet-detail view for the message (#4657), so it is
  // clickable whenever an onClick handler is wired — regardless of whether the
  // firmware set a relay byte. relayNode still drives the relay-candidate list
  // inside that view, but MQTT and direct-reception messages are worth
  // inspecting too, so the click is no longer gated on relayNode being present.
  const isClickable = onClick !== undefined;

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
        <span
          style={{ fontSize: '0.75em', marginLeft: '4px', opacity: isClickable ? 1 : 0.85, ...clickableStyle }}
          onClick={isClickable ? onClick : undefined}
          title={isClickable ? t('messages.click_for_details') : t('messages.signal_info')}
        >
          ({parts.join(' / ')})
        </span>
        {SignedIndicator}
        {StoreForwardIndicator}
        {MqttIndicator}
      </>
    );
  }

  return (
    <>
      <span
        style={{ fontSize: '0.75em', marginLeft: '4px', opacity: isClickable ? 1 : 0.85, ...clickableStyle }}
        onClick={isClickable ? onClick : undefined}
        title={isClickable ? t('messages.click_for_details') : undefined}
      >
        ({t('messages.hops', { count: hopCount, hopStart: hopStart })})
      </span>
      {SignedIndicator}
      {StoreForwardIndicator}
      {MqttIndicator}
    </>
  );
};

export default HopCountDisplay;
