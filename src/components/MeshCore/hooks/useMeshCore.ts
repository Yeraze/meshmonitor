/**
 * useMeshCore — centralised MeshCore state + push events / status safety poll.
 *
 * Owns the status / nodes / contacts / messages state for the MeshCore page
 * and exposes the action callbacks the sub-views call.
 *
 * Reads route through `/api/sources/:id/meshcore/*`; connect/disconnect use
 * the generic `/api/sources/:id/{connect,disconnect}` endpoints (no body
 * params — params come from the saved source.config). Initial load is a
 * single `/snapshot` round-trip and live updates come in via Socket.io rooms
 * (`meshcore:message`, `meshcore:contact:updated`, `meshcore:status:updated`,
 * `meshcore:local-node:updated`) joined per sourceId. A 30s status-only poll
 * runs as a safety net; on socket reconnect a `?since=<seqCursor>` catch-up
 * request fills any gap.
 *
 * `enabled: false` short-circuits all fetches; used to honour permission
 * gates that should suppress polling entirely.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useCsrfFetch } from '../../../hooks/useCsrfFetch';
import { useMapContext } from '../../../contexts/MapContext';
import { useWebSocketContext } from '../../../contexts/WebSocketContext';
import type {
  MeshCoreMessageEvent,
  MeshCoreContactUpdateEvent,
  MeshCoreStatusUpdateEvent,
  MeshCoreLocalNodeUpdateEvent,
} from '../../../hooks/useWebSocket';
import { MeshCoreContact, mapContactsToNodes } from '../../../utils/meshcoreHelpers';

export type TelemetryMode = 'always' | 'device' | 'never';

export interface TracePathResult {
  hops: { index: number; snr: number }[];
  lastSnr: number;
}

export interface MeshCoreNode {
  publicKey: string;
  name: string;
  advType: number;
  txPower?: number;
  maxTxPower?: number;
  radioFreq?: number;
  radioBw?: number;
  radioSf?: number;
  radioCr?: number;
  lastHeard?: number;
  rssi?: number;
  snr?: number;
  batteryMv?: number;
  uptimeSecs?: number;
  latitude?: number;
  longitude?: number;
  advLocPolicy?: number;
  /** Server-side favorite flag (issue #3588). Stored locally only — never
   *  pushed to the device. Favorited nodes pin to the top of the node list. */
  isFavorite?: boolean;
  telemetryModeBase?: TelemetryMode;
  telemetryModeLoc?: TelemetryMode;
  telemetryModeEnv?: TelemetryMode;
  /** Populated from DeviceQuery by the server-side telemetry poller. */
  firmwareVer?: number;
  firmwareBuild?: string;
  model?: string;
  ver?: string;
}

export type MessageDeliveryStatus = 'sending' | 'sent' | 'delivered' | 'failed';

export interface MeshCoreMessage {
  id: string;
  fromPublicKey: string;
  fromName?: string;
  toPublicKey?: string;
  text: string;
  timestamp: number;
  /** 'text' (default, DMs + channel) or 'room_post' (room server posts). */
  messageType?: string;
  expectedAckCrc?: number;
  estTimeout?: number;
  deliveryStatus?: MessageDeliveryStatus;
  roundTripMs?: number;
}

export interface ConnectionStatus {
  connected: boolean;
  deviceType: number;
  deviceTypeName: string;
  config: {
    connectionType: string;
    serialPort?: string;
    tcpHost?: string;
    tcpPort?: number;
  } | null;
  localNode: MeshCoreNode | null;
}

export interface MeshCoreActions {
  connect: () => Promise<boolean>;
  disconnect: () => Promise<void>;
  refreshContacts: () => Promise<void>;
  /** Clear the cached forwarding route ("out_path") for a contact so the next
   *  send re-discovers the route via flooding. Resolves `true` when the device
   *  ACKed the reset; `false` for any error (permission, unknown contact,
   *  source not Companion, network). */
  resetContactPath: (publicKey: string) => Promise<boolean>;
  /** Broadcast the device's saved advert for a contact as a zero-hop frame so
   *  nearby nodes can add this contact themselves. Wraps CMD_SHARE_CONTACT.
   *  Resolves `{ ok: true }` on ACK; on failure `ok` is false and `error`
   *  carries the server's actionable reason. */
  shareContact: (publicKey: string) => Promise<{ ok: boolean; error?: string }>;
  /** Manually push a forwarding route into the device's contact record.
   *  `outPath` is a comma-separated hex chain ("a3,7f,02"); empty string
   *  sets a zero-hop direct path. Requires nodes:write. */
  setContactOutPath: (publicKey: string, outPath: string) => Promise<boolean>;
  /** Send a trace-path diagnostic along the contact's cached forwarding
   *  route and return per-hop SNR data. Resolves `null` on failure. */
  traceContactPath: (publicKey: string) => Promise<TracePathResult | null>;
  /** Flood a path-discovery request to the contact. The device sends a
   *  lightweight telemetry request via flood; when the contact replies,
   *  the PATH return mechanism establishes the forwarding route. The path
   *  update arrives asynchronously — this resolves `true` when the flood
   *  was accepted. */
  discoverContactPath: (publicKey: string) => Promise<boolean>;
  /** Active node discovery; resolves with responder counts, or null on error. */
  discoverNodes: (mode: 'nearby' | 'repeaters' | 'sensors') => Promise<{ returned: number; newCount: number } | null>;
  /** Whether this node answers inbound discovery requests (is discoverable). */
  getDiscoverable: () => Promise<boolean>;
  /** Enable/disable answering inbound discovery requests. */
  setDiscoverable: (enabled: boolean) => Promise<boolean>;
  /** Read the per-source default MeshCore region/scope ('' = unscoped) (#3667). */
  getDefaultScope: () => Promise<string>;
  /** Set the per-source default region/scope. Returns the normalized value, or null on error. */
  setDefaultScope: (scope: string) => Promise<string | null>;
  /** Remove a contact from the device's contact list. Resolves `true` when
   *  the device ACKed the removal; `false` for any error. */
  removeContact: (publicKey: string) => Promise<boolean>;
  /** Toggle the server-side favorite flag for a node (issue #3588). MeshCore
   *  has no native favorite concept, so this persists locally only and never
   *  touches the device. Favorited nodes pin to the top of the node list.
   *  Resolves `true` on success. */
  setNodeFavorite: (publicKey: string, isFavorite: boolean) => Promise<boolean>;
  /** Export a contact as a signed advert blob for sharing. Pass 'self' to
   *  export the local node's identity. Returns the raw bytes or null. */
  exportContact: (publicKey: string) => Promise<number[] | null>;
  /** Import a contact from a signed advert blob. Refreshes contacts on
   *  success. */
  importContact: (advertBytes: number[]) => Promise<boolean>;
  /** Sync the device's RTC to the server's current time. */
  syncDeviceTime: () => Promise<boolean>;
  /** Query the neighbour list from a remote repeater. */
  getNeighbours: (publicKey: string, opts?: { count?: number; offset?: number; orderBy?: number }) => Promise<{
    total: number;
    neighbours: { publicKeyPrefix: string; heardSecondsAgo: number; snr: number }[];
  } | null>;
  /** Reboot the locally connected device. Destructive — requires confirm flow. */
  rebootDevice: (opts?: { confirm?: boolean }) => Promise<boolean>;
  /** Export the device's Ed25519 private key as a hex string for backup. */
  exportPrivateKey: () => Promise<string | null>;
  /** Import an Ed25519 private key onto the device. Destructive — replaces identity. */
  importPrivateKey: (hexKey: string, opts?: { confirm?: boolean }) => Promise<boolean>;
  sendAdvert: () => Promise<void>;
  sendMessage: (text: string, toPublicKey?: string, channelIdx?: number) => Promise<boolean>;
  setDeviceName: (name: string) => Promise<boolean>;
  setRadioParams: (params: { freq: number; bw: number; sf: number; cr: number }) => Promise<boolean>;
  setTxPower: (power: number) => Promise<boolean>;
  setCoords: (lat: number, lon: number) => Promise<boolean>;
  setAdvertLocPolicy: (policy: number) => Promise<boolean>;
  setTelemetryModeBase: (mode: TelemetryMode) => Promise<boolean>;
  setTelemetryModeLoc: (mode: TelemetryMode) => Promise<boolean>;
  setTelemetryModeEnv: (mode: TelemetryMode) => Promise<boolean>;
  refreshAll: () => Promise<void>;
  clearError: () => void;

