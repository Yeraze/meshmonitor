import React, { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  MeshCoreMessage, MeshCoreActions, ConnectionStatus, MeshCoreNode,
} from './hooks/useMeshCore';
import { MeshCoreContact } from '../../utils/meshcoreHelpers';
import { meshcoreRoleIcon, meshcoreRoleLabelKey, meshcoreRoleLabel } from './meshcoreRole';
import { MeshCoreMessageStream } from './MeshCoreMessageStream';
import { MeshCoreContactDetailPanel } from './MeshCoreContactDetailPanel';
import { MeshCoreNodeTelemetryConfig } from './MeshCoreNodeTelemetryConfig';
import TelemetryGraphs from '../TelemetryGraphs';
import { useAuth } from '../../contexts/AuthContext';
import { useSettings } from '../../contexts/SettingsContext';
import {
  markDmRead,
  loadDmLastRead,
  subscribeUnreadChanged,
  computeUnreadDmPeers,
  canonicalizePeerKey,
  isChannelPseudoKey,
} from './meshcoreUnreadStore';

interface MeshCoreDirectMessagesViewProps {
  messages: MeshCoreMessage[];
  contacts: MeshCoreContact[];
  /**
   * Full node list for this source. Contacts carry no favorite flag (it lives
   * server-side, issue #3588), so the favorite status — used to pin favorited
   * peers to the top of the DM list (issue #3620) — is sourced from here, keyed
   * by publicKey. Optional — when omitted (e.g. legacy callers/tests) no peer
   * is pinned and the list sorts purely by the chosen field.
   */
  nodes?: MeshCoreNode[];
  status: ConnectionStatus | null;
  actions: MeshCoreActions;
  /** Frontend basename — required for the per-node telemetry-config panel. */
  baseUrl?: string;
  /**
   * Owning source id. When set together with a 64-hex contact pubkey, the
   * per-node telemetry-retrieval config panel is rendered next to the
   * contact-detail panel.
   */
  sourceId?: string;
  /** When set, auto-selects this contact on mount or when the value changes. */
  initialSelectedContact?: string | null;
}

/** True when the publicKey is a real 64-char hex (i.e. not a synthetic / prefix key). */
function isRealNodeKey(key: string): boolean {
  return /^[0-9a-fA-F]{64}$/.test(key);
}

type DmSortField = 'name' | 'lastMessage';
type DmSortDirection = 'asc' | 'desc';

const MOBILE_BREAKPOINT = 768;
const isMobileViewport = (): boolean =>
  typeof window !== 'undefined' && window.innerWidth <= MOBILE_BREAKPOINT;

