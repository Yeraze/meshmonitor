/**
 * Import gate for contact-share tokens in MeshCore messages (#6370), shared by
 * the Channels, Direct Messages and Rooms views so they agree on when Import
 * runs and why it doesn't. Only a connected Companion holds a contact table
 * MeshMonitor can write; the user also needs `nodes:write` on the source.
 */
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../../../contexts/AuthContext';
import type { AddContactToDeviceResponse, ConnectionStatus } from './useMeshCore';

const DEVICE_TYPE_COMPANION = 1;

export interface ContactTokenImportConfig {
  onImport?: (raw: string, confirmFull: boolean) => Promise<AddContactToDeviceResponse>;
  canImport: boolean;
  disabledReason?: string;
}

export function useContactTokenImport(
  status: ConnectionStatus | null | undefined,
  importContactToken: ((token: string, confirmFull?: boolean) => Promise<AddContactToDeviceResponse>) | undefined,
): ContactTokenImportConfig {
  const { t } = useTranslation();
  const { hasPermission } = useAuth();
  const canWriteNodes = hasPermission('nodes', 'write');
  const isCompanion = status?.deviceType === DEVICE_TYPE_COMPANION;
  const connected = status?.connected === true;

  return useMemo(() => {
    let disabledReason: string | undefined;
    if (!isCompanion) {
      disabledReason = t(
        'meshcore.contact_token.companion_only',
        'Only a Companion source has a contact list to import into.',
      );
    } else if (!connected) {
      disabledReason = t('meshcore.contact_token.not_connected', 'Connect the Companion radio to import contacts.');
    } else if (!canWriteNodes) {
      disabledReason = t('meshcore.contact_token.no_permission', 'You do not have permission to edit nodes on this source.');
    } else if (!importContactToken) {
      disabledReason = t('meshcore.contact_token.import_unavailable', 'Importing needs a connected Companion radio and permission to edit nodes.');
    }
    return {
      onImport: importContactToken
        ? (raw: string, confirmFull: boolean) => importContactToken(raw, confirmFull)
        : undefined,
      canImport: disabledReason === undefined,
      disabledReason,
    };
  }, [isCompanion, connected, canWriteNodes, importContactToken, t]);
}
