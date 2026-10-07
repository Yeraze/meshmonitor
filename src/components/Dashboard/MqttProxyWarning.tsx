/**
 * MqttProxyWarning — source-card indicator for "Proxy to Client is on but no
 * MQTT source is linked" (#5013).
 *
 * The server decides: `status.mqttProxyUnlinked` on the already-polled
 * GET /api/sources/:id/status, set by the same rule Device → MQTT uses
 * (`isMqttProxyLinkMisconfigured`) and sent only to viewers who may read the
 * source's device configuration. This component only draws it.
 *
 * MeshMonitor cannot see an MQTT Proxy sidecar until it has injected broker
 * traffic, so the text says so rather than call a working setup broken.
 */
import React, { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { UiIcon } from '../icons';
import { MQTT_TRAFFIC_DOCS_URL } from '../../utils/mqttProxyLink';
import styles from './MqttProxyWarning.module.css';

interface MqttProxyWarningProps {
  sourceId: string;
  /** Open this source's Device tab, where the MQTT Module section lives. */
  onOpenDeviceMqtt: (sourceId: string) => void;
}

const MqttProxyWarning: React.FC<MqttProxyWarningProps> = ({ sourceId, onOpenDeviceMqtt }) => {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const detailId = useId();
  const title = t(
    'source.mqtt_proxy_warning_title',
    'Proxy to Client is on, but no MQTT source is linked. This node gets no MQTT traffic through MeshMonitor. Click for details.',
  );
  // The card itself is a button: keep clicks and keys inside this control.
  const stop = (e: React.SyntheticEvent) => e.stopPropagation();
  return (
    <>
      <button
        type="button"
        className={styles.badge}
        title={title}
        aria-label={title}
        aria-expanded={open}
        aria-controls={open ? detailId : undefined}
        data-testid={`mqtt-proxy-warning-${sourceId}`}
        onKeyDown={stop}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
      >
        <UiIcon name="alert" size={12} /> {t('source.mqtt_proxy_warning_label', 'MQTT not linked')}
      </button>
      {open && (
        <div
          id={detailId}
          role="note"
          className={styles.detail}
          data-testid={`mqtt-proxy-warning-detail-${sourceId}`}
          onClick={stop}
          onKeyDown={stop}
        >
          <p>
            {t(
              'source.mqtt_proxy_warning_body',
              'This node has "Proxy to Client" on, so it relies on MeshMonitor to carry its MQTT traffic, and no MQTT source is linked to it. It hears MQTT traffic only when another node repeats it over LoRa.',
            )}
          </p>
          <p>
            {t(
              'source.mqtt_proxy_warning_sidecar',
              'If the MQTT Proxy sidecar is attached to this source’s Virtual Node, ignore this: MeshMonitor cannot see a sidecar until it passes broker traffic to the node.',
            )}
          </p>
          <div className={styles.links}>
            <button
              type="button"
              className={styles.link}
              data-testid={`mqtt-proxy-warning-open-${sourceId}`}
              onClick={(e) => {
                e.stopPropagation();
                onOpenDeviceMqtt(sourceId);
              }}
            >
              {t('source.mqtt_proxy_warning_open', 'Open Device → MQTT Module')} <UiIcon name="forward" size={12} />
            </button>
            <a
              className={styles.link}
              href={MQTT_TRAFFIC_DOCS_URL}
              target="_blank"
              rel="noopener noreferrer"
              onClick={stop}
            >
              {t('source.mqtt_proxy_warning_docs', 'Why don’t I see MQTT traffic?')}
            </a>
          </div>
        </div>
      )}
    </>
  );
};

export default MqttProxyWarning;
