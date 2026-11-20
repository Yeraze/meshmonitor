/**
 * Remote-admin "Firmware update" section for a MeshCore repeater / room server
 * (#4943 Phase 2: guided OTA).
 *
 * MeshMonitor can only START a MeshCore OTA update: `start ota` opens an open
 * WiFi AP with an upload page (ESP32) or BLE DFU (nRF52). Someone near the
 * node finishes it. This section shows the newest release for the node's role,
 * sends `start ota` through the console's typed-name confirmation (so command
 * and reply land in the transcript), and turns the reply into the next steps.
 * It never resends on its own: a lost reply does not mean OTA did not start.
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import apiService from '../../services/api';
import { UiIcon } from '../icons';
import type { CliRunResult } from './CliConsoleBody';
import { parseOtaReply } from './meshcoreOtaReply';
import styles from './MeshCoreFirmwareUpdateSection.module.css';

interface LatestResponse {
  success: boolean;
  data?: { role: string; channel: 'stable' | 'alpha'; latest: { version: string; tagName: string; htmlUrl: string } | null };
}

interface Props {
  sourceId: string | null;
  deviceType: 'repeater' | 'room';
  disabled?: boolean;
  /** The latest `start ota` result from the console, if any. */
  result: CliRunResult | null;
  /** Open the console's typed-name confirmation for `start ota`. */
  onStart: () => void;
}

export function MeshCoreFirmwareUpdateSection({ sourceId, deviceType, disabled = false, result, onStart }: Props) {
  const { t } = useTranslation();
  const role = deviceType === 'repeater' ? 'repeater' : 'room-server';
  const [latest, setLatest] = useState<LatestResponse['data'] | null>(null);

  useEffect(() => {
    if (!sourceId) return;
    let cancelled = false;
    apiService
      .get<LatestResponse>(`/api/sources/${encodeURIComponent(sourceId)}/meshcore/admin/firmware/latest?role=${role}`)
      .then((res) => {
        if (!cancelled && res.success && res.data) setLatest(res.data);
      })
      .catch(() => {
        /* release info is a hint only; the section works without it */
      });
    return () => {
      cancelled = true;
    };
  }, [sourceId, role]);

  const reply = result ? parseOtaReply(result) : null;

  return (
    <details className={styles.section}>
      <summary className={styles.summary}>
        <UiIcon name="firmware" size={16} /> {t('meshcore.firmware_ota.title', 'Firmware update')}
      </summary>
      <div className={styles.body}>
        <p className={styles.text}>
          {latest?.latest
            ? t('meshcore.firmware_ota.latest', 'Newest {{role}} release on the {{channel}} channel: {{version}}.', {
                role: deviceType === 'repeater' ? t('meshcore.firmware_ota.role_repeater', 'repeater') : t('meshcore.firmware_ota.role_room', 'room server'),
                channel: latest.channel,
                version: latest.latest.version,
              })
            : t('meshcore.firmware_ota.latest_unknown', 'Newest release not known yet. MeshMonitor checks GitHub every 6 hours.')}{' '}
          {latest?.latest && (
            <a href={latest.latest.htmlUrl} target="_blank" rel="noopener noreferrer">
              {t('meshcore.firmware_ota.release_page', 'Release files')}
            </a>
          )}
        </p>
        <p className={styles.text}>
          {t(
            'meshcore.firmware_ota.how',
            'MeshMonitor can start update mode; someone near the node finishes the upload. Use "Version" in the console to see what the node runs. Download the file for your board from the release: the non-merged .bin for ESP32 boards, the .zip for nRF52 boards. RP2040, STM32 and ESP32-C6 boards have no over-the-air update.',
          )}
        </p>
        <p className={styles.warning}>
          {t(
            'meshcore.firmware_ota.warning',
            'While in update mode, ESP32 nodes run an open WiFi network ("MeshCore-OTA") whose upload page has no password: anyone in range can flash the node. The node keeps meshing; send "reboot" to leave update mode if nobody can finish the upload.',
          )}
        </p>
        <button type="button" className={styles.danger} onClick={onStart} disabled={disabled}>
          {t('meshcore.firmware_ota.start', 'Start OTA mode…')}
        </button>

        {reply?.kind === 'esp32' && (
          <ol className={styles.steps} aria-label={t('meshcore.firmware_ota.next_steps', 'Next steps')}>
            <li>{t('meshcore.firmware_ota.esp32_1', 'Near the node, join the WiFi network "MeshCore-OTA" (no password).')}</li>
            <li>
              {t('meshcore.firmware_ota.esp32_2', 'Open {{url}} in a browser and upload the non-merged .bin for this board.', { url: reply.url })}
            </li>
            <li>{t('meshcore.firmware_ota.esp32_3', 'The node restarts on the new firmware. Its settings are kept.')}</li>
          </ol>
        )}
        {reply?.kind === 'nrf52' && (
          <ol className={styles.steps} aria-label={t('meshcore.firmware_ota.next_steps', 'Next steps')}>
            <li>{t('meshcore.firmware_ota.nrf_1', 'Near the node, open the "nRF Device Firmware Update" app by Nordic (iOS / Android).')}</li>
            <li>{t('meshcore.firmware_ota.nrf_2', 'Pick the .zip for this board, then the device with Bluetooth address {{mac}}.', { mac: reply.mac })}</li>
            <li>
              {t(
                'meshcore.firmware_ota.nrf_3',
                'In the app settings turn on packet receipt notifications (8–10 packets). If it fails, toggle Bluetooth and retry; the OTAFIX bootloader makes failed updates recoverable.',
              )}
            </li>
          </ol>
        )}
        {reply?.kind === 'unsupported' && (
          <p className={styles.notice} role="status">
            {t('meshcore.firmware_ota.unsupported', 'This board has no over-the-air update (RP2040, STM32, ESP32-C6, or a build without OTA). Update it over USB.')}
          </p>
        )}
        {reply?.kind === 'timeout' && (
          <p className={styles.warning} role="status">
            {t(
              'meshcore.firmware_ota.timeout',
              'No reply. The node may still have entered update mode: look for the "MeshCore-OTA" WiFi network or the node in the nRF DFU app before you send it again.',
            )}
          </p>
        )}
        {reply?.kind === 'other' && (
          <p className={styles.notice} role="status">
            {t('meshcore.firmware_ota.other', 'Unexpected reply: {{text}}. Check the console transcript.', { text: reply.text || '—' })}
          </p>
        )}
        {reply?.kind === 'error' && (
          <p className={styles.notice} role="status">{reply.text}</p>
        )}
      </div>
    </details>
  );
}