  // ----- MeshCore remote administration -----
  /** Log in to a remote node. Pass `rememberPassword: true` to persist the
   *  password server-side (encrypted) for use across server restarts —
   *  see {@link getRemoteAdminCapability}. Returns the route's JSON
   *  response so the caller can react to `persisted` and credential errors. */
  loginRemote: (
    publicKey: string,
    password: string,
    rememberPassword?: boolean,
  ) => Promise<{ success: boolean; persisted?: boolean; error?: string; code?: string; reason?: string }>;
  /** Send a CLI command to a remote node and await its single-packet reply.
   *  Resolves the reply text + elapsedMs on success; `error` carries the
   *  human message for any failure (timeouts, send rejections). */
  sendCliCommand: (
    publicKey: string,
    command: string,
    opts?: { timeoutMs?: number; confirm?: boolean },
  ) => Promise<{ ok: true; reply: string; elapsedMs: number } | { ok: false; error: string; code?: string; status?: number }>;
  /** Query the credential-persistence capability for this source. Returns
   *  `canRemember=false` when SESSION_SECRET is auto-generated (along with a
   *  human-readable reason), plus:
   *    - `rotated`: stored credentials whose envelope no longer decrypts
   *      under the current SESSION_SECRET (they need re-entry).
   *    - `stored`: stored credentials that DO decrypt — used by the
   *      console to decide whether to attempt silent auto-login on mount. */
  getRemoteAdminCapability: () => Promise<
    | {
        canRemember: boolean;
        reason?: string;
        rotatedCount: number;
        rotated: Array<{ publicKey: string; name: string | null }>;
        stored: Array<{ publicKey: string; name: string | null }>;
      }
    | null
  >;
  /** Attempt to log in to a remote node using a previously-saved
   *  credential. Returns the route's JSON response so the caller can
   *  branch on `code` (NO_STORED_CREDENTIAL, CREDENTIAL_KEY_ROTATED,
   *  STORED_CREDENTIAL_REJECTED) and fall back to the password modal. */
  loginRemoteWithSaved: (
    publicKey: string,
  ) => Promise<{ success: boolean; usedStored?: boolean; error?: string; code?: string }>;
  /** Send a CLI command to the LOCALLY connected MeshCore node (the one
   *  this source is bound to). For Repeater / Room Server firmware this
   *  drives the device's native text CLI; for Companion firmware a small
   *  synthetic CLI interpreter on the server handles ver / stats / clock
   *  / advert. Reuses the same danger-confirm flow as `sendCliCommand`. */
  sendLocalCliCommand: (
    command: string,
    opts?: { timeoutMs?: number; confirm?: boolean },
  ) => Promise<{ ok: true; reply: string; elapsedMs: number } | { ok: false; error: string; code?: string; status?: number }>;
  /** Forget the saved admin password for a remote node. No-op when none is
   *  saved; resolves `true` on success. */
  forgetRemoteCredential: (publicKey: string) => Promise<boolean>;
  /** Fetch typed status from a remote node (SendStatusReq → StatusResponse).
   *  Populated fields depend on the remote's role: Repeater / Room Server
   *  return the full counter set; Companion firmware returns only battery
   *  and uptime. Returns null on any error so the panel can render an
   *  "unavailable" state without a thrown promise. */
  getRemoteStatus: (publicKey: string) => Promise<MeshCoreRemoteStatus | null>;

  // ----- Room server -----
  /** Login to a room server. Password may be empty for guest access. */
  loginRoom: (publicKey: string, password: string, rememberPassword?: boolean) => Promise<{ success: boolean; persisted?: boolean; error?: string }>;
  /** Login to a room server using a previously saved credential. */
  loginRoomWithSaved: (publicKey: string) => Promise<{ success: boolean; usedStored?: boolean; error?: string; code?: string }>;
  /** Send a text post to a room server. */
  sendRoomPost: (roomPublicKey: string, text: string) => Promise<boolean>;
  /** Get room credential info for this source. */
  getRoomCredentials: () => Promise<{ canRemember: boolean; stored: Array<{ publicKey: string }> } | null>;
  /** Configure periodic room sync. */
  setRoomSyncConfig: (publicKey: string, enabled: boolean, intervalMinutes?: number) => Promise<boolean>;
  /** Get current room sync config. */
  getRoomSyncConfig: (publicKey: string) => Promise<{ enabled: boolean; intervalMinutes: number } | null>;
}

