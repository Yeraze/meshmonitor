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
  telemetryModeBase?: TelemetryMode;
  telemetryModeLoc?: TelemetryMode;
  telemetryModeEnv?: TelemetryMode;
  /** Populated from DeviceQuery by the server-side telemetry poller. */
  firmwareVer?: number;
  firmwareBuild?: string;
  model?: string;
  ver?: string;
}

export interface MeshCoreMessage {
  id: string;
  fromPublicKey: string;
  fromName?: string;
  toPublicKey?: string;
  text: string;
  timestamp: number;
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
  sendAdvert: () => Promise<void>;
  sendMessage: (text: string, toPublicKey?: string) => Promise<boolean>;
  setDeviceName: (name: string) => Promise<boolean>;
  setRadioParams: (params: { freq: number; bw: number; sf: number; cr: number }) => Promise<boolean>;
  setCoords: (lat: number, lon: number) => Promise<boolean>;
  setAdvertLocPolicy: (policy: number) => Promise<boolean>;
  setTelemetryModeBase: (mode: TelemetryMode) => Promise<boolean>;
  setTelemetryModeLoc: (mode: TelemetryMode) => Promise<boolean>;
  setTelemetryModeEnv: (mode: TelemetryMode) => Promise<boolean>;
  refreshAll: () => Promise<void>;
  clearError: () => void;
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
    const merged: MeshCoreNode[] = [];
    if (localNodeRef.current) merged.push(localNodeRef.current);
    for (const c of contactsRef.current.values()) merged.push(contactToNode(c));
    setNodes(merged);
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

    const onMessage = (msg: MeshCoreMessageEvent) => {
      setMessages(prev => {
        if (prev.some(m => m.id === msg.id)) return prev;
        return [...prev, msg];
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

    socket.on('meshcore:message', onMessage);
    socket.on('meshcore:contact:updated', onContactUpdated);
    socket.on('meshcore:status:updated', onStatusUpdated);
    socket.on('meshcore:local-node:updated', onLocalNodeUpdated);
    socket.io.on('reconnect', onReconnect);

    return () => {
      socket.off('connect', joinRoom);
      socket.off('meshcore:message', onMessage);
      socket.off('meshcore:contact:updated', onContactUpdated);
      socket.off('meshcore:status:updated', onStatusUpdated);
      socket.off('meshcore:local-node:updated', onLocalNodeUpdated);
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

  const sendAdvert = useCallback(async () => {
    try {
      const response = await csrfFetch(`${mcPrefix}/advert`, { method: 'POST' });
      const data = await response.json();
      if (!data.success) setError(data.error || 'Failed to send advert');
    } catch (_err) {
      setError('Failed to send advert');
    }
  }, [mcPrefix, csrfFetch]);

  const sendMessage = useCallback(async (text: string, toPublicKey?: string): Promise<boolean> => {
    if (!text.trim()) return false;
    try {
      const response = await csrfFetch(`${mcPrefix}/messages/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, toPublicKey: toPublicKey || undefined }),
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
      sendAdvert,
      sendMessage,
      setDeviceName,
      setRadioParams,
      setCoords,
      setAdvertLocPolicy,
      setTelemetryModeBase,
      setTelemetryModeLoc,
      setTelemetryModeEnv,
      refreshAll,
      clearError,
    },
  };
}
