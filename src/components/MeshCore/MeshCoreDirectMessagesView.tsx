import React, { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  MeshCoreMessage, MeshCoreActions, ConnectionStatus,
} from './hooks/useMeshCore';
import { MeshCoreContact } from '../../utils/meshcoreHelpers';
import { MeshCoreMessageStream } from './MeshCoreMessageStream';

interface MeshCoreDirectMessagesViewProps {
  messages: MeshCoreMessage[];
  contacts: MeshCoreContact[];
  status: ConnectionStatus | null;
  actions: MeshCoreActions;
}

export const MeshCoreDirectMessagesView: React.FC<MeshCoreDirectMessagesViewProps> = ({
  messages,
  contacts,
  status,
  actions,
}) => {
  const { t } = useTranslation();
  const [selected, setSelected] = useState<string | null>(null);

  const selfKey = status?.localNode?.publicKey;
  const connected = status?.connected ?? false;

  // Contacts that have at least one DM thread (filtered on top).
  const contactsByKey = useMemo(() => {
    const map = new Map<string, MeshCoreContact>();
    for (const c of contacts) {
      if (c.publicKey) map.set(c.publicKey, c);
    }
    return map;
  }, [contacts]);

  const dmPeers = useMemo(() => {
    const peers = new Set<string>();
    for (const m of messages) {
      if (!m.toPublicKey) continue;
      if (selfKey && m.fromPublicKey === selfKey) peers.add(m.toPublicKey);
      else if (selfKey && m.toPublicKey === selfKey) peers.add(m.fromPublicKey);
      else {
        peers.add(m.fromPublicKey);
        peers.add(m.toPublicKey);
      }
    }
    // Always include all contacts so the user can start a new DM.
    for (const c of contacts) {
      if (c.publicKey) peers.add(c.publicKey);
    }
    return Array.from(peers);
  }, [messages, contacts, selfKey]);

  const filtered = useMemo(() => {
    if (!selected) return [];
    return messages.filter(m => {
      if (!m.toPublicKey) return false;
      if (selfKey && m.fromPublicKey === selfKey && m.toPublicKey === selected) return true;
      if (selfKey && m.toPublicKey === selfKey && m.fromPublicKey === selected) return true;
      // No selfKey known — fall back to either direction matching the selected peer.
      return m.fromPublicKey === selected || m.toPublicKey === selected;
    });
  }, [messages, selected, selfKey]);

  return (
    <div className="meshcore-two-pane">
      <div className="meshcore-list-pane">
        <div className="meshcore-list-pane-header">
          <span>{t('meshcore.nav.dms', 'Direct Messages')}</span>
          <span className="pane-count">{dmPeers.length}</span>
        </div>
        <div className="meshcore-list-pane-body">
          {dmPeers.length === 0 ? (
            <div className="meshcore-empty-state">
              {t('meshcore.no_contacts', 'No contacts yet')}
            </div>
          ) : dmPeers.map(key => {
            const c = contactsByKey.get(key);
            const name = c?.advName || c?.name || `${key.substring(0, 8)}…`;
            return (
              <button
                key={key}
                className={`mc-node-row ${selected === key ? 'selected' : ''}`}
                onClick={() => setSelected(key)}
              >
                <div className="mc-node-row-name">
                  <span>{name}</span>
                </div>
                <div className="mc-node-row-key">{key.substring(0, 20)}…</div>
              </button>
            );
          })}
        </div>
      </div>
      <div className="meshcore-main-pane">
        {selected ? (
          <MeshCoreMessageStream
            messages={filtered}
            selfPublicKey={selfKey}
            disabled={!connected}
            emptyText={t('meshcore.no_messages', 'No messages with this contact yet')}
            onSend={text => actions.sendMessage(text, selected)}
          />
        ) : (
          <div className="meshcore-empty-state" style={{ alignSelf: 'center', margin: 'auto' }}>
            {t('meshcore.select_contact', 'Select a contact to start a DM')}
          </div>
        )}
      </div>
    </div>
  );
};
