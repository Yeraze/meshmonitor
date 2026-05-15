/**
 * MeshCoreChannelsView — per-channel message stream for a MeshCore source.
 *
 * Reads the channel list from `/api/channels?sourceId=<sourceId>` (mirrored
 * by `MeshCoreManager.syncChannelsFromDevice` on connect — phase 1 of the
 * MeshCore channels feature). Falls back to a synthetic "Channel 0" entry
 * when no rows are available so the panel doesn't look broken before the
 * first sync completes.
 *
 * Channel messaging on the wire is index-keyed (no per-sender pubkey for
 * channel traffic — the firmware embeds the sender's name in the text body).
 * MeshMonitor synthesises `fromPublicKey = 'channel-${idx}'` on receive
 * (meshcoreManager.ts:561) and `toPublicKey = 'channel-${idx}'` on local
 * send (meshcoreManager.ts:sendMessage, phase 2 addition). The per-channel
 * filter therefore matches either direction.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useCsrfFetch } from '../../hooks/useCsrfFetch';
import { MeshCoreMessage, MeshCoreActions, ConnectionStatus } from './hooks/useMeshCore';
import { MeshCoreContact } from '../../utils/meshcoreHelpers';
import { MeshCoreMessageStream } from './MeshCoreMessageStream';
import { useAuth } from '../../contexts/AuthContext';

interface MeshCoreChannelsViewProps {
  messages: MeshCoreMessage[];
  contacts: MeshCoreContact[];
  status: ConnectionStatus | null;
  actions: MeshCoreActions;
  baseUrl: string;
  sourceId: string;
}

interface ChannelRow {
  id: number;
  name: string;
}

/** Synthesised pseudo-pubkey used to scope channel messages. Must match the
 *  format that meshcoreManager generates server-side (`channel-${idx}`). */
const channelKey = (idx: number) => `channel-${idx}`;

/**
 * Returns the messages that belong to the given channel index.
 *
 *  - Received: `fromPublicKey === channel-${idx}` (synthesised by the manager).
 *  - Locally-sent: `toPublicKey === channel-${idx}` (phase-2 tagging).
 *  - Legacy fallback for channel 0 only: pre-phase-2 outbound channel-0
 *    messages had `toPublicKey === undefined`; treat any message with no
 *    recipient AND no synthesised `channel-N` sender as channel 0 so old
 *    rows still appear in the right tab.
 */
function buildChannelFilter(channelIdx: number): (m: MeshCoreMessage) => boolean {
  const key = channelKey(channelIdx);
  return (m) => {
    if (m.fromPublicKey === key) return true;
    if (m.toPublicKey === key) return true;
    if (channelIdx === 0 && !m.toPublicKey && !m.fromPublicKey.startsWith('channel-')) {
      return true;
    }
    return false;
  };
}

export const MeshCoreChannelsView: React.FC<MeshCoreChannelsViewProps> = ({
  messages,
  contacts,
  status,
  actions,
  baseUrl,
  sourceId,
}) => {
  const { t } = useTranslation();
  const csrfFetch = useCsrfFetch();
  const { hasPermission } = useAuth();
  const canSend = hasPermission('messages', 'write');

  const [channels, setChannels] = useState<ChannelRow[]>([]);
  const [selectedIdx, setSelectedIdx] = useState<number>(0);
  const [loadingChannels, setLoadingChannels] = useState(false);

  // Fetch the synced channel list for this source. We use /api/channels/all
  // (rather than /api/channels) so MeshCore rows with idx > 7 aren't dropped
  // by the legacy Meshtastic-shaped 0-7 filter on the basic endpoint. The
  // /all endpoint still goes through the per-row permission gate.
  useEffect(() => {
    if (!sourceId) return;
    let cancelled = false;
    setLoadingChannels(true);
    (async () => {
      try {
        const url = `${baseUrl}/api/channels/all?sourceId=${encodeURIComponent(sourceId)}`;
        const response = await csrfFetch(url);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const raw = await response.json();
        const rows: ChannelRow[] = Array.isArray(raw)
          ? raw
              .filter((c: any) => typeof c?.id === 'number')
              .map((c: any) => ({ id: c.id as number, name: String(c.name ?? '') }))
              .sort((a, b) => a.id - b.id)
          : [];
        if (!cancelled) setChannels(rows);
      } catch (err) {
        if (!cancelled) {
          console.error('Failed to fetch MeshCore channels:', err);
          setChannels([]);
        }
      } finally {
        if (!cancelled) setLoadingChannels(false);
      }
    })();
    return () => { cancelled = true; };
  // Status connected→disconnected→connected transitions trigger a re-fetch so a
  // freshly-synced channel list shows up without a full page reload.
  }, [baseUrl, sourceId, csrfFetch, status?.connected]);

  // Always include a synthetic "Channel 0" placeholder when the device hasn't
  // reported any channels yet — keeps the view usable on first connect, and
  // gives the user something to chat in if the firmware ships with a default
  // primary channel that hasn't been read yet.
  const displayChannels: ChannelRow[] = useMemo(() => {
    if (channels.length > 0) return channels;
    return [{ id: 0, name: t('meshcore.channels.public_fallback', 'Public') }];
  }, [channels, t]);

  // Keep `selectedIdx` valid if channels change underneath us.
  useEffect(() => {
    if (displayChannels.length === 0) return;
    if (!displayChannels.some(c => c.id === selectedIdx)) {
      setSelectedIdx(displayChannels[0].id);
    }
  }, [displayChannels, selectedIdx]);

  const active = displayChannels.find(c => c.id === selectedIdx) ?? displayChannels[0];
  const activeFilter = useMemo(() => buildChannelFilter(active.id), [active.id]);
  const filtered = useMemo(
    () => messages.filter(activeFilter),
    [messages, activeFilter],
  );

  const selfKey = status?.localNode?.publicKey;
  const connected = status?.connected ?? false;

  return (
    <div className="meshcore-two-pane">
      <div className="meshcore-list-pane">
        <div className="meshcore-list-pane-header">
          <span>{t('meshcore.nav.channels', 'Channels')}</span>
          <span className="pane-count">{displayChannels.length}</span>
        </div>
        <div className="meshcore-list-pane-body">
          {loadingChannels && channels.length === 0 && (
            <div className="mc-channel-row" aria-busy="true">
              <div className="mc-channel-row-name">
                {t('meshcore.channels.loading', 'Loading channels…')}
              </div>
            </div>
          )}
          {displayChannels.map(c => {
            const filter = buildChannelFilter(c.id);
            const count = messages.filter(filter).length;
            return (
              <button
                key={c.id}
                className={`mc-channel-row ${active.id === c.id ? 'selected' : ''}`}
                onClick={() => setSelectedIdx(c.id)}
              >
                <div className="mc-channel-row-name">
                  # {c.name || t('meshcore.channels.unnamed', 'Channel {{idx}}', { idx: c.id })}
                </div>
                <div className="mc-channel-row-meta">
                  {count} {t('meshcore.messages', 'messages')}
                </div>
              </button>
            );
          })}
        </div>
      </div>
      <div className="meshcore-main-pane">
        <MeshCoreMessageStream
          messages={filtered}
          contacts={contacts}
          selfPublicKey={selfKey}
          disabled={!connected || !canSend}
          emptyText={t('meshcore.no_messages', 'No messages on this channel yet')}
          onSend={text => actions.sendMessage(text, undefined, active.id)}
        />
      </div>
    </div>
  );
};
