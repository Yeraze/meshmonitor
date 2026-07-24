/**
 * MqttOkToMqttMarker — renders one `ok_to_mqtt` state (#4114 Phase 2).
 *
 * Only `violation` is a badge, and it is a sixth member of the existing
 * `.mqpm-badge` family in MqttPacketMonitor.css — not a parallel system. The
 * three non-violating states render as quiet mono text so that `unknown` (the
 * majority state on encrypted channels) never reads as an alert.
 *
 * `scope` only changes the tooltip: on a grouped row the flag is
 * MAX(okToMqttViolation) across the packet's gateways ("at least one"), while in
 * the receptions table it is that one gateway's own flag.
 *
 * See MQTT_OK_TO_MQTT_PHASE2_SPEC.md §2(a), §2(b), §2(f). Note: the fourth
 * (non-violating, bit-explicitly-clear) state is named `optedOut` here, not
 * `self` as the spec draft had it — see okToMqttState.ts for why.
 */
import React from 'react';
import { useTranslation } from 'react-i18next';
import { UiIcon } from '../icons';
import type { OkToMqttState } from './okToMqttState';

interface Props {
  state: OkToMqttState;
  /** 'packet' = aggregated over the packet's gateways; 'gateway' = one reception. */
  scope: 'packet' | 'gateway';
}

export const MqttOkToMqttMarker: React.FC<Props> = ({ state, scope }) => {
  const { t } = useTranslation();

  if (state === 'violation') {
    return (
      <span
        className="mqpm-badge mqpm-badge-violation"
        title={scope === 'packet'
          ? t('mqtt.packets.violationPacketTitle', 'At least one gateway relayed this packet to MQTT although the sender did not opt in (ok_to_mqtt = 0). Open the packet to see which gateway.')
          : t('mqtt.packets.violationGatewayTitle', 'This gateway relayed the packet to MQTT although the sender did not opt in (ok_to_mqtt = 0).')}
      >
        <UiIcon name="alert" size={12} />
        {t('mqtt.packets.violationBadge', 'violation')}
      </span>
    );
  }

  if (state === 'ok') {
    return (
      <span
        className="mqpm-oktomqtt mqpm-oktomqtt-ok"
        title={t('mqtt.packets.okToMqttAllowedTitle', 'The sender set ok_to_mqtt, so relaying this packet to MQTT is permitted.')}
      >
        {t('mqtt.packets.okToMqttAllowed', 'allowed')}
      </span>
    );
  }

  if (state === 'optedOut') {
    return (
      <span
        className="mqpm-oktomqtt mqpm-oktomqtt-self"
        title={t('mqtt.packets.okToMqttSelfTitle', 'The sender opted out of ok_to_mqtt, but no third-party relay could be established for this reception, so this is not a violation.')}
      >
        {t('mqtt.packets.okToMqttSelf', 'opted out')}
      </span>
    );
  }

  return (
    <span
      className="mqpm-oktomqtt mqpm-oktomqtt-unknown"
      title={t('mqtt.packets.okToMqttUnknownTitle', 'The ok_to_mqtt bit could not be read for this reception — the payload was not decryptable, or the packet was captured before violation detection was added.')}
    >
      {t('mqtt.packets.okToMqttUnknown', 'unknown')}
    </span>
  );
};

export default MqttOkToMqttMarker;