/**
 * Typed status snapshot returned by `getRemoteStatus`. Mirrors the
 * server-side `MeshCoreStatus` in src/server/meshcoreManager.ts; defined
 * separately here so the frontend doesn't pull in server-only modules.
 */
export interface MeshCoreRemoteStatus {
  batteryMv?: number;
  uptimeSecs?: number;
  queueLen?: number;
  noiseFloor?: number;
  lastRssi?: number;
  lastSnr?: number;
  packetsRecv?: number;
  packetsSent?: number;
  airTimeSecs?: number;
  sentFlood?: number;
  sentDirect?: number;
  recvFlood?: number;
  recvDirect?: number;
  errors?: number;
  directDups?: number;
  floodDups?: number;
  txPower?: number;
  radioFreq?: number;
  radioBw?: number;
  radioSf?: number;
  radioCr?: number;
}

export interface UseMeshCoreState {
  status: ConnectionStatus | null;
  nodes: MeshCoreNode[];
  contacts: MeshCoreContact[];
  messages: MeshCoreMessage[];
  loading: boolean;
  error: string | null;
  actions: MeshCoreActions;
}

// Per-source mode relies on push events; the poll exists only to recover from
// a missed status transition (e.g. if the socket is briefly down). 30s keeps
// network chatter low while still catching anything the events miss.
const STATUS_SAFETY_POLL_MS = 30000;

export interface UseMeshCoreOptions {
  /** Frontend basename (typically `''` or `'/meshmonitor'`). */
  baseUrl: string;
  /** Source UUID — all reads/lifecycle calls are scoped to this source. */
  sourceId: string;
  /** When false, the hook returns initial state and never polls. */
  enabled?: boolean;
}

