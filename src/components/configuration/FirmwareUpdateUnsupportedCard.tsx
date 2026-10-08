import React from 'react';
import { useTranslation } from 'react-i18next';
import { UiIcon } from '../icons';
import type { UiIconName } from '../icons';
import {
  MESHTASTICD_DOCS_URL,
  type FirmwareUpdateSupport,
  type FirmwareUpdateUnsupportedReason,
} from '../../utils/firmwareHardwareMap';
import styles from './FirmwareUpdateUnsupportedCard.module.css';

/** Where a board with no OTA path is updated instead: over USB. */
const WEB_FLASHER_URL = 'https://flasher.meshtastic.org/';

interface FirmwareUpdateUnsupportedCardProps {
  /** The `supported: false` verdict of `firmwareUpdateSupport(hwModel)`. */
  support: Extract<FirmwareUpdateSupport, { supported: false }>;
  /** Numeric hardware model the node reports; named when it has no enum name. */
  hwModel: number;
}

const ICONS: Record<FirmwareUpdateUnsupportedReason, UiIconName> = {
  'linux-native': 'terminal',
  unset: 'info',
  simulator: 'info',
  'unknown-model': 'info',
  'unmapped-board': 'info',
  'platform-not-ota': 'info',
};

/**
 * Shown in place of the firmware update UI when the selected source's node
 * has hardware MeshMonitor cannot update (#5677). It only explains: it has no
 * action that starts, schedules or checks for an update.
 */
const FirmwareUpdateUnsupportedCard: React.FC<FirmwareUpdateUnsupportedCardProps> = ({ support, hwModel }) => {
  const { t } = useTranslation();
  const model = support.modelName ?? String(hwModel);
  const platform = support.platform ?? '';

  let title: string;
  let body: string;
  let link: { href: string; label: string } | null = {
    href: WEB_FLASHER_URL,
    label: t('firmware.unsupported_flasher_link', 'Open the Meshtastic web flasher'),
  };

  switch (support.reason) {
    case 'linux-native':
      title = t('firmware.unsupported_linux_title', 'This node is updated on its Linux host');
      body = t(
        'firmware.unsupported_linux_body',
        'This node runs meshtasticd, the Linux build of Meshtastic, so MeshMonitor cannot flash it. Update the meshtasticd package with your system package manager, or pull a newer container image.'
      );
      link = {
        href: MESHTASTICD_DOCS_URL,
        label: t('firmware.unsupported_linux_link', 'meshtasticd install and update guide'),
      };
      break;
    case 'unset':
      title = t('firmware.unsupported_unset_title', 'This node reports no hardware model');
      body = t(
        'firmware.unsupported_unset_body',
        'MeshMonitor picks the firmware build from the hardware model, and this node reports none (UNSET). Update it over USB instead.'
      );
      break;
    case 'simulator':
      title = t('firmware.unsupported_simulator_title', 'This node is a simulator');
      body = t(
        'firmware.unsupported_simulator_body',
        'It reports the ANDROID_SIM hardware model. There is no firmware to flash.'
      );
      link = null;
      break;
    case 'unknown-model':
      title = t('firmware.unsupported_unknown_title', {
        defaultValue: 'MeshMonitor does not know hardware model {{model}}',
        model,
      });
      body = t(
        'firmware.unsupported_unknown_body',
        'This MeshMonitor version has no firmware build for it, so it cannot update this node. Update it over USB instead. A newer MeshMonitor may add this board.'
      );
      break;
    case 'unmapped-board':
      title = t('firmware.unsupported_unmapped_title', {
        defaultValue: 'No firmware build is mapped for {{model}}',
        model,
      });
      body = t(
        'firmware.unsupported_unmapped_body',
        'This MeshMonitor version has no firmware build for this board, so it cannot update this node. Update it over USB instead. A newer MeshMonitor may add it.'
      );
      break;
    case 'platform-not-ota':
      title = t('firmware.unsupported_platform_title', {
        defaultValue: '{{model}} cannot be updated over Wi-Fi',
        model,
      });
      body = t('firmware.unsupported_platform_body', {
        defaultValue:
          'Its platform ({{platform}}) has no Wi-Fi OTA update, so MeshMonitor cannot flash it. Update it over USB instead.',
        platform,
      });
      break;
  }

  return (
    <div
      className={styles.card}
      role="note"
      data-testid="firmware-unsupported-card"
      data-reason={support.reason}
    >
      <UiIcon name={ICONS[support.reason]} size={20} className={styles.icon} />
      <div className={styles.text}>
        <strong className={styles.title}>{title}</strong>
        <p className={styles.body}>{body}</p>
        {link && (
          <a className={styles.link} href={link.href} target="_blank" rel="noopener noreferrer">
            {link.label}
          </a>
        )}
      </div>
    </div>
  );
};

export default FirmwareUpdateUnsupportedCard;
