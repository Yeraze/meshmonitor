/**
 * MeshCoreVirtualNodeCard — read-only Virtual Node status for one MeshCore
 * source, shown on the MeshCore Node Info view (#5380).
 *
 * The Meshtastic Info tab carries the same block, but a MeshCore source opens
 * the MeshCore page and never reaches that tab, so the MeshCore-only
 * PKI export/import flags had nowhere to show. Data comes from
 * `GET /api/virtual-node/status`, which lists every source; we pick ours.
 *
 * Renders nothing when the status call fails (it needs a login) or when the
 * source has no entry — the card is purely informational.
 */
import React from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import apiService from '../../services/api';
import { CollapsibleSection } from './CollapsibleSection';

interface VirtualNodeSourceStatus {
  sourceId: string;
  enabled: boolean;
  isRunning: boolean;
  allowAdminCommands?: boolean;
  allowPkiExport?: boolean;
  allowPkiImport?: boolean;
  clientCount: number;
}

interface MeshCoreVirtualNodeCardProps {
  sourceId: string;
}

export const MeshCoreVirtualNodeCard: React.FC<MeshCoreVirtualNodeCardProps> = ({ sourceId }) => {
  const { t } = useTranslation();

  const { data } = useQuery({
    queryKey: ['virtual-node-status'],
    queryFn: async (): Promise<{ sources?: VirtualNodeSourceStatus[] }> => apiService.getVirtualNodeStatus(),
    refetchInterval: 60_000,
    staleTime: 55_000,
    refetchOnWindowFocus: false,
  });

  const sources = Array.isArray(data?.sources) ? data.sources : [];
  const source = sources.find((s) => s.sourceId === sourceId);
  if (!source) return null;

  const allowed = (flag?: boolean) =>
    flag ? t('info.virtual_node_admin_allowed') : t('info.virtual_node_admin_blocked');

  return (
    <section className="meshcore-info-card" data-testid="meshcore-info-virtual-node">
      <CollapsibleSection title={t('info.virtual_node')}>
        <dl>
          <dt>{t('info.virtual_node_status')}</dt>
          <dd>{source.enabled ? t('common.enabled') : t('common.disabled')}</dd>
          {source.enabled && (
            <>
              <dt>{t('info.server_running')}</dt>
              <dd>{source.isRunning ? t('common.yes') : t('common.no')}</dd>
              <dt>{t('info.virtual_node_admin_commands')}</dt>
              <dd>{allowed(source.allowAdminCommands)}</dd>
              {typeof source.allowPkiExport === 'boolean' && (
                <>
                  <dt>{t('info.virtual_node_pki_export')}</dt>
                  <dd data-testid="meshcore-vn-pki-export">{allowed(source.allowPkiExport)}</dd>
                </>
              )}
              {typeof source.allowPkiImport === 'boolean' && (
                <>
                  <dt>{t('info.virtual_node_pki_import')}</dt>
                  <dd data-testid="meshcore-vn-pki-import">{allowed(source.allowPkiImport)}</dd>
                </>
              )}
              <dt>{t('info.connected_clients')}</dt>
              <dd>{source.clientCount}</dd>
            </>
          )}
        </dl>
      </CollapsibleSection>
    </section>
  );
};

export default MeshCoreVirtualNodeCard;
