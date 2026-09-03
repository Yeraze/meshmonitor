/**
 * Informational notice for a node running Meshtastic 2.8+ that is still being
 * heard on the mesh but has stopped broadcasting position and/or telemetry
 * (issue #5033).
 *
 * DISPLAY ONLY. This component reads what the node list already carries and
 * renders text. It sends nothing, requests nothing, and emits no event — so it
 * cannot reach the Apprise / desktop / MQTT notification fan-out. See the Mesh
 * impact checklist in CLAUDE.md.
 *
 * Renders `null` whenever `evaluateFirmware28Silence` has nothing to say,
 * including for any node whose firmware version we do not know.
 */
import { useTranslation } from 'react-i18next';
import type { DeviceInfo } from '../types/device';
import {
  evaluateFirmware28Silence,
  FIRMWARE_28_POSITION_DOC_URL,
  FIRMWARE_28_TELEMETRY_DOC_URL,
} from '../utils/firmware28Silence';
import { UiIcon } from './icons';
import styles from './Firmware28SilenceNotice.module.css';

interface Firmware28SilenceNoticeProps {
  node: DeviceInfo | null | undefined;
  /** Injectable for tests; defaults to the wall clock. */
  nowMs?: number;
}

export function Firmware28SilenceNotice({ node, nowMs }: Firmware28SilenceNoticeProps) {
  const { t } = useTranslation();
  if (!node) return null;

  const notice = evaluateFirmware28Silence(
    {
      // Firmware version lives in two places depending on which projection
      // built this node; prefer the top-level column.
      firmwareVersion: node.firmwareVersion ?? node.user?.firmwareVersion,
      lastHeard: node.lastHeard,
      positionTimestamp: node.positionTimestamp,
      telemetryTimestamp: node.telemetryTimestamp,
      positionIsOverride: node.positionIsOverride,
      positionIsEstimated: node.positionIsEstimated,
    },
    nowMs,
  );
  if (!notice) return null;

  let detail: string;
  if (notice.positionSilent && notice.telemetrySilent) {
    detail = t(
      'node_details.firmware28_silence_both',
      'It has stopped sending both position and telemetry, but is still being heard on the mesh.',
    );
  } else if (notice.positionSilent) {
    detail = t(
      'node_details.firmware28_silence_position',
      'It has stopped sending position, but is still being heard on the mesh.',
    );
  } else {
    detail = t(
      'node_details.firmware28_silence_telemetry',
      'It has stopped sending telemetry, but is still being heard on the mesh.',
    );
  }

  return (
    <div className={styles.notice} role="note" data-testid="firmware28-silence-notice">
      <UiIcon name="info" size={16} className={styles.icon} />
      <div className={styles.body}>
        <span className={styles.title}>
          {t(
            'node_details.firmware28_silence_title',
            'Position and telemetry are opt-in on Meshtastic 2.8+',
          )}
        </span>
        <span className={styles.detail}>
          {detail}{' '}
          {t(
            'node_details.firmware28_silence_hint',
            'Meshtastic 2.8 turned these broadcasts off by default, so they may need to be re-enabled on the device itself. This is a firmware setting — MeshMonitor cannot turn it back on for you.',
          )}
        </span>
        <span className={styles.links}>
          <a href={FIRMWARE_28_POSITION_DOC_URL} target="_blank" rel="noopener noreferrer">
            {t('node_details.firmware28_silence_position_docs', 'Re-enable position')}
          </a>
          <a href={FIRMWARE_28_TELEMETRY_DOC_URL} target="_blank" rel="noopener noreferrer">
            {t('node_details.firmware28_silence_telemetry_docs', 'Re-enable telemetry')}
          </a>
        </span>
      </div>
    </div>
  );
}

export default Firmware28SilenceNotice;
