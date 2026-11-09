import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MeshCoreVirtualList } from './MeshCoreVirtualList';
import { companionHasNativeCli } from '../../utils/meshcoreCompanionCli';
import { MeshCoreIgnoreBlockControls } from './MeshCoreIgnoreBlockControls';
import type { MeshCoreFilterMode } from '../../hooks/useMeshCoreFilters';
import { useTranslation } from 'react-i18next';
import {
  MeshCoreMessage, MeshCoreActions, ConnectionStatus, MeshCoreNode,
} from './hooks/useMeshCore';
import { MeshCoreContact } from '../../utils/meshcoreHelpers';
import { getMeshCoreMessageContentMatchKeys } from '../../utils/messageContentFilter';
import { meshcoreRoleIconName, meshcoreRoleLabelKey, meshcoreRoleLabel, isMeshCoreInfrastructureAdvType } from './meshcoreRole';
import { MeshCoreMessageStream } from './MeshCoreMessageStream';
import { MeshCoreContactDetailPanel } from './MeshCoreContactDetailPanel';
import { MeshCoreNodeTelemetryConfig } from './MeshCoreNodeTelemetryConfig';
import { MeshCoreNodeNeighboursConfig } from './MeshCoreNodeNeighboursConfig';
import { MeshCoreNodeTimeSyncConfig } from './MeshCoreNodeTimeSyncConfig';
import TelemetryGraphs from '../TelemetryGraphs';
import { useAuth } from '../../contexts/AuthContext';
import { useSettings, useOptionalMuteSettings } from '../../contexts/SettingsContext';
import { MuteMenu, MutedIndicator } from '../notifications/MuteMenu';
import { MarkAllReadButton } from '../messages/MarkAllReadButton';
import {
  markDmRead,
  markManyRead,
  latestIncomingDmByPeer,
  loadDmLastRead,
  subscribeUnreadChanged,
  computeUnreadDmPeers,
  canonicalizePeerKey,
  isChannelPseudoKey,
} from './meshcoreUnreadStore';
import { UiIcon } from '../icons';
import { DmFilterSelect } from '../messages/DmFilterSelect';
import { NodeSortControls } from '../nodes/NodeSortControls';
import { NodeStatChips } from '../nodes/NodeStatChips';
import { usePersistedListSort } from '../../hooks/usePersistedListSort';
import { passesDmFilter } from '../../utils/dmListFilter';
import { formatMessagePreview } from '../../utils/messagePreview';
import type { DmFilter } from '../../types/ui';
import { uniquePrefixMatch } from '../../utils/meshcoreKeyMatch';
import { meshcoreReceiptTimeMs } from '../../utils/meshcoreMessageTime';
import { compareMeshCoreMessages } from './messageOrder';
import { useCsrfFetch } from '../../hooks/useCsrfFetch';
import { parseJsonResponse } from '../../utils/parseJsonResponse';
import { indexNodeFields, mergeNodeFields } from '../../utils/meshcoreNodeFieldMerge';
import { readRequiredRepeaters, mergeMeshCoreHeardBy, type RequiredRepeaterMode } from '../../utils/meshcoreHeardBy';

interface MeshCoreDirectMessagesViewProps {
  messages: MeshCoreMessage[];
  /** Reaction id → target id for late-resolved reactions (#5759). */
  reactionResolutions?: Record<string, string>;
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
  /** True when this MeshCore source is in strict receive-only mode (#4547
   *  Phase 2). Threaded to MeshCoreContactDetailPanel and
   *  MeshCoreNodeTelemetryConfig; WP3 wires the DM send-box gate itself. */
  receiveOnly?: boolean;
  /**
   * Ignore / Block entries for this source (#5408). Peers with an entry are
   * hidden from the list (the selected one stays reachable so it can be
   * taken off the list). When `onSetIgnoredNode` is given, the detail pane
   * shows Ignore / Block controls.
   */
  ignoredNodes?: ReadonlyArray<{ publicKey: string; mode: MeshCoreFilterMode }>;
  onSetIgnoredNode?: (publicKey: string, mode: MeshCoreFilterMode, name: string | null) => Promise<unknown>;
  onRemoveIgnoredNode?: (publicKey: string) => Promise<unknown>;
  /** #5964: Node Details' Show on Map. Switches to the Nodes map, selects
   *  the node and opens its popup. Unset hides the button. */
  onShowOnMap?: (publicKey: string) => void;
}

/** True when the publicKey is a real 64-char hex (i.e. not a synthetic / prefix key). */
function isRealNodeKey(key: string): boolean {
  return /^[0-9a-fA-F]{64}$/.test(key);
}

