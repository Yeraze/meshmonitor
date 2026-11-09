import React from 'react';
import { useTranslation } from 'react-i18next';
import { keyPrefix, type TopBroadcasterView } from './securityTypes';

interface TopBroadcastersTableProps {
  broadcasters: TopBroadcasterView[];
  onOpenNode: (nodeKey: string) => void;
}

/** Top broadcasters by packets per hour. Rows key on `nodeKey` (or `mt:<nodeNum>`). */
export const TopBroadcastersTable: React.FC<TopBroadcastersTableProps> = ({ broadcasters, onOpenNode }) => {
  const { t } = useTranslation();
  if (!broadcasters || broadcasters.length === 0) return null;
  return (
    <div className="issues-section top-broadcasters-section">
      <h3>{t('security.top_broadcasters')}</h3>
      <p className="section-description">{t('security.top_broadcasters_description')}</p>
      <div className="security-table-scroll">
        <table className="top-broadcasters-table">
          <thead>
            <tr>
              <th>{t('security.rank')}</th>
              <th>{t('security.node')}</th>
              <th>{t('security.node_id')}</th>
              <th>{t('security.packets_hour')}</th>
            </tr>
          </thead>
          <tbody>
            {broadcasters.map((broadcaster, index) => {
              const nodeKey = broadcaster.nodeKey ?? `mt:${broadcaster.nodeNum}`;
              const isMeshCore = nodeKey.startsWith('mc:');
              return (
                <tr key={nodeKey}>
                  <td className="rank">#{index + 1}</td>
                  <td className="node-name">
                    <span className="node-link" onClick={() => onOpenNode(nodeKey)}>
                      {broadcaster.longName || broadcaster.shortName || 'Unknown'}
                    </span>
                    {broadcaster.shortName && broadcaster.longName && (
                      <span className="short-name"> ({broadcaster.shortName})</span>
                    )}
                  </td>
                  <td className="node-id">
                    {isMeshCore ? keyPrefix(nodeKey.slice(3)) : `!${broadcaster.nodeNum.toString(16).padStart(8, '0')}`}
                  </td>
                  <td className="packet-count">{broadcaster.packetCount}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
};
