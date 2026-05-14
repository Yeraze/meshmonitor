import React, { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  MeshCoreMessage, MeshCoreActions, ConnectionStatus,
} from './hooks/useMeshCore';
import { MeshCoreContact } from '../../utils/meshcoreHelpers';
import { MeshCoreMessageStream } from './MeshCoreMessageStream';
import { MeshCoreContactDetailPanel } from './MeshCoreContactDetailPanel';

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

  // Inbound `contact_message` arrives with only `pubkey_prefix` (typically
  // 12 hex chars), while contacts and outbound messages use the full pubkey.
  // Canonicalize any prefix to the matching contact's full pubkey so a single
  // peer doesn't show up as two sidebar entries.
  const canonicalize = useMemo(() => {
    return (key: string): string => {
      if (!key) return key;
      if (contactsByKey.has(key)) return key;
      for (const c of contacts) {
        if (c.publicKey && c.publicKey.startsWith(key)) return c.publicKey;
      }
      return key;
    };
  }, [contacts, contactsByKey]);

  const keysMatch = (a: string, b: string): boolean => {
    if (!a || !b) return false;
    if (a === b) return true;
    return a.startsWith(b) || b.startsWith(a);
  };

  const dmPeers = useMemo(() => {
    const peers = new Set<string>();
    for (const m of messages) {
      if (!m.toPublicKey) continue;
      if (selfKey && keysMatch(m.fromPublicKey, selfKey)) peers.add(canonicalize(m.toPublicKey));
      else if (selfKey && keysMatch(m.toPublicKey, selfKey)) peers.add(canonicalize(m.fromPublicKey));
      else {
        peers.add(canonicalize(m.fromPublicKey));
        peers.add(canonicalize(m.toPublicKey));
      }
    }
    // Always include all contacts so the user can start a new DM.
    for (const c of contacts) {
      if (c.publicKey) peers.add(c.publicKey);
    }
    return Array.from(peers);
  }, [messages, contacts, selfKey, canonicalize]);

  const filtered = useMemo(() => {
    if (!selected) return [];
    return messages.filter(m => {
      if (!m.toPublicKey) return false;
      if (selfKey && keysMatch(m.fromPublicKey, selfKey) && keysMatch(m.toPublicKey, selected)) return true;
      if (selfKey && keysMatch(m.toPublicKey, selfKey) && keysMatch(m.fromPublicKey, selected)) return true;
      // No selfKey known — fall back to either direction matching the selected peer.
      return keysMatch(m.fromPublicKey, selected) || keysMatch(m.toPublicKey, selected);
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
          <>
            <MeshCoreMessageStream
              messages={filtered}
              contacts={contacts}
              selfPublicKey={selfKey}
              disabled={!connected}
              emptyText={t('meshcore.no_messages', 'No messages with this contact yet')}
              onSend={text => actions.sendMessage(text, selected)}
            />
            <div className="meshcore-detail-pane">
              <MeshCoreContactDetailPanel
                contact={contactsByKey.get(selected) ?? null}
                publicKey={selected}
              />
            </div>
          </>
        ) : (
          <div className="meshcore-empty-state" style={{ alignSelf: 'center', margin: 'auto' }}>
            {t('meshcore.select_contact', 'Select a contact to start a DM')}
          </div>
        )}
      </div>
    </div>
  );
};