export function useMeshCore(options: UseMeshCoreOptions): UseMeshCoreState {
  const { baseUrl, sourceId, enabled = true } = options;
  const csrfFetch = useCsrfFetch();
  const { setMeshCoreNodes } = useMapContext();
  const { state: wsState } = useWebSocketContext();
  const socket = wsState.socket;

  const mcPrefix = `${baseUrl}/api/sources/${encodeURIComponent(sourceId)}/meshcore`;
  const sourceLifecyclePrefix = `${baseUrl}/api/sources/${encodeURIComponent(sourceId)}`;

  const [status, setStatus] = useState<ConnectionStatus | null>(null);
  const [nodes, setNodes] = useState<MeshCoreNode[]>([]);
  const [contacts, setContacts] = useState<MeshCoreContact[]>([]);
  const [messages, setMessages] = useState<MeshCoreMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const connectedRef = useRef(false);
  // Per-source push-event bookkeeping. seqCursorRef tracks the newest message
  // timestamp seen so reconnect catch-up only asks for the gap. localNodeRef +
  // contactsRef back the contact-derived nodes list when push events arrive.
  const seqCursorRef = useRef<number>(0);
  const localNodeRef = useRef<MeshCoreNode | null>(null);
  const contactsRef = useRef<Map<string, MeshCoreContact>>(new Map());

  const contactToNode = useCallback((c: MeshCoreContact): MeshCoreNode => ({
    publicKey: c.publicKey,
    name: c.advName || c.name || 'Unknown',
    advType: c.advType ?? 0,
    lastHeard: c.lastSeen,
    rssi: c.rssi,
    snr: c.snr,
  }), []);

  const recomputeNodes = useCallback(() => {
    // Rebuild the node list from in-memory contacts. Contacts carry no
    // favorite flag (it lives server-side, issue #3588), so carry forward the
    // last-known isFavorite per publicKey from the previous nodes state — a
    // contact push must not transiently un-pin a favorite before the next
    // snapshot poll reconciles from the DB.
    setNodes(prev => {
      const favByKey = new Map(prev.map(n => [n.publicKey, n.isFavorite]));
      const merged: MeshCoreNode[] = [];
      if (localNodeRef.current) merged.push(localNodeRef.current);
      for (const c of contactsRef.current.values()) {
        const node = contactToNode(c);
        const fav = favByKey.get(c.publicKey);
        if (fav !== undefined) node.isFavorite = fav;
        merged.push(node);
      }
      return merged;
    });
  }, [contactToNode]);

  const fetchStatus = useCallback(async (): Promise<boolean> => {
    if (!enabled) return false;
    try {
      const response = await csrfFetch(`${mcPrefix}/status`);
      const data = await response.json();
      if (data.success) {
        setStatus(data.data);
        return data.data.connected ?? false;
      }
    } catch (_err) {
      console.error('Failed to fetch meshcore status:', _err);
    }
    return false;
  }, [enabled, mcPrefix, csrfFetch]);

  const fetchMessages = useCallback(async () => {
    if (!enabled) return;
    try {
      const response = await csrfFetch(`${mcPrefix}/messages?limit=100`);
      const data = await response.json();
      if (data.success) setMessages(data.data ?? []);
    } catch (_err) {
      console.error('Failed to fetch meshcore messages:', _err);
    }
  }, [enabled, mcPrefix, csrfFetch]);

  // Single-call initial load. Returns status, contacts, nodes, messages and
  // a seqCursor (newest message timestamp) for reconnect catch-up. Replaces
  // three separate HTTP fetches at mount.
  const loadSnapshot = useCallback(async (): Promise<boolean> => {
    if (!enabled) return false;
    try {
      const response = await csrfFetch(`${mcPrefix}/snapshot`);
      const data = await response.json();
      if (!data.success) return false;
      const snap = data.data;
      setStatus(snap.status ?? null);
      localNodeRef.current = snap.status?.localNode ?? null;
      contactsRef.current = new Map(
        (snap.contacts ?? []).map((c: MeshCoreContact) => [c.publicKey, c]),
      );
      setContacts(snap.contacts ?? []);
      setNodes(snap.nodes ?? []);
      setMessages(snap.messages ?? []);
      seqCursorRef.current = snap.seqCursor ?? 0;
      setMeshCoreNodes(mapContactsToNodes(snap.contacts ?? []));
      return snap.status?.connected ?? false;
    } catch (_err) {
      console.error('Failed to load meshcore snapshot:', _err);
      return false;
    }
  }, [enabled, mcPrefix, csrfFetch, setMeshCoreNodes]);

  useEffect(() => {
    connectedRef.current = status?.connected ?? false;
  }, [status?.connected]);

  useEffect(() => {
    if (!enabled) return;
    // Snapshot on mount, then 30s status-only safety poll. Live updates ride
    // in over Socket.io (see the push-events effect below).
    void loadSnapshot();
    const interval = setInterval(() => { void fetchStatus(); }, STATUS_SAFETY_POLL_MS);
    return () => {
      clearInterval(interval);
    };
  }, [enabled, loadSnapshot, fetchStatus]);

  // Push events — join the per-source room, subscribe to MeshCore events,
  // and run a seq-cursor catch-up on reconnect.
  useEffect(() => {
    if (!enabled || !sourceId || !socket) return;

    const joinRoom = () => {
      socket.emit('join-source', sourceId);
    };
    if (socket.connected) joinRoom();
    socket.on('connect', joinRoom);

    const ackTimers = new Map<number, NodeJS.Timeout>();

    const startAckTimeout = (ackCrc: number, timeoutMs: number) => {
      if (ackTimers.has(ackCrc)) return;
      const timer = setTimeout(() => {
        ackTimers.delete(ackCrc);
        setMessages(prev => prev.map(m =>
          m.expectedAckCrc === ackCrc && m.deliveryStatus === 'sent'
            ? { ...m, deliveryStatus: 'failed' as const }
            : m,
        ));
      }, timeoutMs + 5000);
      ackTimers.set(ackCrc, timer);
    };

    const onMessage = (msg: MeshCoreMessageEvent) => {
      setMessages(prev => {
        if (prev.some(m => m.id === msg.id)) return prev;
        const enriched: MeshCoreMessage = msg.expectedAckCrc
          ? { ...msg, deliveryStatus: 'sent' as const }
          : msg;
        if (enriched.expectedAckCrc && enriched.estTimeout) {
          startAckTimeout(enriched.expectedAckCrc, enriched.estTimeout);
        }
        return [...prev, enriched];
      });
      if (msg.timestamp > seqCursorRef.current) seqCursorRef.current = msg.timestamp;
    };

    const onContactUpdated = (evt: MeshCoreContactUpdateEvent) => {
      if (evt.sourceId !== sourceId) return;
      const c = evt.contact as MeshCoreContact;
      contactsRef.current.set(c.publicKey, c);
      const next = Array.from(contactsRef.current.values());
      setContacts(next);
      setMeshCoreNodes(mapContactsToNodes(next));
      recomputeNodes();
    };

    const onStatusUpdated = (evt: MeshCoreStatusUpdateEvent) => {
      if (evt.sourceId !== sourceId) return;
      setStatus(prev => {
        if (!prev) {
          return {
            connected: evt.connected,
            deviceType: 0,
            deviceTypeName: '',
            config: null,
            localNode: (evt.node as MeshCoreNode | null) ?? null,
          };
        }
        return {
          ...prev,
          connected: evt.connected,
          localNode: (evt.node as MeshCoreNode | null) ?? prev.localNode,
        };
      });
      if (evt.node) localNodeRef.current = evt.node as MeshCoreNode;
    };

    const onLocalNodeUpdated = (evt: MeshCoreLocalNodeUpdateEvent) => {
      if (evt.sourceId !== sourceId) return;
      localNodeRef.current = evt.node as MeshCoreNode;
      setStatus(prev => (prev ? { ...prev, localNode: evt.node as MeshCoreNode } : prev));
      recomputeNodes();
    };

    // Reconnect catch-up: pull any messages newer than our cursor that the
    // socket missed while disconnected, then re-join (the 'connect' handler
    // above takes care of the actual room rejoin).
    const onReconnect = () => {
      const since = seqCursorRef.current;
      void (async () => {
        try {
          const res = await csrfFetch(`${mcPrefix}/messages?since=${since}`);
          const data = await res.json();
          if (data.success && Array.isArray(data.data) && data.data.length > 0) {
            setMessages(prev => {
              const seen = new Set(prev.map(m => m.id));
              const additions = (data.data as MeshCoreMessage[]).filter(
                m => !seen.has(m.id),
              );
              if (additions.length === 0) return prev;
              for (const m of additions) {
                if (m.timestamp > seqCursorRef.current) seqCursorRef.current = m.timestamp;
              }
              return [...prev, ...additions];
            });
          }
        } catch (_err) {
          console.error('MeshCore reconnect catch-up failed:', _err);
        }
      })();
    };

    const onSendConfirmed = (evt: { sourceId: string; ackCode: number; roundTripMs: number }) => {
      if (evt.sourceId !== sourceId) return;
      const timer = ackTimers.get(evt.ackCode);
      if (timer) {
        clearTimeout(timer);
        ackTimers.delete(evt.ackCode);
      }
      setMessages(prev => prev.map(m =>
        m.expectedAckCrc === evt.ackCode
          ? { ...m, deliveryStatus: 'delivered' as const, roundTripMs: evt.roundTripMs }
          : m,
      ));
    };

    socket.on('meshcore:message', onMessage);
    socket.on('meshcore:contact:updated', onContactUpdated);
    socket.on('meshcore:status:updated', onStatusUpdated);
    socket.on('meshcore:local-node:updated', onLocalNodeUpdated);
    socket.on('meshcore:send-confirmed', onSendConfirmed);
    socket.io.on('reconnect', onReconnect);

    return () => {
      for (const timer of ackTimers.values()) clearTimeout(timer);
      ackTimers.clear();
      socket.off('connect', joinRoom);
      socket.off('meshcore:message', onMessage);
      socket.off('meshcore:contact:updated', onContactUpdated);
      socket.off('meshcore:status:updated', onStatusUpdated);
      socket.off('meshcore:local-node:updated', onLocalNodeUpdated);
      socket.off('meshcore:send-confirmed', onSendConfirmed);
      socket.io.off('reconnect', onReconnect);
    };
  }, [enabled, sourceId, socket, mcPrefix, csrfFetch, setMeshCoreNodes, recomputeNodes]);

  const connect = useCallback(async (): Promise<boolean> => {
    setLoading(true);
    setError(null);
    try {
      // Connection params come from source.config; the source lifecycle
      // endpoint takes an empty body.
      const response = await csrfFetch(`${sourceLifecyclePrefix}/connect`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const data = await response.json();
      if (data.success) {
        // A snapshot pull primes status/nodes/contacts/messages and the seq
        // cursor in one round trip; live updates then ride on sockets.
        await loadSnapshot();
        return true;
      }
      setError(data.error || 'Connection failed');
      return false;
    } catch (_err) {
      setError('Connection error');
      return false;
    } finally {
      setLoading(false);
    }
  }, [sourceLifecyclePrefix, csrfFetch, loadSnapshot]);

  const disconnect = useCallback(async () => {
    setLoading(true);
    try {
      await csrfFetch(`${sourceLifecyclePrefix}/disconnect`, { method: 'POST' });
      await fetchStatus();
      setNodes([]);
      setContacts([]);
      setMessages([]);
      setMeshCoreNodes([]);
      // Clear push-event bookkeeping so a fresh connect doesn't resurrect
      // stale contacts/local-node from refs.
      contactsRef.current.clear();
      localNodeRef.current = null;
      seqCursorRef.current = 0;
    } catch (_err) {
      console.error('Disconnect error:', _err);
    } finally {
      setLoading(false);
    }
  }, [sourceLifecyclePrefix, csrfFetch, fetchStatus, setMeshCoreNodes]);

  const refreshContacts = useCallback(async () => {
    setLoading(true);
    try {
      const response = await csrfFetch(`${mcPrefix}/contacts/refresh`, { method: 'POST' });
      const data = await response.json();
      if (data.success) {
        const fresh = (data.data ?? []) as MeshCoreContact[];
        setContacts(fresh);
        setMeshCoreNodes(mapContactsToNodes(fresh));
        // Keep the push-event ref view in sync with the manual refresh so
        // a subsequent contact:updated event doesn't reintroduce stale rows.
        contactsRef.current = new Map(fresh.map(c => [c.publicKey, c]));
        recomputeNodes();
      } else {
        setError(data.error || 'Failed to refresh contacts');
      }
    } catch (_err) {
      setError('Failed to refresh contacts');
    } finally {
      setLoading(false);
    }
  }, [mcPrefix, csrfFetch, setMeshCoreNodes, recomputeNodes]);

  const resetContactPath = useCallback(async (publicKey: string): Promise<boolean> => {
    try {
      const response = await csrfFetch(
        `${mcPrefix}/contacts/${encodeURIComponent(publicKey)}/reset-path`,
        { method: 'POST' },
      );
      const data = await response.json();
      if (!data.success) {
        setError(data.error || 'Failed to reset path');
        return false;
      }
      // Optimistic local update so the UI flips to "unknown" instantly. The
      // server has already mirrored the cleared row to meshcore_nodes; we
      // skip a full refreshContacts() call to avoid hammering the device.
      setContacts(prev => prev.map(c => (
        c.publicKey === publicKey ? { ...c, outPath: null, pathLen: null } : c
      )));
      contactsRef.current.set(publicKey, {
        ...(contactsRef.current.get(publicKey) ?? { publicKey }),
        outPath: null,
        pathLen: null,
      });
      return true;
    } catch (_err) {
      setError('Failed to reset path');
      return false;
    }
  }, [mcPrefix, csrfFetch]);

  const discoverContactPath = useCallback(async (publicKey: string): Promise<boolean> => {
    try {
      const response = await csrfFetch(
        `${mcPrefix}/contacts/${encodeURIComponent(publicKey)}/discover-path`,
        { method: 'POST' },
      );
      const data = await response.json();
      if (!data.success) {
        setError(data.error || 'Failed to discover path');
        return false;
      }
      return true;
    } catch (_err) {
      setError('Failed to discover path');
      return false;
    }
  }, [mcPrefix, csrfFetch]);

  const discoverNodes = useCallback(async (
    mode: 'nearby' | 'repeaters' | 'sensors',
  ): Promise<{ returned: number; newCount: number } | null> => {
    try {
      const response = await csrfFetch(`${mcPrefix}/discover`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode }),
      });
      const data = await response.json();
      if (!data.success) {
        setError(data.error || 'Failed to discover nodes');
        return null;
      }
      // Auto-added responders are already mirrored server-side; refresh so
      // they appear in the contact/node lists immediately.
      if (data.returned > 0) {
        await refreshContacts();
      }
      return { returned: data.returned ?? 0, newCount: data.new ?? 0 };
    } catch (_err) {
      setError('Failed to discover nodes');
      return null;
    }
  }, [mcPrefix, csrfFetch, refreshContacts]);

  const getDiscoverable = useCallback(async (): Promise<boolean> => {
    try {
      const response = await csrfFetch(`${mcPrefix}/config/discoverable`);
      const data = await response.json();
      return data.success ? !!data.enabled : false;
    } catch (_err) {
      return false;
    }
  }, [mcPrefix, csrfFetch]);

  const setDiscoverable = useCallback(async (enabled: boolean): Promise<boolean> => {
    try {
      const response = await csrfFetch(`${mcPrefix}/config/discoverable`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled }),
      });
      const data = await response.json();
      if (!data.success) {
        setError(data.error || 'Failed to update discoverable setting');
        return false;
      }
      return true;
    } catch (_err) {
      setError('Failed to update discoverable setting');
      return false;
    }
  }, [mcPrefix, csrfFetch]);

  const getDefaultScope = useCallback(async (): Promise<string> => {
    try {
      const response = await csrfFetch(`${mcPrefix}/config/default-scope`);
      const data = await response.json();
      return data.success ? (typeof data.scope === 'string' ? data.scope : '') : '';
    } catch (_err) {
      return '';
    }
  }, [mcPrefix, csrfFetch]);

  const setDefaultScope = useCallback(async (scope: string): Promise<string | null> => {
    try {
      const response = await csrfFetch(`${mcPrefix}/config/default-scope`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scope }),
      });
      const data = await response.json();
      if (!data.success) {
        setError(data.error || 'Failed to update default scope');
        return null;
      }
      return typeof data.scope === 'string' ? data.scope : '';
    } catch (_err) {
      setError('Failed to update default scope');
      return null;
    }
  }, [mcPrefix, csrfFetch]);

  const loginRemote = useCallback(async (
    publicKey: string,
    password: string,
    rememberPassword?: boolean,
  ) => {
    try {
      const response = await csrfFetch(`${mcPrefix}/admin/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ publicKey, password, rememberPassword }),
      });
      const data = await response.json();
      return {
        success: !!data.success,
        persisted: data.persisted,
        error: data.error,
        code: data.code,
        reason: data.reason,
      };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : 'Network error' };
    }
  }, [mcPrefix, csrfFetch]);

  const sendCliCommand = useCallback(async (
    publicKey: string,
    command: string,
    opts?: { timeoutMs?: number; confirm?: boolean },
  ) => {
    try {
      const response = await csrfFetch(`${mcPrefix}/admin/cli`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          publicKey,
          command,
          ...(opts?.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
          ...(opts?.confirm ? { confirm: true } : {}),
        }),
      });
      const data = await response.json();
      if (data.success && data.data) {
        return { ok: true as const, reply: data.data.reply, elapsedMs: data.data.elapsedMs };
      }
      return { ok: false as const, error: data.error || 'Unknown error', code: data.code, status: response.status };
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : 'Network error' };
    }
  }, [mcPrefix, csrfFetch]);

  const getRemoteAdminCapability = useCallback(async () => {
    try {
      const response = await csrfFetch(`${mcPrefix}/admin/credentials-capability`);
      const data = await response.json();
      if (data.success && data.data) return data.data;
      return null;
    } catch (_err) {
      return null;
    }
  }, [mcPrefix, csrfFetch]);

  const sendLocalCliCommand = useCallback(async (
    command: string,
    opts?: { timeoutMs?: number; confirm?: boolean },
  ) => {
    try {
      const response = await csrfFetch(`${mcPrefix}/cli`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          command,
          ...(opts?.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
          ...(opts?.confirm ? { confirm: true } : {}),
        }),
      });
      const data = await response.json();
      if (data.success && data.data) {
        return { ok: true as const, reply: data.data.reply, elapsedMs: data.data.elapsedMs };
      }
      return { ok: false as const, error: data.error || 'Unknown error', code: data.code, status: response.status };
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : 'Network error' };
    }
  }, [mcPrefix, csrfFetch]);

  const loginRemoteWithSaved = useCallback(async (publicKey: string) => {
    try {
      const response = await csrfFetch(`${mcPrefix}/admin/login-with-saved`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ publicKey }),
      });
      const data = await response.json();
      return {
        success: !!data.success,
        usedStored: data.usedStored,
        error: data.error,
        code: data.code,
      };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : 'Network error' };
    }
  }, [mcPrefix, csrfFetch]);

  const forgetRemoteCredential = useCallback(async (publicKey: string): Promise<boolean> => {
    try {
      const response = await csrfFetch(
        `${mcPrefix}/admin/credentials/${encodeURIComponent(publicKey)}`,
        { method: 'DELETE' },
      );
      const data = await response.json();
      return !!data.success;
    } catch (_err) {
      return false;
    }
  }, [mcPrefix, csrfFetch]);

  const getRemoteStatus = useCallback(async (publicKey: string): Promise<MeshCoreRemoteStatus | null> => {
    try {
      const response = await csrfFetch(
        `${mcPrefix}/admin/status/${encodeURIComponent(publicKey)}`,
      );
      const data = await response.json();
      if (data.success && data.data) return data.data as MeshCoreRemoteStatus;
      return null;
    } catch (_err) {
      return null;
    }
  }, [mcPrefix, csrfFetch]);

  const shareContact = useCallback(async (publicKey: string): Promise<{ ok: boolean; error?: string }> => {
    try {
      const response = await csrfFetch(
        `${mcPrefix}/contacts/${encodeURIComponent(publicKey)}/share`,
        { method: 'POST' },
      );
      const data = await response.json();
      if (!data.success) {
        const error = data.error || 'Failed to share contact';
        setError(error);
        return { ok: false, error };
      }
      return { ok: true };
    } catch (_err) {
      const error = 'Failed to share contact';
      setError(error);
      return { ok: false, error };
    }
  }, [mcPrefix, csrfFetch]);

  const setContactOutPath = useCallback(async (publicKey: string, outPath: string): Promise<boolean> => {
    try {
      const response = await csrfFetch(
        `${mcPrefix}/contacts/${encodeURIComponent(publicKey)}/out-path`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ outPath }),
        },
      );
      const data = await response.json();
      if (!data.success) {
        setError(data.error || 'Failed to set path');
        return false;
      }
      // Optimistic local update so the UI shows the new hops without a
      // round trip. The server has already mirrored the new bytes to
      // meshcore_nodes; refreshContacts() will happen on the next
      // PathUpdated push if the firmware reroutes.
      const trimmed = outPath.trim();
      const newPathLen = trimmed === '' ? 0 : trimmed.split(',').length;
      setContacts(prev => prev.map(c => (
        c.publicKey === publicKey
          ? { ...c, outPath: trimmed, pathLen: newPathLen }
          : c
      )));
      const existing = contactsRef.current.get(publicKey) ?? { publicKey };
      contactsRef.current.set(publicKey, { ...existing, outPath: trimmed, pathLen: newPathLen });
      return true;
    } catch (_err) {
      setError('Failed to set path');
      return false;
    }
  }, [mcPrefix, csrfFetch]);

  const traceContactPath = useCallback(async (publicKey: string): Promise<TracePathResult | null> => {
    try {
      const response = await csrfFetch(
        `${mcPrefix}/contacts/${encodeURIComponent(publicKey)}/trace-path`,
        { method: 'POST' },
      );
      const data = await response.json();
      if (!data.success) {
        setError(data.error || 'Trace path failed');
        return null;
      }
      return { hops: data.hops, lastSnr: data.lastSnr };
    } catch (_err) {
      setError('Trace path failed');
      return null;
    }
  }, [mcPrefix, csrfFetch]);

  const removeContact = useCallback(async (publicKey: string): Promise<boolean> => {
    try {
      const response = await csrfFetch(
        `${mcPrefix}/contacts/${encodeURIComponent(publicKey)}`,
        { method: 'DELETE' },
      );
      const data = await response.json();
      if (!data.success) {
        setError(data.error || 'Failed to remove contact');
        return false;
      }
      setContacts(prev => prev.filter(c => c.publicKey !== publicKey));
      contactsRef.current.delete(publicKey);
      recomputeNodes();
      return true;
    } catch (_err) {
      setError('Failed to remove contact');
      return false;
    }
  }, [mcPrefix, csrfFetch, recomputeNodes]);

  const setNodeFavorite = useCallback(async (publicKey: string, isFavorite: boolean): Promise<boolean> => {
    try {
      const response = await csrfFetch(
        `${mcPrefix}/nodes/${encodeURIComponent(publicKey)}/favorite`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ isFavorite }),
        },
      );
      const data = await response.json();
      if (!data.success) {
        setError(data.error || 'Failed to update favorite');
        return false;
      }
      // Optimistically reflect the new flag so the list re-pins immediately,
      // without waiting for the next snapshot poll. The server is the source
      // of truth — getAllNodes() will confirm on the next refresh.
      setNodes(prev => prev.map(n =>
        n.publicKey === publicKey ? { ...n, isFavorite } : n));
      return true;
    } catch (_err) {
      setError('Failed to update favorite');
      return false;
    }
  }, [mcPrefix, csrfFetch]);

  const exportContact = useCallback(async (publicKey: string): Promise<number[] | null> => {
    try {
      const response = await csrfFetch(
        `${mcPrefix}/contacts/${encodeURIComponent(publicKey)}/export`,
      );
      const data = await response.json();
      if (!data.success) {
        setError(data.error || 'Failed to export contact');
        return null;
      }
      return data.data?.advertBytes ?? null;
    } catch (_err) {
      setError('Failed to export contact');
      return null;
    }
  }, [mcPrefix, csrfFetch]);

  const importContact = useCallback(async (advertBytes: number[]): Promise<boolean> => {
    try {
      const response = await csrfFetch(`${mcPrefix}/contacts/import`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ advertBytes }),
      });
      const data = await response.json();
      if (!data.success) {
        setError(data.error || 'Failed to import contact');
        return false;
      }
      await refreshContacts();
      return true;
    } catch (_err) {
      setError('Failed to import contact');
      return false;
    }
  }, [mcPrefix, csrfFetch, refreshContacts]);

  const syncDeviceTime = useCallback(async (): Promise<boolean> => {
    try {
      const response = await csrfFetch(`${mcPrefix}/config/sync-time`, { method: 'POST' });
      const data = await response.json();
      if (!data.success) {
        setError(data.error || 'Failed to sync device time');
        return false;
      }
      return true;
    } catch (_err) {
      setError('Failed to sync device time');
      return false;
    }
  }, [mcPrefix, csrfFetch]);

  const getNeighbours = useCallback(async (
    publicKey: string,
    opts?: { count?: number; offset?: number; orderBy?: number },
  ) => {
    try {
      const params = new URLSearchParams();
      if (opts?.count) params.set('count', String(opts.count));
      if (opts?.offset) params.set('offset', String(opts.offset));
      if (opts?.orderBy !== undefined) params.set('orderBy', String(opts.orderBy));
      const qs = params.toString();
      const response = await csrfFetch(
        `${mcPrefix}/contacts/${encodeURIComponent(publicKey)}/neighbours${qs ? '?' + qs : ''}`,
      );
      const data = await response.json();
      if (!data.success) return null;
      return data.data as { total: number; neighbours: { publicKeyPrefix: string; heardSecondsAgo: number; snr: number }[] };
    } catch (_err) {
      return null;
    }
  }, [mcPrefix, csrfFetch]);

  const rebootDevice = useCallback(async (opts?: { confirm?: boolean }): Promise<boolean> => {
    try {
      const response = await csrfFetch(`${mcPrefix}/config/reboot`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirm: opts?.confirm ?? true }),
      });
      const data = await response.json();
      if (!data.success) {
        setError(data.error || 'Reboot failed');
        return false;
      }
      return true;
    } catch (_err) {
      setError('Reboot failed');
      return false;
    }
  }, [mcPrefix, csrfFetch]);

  const exportPrivateKey = useCallback(async (): Promise<string | null> => {
    try {
      const response = await csrfFetch(`${mcPrefix}/config/private-key`);
      const data = await response.json();
      if (!data.success) {
        setError(data.error || 'Failed to export private key');
        return null;
      }
      return data.data?.privateKey ?? null;
    } catch (_err) {
      setError('Failed to export private key');
      return null;
    }
  }, [mcPrefix, csrfFetch]);

  const importPrivateKey = useCallback(async (hexKey: string, opts?: { confirm?: boolean }): Promise<boolean> => {
    try {
      const response = await csrfFetch(`${mcPrefix}/config/private-key`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ privateKey: hexKey, confirm: opts?.confirm ?? true }),
      });
      const data = await response.json();
      if (!data.success) {
        setError(data.error || 'Failed to import private key');
        return false;
      }
      return true;
    } catch (_err) {
      setError('Failed to import private key');
      return false;
    }
  }, [mcPrefix, csrfFetch]);

  const sendAdvert = useCallback(async () => {
    try {
      const response = await csrfFetch(`${mcPrefix}/advert`, { method: 'POST' });
      const data = await response.json();
      if (!data.success) setError(data.error || 'Failed to send advert');
    } catch (_err) {
      setError('Failed to send advert');
    }
  }, [mcPrefix, csrfFetch]);

  const sendMessage = useCallback(async (text: string, toPublicKey?: string, channelIdx?: number): Promise<boolean> => {
    if (!text.trim()) return false;
    try {
      const response = await csrfFetch(`${mcPrefix}/messages/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text,
          toPublicKey: toPublicKey || undefined,
          channelIdx,
        }),
      });
      const data = await response.json();
      if (data.success) {
        await fetchMessages();
        return true;
      }
      setError(data.error || 'Failed to send message');
      return false;
    } catch (_err) {
      setError('Failed to send message');
      return false;
    }
  }, [mcPrefix, csrfFetch, fetchMessages]);

  const setDeviceName = useCallback(async (name: string): Promise<boolean> => {
    try {
      const response = await csrfFetch(`${mcPrefix}/config/name`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      const data = await response.json();
      if (data.success) {
        await fetchStatus();
        return true;
      }
      setError(data.error || 'Failed to set device name');
      return false;
    } catch (_err) {
      setError('Failed to set device name');
      return false;
    }
  }, [mcPrefix, csrfFetch, fetchStatus]);

  const setRadioParams = useCallback(async (params: { freq: number; bw: number; sf: number; cr: number }): Promise<boolean> => {
    try {
      const response = await csrfFetch(`${mcPrefix}/config/radio`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
      });
      const data = await response.json();
      if (data.success) {
        await fetchStatus();
        return true;
      }
      setError(data.error || 'Failed to update radio params');
      return false;
    } catch (_err) {
      setError('Failed to update radio params');
      return false;
    }
  }, [mcPrefix, csrfFetch, fetchStatus]);

  const setTxPower = useCallback(async (power: number): Promise<boolean> => {
    try {
      const response = await csrfFetch(`${mcPrefix}/config/tx-power`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ power }),
      });
      const data = await response.json();
      if (data.success) {
        await fetchStatus();
        return true;
      }
      setError(data.error || 'Failed to update TX power');
      return false;
    } catch (_err) {
      setError('Failed to update TX power');
      return false;
    }
  }, [mcPrefix, csrfFetch, fetchStatus]);

  const setCoords = useCallback(async (lat: number, lon: number): Promise<boolean> => {
    try {
      const response = await csrfFetch(`${mcPrefix}/config/coords`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lat, lon }),
      });
      const data = await response.json();
      if (data.success) {
        await fetchStatus();
        return true;
      }
      setError(data.error || 'Failed to update coordinates');
      return false;
    } catch (_err) {
      setError('Failed to update coordinates');
      return false;
    }
  }, [mcPrefix, csrfFetch, fetchStatus]);

  const setAdvertLocPolicy = useCallback(async (policy: number): Promise<boolean> => {
    try {
      const response = await csrfFetch(`${mcPrefix}/config/advert-loc-policy`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ policy }),
      });
      const data = await response.json();
      if (data.success) {
        await fetchStatus();
        return true;
      }
      setError(data.error || 'Failed to update advert location policy');
      return false;
    } catch (_err) {
      setError('Failed to update advert location policy');
      return false;
    }
  }, [mcPrefix, csrfFetch, fetchStatus]);

  const setTelemetryMode = useCallback(async (
    endpoint: 'telemetry-mode-base' | 'telemetry-mode-loc' | 'telemetry-mode-env',
    mode: TelemetryMode,
    label: string,
  ): Promise<boolean> => {
    try {
      const response = await csrfFetch(`${mcPrefix}/config/${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode }),
      });
      const data = await response.json();
      if (data.success) {
        await fetchStatus();
        return true;
      }
      setError(data.error || `Failed to update ${label}`);
      return false;
    } catch (_err) {
      setError(`Failed to update ${label}`);
      return false;
    }
  }, [mcPrefix, csrfFetch, fetchStatus]);

  const setTelemetryModeBase = useCallback(
    (mode: TelemetryMode) => setTelemetryMode('telemetry-mode-base', mode, 'basic telemetry mode'),
    [setTelemetryMode],
  );
  const setTelemetryModeLoc = useCallback(
    (mode: TelemetryMode) => setTelemetryMode('telemetry-mode-loc', mode, 'location telemetry mode'),
    [setTelemetryMode],
  );
  const setTelemetryModeEnv = useCallback(
    (mode: TelemetryMode) => setTelemetryMode('telemetry-mode-env', mode, 'environment telemetry mode'),
    [setTelemetryMode],
  );

  const refreshAll = useCallback(async () => {
    await loadSnapshot();
  }, [loadSnapshot]);

  const clearError = useCallback(() => setError(null), []);

  // ----- Room server -----

  const loginRoom = useCallback(async (publicKey: string, password: string, rememberPassword?: boolean): Promise<{ success: boolean; persisted?: boolean; error?: string }> => {
    try {
      const response = await csrfFetch(`${mcPrefix}/rooms/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ publicKey, password, rememberPassword }),
      });
      const data = await response.json();
      return { success: !!data.success, persisted: data.persisted, error: data.error };
    } catch (_err) {
      return { success: false, error: 'Room login request failed' };
    }
  }, [mcPrefix, csrfFetch]);

  const loginRoomWithSaved = useCallback(async (publicKey: string): Promise<{ success: boolean; usedStored?: boolean; error?: string; code?: string }> => {
    try {
      const response = await csrfFetch(`${mcPrefix}/rooms/login-with-saved`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ publicKey }),
      });
      const data = await response.json();
      return { success: !!data.success, usedStored: data.usedStored, error: data.error, code: data.code };
    } catch (_err) {
      return { success: false, error: 'Room auto-login request failed' };
    }
  }, [mcPrefix, csrfFetch]);

  const sendRoomPost = useCallback(async (roomPublicKey: string, text: string): Promise<boolean> => {
    try {
      const response = await csrfFetch(`${mcPrefix}/rooms/post`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ roomPublicKey, text }),
      });
      const data = await response.json();
      if (!data.success) {
        setError(data.error || 'Failed to send room post');
        return false;
      }
      return true;
    } catch (_err) {
      setError('Failed to send room post');
      return false;
    }
  }, [mcPrefix, csrfFetch]);

  const getRoomCredentials = useCallback(async (): Promise<{ canRemember: boolean; stored: Array<{ publicKey: string }> } | null> => {
    try {
      const response = await csrfFetch(`${mcPrefix}/rooms/credentials`);
      const data = await response.json();
      if (data.success) return { canRemember: data.canRemember, stored: data.stored ?? [] };
      return null;
    } catch (_err) {
      return null;
    }
  }, [mcPrefix, csrfFetch]);

  const getRoomSyncConfig = useCallback(async (publicKey: string): Promise<{ enabled: boolean; intervalMinutes: number } | null> => {
    try {
      const response = await csrfFetch(`${mcPrefix}/rooms/sync-config?publicKey=${encodeURIComponent(publicKey)}`);
      const data = await response.json();
      if (data.success) return { enabled: data.enabled, intervalMinutes: data.intervalMinutes };
      return null;
    } catch (_err) {
      return null;
    }
  }, [mcPrefix, csrfFetch]);

  const setRoomSyncConfig = useCallback(async (publicKey: string, enabled: boolean, intervalMinutes?: number): Promise<boolean> => {
    try {
      const response = await csrfFetch(`${mcPrefix}/rooms/sync-config`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ publicKey, enabled, intervalMinutes }),
      });
      const data = await response.json();
      return !!data.success;
    } catch (_err) {
      return false;
    }
  }, [mcPrefix, csrfFetch]);

  return {
    status,
    nodes,
    contacts,
    messages,
    loading,
    error,
    actions: {
      connect,
      disconnect,
      refreshContacts,
      resetContactPath,
      discoverContactPath,
      discoverNodes,
      getDiscoverable,
      setDiscoverable,
      getDefaultScope,
      setDefaultScope,
      shareContact,
      setContactOutPath,
      traceContactPath,
      removeContact,
      setNodeFavorite,
      exportContact,
      importContact,
      syncDeviceTime,
      getNeighbours,
      rebootDevice,
      exportPrivateKey,
      importPrivateKey,
      sendAdvert,
      sendMessage,
      setDeviceName,
      setRadioParams,
      setTxPower,
      setCoords,
      setAdvertLocPolicy,
      setTelemetryModeBase,
      setTelemetryModeLoc,
      setTelemetryModeEnv,
      refreshAll,
      clearError,
      loginRemote,
      sendCliCommand,
      getRemoteAdminCapability,
      forgetRemoteCredential,
      getRemoteStatus,
      loginRemoteWithSaved,
      sendLocalCliCommand,
      loginRoom,
      loginRoomWithSaved,
      sendRoomPost,
      getRoomCredentials,
      getRoomSyncConfig,
      setRoomSyncConfig,
    },
  };
}
