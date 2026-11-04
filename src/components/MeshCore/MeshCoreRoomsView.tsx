/**
 * MeshCoreRoomsView -- room server message board UI.
 *
 * Room servers (advType=3) are BBS-style nodes that store posts and push-sync
 * them to connected clients. This view mirrors the Channels layout: left pane
 * lists discovered room servers, right pane shows the selected room's message
 * stream via the shared MeshCoreMessageStream component.
 *
 * Features:
 *   - Credential persistence (remember password / auto-login with saved creds)
 *   - Room stats header (post count from message stream)
 *   - Sync-since tracking (newest post timestamp)
 *   - Auto-sync configuration (periodic re-login interval)
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { MeshCoreMessage, MeshCoreActions, ConnectionStatus, RoomSyncFailureReason } from './hooks/useMeshCore';
import { MeshCoreContact } from '../../utils/meshcoreHelpers';
import { MeshCoreMessageStream } from './MeshCoreMessageStream';
import { useAuth } from '../../contexts/AuthContext';
import { UiIcon } from '../icons';
import { PasswordField } from '../shared/config/PasswordField';
import { MeshCoreReceiveOnlyNote } from './MeshCoreReceiveOnlyNote';
import { MeshCoreLoginProgress } from './MeshCoreLoginProgress';
import { useMeshCoreLoginProgress } from './hooks/useMeshCoreLoginProgress';
import loginProgressStyles from './MeshCoreLoginProgress.module.css';
import { compareMeshCoreMessages } from './messageOrder';
import { useSettingsOptional } from '../../contexts/SettingsContext';
import { calculateDistance, formatDistance } from '../../utils/distance';
import { advertHasPosition } from '../../utils/meshcoreAdvertPosition';
import { MeshCoreChannelReorderList } from './MeshCoreChannelReorderList';
import {
  type RoomSortMode,
  sortItems,
  loadRoomSortMode,
  saveRoomSortMode,
  loadRoomCustomOrder,
  saveRoomCustomOrder,
  type OrderableItem,
} from './meshcoreChannelOrder';
import styles from './MeshCoreRoomsView.module.css';

const MOBILE_BREAKPOINT = 768;
const isMobileViewport = (): boolean =>
  typeof window !== 'undefined' && window.innerWidth <= MOBILE_BREAKPOINT;

interface MeshCoreRoomsViewProps {
  messages: MeshCoreMessage[];
  contacts: MeshCoreContact[];
  status: ConnectionStatus | null;
  actions: MeshCoreActions;
  baseUrl: string;
  sourceId: string;
  onNodeNameClick?: (publicKey: string) => void;
  /** True when this MeshCore source is in strict receive-only mode (#4547
   *  Phase 2). Plumbed here in WP1; WP3 wires the actual gating (login
   *  button + password input + send box disabled, and the auto-login
   *  effect's silent skip). */
  receiveOnly?: boolean;
}

function buildRoomFilter(roomPubkey: string): (m: MeshCoreMessage) => boolean {
  return (m) => {
    if (m.messageType !== 'room_post') return false;
    if (!m.toPublicKey) return false;
    return m.toPublicKey === roomPubkey ||
      m.toPublicKey.startsWith(roomPubkey) ||
      roomPubkey.startsWith(m.toPublicKey);
  };
}

function formatTimestamp(ts: number): string {
  return new Date(ts).toLocaleString();
}

/** The name a room row shows: advertised name, then stored name, then a short
 *  public-key prefix. Also the key the Room-name sort collates on (#6148). */
function roomLabel(room: MeshCoreContact): string {
  return room.advName || room.name || room.publicKey.substring(0, 12) + '…';
}

/** A room wrapped for the shared ordering engine: keyed by `publicKey`. */
interface OrderableRoom extends OrderableItem<string> {
  room: MeshCoreContact;
}