export const MeshCoreDirectMessagesView: React.FC<MeshCoreDirectMessagesViewProps> = ({
  messages,
  contacts,
  nodes = [],
  status,
  actions,
  baseUrl,
  sourceId,
  initialSelectedContact,
}) => {
  const { t } = useTranslation();
  const { hasPermission } = useAuth();
  // Honor the user's Temperature Unit + telemetry time-range settings on the
  // per-node telemetry graph, consistent with the Meshtastic DM view and the
  // MeshCore Telemetry dashboard (#3659).
  const { temperatureUnit, telemetryVisualizationHours } = useSettings();
  const canSend = hasPermission('messages', 'write');
  const canWriteNodes = hasPermission('nodes', 'write');
  const canRemoteAdmin = hasPermission('remote_admin', 'write');
  const [selected, setSelected] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [sortField, setSortField] = useState<DmSortField>('lastMessage');
  const [sortDirection, setSortDirection] = useState<DmSortDirection>('desc');
  const [isCollapsed, setIsCollapsed] = useState<boolean>(false);
  const [mobileShowContent, setMobileShowContent] = useState(false);

  useEffect(() => {
    const onResize = () => {
      if (!isMobileViewport()) setMobileShowContent(false);
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  useEffect(() => {
    if (initialSelectedContact) {
      setSelected(initialSelectedContact);
      if (isMobileViewport()) setMobileShowContent(true);
    }
  }, [initialSelectedContact]);

  const selfKey = status?.localNode?.publicKey;
  const connected = status?.connected ?? false;
  // CMD_RESET_PATH / CMD_SHARE_CONTACT / CMD_ADD_UPDATE_CONTACT are all
  // companion-only (firmware deviceType=1).
  const isCompanion = (status?.deviceType ?? 0) === 1;

  // Lazy-read the advanced path-edit toggle from /api/settings. Off by
  // default; flipping it on/off in the Settings tab takes effect on the
  // next mount. We don't subscribe to settings changes here — the panel
  // is mounted often enough that polling isn't worth the complexity.
  // Contacts that have at least one DM thread (filtered on top).
  const contactsByKey = useMemo(() => {
    const map = new Map<string, MeshCoreContact>();
    for (const c of contacts) {
      if (c.publicKey) map.set(c.publicKey, c);
    }
    return map;
  }, [contacts]);

  // Favorite status lives server-side on the node list (issue #3588), not on
  // contacts. Build a publicKey -> isFavorite lookup so favorited peers can be
  // pinned to the top of the DM list (issue #3620), mirroring the Meshtastic
  // DM list and the MeshCore node list.
  const favoriteByKey = useMemo(() => {
    const map = new Map<string, boolean>();
    for (const n of nodes) {
      if (n.publicKey && n.isFavorite) map.set(n.publicKey, true);
    }
    return map;
  }, [nodes]);

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

  // Channel messages carry synthetic `channel-${idx}` keys (see the shared
  // `isChannelPseudoKey` in meshcoreUnreadStore) — they are NOT real DM peers
  // and are filtered out everywhere this view looks at to/fromPublicKey.
  const dmPeers = useMemo(() => {
    const peers = new Set<string>();
    const lastMessageAt = new Map<string, number>();
    const noteMessage = (key: string, ts: number | undefined) => {
      if (typeof ts !== 'number') return;
      const prev = lastMessageAt.get(key) ?? 0;
      if (ts > prev) lastMessageAt.set(key, ts);
    };
    for (const m of messages) {
      if (!m.toPublicKey) continue;
      if (m.messageType === 'room_post') continue;
      if (isChannelPseudoKey(m.toPublicKey) || isChannelPseudoKey(m.fromPublicKey)) continue;
      if (selfKey && keysMatch(m.fromPublicKey, selfKey)) {
        const peer = canonicalize(m.toPublicKey);
        peers.add(peer);
        noteMessage(peer, m.timestamp);
      } else if (selfKey && keysMatch(m.toPublicKey, selfKey)) {
        const peer = canonicalize(m.fromPublicKey);
        peers.add(peer);
        noteMessage(peer, m.timestamp);
      } else {
        const a = canonicalize(m.fromPublicKey);
        const b = canonicalize(m.toPublicKey);
        peers.add(a);
        peers.add(b);
        noteMessage(a, m.timestamp);
        noteMessage(b, m.timestamp);
      }
    }
    // Always include all contacts so the user can start a new DM.
    // Exclude room servers (advType=3) — they belong in the Rooms view.
    for (const c of contacts) {
      if (c.publicKey && !isChannelPseudoKey(c.publicKey) && c.advType !== 3) peers.add(c.publicKey);
    }
    // Drop the local node — DMing yourself is meaningless and the local node
    // sometimes appears in the contacts list as a side-effect of seeding.
    if (selfKey) {
      for (const key of Array.from(peers)) {
        if (keysMatch(key, selfKey)) peers.delete(key);
      }
    }
    const peerNameFor = (key: string): string => {
      const c = contactsByKey.get(key);
      return c?.advName || c?.name || key;
    };
    const dir = sortDirection === 'asc' ? 1 : -1;
    return Array.from(peers).sort((a, b) => {
      // Favorites pin to the top regardless of sort field/direction, matching
      // the Meshtastic DM list and the MeshCore node list (issue #3620).
      const aFav = favoriteByKey.get(a) ?? false;
      const bFav = favoriteByKey.get(b) ?? false;
      if (aFav !== bFav) return aFav ? -1 : 1;
      if (sortField === 'name') {
        return peerNameFor(a).localeCompare(peerNameFor(b), undefined, { sensitivity: 'base' }) * dir;
      }
      const at = lastMessageAt.get(a) ?? 0;
      const bt = lastMessageAt.get(b) ?? 0;
      return (at - bt) * dir;
    });
  }, [messages, contacts, selfKey, canonicalize, contactsByKey, favoriteByKey, sortField, sortDirection]);

  const filteredPeers = useMemo(() => {
    if (!searchQuery.trim()) return dmPeers;
    const q = searchQuery.toLowerCase();
    return dmPeers.filter(key => {
      const c = contactsByKey.get(key);
      const name = c?.advName || c?.name || '';
      return name.toLowerCase().includes(q) || key.toLowerCase().includes(q);
    });
  }, [dmPeers, searchQuery, contactsByKey]);

  const filtered = useMemo(() => {
    if (!selected) return [];
    return messages.filter(m => {
      if (!m.toPublicKey) return false;
      if (m.messageType === 'room_post') return false;
      if (isChannelPseudoKey(m.toPublicKey) || isChannelPseudoKey(m.fromPublicKey)) return false;
      if (selfKey && keysMatch(m.fromPublicKey, selfKey) && keysMatch(m.toPublicKey, selected)) return true;
      if (selfKey && keysMatch(m.toPublicKey, selfKey) && keysMatch(m.fromPublicKey, selected)) return true;
      // No selfKey known — fall back to either direction matching the selected peer.
      return keysMatch(m.fromPublicKey, selected) || keysMatch(m.toPublicKey, selected);
    });
  }, [messages, selected, selfKey]);

  // Unread-marker re-read trigger (localStorage isn't reactive) (#3891).
  const [unreadTick, setUnreadTick] = useState(0);
  useEffect(() => subscribeUnreadChanged(() => setUnreadTick((n) => n + 1)), []);

  // Mark the open conversation read up to its newest message. Re-runs when a
  // new message arrives for the selected peer (filtered changes), so a
  // conversation you're actively viewing never lingers as unread. markDmRead is
  // a no-op when the marker is already current, so this stays cheap.
  useEffect(() => {
    if (!sourceId || !selected) return;
    const peer = canonicalizePeerKey(selected, contacts);
    const latest = filtered.reduce((mx, m) => Math.max(mx, m.timestamp), 0);
    markDmRead(sourceId, peer, latest || Date.now());
  }, [sourceId, selected, contacts, filtered]);

  // Peers with unread incoming DMs — drives the per-row red-dot in the contact
  // list. The currently-open peer is never flagged.
  const unreadPeers = useMemo(() => {
    void unreadTick;
    if (!sourceId) return new Set<string>();
    return computeUnreadDmPeers({
      messages,
      contacts,
      selfKey,
      dmLastRead: loadDmLastRead(sourceId),
      activePeerKey: selected,
    });
  }, [sourceId, messages, contacts, selfKey, selected, unreadTick]);

  const handleSelectContact = (key: string) => {
    setSelected(key);
    if (isMobileViewport()) setMobileShowContent(true);
  };

  const selectedContactName = selected
    ? (contactsByKey.get(selected)?.advName || contactsByKey.get(selected)?.name || `${selected.substring(0, 8)}…`)
    : '';

  // Repeaters (advType=2) cannot receive direct messages — the firmware acks
  // the relay packet, which surfaced as a misleading "delivered" (✓✓). We keep
  // the repeater listed in the contact sidebar and still render its detail panel
  // (telemetry/position/remote-admin), but drop the messaging UI entirely rather
  // than send messages that can never arrive (issue #3755).
  const isSelectedRepeater = selected ? contactsByKey.get(selected)?.advType === 2 : false;

  const mobileClass = mobileShowContent ? 'mobile-show-content' : 'mobile-show-list';

  return (
    <div className={`meshcore-two-pane ${mobileClass}`}>
      <div className={`meshcore-list-pane ${isCollapsed ? 'collapsed' : ''}`}>
        <div className="meshcore-list-pane-header">
          <button
            type="button"
            className="meshcore-collapse-btn"
            onClick={() => setIsCollapsed((c) => !c)}
            title={isCollapsed
              ? t('nodes.expand_node_list', 'Expand node list')
              : t('nodes.collapse_node_list', 'Collapse node list')}
            aria-label={isCollapsed
              ? t('nodes.expand_node_list', 'Expand node list')
              : t('nodes.collapse_node_list', 'Collapse node list')}
            aria-expanded={!isCollapsed}
          >
            {isCollapsed ? '▶' : '◀'}
          </button>
          {!isCollapsed && (
            <>
              <span>{t('meshcore.nav.dms', 'Node Details')}</span>
              <span className="pane-count">{dmPeers.length}</span>
              <div className="sort-controls meshcore-sort-controls">
                <select
                  aria-label={t('meshcore.sort_by', 'Sort by')}
                  title={t('meshcore.sort_by', 'Sort by')}
                  value={sortField}
                  onChange={(e) => setSortField(e.target.value as DmSortField)}
                  className="sort-dropdown"
                >
                  <option value="lastMessage">{t('meshcore.sort_last_message', 'Last message')}</option>
                  <option value="name">{t('meshcore.sort_name', 'Name')}</option>
                </select>
                <button
                  type="button"
                  className="sort-direction-btn"
                  onClick={() => setSortDirection((d) => (d === 'asc' ? 'desc' : 'asc'))}
                  title={sortDirection === 'asc'
                    ? t('meshcore.ascending', 'Ascending')
                    : t('meshcore.descending', 'Descending')}
                  aria-label={sortDirection === 'asc'
                    ? t('meshcore.ascending', 'Ascending')
                    : t('meshcore.descending', 'Descending')}
                >
                  {sortDirection === 'asc' ? '↑' : '↓'}
                </button>
              </div>
            </>
          )}
        </div>
        {!isCollapsed && (
          <>
          <div className="meshcore-search-bar">
            <input
              type="text"
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              placeholder={t('meshcore.search_contacts', 'Search contacts…')}
              className="meshcore-search-input"
            />
            {searchQuery && (
              <button
                type="button"
                className="meshcore-search-clear"
                onClick={() => setSearchQuery('')}
                aria-label={t('common.clear', 'Clear')}
              >
                ×
              </button>
            )}
          </div>
          <div className="meshcore-list-pane-body">
            {filteredPeers.length === 0 ? (
              <div className="meshcore-empty-state">
                {searchQuery
                  ? t('meshcore.no_search_results', 'No contacts match your search')
                  : t('meshcore.no_contacts', 'No contacts yet')}
              </div>
            ) : filteredPeers.map(key => {
              const c = contactsByKey.get(key);
              const name = c?.advName || c?.name || `${key.substring(0, 8)}…`;
              const isFavorite = favoriteByKey.get(key) ?? false;
              const roleIcon = meshcoreRoleIcon(c?.advType);
              const hasUnread = unreadPeers.has(key);
              return (
                <button
                  key={key}
                  className={`mc-node-row ${selected === key ? 'selected' : ''}`}
                  onClick={() => handleSelectContact(key)}
                >
                  <div className="mc-node-row-name">
                    {hasUnread && (
                      <span
                        className="meshcore-dm-unread-dot"
                        aria-label={t('meshcore.dms.unread', 'Unread messages')}
                        title={t('meshcore.dms.unread', 'Unread messages')}
                      />
                    )}
                    {roleIcon && (
                      <span
                        className="mc-node-role-icon"
                        role="img"
                        aria-label={t(meshcoreRoleLabelKey(c?.advType), meshcoreRoleLabel(c?.advType))}
                        title={t(meshcoreRoleLabelKey(c?.advType), meshcoreRoleLabel(c?.advType))}
                      >
                        {roleIcon}
                      </span>
                    )}
                    {isFavorite && (
                      <span className="mc-dm-row-favorite" aria-label={t('meshcore.favorite.is_favorite', 'Favorite')} title={t('meshcore.favorite.is_favorite', 'Favorite')}>★</span>
                    )}
                    <span className="mc-node-row-display-name">{name}</span>
                  </div>
                  <div className="mc-node-row-key">{key.substring(0, 20)}…</div>
                </button>
              );
            })}
          </div>
          </>
        )}
      </div>
      <div className="meshcore-main-pane meshcore-main-pane--dm">
        {mobileShowContent && (
          <div className="meshcore-mobile-back-header">
            <button
              type="button"
              className="meshcore-mobile-back-btn"
              onClick={() => setMobileShowContent(false)}
            >
              ◀ {t('common.back', 'Back')}
            </button>
            {selected && (
              <span className="meshcore-mobile-back-title">{selectedContactName}</span>
            )}
          </div>
        )}
        {selected ? (
          <>
            {isSelectedRepeater ? (
              <div className="meshcore-dm-no-messaging" role="note">
                {t('meshcore.repeater_no_messaging', 'Repeaters cannot receive direct messages — showing node details only.')}
              </div>
            ) : (
              <MeshCoreMessageStream
                messages={filtered}
                contacts={contacts}
                selfPublicKey={selfKey}
                disabled={!connected || !canSend}
                emptyText={t('meshcore.no_messages', 'No messages with this contact yet')}
                onSend={text => actions.sendMessage(text, selected)}
                conversationKey={`dm-${selected}`}
                maxBytes={150}
              />
            )}
            <div className="meshcore-detail-pane">
              <MeshCoreContactDetailPanel
                contact={contactsByKey.get(selected) ?? null}
                publicKey={selected}
                onResetPath={actions.resetContactPath}
                onShareContact={actions.shareContact}
                onSetOutPath={actions.setContactOutPath}
                onTracePath={actions.traceContactPath}
                onDiscoverPath={actions.discoverContactPath}
                onRemoveContact={actions.removeContact}
                onExportContact={actions.exportContact}
                onGetNeighbours={actions.getNeighbours}
                canWriteNodes={canWriteNodes && connected}
                isCompanion={isCompanion}
                repeaters={contacts}
                canRemoteAdmin={canRemoteAdmin && connected}
                remoteAdminActions={{
                  loginRemote: actions.loginRemote,
                  loginRemoteWithSaved: actions.loginRemoteWithSaved,
                  sendCliCommand: actions.sendCliCommand,
                  getRemoteAdminCapability: actions.getRemoteAdminCapability,
                  forgetRemoteCredential: actions.forgetRemoteCredential,
                  getRemoteStatus: actions.getRemoteStatus,
                }}
              />
              {!!sourceId && typeof baseUrl === 'string' && isRealNodeKey(selected) && (
                <>
                  <MeshCoreNodeTelemetryConfig
                    baseUrl={baseUrl}
                    sourceId={sourceId}
                    publicKey={selected}
                  />
                  <TelemetryGraphs
                    nodeId={selected}
                    temperatureUnit={temperatureUnit}
                    telemetryHours={telemetryVisualizationHours}
                    baseUrl={baseUrl}
                  />
                </>
              )}
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
