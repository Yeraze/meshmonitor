import React, { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { MeshCoreNode } from './hooks/useMeshCore';
import { MeshCoreContact } from '../../utils/meshcoreHelpers';
import { MeshCoreMap } from './MeshCoreMap';

const DEVICE_TYPE_KEYS: Record<number, string> = {
  0: 'meshcore.device_type.unknown',
  1: 'meshcore.device_type.companion',
  2: 'meshcore.device_type.repeater',
  3: 'meshcore.device_type.room_server',
};

interface MeshCoreNodesViewProps {
  nodes: MeshCoreNode[];
  contacts: MeshCoreContact[];
}

interface MergedRow {
  publicKey: string;
  name: string;
  advType?: number;
  rssi?: number;
  snr?: number;
  lastHeard?: number;
  hasPosition: boolean;
}

function mergeNodesAndContacts(
  nodes: MeshCoreNode[],
  contacts: MeshCoreContact[],
): MergedRow[] {
  const byKey = new Map<string, MergedRow>();
  for (const n of nodes) {
    if (!n.publicKey) continue;
    byKey.set(n.publicKey, {
      publicKey: n.publicKey,
      name: n.name || 'Unknown',
      advType: n.advType,
      rssi: n.rssi,
      snr: n.snr,
      lastHeard: n.lastHeard,
      hasPosition: false,
    });
  }
  for (const c of contacts) {
    if (!c.publicKey) continue;
    const existing = byKey.get(c.publicKey);
    const hasPos = typeof c.latitude === 'number' && typeof c.longitude === 'number';
    if (existing) {
      existing.name = existing.name === 'Unknown'
        ? (c.advName || c.name || existing.name)
        : existing.name;
      existing.rssi = existing.rssi ?? c.rssi;
      existing.snr = existing.snr ?? c.snr;
      existing.lastHeard = existing.lastHeard ?? c.lastSeen;
      existing.hasPosition = existing.hasPosition || hasPos;
      existing.advType = existing.advType ?? c.advType;
    } else {
      byKey.set(c.publicKey, {
        publicKey: c.publicKey,
        name: c.advName || c.name || 'Unknown',
        advType: c.advType,
        rssi: c.rssi,
        snr: c.snr,
        lastHeard: c.lastSeen,
        hasPosition: hasPos,
      });
    }
  }
  return Array.from(byKey.values()).sort((a, b) => {
    const at = a.lastHeard ?? 0;
    const bt = b.lastHeard ?? 0;
    return bt - at;
  });
}

export const MeshCoreNodesView: React.FC<MeshCoreNodesViewProps> = ({
  nodes,
  contacts,
}) => {
  const { t } = useTranslation();
  const [selected, setSelected] = useState<string | null>(null);

  const rows = useMemo(() => mergeNodesAndContacts(nodes, contacts), [nodes, contacts]);

  return (
    <div className="meshcore-two-pane">
      <div className="meshcore-list-pane">
        <div className="meshcore-list-pane-header">
          <span>{t('meshcore.nav.nodes', 'Nodes')}</span>
          <span className="pane-count">{rows.length}</span>
        </div>
        <div className="meshcore-list-pane-body">
          {rows.length === 0 ? (
            <div className="meshcore-empty-state">
              {t('meshcore.no_nodes', 'No nodes seen yet')}
            </div>
          ) : rows.map(row => (
            <button
              key={row.publicKey}
              className={`mc-node-row ${selected === row.publicKey ? 'selected' : ''}`}
              onClick={() => setSelected(row.publicKey)}
            >
              <div className="mc-node-row-name">
                <span>{row.name}</span>
                {typeof row.advType === 'number' && (
                  <span className="mc-node-row-type">
                    {t(DEVICE_TYPE_KEYS[row.advType] || 'meshcore.device_type.unknown', '')}
                  </span>
                )}
              </div>
              <div className="mc-node-row-meta">
                {typeof row.rssi === 'number' && <span>RSSI {row.rssi}</span>}
                {typeof row.snr === 'number' && <span>SNR {row.snr}</span>}
                {row.lastHeard && (
                  <span>{new Date(row.lastHeard).toLocaleTimeString()}</span>
                )}
                {row.hasPosition && <span>📍</span>}
              </div>
              <div className="mc-node-row-key">
                {row.publicKey.substring(0, 16)}…
              </div>
            </button>
          ))}
        </div>
      </div>
      <div className="meshcore-main-pane">
        <MeshCoreMap contacts={contacts} selectedPublicKey={selected} />
      </div>
    </div>
  );
};