type DmSortField = 'name' | 'lastMessage' | 'publicKey';
const DM_SORT_FIELDS: readonly DmSortField[] = ['lastMessage', 'name', 'publicKey'];
// Conversation filters offered here: no 'hops' (the sort control covers it) and
// no 'noInfra' (the node-type filter covers it).
const DM_FILTER_OPTIONS: readonly DmFilter[] = ['all', 'unread', 'recent', 'favorites', 'withPosition'];
// Node-type (advType) filter for the contact list (issue #3890). 'all' = no
// filter; otherwise a MeshCore advert type: 1=Companion, 2=Repeater, 4=Sensor.
// Room Server (3) is intentionally omitted — those peers are already excluded
// from this list (they live in the Rooms view), so they can never match here.
type DmTypeFilter = 'all' | 1 | 2 | 4;
const DM_TYPE_FILTER_OPTIONS: readonly (1 | 2 | 4)[] = [1, 2, 4];

const MOBILE_BREAKPOINT = 768;
const isMobileViewport = (): boolean =>
  typeof window !== 'undefined' && window.innerWidth <= MOBILE_BREAKPOINT;

export const MeshCoreDirectMessagesView: React.FC<MeshCoreDirectMessagesViewProps> = ({
  messages,
  reactionResolutions,
  contacts,
  nodes = [],
  status,
  actions,
  baseUrl,
  sourceId,
  initialSelectedContact,
  receiveOnly = false,
  ignoredNodes,
  onSetIgnoredNode,
  onRemoveIgnoredNode,
  onShowOnMap,
}) => {
  const { t } = useTranslation();
  const { hasPermission, authStatus } = useAuth();
  const mute = useOptionalMuteSettings();
  const canMute = !!mute && authStatus?.authenticated === true;
  // Honor the user's Temperature Unit + telemetry time-range settings on the
  // per-node telemetry graph, consistent with the Meshtastic DM view and the
  // MeshCore Telemetry dashboard (#3659).
  const { temperatureUnit, telemetryVisualizationHours, tapbackEmojis } = useSettings();
  const canSend = hasPermission('messages', 'write');
  const canWriteNodes = hasPermission('nodes', 'write');
  const canTraceroute = hasPermission('traceroute', 'write');
  const canRemoteAdmin = hasPermission('remote_admin', 'write');
  const canWriteConfig = hasPermission('configuration', 'write');
  const [selected, setSelected] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const {
    field: sortField,
    direction: sortDirection,
    setField: setSortField,
    toggleDirection: toggleSortDirection,
  } = usePersistedListSort<DmSortField>('meshcoreDmSort', DM_SORT_FIELDS, { field: 'lastMessage', direction: 'desc' });
  const [dmFilter, setDmFilter] = useState<DmFilter>('all');
  const [typeFilter, setTypeFilter] = useState<DmTypeFilter>('all');
  const [isCollapsed, setIsCollapsed] = useState<boolean>(false);
  const [mobileShowContent, setMobileShowContent] = useState(false);
  const csrfFetch = useCsrfFetch();
  // #6194: per-source Required Repeaters list + ANY/ALL mode (shared with the
  // channel view). Gates the DM resend ↻ button and pins the required rows in
  // the heard-by bubble, at parity with channel sends.
  const [requiredRepeaterKeys, setRequiredRepeaterKeys] = useState<string[]>([]);
  const [requiredRepeaterMode, setRequiredRepeaterMode] = useState<RequiredRepeaterMode>('any');

  // #6186: the selected peer's DM history, read from the server so it survives
  // channel traffic evicting it from the shared `messages` window. Mirrors the
  // channel view's per-channel backlog + load-older paging (#4460).
  const { fetchDmMessages, fetchDmPeers } = actions;
  const [dmHistory, setDmHistory] = useState<MeshCoreMessage[]>([]);
  const [dmHistoryFor, setDmHistoryFor] = useState<string | null>(null);
  const [dmHasMore, setDmHasMore] = useState(false);
  const [dmLoadingOlder, setDmLoadingOlder] = useState(false);
  // DM threads that have stored history, sourced from a server query so a
  // thread whose whole history aged out of the window still shows.
  const [serverPeers, setServerPeers] = useState<Array<{ publicKey: string; lastMessageAt: number }>>([]);
  const dmHistoryRef = useRef<MeshCoreMessage[]>([]);
  const activePeerRef = useRef<string | null>(null);
  useEffect(() => { dmHistoryRef.current = dmHistory; }, [dmHistory]);

  // #6194: read this source's Required Repeaters list + mode (same reader/route
  // as the channel view). Re-read on source change; switching to Settings and
  // back remounts this view, so a change made there is picked up on return.
  useEffect(() => {
    if (!sourceId) { setRequiredRepeaterKeys([]); setRequiredRepeaterMode('any'); return; }
    let cancelled = false;
    void (async () => {
      try {
        const res = await csrfFetch(`${baseUrl ?? ''}/api/settings?sourceId=${encodeURIComponent(sourceId)}`);
        if (!res.ok) return;
        const settings = await parseJsonResponse(res);
        if (cancelled || !settings) return;
        const { keys, mode } = readRequiredRepeaters(settings);
        setRequiredRepeaterKeys(keys);
        setRequiredRepeaterMode(mode);
      } catch {
        // Keep the default (none); the resend button behaves as before.
      }
    })();
    return () => { cancelled = true; };
  }, [baseUrl, sourceId, csrfFetch]);

  // Refresh the server-sourced DM thread list on source/connect change. New DMs
  // also arrive live in `messages`, so this mainly catches old threads that are
  // no longer in the window.
  useEffect(() => {
    if (!sourceId) { setServerPeers([]); return; }
    let cancelled = false;
    void (async () => {
      const peers = await fetchDmPeers();
      if (!cancelled) setServerPeers(peers);
    })();
    return () => { cancelled = true; };
  }, [sourceId, fetchDmPeers, status?.connected]);

  // Load the selected peer's backlog from the server. Resets paging on every
  // peer/source switch so an in-flight load-older for the previous peer can't
  // land in the new conversation.
  useEffect(() => {
    if (!sourceId || !selected) return;
    let cancelled = false;
    activePeerRef.current = selected;
    setDmHasMore(false);
    setDmLoadingOlder(false);
    void (async () => {
      const { messages: hist, hasMore } = await fetchDmMessages(selected, { offset: 0, limit: 200 });
      if (cancelled) return;
      setDmHistory(hist);
      setDmHistoryFor(`${sourceId}:${selected}`);
      setDmHasMore(hasMore);
    })();
    return () => { cancelled = true; };
  }, [sourceId, selected, fetchDmMessages, status?.connected]);

  // Load an older page of the selected peer's history (#4460 infinite scroll).
  // Offset is the current backlog length; dedupe by id against a live DM that
  // may have slid the window between pages.
  const loadOlderDmHistory = useCallback(() => {
    if (!sourceId || !selected || dmLoadingOlder || !dmHasMore) return;
    const peer = selected;
    const offset = dmHistoryRef.current.length;
    setDmLoadingOlder(true);
    void (async () => {
      try {
        const { messages: older, hasMore } = await fetchDmMessages(peer, { offset, limit: 100 });
        if (activePeerRef.current !== peer) return;
        setDmHistory(prev => {
          const seen = new Set(prev.map(m => m.id));
          return [...older.filter(m => !seen.has(m.id)), ...prev];
        });
        setDmHasMore(hasMore);
      } finally {
        if (activePeerRef.current === peer) setDmLoadingOlder(false);
      }
    })();
  }, [sourceId, selected, dmLoadingOlder, dmHasMore, fetchDmMessages]);

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
  // Outbound reactions (#5762): needs the per-source switch and a live, non-receive-only link.
  const canReact = canSend && connected && !receiveOnly && status?.reactionsOutboundEnabled === true;
  // CMD_RESET_PATH / CMD_SHARE_CONTACT / CMD_ADD_UPDATE_CONTACT are all
  // companion-only (firmware deviceType=1).
  const isCompanion = (status?.deviceType ?? 0) === 1;
  // fw 1.18.0+ can grant and send remote CLI to other companions (#5867).
  const localNativeCli = isCompanion && companionHasNativeCli(status?.localNode?.firmwareVer);

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
  // #5578 advert-position fields and the P7a advert signature live on the
  // node row (it wins over the live contact). The panel needs the first two to
  // hide Show on Map for a node the map would not draw (#5964). One shared
  // merge (S8) copies them across.
  // #5390: durable First Heard (epoch ms) also comes from this index.
  const nodeFieldIndex = useMemo(() => indexNodeFields(nodes), [nodes]);

  const dmSortOptions = useMemo(
    () => [
      { value: 'lastMessage' as const, label: t('meshcore.sort_last_message', 'Last message') },
      { value: 'name' as const, label: t('meshcore.sort_name', 'Name') },
      { value: 'publicKey' as const, label: t('meshcore.sort_public_key', 'Public key') },
    ],
    [t],
  );

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
      // Unique match only (#5349): an ambiguous prefix keeps its own entry
      // rather than merging into whichever colliding contact comes first.
      return uniquePrefixMatch(contacts, key)?.publicKey ?? key;
    };
  }, [contacts, contactsByKey]);

  const keysMatch = (a: string, b: string): boolean => {
    if (!a || !b) return false;
    if (a === b) return true;
    return a.startsWith(b) || b.startsWith(a);
  };

  const ignoredModeByKey = useMemo(
    () => new Map((ignoredNodes ?? []).map((e) => [e.publicKey.toLowerCase(), e.mode] as const)),
    [ignoredNodes],
  );

  // Channel messages carry synthetic `channel-${idx}` keys (see the shared
  // `isChannelPseudoKey` in meshcoreUnreadStore) — they are NOT real DM peers
  // and are filtered out everywhere this view looks at to/fromPublicKey.
  const dmPeerData = useMemo(() => {
    const peers = new Set<string>();
    const lastMessageAt = new Map<string, number>();
    // Preview text of the newest live-window message per peer. Server-only peers
    // (#6186) contribute a time but no text, so they show no preview (#6259).
    const lastText = new Map<string, string>();
    // A reaction keeps its peer in the list but is not a message (#5759): it
    // does not move the peer's "last message" time.
    let countsAsMessage = true;
    const noteMessage = (key: string, ts: number | undefined, text?: string) => {
      if (!countsAsMessage || typeof ts !== 'number') return;
      const prev = lastMessageAt.get(key) ?? 0;
      if (ts > prev) {
        lastMessageAt.set(key, ts);
        if (text !== undefined) lastText.set(key, text);
        else lastText.delete(key);
      }
    };
    for (const m of messages) {
      if (!m.toPublicKey) continue;
      if (m.messageType === 'room_post') continue;
      if (isChannelPseudoKey(m.toPublicKey) || isChannelPseudoKey(m.fromPublicKey)) continue;
      countsAsMessage = !m.reactionEmoji;
      if (selfKey && keysMatch(m.fromPublicKey, selfKey)) {
        const peer = canonicalize(m.toPublicKey);
        peers.add(peer);
        noteMessage(peer, meshcoreReceiptTimeMs(m), m.text);
      } else if (selfKey && keysMatch(m.toPublicKey, selfKey)) {
        const peer = canonicalize(m.fromPublicKey);
        peers.add(peer);
        noteMessage(peer, meshcoreReceiptTimeMs(m), m.text);
      } else {
        const a = canonicalize(m.fromPublicKey);
        const b = canonicalize(m.toPublicKey);
        peers.add(a);
        peers.add(b);
        noteMessage(a, meshcoreReceiptTimeMs(m), m.text);
        noteMessage(b, meshcoreReceiptTimeMs(m), m.text);
      }
    }
    // #6186: threads whose entire history has aged out of the live window still
    // appear, sourced from the server-side DM-peer query.
    countsAsMessage = true;
    for (const sp of serverPeers) {
      if (isChannelPseudoKey(sp.publicKey)) continue;
      const peer = canonicalize(sp.publicKey);
      peers.add(peer);
      noteMessage(peer, sp.lastMessageAt);
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
    // Ignore / Block (#5408): hide listed peers, except the open one.
    if (ignoredModeByKey.size > 0) {
      for (const key of Array.from(peers)) {
        if (ignoredModeByKey.has(key.toLowerCase()) && key !== selected) peers.delete(key);
      }
    }
    return { peers: Array.from(peers), lastMessageAt, lastText };
  }, [messages, contacts, selfKey, canonicalize, ignoredModeByKey, selected, serverPeers]);

  const dmPeers = useMemo(() => {
    const peerNameFor = (key: string): string => {
      const c = contactsByKey.get(key);
      return c?.advName || c?.name || key;
    };
    const dir = sortDirection === 'asc' ? 1 : -1;
    return [...dmPeerData.peers].sort((a, b) => {
      // Favorites pin to the top regardless of sort field/direction, matching
      // the Meshtastic DM list and the MeshCore node list (issue #3620).
      const aFav = favoriteByKey.get(a) ?? false;
      const bFav = favoriteByKey.get(b) ?? false;
      if (aFav !== bFav) return aFav ? -1 : 1;
      if (sortField === 'name') {
        return peerNameFor(a).localeCompare(peerNameFor(b), undefined, { sensitivity: 'base' }) * dir;
      }
      if (sortField === 'publicKey') {
        // Compare lowercase hex so mixed-case keys sort the same (issue #6185).
        return a.toLowerCase().localeCompare(b.toLowerCase()) * dir;
      }
      const at = dmPeerData.lastMessageAt.get(a) ?? 0;
      const bt = dmPeerData.lastMessageAt.get(b) ?? 0;
      return (at - bt) * dir;
    });
  }, [dmPeerData, contactsByKey, favoriteByKey, sortField, sortDirection]);

  // Issue #3922 (MeshCore): let the conversation filter match on message
  // *content*, not just the contact's name / public key. Precompute the set of
  // (canonicalized) peer keys whose DM history contains the current search term
  // so the peer filter can do an O(1) membership check instead of rescanning
  // messages per peer.
  const messageContentMatchKeys = useMemo(
    () =>
      getMeshCoreMessageContentMatchKeys(messages, searchQuery, {
        canonicalize,
        isChannelKey: isChannelPseudoKey,
      }),
    [messages, searchQuery, canonicalize],
  );

  // Unread-marker re-read trigger (localStorage isn't reactive) (#3891).
  const [unreadTick, setUnreadTick] = useState(0);
  useEffect(() => subscribeUnreadChanged(() => setUnreadTick((n) => n + 1)), []);

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

  const filteredPeers = useMemo(() => {
    let peers = dmPeers;
    // Node-type filter (#3890). A peer that only exists via a message thread
    // (no matching contact) has no advType and is hidden by any specific-type
    // filter — expected, since the filter targets known node roles.
    if (typeFilter !== 'all') {
      peers = peers.filter(key => contactsByKey.get(key)?.advType === typeFilter);
    }
    if (dmFilter !== 'all') {
      const nowMs = Date.now();
      peers = peers.filter(key => {
        // The open conversation never drops out from under the user.
        if (key === selected) return true;
        const c = contactsByKey.get(key);
        return passesDmFilter(
          {
            unread: unreadPeers.has(key),
            lastMessageTime: dmPeerData.lastMessageAt.get(key) ?? 0,
            isFavorite: favoriteByKey.get(key) ?? false,
            hasPosition: typeof c?.latitude === 'number' && typeof c?.longitude === 'number',
            isInfrastructure: isMeshCoreInfrastructureAdvType(c?.advType),
          },
          dmFilter,
          nowMs
        );
      });
    }
    if (!searchQuery.trim()) return peers;
    const q = searchQuery.toLowerCase();
    return peers.filter(key => {
      const c = contactsByKey.get(key);
      const name = c?.advName || c?.name || '';
      return (
        name.toLowerCase().includes(q) ||
        key.toLowerCase().includes(q) ||
        // Issue #3922: also match conversations by message content.
        messageContentMatchKeys.has(key)
      );
    });
  }, [dmPeers, searchQuery, contactsByKey, typeFilter, messageContentMatchKeys, dmFilter, selected, unreadPeers, dmPeerData, favoriteByKey]);

  // The server backlog is "ready" only once it matches the selected peer, so a
  // previous peer's history is never drawn while this one loads (#6186).
  const dmHistoryReady = !sourceId || !selected || dmHistoryFor === `${sourceId}:${selected}`;
  const filtered = useMemo(() => {
    if (!selected) return [];
    const matchesPeer = (m: MeshCoreMessage): boolean => {
      if (!m.toPublicKey) return false;
      if (m.messageType === 'room_post') return false;
      if (isChannelPseudoKey(m.toPublicKey) || isChannelPseudoKey(m.fromPublicKey)) return false;
      if (selfKey && keysMatch(m.fromPublicKey, selfKey) && keysMatch(m.toPublicKey, selected)) return true;
      if (selfKey && keysMatch(m.toPublicKey, selfKey) && keysMatch(m.fromPublicKey, selected)) return true;
      // No selfKey known — fall back to either direction matching the selected peer.
      return keysMatch(m.fromPublicKey, selected) || keysMatch(m.toPublicKey, selected);
    };
    // Merge the server backlog (full history, #6186) with any live DMs from the
    // shared window (socket pushes land there). Dedupe by id, live copy wins so
    // delivery-status updates show, then sort receipt-time (#5973).
    // Relay evidence (heardBy, #6194) is monotonic: merge it across whichever
    // copy wins the dedupe so a confirmation on one copy is never lost when the
    // other lacks it — mirrors MeshCoreChannelsView's fold (#6212).
    const byId = new Map<string, MeshCoreMessage>();
    if (dmHistoryReady) {
      for (const m of dmHistory) {
        const heardBy = mergeMeshCoreHeardBy(byId.get(m.id)?.heardBy, m.heardBy);
        byId.set(m.id, heardBy?.length ? { ...m, heardBy } : m);
      }
    }
    for (const m of messages) {
      if (matchesPeer(m)) {
        const heardBy = mergeMeshCoreHeardBy(byId.get(m.id)?.heardBy, m.heardBy);
        byId.set(m.id, heardBy?.length ? { ...m, heardBy } : m);
      }
    }
    return Array.from(byId.values()).sort(compareMeshCoreMessages);
  }, [messages, selected, selfKey, dmHistory, dmHistoryReady]);

  // Unread-divider anchor (#4607): the peer's last-read marker frozen at the
  // moment the conversation was opened. The mark-read effect below fires within
  // a tick of selection, so a live read would always report "nothing unread".
  // Deliberately re-pinned only on peer/source change — NOT on `filtered`,
  // which changes with every incoming message.
  const [entryLastRead, setEntryLastRead] = useState<number | null>(null);
  useEffect(() => {
    if (!sourceId || !selected) {
      setEntryLastRead(null);
      return;
    }
    const peer = canonicalizePeerKey(selected, contacts);
    setEntryLastRead(loadDmLastRead(sourceId)[peer] ?? 0);
    // `contacts` is intentionally omitted: it re-resolves on every contact
    // refresh, which would re-pin mid-conversation and erase the line.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- #4607 pin-once-per-conversation is the point
  }, [sourceId, selected]);

  // Mark the open conversation read up to its newest message. Re-runs when a
  // new message arrives for the selected peer (filtered changes), so a
  // conversation you're actively viewing never lingers as unread. markDmRead is
  // a no-op when the marker is already current, so this stays cheap.
  useEffect(() => {
    if (!sourceId || !selected) return;
    const peer = canonicalizePeerKey(selected, contacts);
    const latest = filtered.reduce((mx, m) => Math.max(mx, meshcoreReceiptTimeMs(m)), 0);
    markDmRead(sourceId, peer, latest || Date.now());
  }, [sourceId, selected, contacts, filtered]);

  // Mark-all-read (#6261): every peer with an incoming DM past its marker,
  // muted peers included (muting hides the dot, not the backlog).
  const unreadDmEntries = useMemo(() => {
    void unreadTick;
    if (!sourceId) return [];
    const lastRead = loadDmLastRead(sourceId);
    const out: Array<{ kind: 'meshcore_dm'; key: string; ts: number }> = [];
    for (const [peer, ts] of latestIncomingDmByPeer({ messages, contacts, selfKey })) {
      if (ts > (lastRead[peer] ?? 0)) out.push({ kind: 'meshcore_dm', key: peer, ts });
    }
    return out;
  }, [sourceId, messages, contacts, selfKey, unreadTick]);

  const handleSelectContact = (key: string) => {
    setSelected(key);
    if (isMobileViewport()) setMobileShowContent(true);
  };

  // Per-message delete + whole-conversation clear (#3981). Both confirm first
  // (destructive, no undo); the hook prunes local state and the server
  // broadcasts a deletion event so other clients converge.
  const handleDeleteMessage = async (m: MeshCoreMessage) => {
    if (!window.confirm(t('meshcore.confirm_delete_message', 'Delete this message?'))) return;
    await actions.deleteMessage(m.id);
  };
  const handleClearConversation = async () => {
    if (!selected) return;
    if (!window.confirm(t(
      'meshcore.confirm_clear_conversation',
      'Clear the entire conversation with this contact? This cannot be undone.',
    ))) return;
    await actions.clearConversation(selected);
  };
  // Resend (#6194): the stream confirms first. Patch `dmHistory` too — most of
  // this view renders from the server-sourced backlog, which the hook's live
  // `messages` update doesn't always reach (same reason as the channel view).
  const handleResendMessage = useCallback(async (m: MeshCoreMessage) => {
    const state = await actions.resendMessage(m.id);
    if (state) {
      setDmHistory(prev => prev.map(x => (x.id === m.id ? { ...x, ...state } : x)));
    }
    return state;
  }, [actions]);

  const selectedContactName = selected
    ? (contactsByKey.get(selected)?.advName || contactsByKey.get(selected)?.name || `${selected.substring(0, 8)}…`)
    : '';

  // Repeaters (advType=2) cannot receive direct messages — the firmware acks
  // the relay packet, which surfaced as a misleading "delivered" (✓✓). We keep
  // the repeater listed in the contact sidebar and still render its detail panel
  // (telemetry/position/remote-admin), but drop the messaging UI entirely rather
  // than send messages that can never arrive (issue #3755).
  const isSelectedRepeater = selected ? contactsByKey.get(selected)?.advType === 2 : false;

  const muteKey = selected ? canonicalizePeerKey(selected, contacts) : '';
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
            <UiIcon name={isCollapsed ? 'forward' : 'back'} size={18} />
          </button>
          {!isCollapsed && (
            <>
              <span>{t('meshcore.nav.dms', 'Node Details')}</span>
              <span className="pane-count">{dmPeers.length}</span>
              {unreadDmEntries.length > 0 && (
                <MarkAllReadButton
                  onMarkAll={() => { if (sourceId) markManyRead(sourceId, unreadDmEntries); }}
                  label={t('messages.mark_all_read_button', 'Mark All Read')}
                  title={t('messages.mark_all_read_title', 'Mark all direct messages as read')}
                  unreadCount={unreadDmEntries.length}
                />
              )}
              <div className="sort-controls meshcore-sort-controls">
                <select
                  aria-label={t('meshcore.filter_by_type', 'Filter by node type')}
                  title={t('meshcore.filter_by_type', 'Filter by node type')}
                  value={typeFilter === 'all' ? 'all' : String(typeFilter)}
                  onChange={(e) =>
                    setTypeFilter(e.target.value === 'all'
                      ? 'all'
                      : (Number(e.target.value) as DmTypeFilter))}
                  className="sort-dropdown"
                >
                  <option value="all">{t('meshcore.filter_all_types', 'All types')}</option>
                  {DM_TYPE_FILTER_OPTIONS.map((adv) => (
                    <option key={adv} value={String(adv)}>
                      {t(meshcoreRoleLabelKey(adv), meshcoreRoleLabel(adv))}
                    </option>
                  ))}
                </select>
                <DmFilterSelect value={dmFilter} onChange={setDmFilter} options={DM_FILTER_OPTIONS} />
                <NodeSortControls<DmSortField>
                  bare
                  value={sortField}
                  direction={sortDirection}
                  options={dmSortOptions}
                  onChange={setSortField}
                  onToggleDirection={toggleSortDirection}
                  ariaLabel={t('meshcore.sort_by', 'Sort by')}
                />
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
              placeholder={t('meshcore.search_contacts', 'Search contacts or messages…')}
              className="meshcore-search-input"
            />
            {searchQuery && (
              <button
                type="button"
                className="meshcore-search-clear"
                onClick={() => setSearchQuery('')}
                aria-label={t('common.clear', 'Clear')}
              >
                <UiIcon name="close" size={16} />
              </button>
            )}
          </div>
          <MeshCoreVirtualList
            items={filteredPeers}
            getKey={key => key}
            estimateSize={72}
            empty={(
              <div className="meshcore-empty-state">
                {searchQuery
                  ? t('meshcore.no_search_results', 'No contacts match your search')
                  : dmFilter !== 'all'
                    ? t('meshcore.no_filter_results', 'No conversations match this filter')
                  : typeFilter !== 'all'
                    ? t('meshcore.no_type_results', 'No contacts of this type')
                    : t('meshcore.no_contacts', 'No contacts yet')}
              </div>
            )}
            renderRow={key => {
              const c = contactsByKey.get(key);
              const name = c?.advName || c?.name || `${key.substring(0, 8)}…`;
              const isFavorite = favoriteByKey.get(key) ?? false;
              const roleIcon = meshcoreRoleIconName(c?.advType);
              const isMuted = mute?.isDMMuted(key) ?? false;
              const hasUnread = unreadPeers.has(key) && !isMuted;
              const lastText = dmPeerData.lastText.get(key);
              const previewText = lastText !== undefined ? formatMessagePreview(lastText) : undefined;
              // Older server-only threads have a time but no text; show nothing.
              const hasKnownMessage = dmPeerData.lastMessageAt.has(key);
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
                        <UiIcon name={roleIcon} size={16} />
                      </span>
                    )}
                    {isFavorite && (
                      <span className="mc-dm-row-favorite" aria-label={t('meshcore.favorite.is_favorite', 'Favorite')} title={t('meshcore.favorite.is_favorite', 'Favorite')}><UiIcon name="favorite" size={15} /></span>
                    )}
                    <span className="mc-node-row-display-name">{name}</span>
                    {isMuted && <MutedIndicator />}
                  </div>
                  <div className="mc-node-row-key">{key.substring(0, 20)}…</div>
                  <div className="last-message-preview">
                    {previewText ?? (hasKnownMessage ? '' : t('messages.no_messages_preview'))}
                  </div>
                  <div className="node-stats">
                    <NodeStatChips snr={c?.snr} hops={c?.pathLen} />
                  </div>
                </button>
              );
            }}
          />
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
              <UiIcon name="back" size={16} /> {t('common.back', 'Back')}
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
              <>
                {((canSend && filtered.length > 0) || canMute) && (
                  <div className="meshcore-conversation-toolbar">
                    {canMute && mute && (
                      <MuteMenu
                        muted={mute.isDMMuted(muteKey)}
                        onMute={(until) => mute.muteDM(muteKey, until)}
                        onUnmute={() => mute.unmuteDM(muteKey)}
                      />
                    )}
                    {canSend && filtered.length > 0 && (
                    <button
                      type="button"
                      className="meshcore-clear-conversation-btn"
                      onClick={() => void handleClearConversation()}
                      title={t('meshcore.clear_conversation', 'Clear conversation')}
                    >
                      <UiIcon name="delete" size={16} /> {t('meshcore.clear_conversation', 'Clear conversation')}
                    </button>
                    )}
                  </div>
                )}
                <MeshCoreMessageStream
                  messages={filtered}
                  reactionResolutions={reactionResolutions}
                  contacts={contacts}
                  sourceId={sourceId}
                  selfPublicKey={selfKey}
                  disabled={!connected || !canSend || receiveOnly}
                  disabledReason={receiveOnly ? t('meshcore.receive_only.control_tooltip', 'Receive-only mode is on for this MeshCore source. Turn it off in MeshCore Settings to use this.') : undefined}
                  emptyText={t('meshcore.no_messages', 'No messages with this contact yet')}
                  onSend={text => actions.sendMessage(text, selected)}
                  onDeleteMessage={canSend ? handleDeleteMessage : undefined}
                  onResendMessage={canSend ? handleResendMessage : undefined}
                  requiredRepeaterKeys={requiredRepeaterKeys}
                  requiredRepeaterMode={requiredRepeaterMode}
                  onReact={canReact ? (m, e) => actions.sendReaction(m, e) : undefined}
                  reactionEmojis={tapbackEmojis}
                  conversationKey={`dm-${selected}`}
                  unreadAnchorMs={entryLastRead}
                  maxBytes={150}
                  onLoadOlder={loadOlderDmHistory}
                  hasMoreOlder={dmHistoryReady && dmHasMore}
                  loadingOlder={dmLoadingOlder}
                />
              </>
            )}
            <div className="meshcore-detail-pane">
              <MeshCoreContactDetailPanel
                contact={(() => {
                  const raw = contactsByKey.get(selected);
                  return raw ? mergeNodeFields(raw, nodeFieldIndex, ['advertPosition', 'advertSignatureVerified']) : null;
                })()}
                publicKey={selected}
                // An ignored or blocked node is off the map (#5408).
                onShowOnMap={ignoredModeByKey.has(selected.toLowerCase()) ? undefined : onShowOnMap}
                isFavorite={favoriteByKey.get(selected) ?? false}
                onToggleFavorite={actions.setNodeFavorite}
                onSetPositionOverride={actions.setNodePositionOverride}
                canEditPositionOverride={canWriteNodes}
                onResetPath={actions.resetContactPath}
                onShareContact={actions.shareContact}
                onSetOutPath={actions.setContactOutPath}
                onTracePath={actions.traceContactPath}
                onPingZeroHop={actions.pingContactZeroHop}
                onDiscoverPath={actions.discoverContactPath}
                onRemoveContact={actions.removeContact}
                onAddToDevice={actions.addContactToDevice}
                onExportContact={actions.exportContact}
                onGetNeighbours={actions.getNeighbours}
                neighboursFetchActions={{
                  startNeighboursFetch: actions.startNeighboursFetch,
                  getNeighboursFetchProgress: actions.getNeighboursFetchProgress,
                  cancelNeighboursFetch: actions.cancelNeighboursFetch,
                }}
                canWriteNodes={canWriteNodes && connected}
                canTraceroute={canTraceroute && connected}
                canClearTraceSnr={canTraceroute}
                isCompanion={isCompanion}
                repeaters={contacts}
                selfPublicKey={selfKey}
                canRemoteAdmin={canRemoteAdmin && connected}
                remoteAdminActions={{
                  loginRemote: actions.loginRemote,
                  loginRemoteWithSaved: actions.loginRemoteWithSaved,
                  getLoginProgress: actions.getLoginProgress,
                  cancelLogin: actions.cancelLogin,
                  sendCliCommand: actions.sendCliCommand,
                  getRemoteAdminCapability: actions.getRemoteAdminCapability,
                  forgetRemoteCredential: actions.forgetRemoteCredential,
                  getRemoteStatus: actions.getRemoteStatus,
                  getRemoteAdminSession: actions.getRemoteAdminSession,
                  logoutRemote: actions.logoutRemote,
                  readRemoteSettings: actions.readRemoteSettings,
                  saveRemoteSettings: actions.saveRemoteSettings,
                }}
                localRadio={{ sf: status?.localNode?.radioSf, bw: status?.localNode?.radioBw, cr: status?.localNode?.radioCr }}
                receiveOnly={receiveOnly}
                firstHeard={nodeFieldIndex.firstHeard.get(selected)}
                localNativeCli={localNativeCli}
                onSetRemoteCli={actions.setContactRemoteCli}
                canWriteConfig={canWriteConfig && connected}
              />
              {onSetIgnoredNode && onRemoveIgnoredNode && isRealNodeKey(selected) && (
                <MeshCoreIgnoreBlockControls
                  publicKey={selected}
                  mode={ignoredModeByKey.get(selected.toLowerCase()) ?? null}
                  canWrite={canWriteNodes}
                  onSet={(mode) => {
                    const c = contactsByKey.get(selected);
                    return onSetIgnoredNode(selected, mode, c?.advName || c?.name || null);
                  }}
                  onRemove={() => onRemoveIgnoredNode(selected)}
                />
              )}
              {!!sourceId && typeof baseUrl === 'string' && isRealNodeKey(selected) && (
                <>
                  <MeshCoreNodeTelemetryConfig
                    baseUrl={baseUrl}
                    sourceId={sourceId}
                    publicKey={selected}
                    receiveOnly={receiveOnly}
                  />
                  <MeshCoreNodeNeighboursConfig
                    baseUrl={baseUrl}
                    sourceId={sourceId}
                    publicKey={selected}
                    receiveOnly={receiveOnly}
                  />
                  <MeshCoreNodeTimeSyncConfig
                    baseUrl={baseUrl}
                    sourceId={sourceId}
                    publicKey={selected}
                    receiveOnly={receiveOnly}
                  />
                  <TelemetryGraphs
                    nodeId={selected}
                    temperatureUnit={temperatureUnit}
                    telemetryHours={telemetryVisualizationHours}
                    baseUrl={baseUrl}
                    showTimeRangeSelector
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
