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
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useCsrfFetch } from '../../hooks/useCsrfFetch';
import { MeshCoreMessage, MeshCoreActions, ConnectionStatus } from './hooks/useMeshCore';
import { MeshCoreContact, formatMeshCoreChannelName } from '../../utils/meshcoreHelpers';
import { MeshCoreMessageStream } from './MeshCoreMessageStream';
import { useAuth } from '../../contexts/AuthContext';

const MOBILE_BREAKPOINT = 768;
const isMobileViewport = (): boolean =>
  typeof window !== 'undefined' && window.innerWidth <= MOBILE_BREAKPOINT;

interface MeshCoreChannelsViewProps {
  messages: MeshCoreMessage[];
  contacts: MeshCoreContact[];
  status: ConnectionStatus | null;
  actions: MeshCoreActions;
  baseUrl: string;
  sourceId: string;
  onNodeNameClick?: (publicKey: string) => void;
}

interface ChannelRow {
  id: number;
  name: string;
  /** Persisted per-channel region/scope (#3667). null/'' = no channel scope. */
  scope: string | null;
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
  onNodeNameClick,
}) => {
  const { t } = useTranslation();
  const csrfFetch = useCsrfFetch();
  const { hasPermission } = useAuth();
  const canSend = hasPermission('messages', 'write');

  const [channels, setChannels] = useState<ChannelRow[]>([]);
  const [selectedIdx, setSelectedIdx] = useState<number>(0);
  const [loadingChannels, setLoadingChannels] = useState(false);
  const [mobileShowContent, setMobileShowContent] = useState(false);
  // Per-channel backlog for the *active* channel, fetched independently of the
  // shared `messages` pool so each channel shows its own history (not a slice
  // of the global recent-tail). Live updates still arrive via `messages` and
  // are merged in below.
  const [history, setHistory] = useState<MeshCoreMessage[]>([]);
  // Accurate persisted message count per channel index (for the list badges),
  // so a quiet channel doesn't read as empty next to a busy one just because
  // the shared pool's recent-tail happened to exclude it.
  const [counts, setCounts] = useState<Record<number, number>>({});
  // Per-message scope/region override (#3701). `null` means "no override —
  // use the channel's resolved scope". A string is a one-off override applied
  // to the NEXT send only; it is never persisted to the channel row. Reset on
  // channel switch so the override doesn't leak across channels.
  const [overrideScope, setOverrideScope] = useState<string | null>(null);
  const [showScopeOverride, setShowScopeOverride] = useState(false);
  // Source default scope (#3667) — used as the displayed default when a channel
  // has no scope of its own, so the operator can see what scope a normal send
  // would use before deciding to override it.
  const [defaultScope, setDefaultScope] = useState<string>('');
  // Region names served by nearby repeaters (#3667 phase 3) for the datalist
  // suggestions on the override input.
  const [discoveredRegions, setDiscoveredRegions] = useState<string[]>([]);
  // Guard so region discovery — which emits active radio traffic — runs at most
  // once per mount, and only after the operator signals intent by opening the
  // scope-override control. We must NOT re-discover on every reconnect (#3704
  // review): status flapping would flood the mesh with discovery requests.
  const regionsDiscoveredRef = useRef(false);

  useEffect(() => {
    const onResize = () => {
      if (!isMobileViewport()) setMobileShowContent(false);
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const handleSelectChannel = useCallback((idx: number) => {
    setSelectedIdx(idx);
    if (isMobileViewport()) setMobileShowContent(true);
  }, []);

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
              .map((c: any) => ({
                id: c.id as number,
                name: String(c.name ?? ''),
                scope: typeof c?.scope === 'string' && c.scope ? c.scope : null,
              }))
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
    return [{ id: 0, name: t('meshcore.channels.public_fallback', 'Public'), scope: null }];
  }, [channels, t]);

  // Keep `selectedIdx` valid if channels change underneath us.
  useEffect(() => {
    if (displayChannels.length === 0) return;
    if (!displayChannels.some(c => c.id === selectedIdx)) {
      setSelectedIdx(displayChannels[0].id);
    }
  }, [displayChannels, selectedIdx]);

  // Fetch accurate per-channel message counts for the list badges whenever the
  // channel set changes or the source (re)connects.
  const channelIdsKey = displayChannels.map(c => c.id).join(',');
  useEffect(() => {
    if (!sourceId || !channelIdsKey) return;
    let cancelled = false;
    (async () => {
      try {
        const url = `${baseUrl}/api/sources/${encodeURIComponent(sourceId)}/meshcore/messages/channel-counts?channels=${encodeURIComponent(channelIdsKey)}`;
        const response = await csrfFetch(url);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        if (!cancelled && data?.success && data.counts) setCounts(data.counts as Record<number, number>);
      } catch (err) {
        if (!cancelled) console.error('Failed to fetch MeshCore channel counts:', err);
      }
    })();
    return () => { cancelled = true; };
  }, [baseUrl, sourceId, channelIdsKey, csrfFetch, status?.connected]);

  const active = displayChannels.find(c => c.id === selectedIdx) ?? displayChannels[0];
  const activeFilter = useMemo(() => buildChannelFilter(active.id), [active.id]);

  // The scope a *normal* send on the active channel would assert: the channel's
  // own scope, else the source default, else unscoped. Used as the override
  // field's default/placeholder so the operator overrides from a known baseline.
  const resolvedScope = (active.scope && active.scope.trim()) || defaultScope.trim() || '';

  // Load the source default scope when (re)connected so the override control can
  // show the baseline. This is a cheap local DB read (no radio traffic), so it's
  // safe to re-run on reconnect.
  useEffect(() => {
    if (!status?.connected) return;
    let cancelled = false;
    (async () => {
      try {
        const def = await actions.getDefaultScope();
        if (!cancelled) setDefaultScope(def ?? '');
      } catch {
        /* non-fatal — the override still works without a baseline */
      }
    })();
    return () => { cancelled = true; };
  }, [status?.connected, actions]);

  // Lazily discover regions for the suggestion datalist ONLY once the operator
  // opens the scope-override control (explicit intent), and at most once per
  // mount. discoverRegions() emits active radio traffic, so we must never tie it
  // to status?.connected — reconnect flapping would flood the mesh (#3704 review).
  useEffect(() => {
    if (!showScopeOverride || !status?.connected) return;
    if (regionsDiscoveredRef.current) return;
    regionsDiscoveredRef.current = true;
    let cancelled = false;
    (async () => {
      try {
        const res = await actions.discoverRegions();
        if (!cancelled && res?.regions) setDiscoveredRegions(res.regions);
      } catch {
        regionsDiscoveredRef.current = false; // allow a retry on next open
        /* non-fatal — suggestions are optional */
      }
    })();
    return () => { cancelled = true; };
  }, [showScopeOverride, status?.connected, actions]);

  // Reset the one-off override when switching channels so it never leaks across
  // channels, and collapse the control back to its unobtrusive default.
  useEffect(() => {
    setOverrideScope(null);
    setShowScopeOverride(false);
  }, [active.id]);

  // Fetch the active channel's backlog from the per-channel endpoint. Re-runs on
  // channel switch and on (re)connect. The shared `messages` pool only carries a
  // global recent-tail, so this is what makes each channel's full history show.
  useEffect(() => {
    if (!sourceId) return;
    let cancelled = false;
    const idx = active.id;
    (async () => {
      try {
        const url = `${baseUrl}/api/sources/${encodeURIComponent(sourceId)}/meshcore/messages/channel/${idx}?limit=200`;
        const response = await csrfFetch(url);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        if (!cancelled) {
          setHistory(data?.success && Array.isArray(data.data) ? (data.data as MeshCoreMessage[]) : []);
        }
      } catch (err) {
        if (!cancelled) {
          console.error('Failed to fetch MeshCore channel messages:', err);
          setHistory([]);
        }
      }
    })();
    return () => { cancelled = true; };
  }, [baseUrl, sourceId, active.id, csrfFetch, status?.connected]);

  // Merge the fetched backlog with any live messages for this channel (socket
  // pushes land in `messages`). Dedupe by id, letting the live copy win so
  // delivery-status updates (sent → delivered/failed) are reflected, then sort
  // oldest-first for the stream.
  const filtered = useMemo(() => {
    const byId = new Map<string, MeshCoreMessage>();
    for (const m of history) byId.set(m.id, m);
    for (const m of messages) {
      if (activeFilter(m)) byId.set(m.id, m);
    }
    return Array.from(byId.values()).sort((a, b) => a.timestamp - b.timestamp);
  }, [history, messages, activeFilter]);

  const selfKey = status?.localNode?.publicKey;
  const connected = status?.connected ?? false;

  const mobileClass = mobileShowContent ? 'mobile-show-content' : 'mobile-show-list';

  return (
    <div className={`meshcore-two-pane ${mobileClass}`}>
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
            // Accurate persisted count from the counts endpoint. For the active
            // channel, prefer the merged stream length when it's larger so a
            // just-arrived live message bumps the badge before the next refetch.
            const persisted = counts[c.id] ?? messages.filter(buildChannelFilter(c.id)).length;
            const count = c.id === active.id ? Math.max(persisted, filtered.length) : persisted;
            return (
              <button
                key={c.id}
                className={`mc-channel-row ${active.id === c.id ? 'selected' : ''}`}
                onClick={() => handleSelectChannel(c.id)}
              >
                <div className="mc-channel-row-name">
                  {formatMeshCoreChannelName(
                    c.name,
                    t('meshcore.channels.unnamed', 'Channel {{idx}}', { idx: c.id }),
                  )}
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
        {mobileShowContent && (
          <div className="meshcore-mobile-back-header">
            <button
              type="button"
              className="meshcore-mobile-back-btn"
              onClick={() => setMobileShowContent(false)}
            >
              ◀ {t('common.back', 'Back')}
            </button>
            <span className="meshcore-mobile-back-title">
              {formatMeshCoreChannelName(
                active.name,
                t('meshcore.channels.unnamed', 'Channel {{idx}}', { idx: active.id }),
              )}
            </span>
          </div>
        )}
        {canSend && connected && (
          <div className="mc-scope-override">
            {showScopeOverride ? (
              <div className="mc-scope-override-row">
                <label className="mc-scope-override-label" htmlFor={`mc-scope-${active.id}`}>
                  {t('meshcore.scope.override_label', 'Send scope')}
                </label>
                <input
                  id={`mc-scope-${active.id}`}
                  className="mc-scope-override-input"
                  type="text"
                  list="mc-scope-region-suggestions"
                  value={overrideScope ?? ''}
                  placeholder={resolvedScope
                    ? t('meshcore.scope.override_placeholder', 'e.g. {{scope}}', { scope: resolvedScope })
                    : t('meshcore.scope.override_placeholder_unscoped', 'unscoped')}
                  onChange={e => setOverrideScope(e.target.value)}
                  spellCheck={false}
                  autoCapitalize="none"
                  autoCorrect="off"
                />
                <datalist id="mc-scope-region-suggestions">
                  {discoveredRegions.map(r => <option key={r} value={r} />)}
                </datalist>
                <button
                  type="button"
                  className="mc-scope-override-clear"
                  onClick={() => { setOverrideScope(null); setShowScopeOverride(false); }}
                  title={t('meshcore.scope.override_clear', 'Use channel scope')}
                >
                  ✕
                </button>
              </div>
            ) : (
              <button
                type="button"
                className="mc-scope-override-toggle"
                onClick={() => setShowScopeOverride(true)}
                title={t(
                  'meshcore.scope.override_toggle_title',
                  'Send this message under a one-off region/scope override',
                )}
              >
                {t('meshcore.scope.override_toggle', 'Scope: {{scope}}', {
                  scope: resolvedScope || t('meshcore.scope.unscoped', 'unscoped'),
                })}
              </button>
            )}
          </div>
        )}
        <MeshCoreMessageStream
          messages={filtered}
          contacts={contacts}
          selfPublicKey={selfKey}
          disabled={!connected || !canSend}
          emptyText={t('meshcore.no_messages', 'No messages on this channel yet')}
          onSend={async text => {
            // Pass the one-off scope override only when the operator has opened
            // the control AND typed a value (incl. '' to mean unscoped). When
            // collapsed, omit the arg so the backend resolves the channel /
            // default scope as usual (#3701).
            const ok = showScopeOverride && overrideScope !== null
              ? await actions.sendMessage(text, undefined, active.id, overrideScope)
              : await actions.sendMessage(text, undefined, active.id);
            return ok;
          }}
          onNodeNameClick={onNodeNameClick}
          conversationKey={`channel-${active.id}`}
        />
      </div>
    </div>
  );
};
