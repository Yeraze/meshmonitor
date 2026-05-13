import React, { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { MeshCoreMessage, MeshCoreActions, ConnectionStatus } from './hooks/useMeshCore';
import { MeshCoreMessageStream } from './MeshCoreMessageStream';

interface MeshCoreChannelsViewProps {
  messages: MeshCoreMessage[];
  status: ConnectionStatus | null;
  actions: MeshCoreActions;
}

interface ChannelDef {
  id: string;
  name: string;
  filter: (m: MeshCoreMessage) => boolean;
  /** When sending, the toPublicKey to use (undefined = broadcast). */
  toPublicKey?: string;
}

const PUBLIC_CHANNEL: ChannelDef = {
  id: 'public',
  name: 'Public',
  filter: m => !m.toPublicKey,
  toPublicKey: undefined,
};

export const MeshCoreChannelsView: React.FC<MeshCoreChannelsViewProps> = ({
  messages,
  status,
  actions,
}) => {
  const { t } = useTranslation();
  const [selected, setSelected] = useState<string>('public');
  const channels: ChannelDef[] = [PUBLIC_CHANNEL];

  const active = channels.find(c => c.id === selected) ?? PUBLIC_CHANNEL;
  const filtered = useMemo(
    () => messages.filter(active.filter),
    [messages, active],
  );

  const selfKey = status?.localNode?.publicKey;
  const connected = status?.connected ?? false;

  return (
    <div className="meshcore-two-pane">
      <div className="meshcore-list-pane">
        <div className="meshcore-list-pane-header">
          <span>{t('meshcore.nav.channels', 'Channels')}</span>
          <span className="pane-count">{channels.length}</span>
        </div>
        <div className="meshcore-list-pane-body">
          {channels.map(c => (
            <button
              key={c.id}
              className={`mc-node-row ${active.id === c.id ? 'selected' : ''}`}
              onClick={() => setSelected(c.id)}
            >
              <div className="mc-node-row-name">
                <span># {c.name}</span>
              </div>
              <div className="mc-node-row-meta">
                <span>{messages.filter(c.filter).length} {t('meshcore.messages', 'messages')}</span>
              </div>
            </button>
          ))}
        </div>
      </div>
      <div className="meshcore-main-pane">
        <MeshCoreMessageStream
          messages={filtered}
          selfPublicKey={selfKey}
          disabled={!connected}
          emptyText={t('meshcore.no_messages', 'No messages on this channel yet')}
          onSend={text => actions.sendMessage(text, active.toPublicKey)}
        />
      </div>
    </div>
  );
};