export const MeshCoreRoomsView: React.FC<MeshCoreRoomsViewProps> = ({
  messages,
  contacts,
  status,
  actions,
  sourceId,
  onNodeNameClick,
  receiveOnly = false,
}) => {
  const { t } = useTranslation();
  const { hasPermission } = useAuth();
  const distanceUnit = useSettingsOptional()?.distanceUnit ?? 'km';
  const canSend = hasPermission('messages', 'write');
  const canConfig = hasPermission('configuration', 'write');

  const [selectedRoom, setSelectedRoom] = useState<string | null>(null);
  const [loggedInRooms, setLoggedInRooms] = useState<Set<string>>(new Set());
  const [loginPassword, setLoginPassword] = useState('');
  const [loginError, setLoginError] = useState<string | null>(null);
  const [loginLoading, setLoginLoading] = useState(false);
  // Live "attempt n of 3" progress + cancel for the login in flight (#5400).
  const { progress: loginProgress, run: runLogin, cancel: cancelLoginAttempt } = useMeshCoreLoginProgress(actions);
  // Shown briefly on the login card after the user cancels.
  const [loginNotice, setLoginNotice] = useState<string | null>(null);
  const [rememberPassword, setRememberPassword] = useState(false);
  const [mobileShowContent, setMobileShowContent] = useState(false);

  // #6186: the selected room's posts and the per-room stats, read from the
  // server so they survive channel/DM traffic evicting them from the shared
  // `messages` window. Mirrors the channel view's backlog + load-older (#4460).
  const { fetchRoomMessages, fetchRoomStats } = actions;
  const [roomHistory, setRoomHistory] = useState<MeshCoreMessage[]>([]);
  const [roomHistoryFor, setRoomHistoryFor] = useState<string | null>(null);
  const [roomHasMore, setRoomHasMore] = useState(false);
  const [roomLoadingOlder, setRoomLoadingOlder] = useState(false);
  const [serverRoomStats, setServerRoomStats] = useState<Array<{ roomPublicKey: string; count: number; latest: number }>>([]);
  const roomHistoryRef = useRef<MeshCoreMessage[]>([]);
  const activeRoomRef = useRef<string | null>(null);
  useEffect(() => { roomHistoryRef.current = roomHistory; }, [roomHistory]);

  // Display-only list order (#6148). Persisted per source in localStorage, so a
  // read-only viewer can sort without `settings:write`. Default: Room name.
  const [sortMode, setSortMode] = useState<RoomSortMode>(() => loadRoomSortMode(sourceId));
  const [customOrder, setCustomOrder] = useState<string[]>(() => loadRoomCustomOrder(sourceId));
  // The room-set key the reorder panel was opened against, or null when closed.
  const [reorderingFor, setReorderingFor] = useState<string | null>(null);

  useEffect(() => {
    const onResize = () => {
      if (!isMobileViewport()) setMobileShowContent(false);
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // Reload the per-source sort preference when the source changes.
  useEffect(() => {
    setSortMode(loadRoomSortMode(sourceId));
    setCustomOrder(loadRoomCustomOrder(sourceId));
    setReorderingFor(null);
  }, [sourceId]);

  // Credential persistence state
  const [canRemember, setCanRemember] = useState(false);
  const [storedCreds, setStoredCreds] = useState<Set<string>>(new Set());
  const autoLoginAttempted = useRef<Set<string>>(new Set());

  // Sync config state (for selected room)
  const [syncEnabled, setSyncEnabled] = useState(false);
  const [syncInterval, setSyncInterval] = useState(60);
  const [syncConfigDirty, setSyncConfigDirty] = useState(false);
  // Why the scheduler last failed to sync this room, so a saved password that
  // has stopped working explains itself instead of auto-sync just reading
  // "off" for no visible reason.
  const [syncFailure, setSyncFailure] = useState<{ count: number; reason: RoomSyncFailureReason } | null>(null);
  const [forgetting, setForgetting] = useState(false);

  // Fetch credential capability on mount
  useEffect(() => {
    void (async () => {
      const creds = await actions.getRoomCredentials();
      if (creds) {
        setCanRemember(creds.canRemember);
        setStoredCreds(new Set(creds.stored.map(s => s.publicKey)));
      }
    })();
  }, [actions]);

  const roomServers = useMemo(
    () => contacts.filter(c => c.advType === 3),
    [contacts],
  );

  // Per-room post count and newest post time (#6148). Count matches the per-row
  // filter; Last message uses SENDER time (`m.timestamp`), not receipt time, so
  // a backlog replay at login does not jump a room to the top (#5973).
  //
  // Baseline is the live window; the server query (#6186) then overrides with
  // the true totals whenever it reports more than the bounded window could see,
  // so counts/ordering no longer collapse once 100 newer messages arrive.
  // Prefix-aware room match mirrors `buildRoomFilter`.
  const roomStats = useMemo(() => {
    const counts: Record<string, number> = {};
    const latest: Record<string, number> = {};
    for (const room of roomServers) counts[room.publicKey] = 0;
    for (const m of messages) {
      if (m.messageType !== 'room_post' || !m.toPublicKey) continue;
      for (const room of roomServers) {
        const pk = room.publicKey;
        if (m.toPublicKey === pk || m.toPublicKey.startsWith(pk) || pk.startsWith(m.toPublicKey)) {
          counts[pk] = (counts[pk] ?? 0) + 1;
          if (m.timestamp > (latest[pk] ?? 0)) latest[pk] = m.timestamp;
        }
      }
    }
    for (const s of serverRoomStats) {
      for (const room of roomServers) {
        const pk = room.publicKey;
        if (s.roomPublicKey === pk || s.roomPublicKey.startsWith(pk) || pk.startsWith(s.roomPublicKey)) {
          if (s.count > (counts[pk] ?? 0)) counts[pk] = s.count;
          if (s.latest > (latest[pk] ?? 0)) latest[pk] = s.latest;
        }
      }
    }
    return { counts, latest };
  }, [serverRoomStats, messages, roomServers]);

  // Count of room posts in the live window — bumps when a new post arrives, so
  // the server room-stats fetch re-runs and the list counts stay current.
  const liveRoomPostCount = useMemo(
    () => messages.reduce((n, m) => (m.messageType === 'room_post' ? n + 1 : n), 0),
    [messages],
  );

  // Distance (km) from the source node to each room, for the Distance sort.
  // 0/0 and absent coordinates count as "no location" (`advertHasPosition`),
  // so such rooms sink to the bottom. With no source-node fix there is no
  // distance for any room, and the Distance option is disabled below.
  const selfLat = status?.localNode?.latitude;
  const selfLon = status?.localNode?.longitude;
  const selfHasLocation = advertHasPosition(selfLat, selfLon);
  const roomDistances = useMemo(() => {
    const out: Record<string, number> = {};
    if (!selfHasLocation || selfLat == null || selfLon == null) return out;
    for (const room of roomServers) {
      if (advertHasPosition(room.latitude, room.longitude)) {
        out[room.publicKey] = calculateDistance(selfLat, selfLon, room.latitude!, room.longitude!);
      }
    }
    return out;
  }, [roomServers, selfHasLocation, selfLat, selfLon]);

  // The room list in the operator's chosen display order.
  const displayRooms = useMemo<OrderableRoom[]>(() => {
    const items: OrderableRoom[] = roomServers.map(room => ({
      id: room.publicKey,
      name: roomLabel(room),
      room,
    }));
    return sortItems(items, sortMode, {
      customOrder,
      latest: roomStats.latest,
      counts: roomStats.counts,
      distances: roomDistances,
    });
  }, [roomServers, sortMode, customOrder, roomStats, roomDistances]);

  // A stable key for the current room set; the reorder panel closes when the
  // set changes under it (a room joins or leaves).
  const roomIdsKey = useMemo(() => roomServers.map(r => r.publicKey).join(','), [roomServers]);
  const reordering = reorderingFor !== null && reorderingFor === roomIdsKey;
  useEffect(() => {
    setReorderingFor(prev => (prev !== null && prev !== roomIdsKey ? null : prev));
  }, [roomIdsKey]);

  const handleSortModeChange = useCallback((mode: RoomSortMode) => {
    setSortMode(mode);
    saveRoomSortMode(sourceId, mode);
  }, [sourceId]);

  const handleSaveRoomOrder = useCallback((order: string[]) => {
    setCustomOrder(order);
    saveRoomCustomOrder(sourceId, order);
    setSortMode('custom');
    saveRoomSortMode(sourceId, 'custom');
    setReorderingFor(null);
  }, [sourceId]);

  const activeRoom = useMemo(
    () => roomServers.find(r => r.publicKey === selectedRoom) ?? null,
    [roomServers, selectedRoom],
  );

  const activeFilter = useMemo(
    () => selectedRoom ? buildRoomFilter(selectedRoom) : () => false,
    [selectedRoom],
  );

  // The server backlog is "ready" only once it matches the selected room, so a
  // previous room's posts are never drawn while this one loads (#6186).
  const roomHistoryReady = !sourceId || !selectedRoom || roomHistoryFor === `${sourceId}:${selectedRoom}`;
  const filtered = useMemo(
    // Merge the server backlog (full history, #6186) with any live posts from
    // the shared window. Dedupe by id, live copy wins, then sort sender-time
    // (#5973): a room replays its backlog on login, so receipt time is the
    // login time. See ./messageOrder.ts.
    () => {
      const byId = new Map<string, MeshCoreMessage>();
      if (roomHistoryReady) {
        for (const m of roomHistory) byId.set(m.id, m);
      }
      for (const m of messages) {
        if (activeFilter(m)) byId.set(m.id, m);
      }
      return Array.from(byId.values()).sort(compareMeshCoreMessages);
    },
    [messages, activeFilter, roomHistory, roomHistoryReady],
  );

  // Load the selected room's backlog from the server. Resets paging on every
  // room/source switch (and after a login that syncs new posts) so an in-flight
  // load-older for the previous room can't land in the new one.
  useEffect(() => {
    if (!sourceId || !selectedRoom) return;
    let cancelled = false;
    activeRoomRef.current = selectedRoom;
    setRoomHasMore(false);
    setRoomLoadingOlder(false);
    void (async () => {
      const { messages: hist, hasMore } = await fetchRoomMessages(selectedRoom, { offset: 0, limit: 200 });
      if (cancelled) return;
      setRoomHistory(hist);
      setRoomHistoryFor(`${sourceId}:${selectedRoom}`);
      setRoomHasMore(hasMore);
    })();
    return () => { cancelled = true; };
  }, [sourceId, selectedRoom, fetchRoomMessages, status?.connected, loggedInRooms]);

  // Refresh server room stats on source/connect change and whenever a new live
  // room post arrives (so list counts stay current without the window).
  useEffect(() => {
    if (!sourceId) { setServerRoomStats([]); return; }
    let cancelled = false;
    void (async () => {
      const stats = await fetchRoomStats();
      if (!cancelled) setServerRoomStats(stats);
    })();
    return () => { cancelled = true; };
  }, [sourceId, fetchRoomStats, status?.connected, liveRoomPostCount]);

  // Load an older page of the selected room's posts (#4460 infinite scroll).
  const loadOlderRoomHistory = useCallback(() => {
    if (!sourceId || !selectedRoom || roomLoadingOlder || !roomHasMore) return;
    const room = selectedRoom;
    const offset = roomHistoryRef.current.length;
    setRoomLoadingOlder(true);
    void (async () => {
      try {
        const { messages: older, hasMore } = await fetchRoomMessages(room, { offset, limit: 100 });
        if (activeRoomRef.current !== room) return;
        setRoomHistory(prev => {
          const seen = new Set(prev.map(m => m.id));
          return [...older.filter(m => !seen.has(m.id)), ...prev];
        });
        setRoomHasMore(hasMore);
      } finally {
        if (activeRoomRef.current === room) setRoomLoadingOlder(false);
      }
    })();
  }, [sourceId, selectedRoom, roomLoadingOlder, roomHasMore, fetchRoomMessages]);

  const newestPostTs = useMemo(() => {
    if (filtered.length === 0) return null;
    return Math.max(...filtered.map(m => m.timestamp));
  }, [filtered]);

  const isLoggedIn = useCallback(
    (pubkey: string) => loggedInRooms.has(pubkey),
    [loggedInRooms],
  );

  // Auto-login when selecting a room with saved credentials
  useEffect(() => {
    if (!selectedRoom) return;
    if (loggedInRooms.has(selectedRoom)) return;
    if (!storedCreds.has(selectedRoom)) return;
    // Receive-only mode: silently skip — no request, no toast, no error
    // state. Must sit BEFORE the do-not-repeat latch below so turning
    // receive-only back off re-triggers auto-login the next time the room is
    // selected (#4547 Phase 2 §3.4a).
    if (receiveOnly) return;
    if (autoLoginAttempted.current.has(selectedRoom)) return;

    autoLoginAttempted.current.add(selectedRoom);
    void (async () => {
      setLoginLoading(true);
      setLoginNotice(null);
      const { value: result, cancelledByUser } = await runLogin((requestId) =>
        actions.loginRoomWithSaved(selectedRoom, { requestId }),
      );
      if (cancelledByUser || result.cancelled) {
        setLoginNotice(t('meshcore.rooms.login_cancelled', 'Login cancelled'));
      } else if (result.success) {
        setLoggedInRooms(prev => new Set(prev).add(selectedRoom));
      } else if (result.reason === 'rejected') {
        // Say so rather than dropping the user on a blank login card: the
        // saved password is the thing at fault, and the forget button below
        // is the fix.
        setLoginError(t(
          'meshcore.rooms.saved_password_refused_short',
          'The saved password was refused by this room server.',
        ));
      }
      setLoginLoading(false);
    })();
  }, [selectedRoom, loggedInRooms, storedCreds, actions, receiveOnly, runLogin, t]);

  const loadSyncConfig = useCallback(async (pubkey: string) => {
    const config = await actions.getRoomSyncConfig(pubkey);
    if (config) {
      setSyncEnabled(config.enabled);
      setSyncInterval(config.intervalMinutes);
      setSyncFailure(
        config.failureCount > 0 && config.lastError
          ? { count: config.failureCount, reason: config.lastError }
          : null,
      );
    } else {
      setSyncEnabled(false);
      setSyncInterval(60);
      setSyncFailure(null);
    }
    setSyncConfigDirty(false);
  }, [actions]);

  const handleSelectRoom = useCallback((pubkey: string) => {
    const mobile = isMobileViewport();
    // Desktop (#6149): a click on the already-open room de-selects it and
    // returns to the landing pane. Mobile keeps its behaviour — the list IS the
    // landing view and Back leaves `selectedRoom` set, so a tap on the same row
    // must REOPEN the room, never de-select it.
    const deselect = !mobile && selectedRoom === pubkey;

    // Clear the login and sync form state on both paths (same as a normal
    // select). `loggedInRooms` is NOT cleared: de-selecting is a view change,
    // not a logout.
    setLoginError(null);
    setLoginNotice(null);
    setLoginPassword('');
    setRememberPassword(false);
    setSyncConfigDirty(false);
    setSyncFailure(null);

    if (deselect) {
      // Skip loadSyncConfig — there is no selected room to read config for.
      setSelectedRoom(null);
      return;
    }

    setSelectedRoom(pubkey);
    void loadSyncConfig(pubkey);
    if (mobile) setMobileShowContent(true);
  }, [selectedRoom, loadSyncConfig]);

  const handleLogin = useCallback(async () => {
    if (!selectedRoom) return;
    setLoginLoading(true);
    setLoginError(null);
    setLoginNotice(null);
    try {
      const { value: result, cancelledByUser } = await runLogin((requestId) =>
        actions.loginRoom(selectedRoom, loginPassword, rememberPassword, { requestId }),
      );
      if (cancelledByUser || result.cancelled) {
        setLoginNotice(t('meshcore.rooms.login_cancelled', 'Login cancelled'));
        // A reply may have raced the cancel on the server; re-read which
        // rooms have a saved password rather than assume.
        const creds = await actions.getRoomCredentials();
        if (creds) setStoredCreds(new Set(creds.stored.map(c => c.publicKey)));
      } else if (result.success) {
        setLoggedInRooms(prev => new Set(prev).add(selectedRoom));
        if (result.persisted) {
          setStoredCreds(prev => new Set(prev).add(selectedRoom));
        }
        setLoginPassword('');
        // The server clears the stored failure record on a successful login;
        // mirror that here so the warning does not linger.
        setSyncFailure(null);
      } else {
        setLoginError(result.error || t('meshcore.rooms.login_failed', 'Login failed'));
      }
    } catch {
      setLoginError(t('meshcore.rooms.login_failed', 'Login failed'));
    } finally {
      setLoginLoading(false);
    }
  }, [selectedRoom, loginPassword, rememberPassword, actions, runLogin, t]);

  const handleForgetCredential = useCallback(async () => {
    if (!selectedRoom) return;
    setForgetting(true);
    try {
      const ok = await actions.forgetRoomCredential(selectedRoom);
      if (ok) {
        setStoredCreds(prev => {
          const next = new Set(prev);
          next.delete(selectedRoom);
          return next;
        });
        // Let auto-login run again if a new password is saved later.
        autoLoginAttempted.current.delete(selectedRoom);
        setSyncFailure(null);
        setSyncEnabled(false);
        setLoginError(null);
      }
    } finally {
      setForgetting(false);
    }
  }, [selectedRoom, actions]);

  const handleSend = useCallback(async (text: string): Promise<boolean> => {
    if (!selectedRoom) return false;
    return actions.sendRoomPost(selectedRoom, text);
  }, [selectedRoom, actions]);

  const handleSaveSyncConfig = useCallback(async () => {
    if (!selectedRoom) return;
    const ok = await actions.setRoomSyncConfig(selectedRoom, syncEnabled, syncInterval);
    if (ok) setSyncConfigDirty(false);
  }, [selectedRoom, syncEnabled, syncInterval, actions]);

  const selfKey = status?.localNode?.publicKey;
  const connected = status?.connected ?? false;

  const showLoginOverlay = selectedRoom && !isLoggedIn(selectedRoom) && !loginLoading;

  // Explains a stored password that has stopped working. Suppressed while
  // `loginError` is showing: that already carries this session's live outcome,
  // so the stored-failure text would only repeat it.
  const savedCredWarning = useMemo(() => {
    if (loginError || !syncFailure) return null;
    if (syncFailure.reason === 'rejected') {
      return t(
        'meshcore.rooms.saved_password_refused',
        'The saved password was refused by this room server, so auto-sync has been turned off. Log in with the correct password, or forget the saved one.',
      );
    }
    return t(
      'meshcore.rooms.saved_password_unanswered',
      'The last {{count}} scheduled logins with the saved password went unanswered.',
      { count: syncFailure.count },
    );
  }, [loginError, syncFailure, t]);

  const mobileClass = mobileShowContent ? 'mobile-show-content' : 'mobile-show-list';

  return (
    <div className={`meshcore-two-pane ${mobileClass}`}>
      <div className="meshcore-list-pane">
        <div className="meshcore-list-pane-header">
          <span>{t('meshcore.nav.rooms', 'Rooms')}</span>
          <span className="pane-count">{roomServers.length}</span>
        </div>
        {roomServers.length > 0 && (
          <div className={styles.orderBar}>
            <select
              className={styles.sortSelect}
              value={sortMode}
              onChange={e => handleSortModeChange(e.target.value as RoomSortMode)}
              disabled={reordering}
              aria-label={t('meshcore.rooms.order.sort_by', 'Sort rooms by')}
              title={t('meshcore.rooms.order.sort_by', 'Sort rooms by')}
            >
              <option value="name">{t('meshcore.rooms.order.name', 'Room name')}</option>
              <option value="lastMessage">{t('meshcore.rooms.order.last_message', 'Last message')}</option>
              <option value="messageCount">{t('meshcore.rooms.order.message_count', 'Message count')}</option>
              <option value="distance" disabled={!selfHasLocation}>{t('meshcore.rooms.order.distance', 'Distance')}</option>
              <option value="custom">{t('meshcore.rooms.order.custom', 'Custom')}</option>
            </select>
            {roomServers.length > 1 && (
              <button
                type="button"
                className={`${styles.reorderButton} ${reordering ? styles.active : ''}`}
                onClick={() => setReorderingFor(prev => (prev === roomIdsKey ? null : roomIdsKey))}
                aria-pressed={reordering}
                title={t('meshcore.rooms.order.reorder_title', 'Sort the room list in your own order (MeshMonitor display only)')}
              >
                <UiIcon name="dragHandle" size={14} /> {t('meshcore.rooms.order.reorder', 'Sort')}
              </button>
            )}
          </div>
        )}
        <div className="meshcore-list-pane-body">
          {roomServers.length === 0 && (
            <div className="mc-channel-row" style={{ opacity: 0.6 }}>
              <div className="mc-channel-row-name">
                {t('meshcore.rooms.no_rooms', 'No room servers discovered yet')}
              </div>
            </div>
          )}
          {reordering ? (
            <MeshCoreChannelReorderList<string>
              channels={displayRooms.map(r => ({ id: r.id, label: r.name }))}
              onSave={handleSaveRoomOrder}
              onCancel={() => setReorderingFor(null)}
            />
          ) : displayRooms.map(({ id: pubkey, name }) => {
            const count = roomStats.counts[pubkey] ?? 0;
            const loggedIn = isLoggedIn(pubkey);
            const hasSaved = storedCreds.has(pubkey);
            const distanceKm = roomDistances[pubkey];
            return (
              <button
                key={pubkey}
                className={`mc-channel-row ${selectedRoom === pubkey ? 'selected' : ''}`}
                onClick={() => handleSelectRoom(pubkey)}
              >
                <div className="mc-channel-row-name">
                  <span className={`mc-room-row-status ${loggedIn ? 'logged-in' : hasSaved ? 'has-saved' : 'not-logged-in'}`}>
                    <UiIcon name={loggedIn ? 'statusOn' : hasSaved ? 'statusPartial' : 'statusOff'} size={12} />
                  </span>
                  {' '}
                  {name}
                </div>
                <div className="mc-channel-row-meta">
                  {count} {t('meshcore.messages', 'messages')}
                  {sortMode === 'distance' && typeof distanceKm === 'number' && (
                    <span className={styles.distanceMeta}> &middot; {formatDistance(distanceKm, distanceUnit)}</span>
                  )}
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
              <UiIcon name="back" size={15} /> {t('common.back', 'Back')}
            </button>
            {activeRoom && (
              <span className="meshcore-mobile-back-title">
                {activeRoom.advName || activeRoom.name || selectedRoom?.substring(0, 12) + '…'}
              </span>
            )}
          </div>
        )}
        {!selectedRoom && (
          <div className="meshcore-empty-state">
            {t('meshcore.rooms.select_room', 'Select a room server to view posts')}
          </div>
        )}

        {selectedRoom && loginLoading && (
          <div className="meshcore-empty-state">
            {loginProgress ? (
              <MeshCoreLoginProgress progress={loginProgress} onCancel={() => void cancelLoginAttempt()} />
            ) : (
              t('meshcore.rooms.logging_in', 'Logging in…')
            )}
          </div>
        )}

        {showLoginOverlay && (
          <div className="meshcore-room-login-overlay">
            <div className="meshcore-room-login-card">
              <h3>{t('meshcore.rooms.login_title', 'Login to Room Server')}</h3>
              <p className="meshcore-room-login-name">
                {activeRoom?.advName || activeRoom?.name || selectedRoom.substring(0, 16) + '…'}
              </p>
              <PasswordField
                className="meshcore-room-login-input"
                autoComplete="off"
                value={loginPassword}
                onChange={e => setLoginPassword(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && !loginLoading && !receiveOnly && handleLogin()}
                placeholder={t('meshcore.rooms.password_placeholder', 'Password (empty for guest)')}
                disabled={loginLoading || receiveOnly}
                title={receiveOnly ? t('meshcore.receive_only.control_tooltip', 'Receive-only mode is on for this MeshCore source. Turn it off in MeshCore Settings to use this.') : undefined}
                autoFocus
              />
              {canRemember && (
                <label className="meshcore-room-login-remember">
                  <input
                    type="checkbox"
                    checked={rememberPassword}
                    onChange={e => setRememberPassword(e.target.checked)}
                  />
                  {t('meshcore.rooms.remember_password', 'Remember password')}
                </label>
              )}
              <button
                className="meshcore-room-login-btn"
                onClick={handleLogin}
                disabled={loginLoading || receiveOnly}
                title={receiveOnly ? t('meshcore.receive_only.control_tooltip', 'Receive-only mode is on for this MeshCore source. Turn it off in MeshCore Settings to use this.') : undefined}
              >
                {loginLoading
                  ? t('meshcore.rooms.logging_in', 'Logging in…')
                  : t('meshcore.rooms.login_button', 'Login')}
              </button>
              {loginError && (
                <div className="meshcore-room-login-error">{loginError}</div>
              )}
              {loginNotice && !loginError && (
                <div className={loginProgressStyles.notice} role="status">{loginNotice}</div>
              )}
              {selectedRoom && storedCreds.has(selectedRoom) && (
                <div className="meshcore-room-saved-cred">
                  {savedCredWarning && (
                    <p className="meshcore-room-saved-cred-warning">{savedCredWarning}</p>
                  )}
                  <button
                    type="button"
                    className="meshcore-room-forget-btn"
                    onClick={handleForgetCredential}
                    disabled={forgetting}
                  >
                    {forgetting
                      ? t('meshcore.rooms.forgetting_password', 'Forgetting…')
                      : t('meshcore.rooms.forget_password', 'Forget saved password')}
                  </button>
                </div>
              )}
            </div>
          </div>
        )}

        {selectedRoom && isLoggedIn(selectedRoom) && (
          <>
            {/* Room stats header */}
            <div className="meshcore-room-stats-header">
              <span className="meshcore-room-stats-name">
                {activeRoom?.advName || activeRoom?.name || selectedRoom.substring(0, 16) + '…'}
              </span>
              <span className="meshcore-room-stats-info">
                {filtered.length} {t('meshcore.rooms.posts', 'posts')}
                {newestPostTs && (
                  <> &middot; {t('meshcore.rooms.last_post', 'last')}: {formatTimestamp(newestPostTs)}</>
                )}
              </span>
              {/* Sync config toggle */}
              {canConfig && (
                <span className="meshcore-room-sync-config">
                  <label title={t('meshcore.rooms.sync_enabled_tooltip', 'Periodically re-login to fetch new posts')}>
                    <input
                      type="checkbox"
                      checked={syncEnabled}
                      onChange={e => { setSyncEnabled(e.target.checked); setSyncConfigDirty(true); }}
                    />
                    {t('meshcore.rooms.auto_sync', 'Auto-sync')}
                  </label>
                  {syncEnabled && (
                    <select
                      value={syncInterval}
                      onChange={e => { setSyncInterval(Number(e.target.value)); setSyncConfigDirty(true); }}
                    >
                      <option value={60}>1h</option>
                      <option value={120}>2h</option>
                      <option value={240}>4h</option>
                      <option value={480}>8h</option>
                      <option value={720}>12h</option>
                      <option value={1440}>24h</option>
                    </select>
                  )}
                  {syncConfigDirty && (
                    <button className="meshcore-room-sync-save" onClick={handleSaveSyncConfig}>
                      {t('meshcore.rooms.save_sync', 'Save')}
                    </button>
                  )}
                  {syncFailure && (
                    <span
                      className="meshcore-room-sync-warning"
                      title={syncFailure.reason === 'rejected'
                        ? t('meshcore.rooms.sync_failed_rejected', 'The room server refused the saved password, so auto-sync was turned off.')
                        : t('meshcore.rooms.sync_failed_no_reply', 'The last {{count}} scheduled logins went unanswered.', { count: syncFailure.count })}
                    >
                      <UiIcon name="alert" size={12} />
                    </span>
                  )}
                  <MeshCoreReceiveOnlyNote receiveOnly={receiveOnly} />
                </span>
              )}
            </div>
            <MeshCoreMessageStream
              messages={filtered}
              contacts={contacts}
              sourceId={sourceId}
              selfPublicKey={selfKey}
              disabled={!connected || !canSend || receiveOnly}
              disabledReason={receiveOnly ? t('meshcore.receive_only.control_tooltip', 'Receive-only mode is on for this MeshCore source. Turn it off in MeshCore Settings to use this.') : undefined}
              emptyText={t('meshcore.rooms.no_messages', 'No posts in this room yet')}
              onSend={handleSend}
              onNodeNameClick={onNodeNameClick}
              conversationKey={`room-${selectedRoom}`}
              onLoadOlder={loadOlderRoomHistory}
              hasMoreOlder={roomHistoryReady && roomHasMore}
              loadingOlder={roomLoadingOlder}
            />
          </>
        )}
      </div>
    </div>
  );
};
