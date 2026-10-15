/**
 * ChannelEncryptionLabel — icon + words for a channel's encryption status,
 * for the chip on a collapsed channel card (#5829). Both protocols classify
 * the key with `pskEncryptionStatus` (src/utils/publicChannel.ts).
 */
import React from 'react';
import { useTranslation } from 'react-i18next';
import { UiIcon } from '../../icons';
import type { PskEncryptionStatus } from '../../../utils/publicChannel';

export const ChannelEncryptionLabel: React.FC<{
  status: PskEncryptionStatus;
  /** Replaces the default wording for 'default' (e.g. MeshCore "Public key"). */
  defaultLabel?: React.ReactNode;
}> = ({ status, defaultLabel }) => {
  const { t } = useTranslation();
  if (status === 'secure') {
    return <><UiIcon name="encrypted" size={12} /> {t('channel_card.encryption_secure', 'Private key')}</>;
  }
  if (status === 'default') {
    return <><UiIcon name="encryptedKey" size={12} /> {defaultLabel ?? t('channel_card.encryption_default', 'Default key (public)')}</>;
  }
  return <><UiIcon name="unencrypted" size={12} /> {t('channel_card.encryption_none', 'No encryption')}</>;
};

export default ChannelEncryptionLabel;
