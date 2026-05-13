/**
 * useMeshCore — centralised MeshCore state + polling.
 *
 * Owns the status / nodes / contacts / messages state for the MeshCore page
 * and exposes the action callbacks the sub-views call. Polls every 5s while
 * mounted; when connected it also pulls nodes / contacts / messages.
 *
 * Modes:
 *   - Singleton (App-shell tab): `useMeshCore({ baseUrl })` → /api/meshcore/*,
 *     connect/disconnect take ConnectParams.
 *   - Per-source (source dashboard): `useMeshCore({ baseUrl, sourceId })` →
 *     /api/sources/:id/meshcore/* for reads, /api/sources/:id/connect (no
 *     body params — params come from the saved source.config) for lifecycle.
 *   - `enabled: false` short-circuits all fetches; used to honour permission
 *     gates that should suppress polling entirely.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useCsrfFetch } from '../../../hooks/useCsrfFetch';
import { useMapContext } from '../../../contexts/MapContext';
import { MeshCoreContact, mapContactsToNodes } from '../../../utils/meshcoreHelpers';

export interface MeshCoreNode {
  publicKey: string;
  name: string;
  advType: number;
  txPower?: number;
  radioFreq?: number;
  radioBw?: number;
  radioSf?: number;
  radioCr?: number;
  lastHeard?: number;
  rssi?: number;
  snr?: number;
  batteryMv?: number;
  uptimeSecs?: number;
}

export interface MeshCoreMessage {
  id: string;
  fromPublicKey: string;
  toPublicKey?: string;
  text: string;
  timestamp: number;
}

export interface MeshCoreEnvConfig {
  connectionType: string;
  serialPort?: string;
  tcpHost?: string;
  tcpPort?: number;
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
  envConfig: MeshCoreEnvConfig | null;
}

export interface ConnectParams {
  connectionType: 'serial' | 'tcp';
  serialPort?: string;
  tcpHost?: string;
  tcpPort?: number;
}

export interface MeshCoreActions {
  connect: (params: ConnectParams) => Promise<boolean>;
  disconnect: () => Promise<void>;
  refreshContacts: () => Promise<void>;
  sendAdvert: () => Promise<void>;
  sendMessage: (text: string, toPublicKey?: string) => Promise<boolean>;
  setDeviceName: (name: string) => Promise<boolean>;
  setRadioParams: (params: { freq: number; bw: number; sf: number; cr: number }) => Promise<boolean>;
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

const POLL_INTERVAL_MS = 5000;

export interface UseMeshCoreOptions {
  /** Frontend basename (typically `''` or `'/meshmonitor'`). */
  baseUrl: string;
  /**
   * Optional source UUID. When set, all reads route through
   * `/api/sources/:id/meshcore/*` and connect/disconnect use the generic
   * `/api/sources/:id/{connect,disconnect}` endpoints (no body params —
   * connection settings live in the persisted source.config).
   */
  sourceId?: string;
  /** When false, the hook returns initial state and never polls. */
  enabled?: boolean;
}

export function useMeshCore(options: UseMeshCoreOptions): UseMeshCoreState {
  const { baseUrl, sourceId, enabled = true } = options;
  const csrfFetch = useCsrfFetch();
  const { setMeshCoreNodes } = useMapContext();

  // Endpoint prefixes vary by mode.
  const mcPrefix = sourceId
    ? `${baseUrl}/api/sources/${encodeURIComponent(sourceId)}/meshcore`
    : `${baseUrl}/api/meshcore`;
  const sourceLifecyclePrefix = sourceId
    ? `${baseUrl}/api/sources/${encodeURIComponent(sourceId)}`
    : null;

  const [status, setStatus] = useState<ConnectionStatus | null>(null);
  const [nodes, setNodes] = useState<MeshCoreNode[]>([]);
  const [contacts, setContacts] = useState<MeshCoreContact[]>([]);
  const [messages, setMessages] = useState<MeshCoreMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const connectedRef = useRef(false);

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

  const fetchNodes = useCallback(async () => {
    if (!enabled) return;
    try {
      const response = await csrfFetch(`${mcPrefix}/nodes`);
      const data = await response.json();
      if (data.success) setNodes(data.data ?? []);
    } catch (_err) {
      console.error('Failed to fetch meshcore nodes:', _err);
    }
  }, [enabled, mcPrefix, csrfFetch]);

  const fetchContacts = useCallback(async () => {
    if (!enabled) return;
    try {
      const response = await csrfFetch(`${mcPrefix}/contacts`);
      const data = await response.json();
      if (data.success) {
        setContacts(data.data ?? []);
        setMeshCoreNodes(mapContactsToNodes(data.data ?? []));
      }
    } catch (_err) {
      console.error('Failed to fetch meshcore contacts:', _err);
    }
  }, [enabled, mcPrefix, csrfFetch, setMeshCoreNodes]);

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

  useEffect(() => {
    connectedRef.current = status?.connected ?? false;
  }, [status?.connected]);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const tick = async () => {
      const isConnected = await fetchStatus();
      if (cancelled) return;
      if (isConnected) {
        await Promise.all([fetchNodes(), fetchContacts(), fetchMessages()]);
      }
    };
    void tick();
    const interval = setInterval(tick, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [enabled, fetchStatus, fetchNodes, fetchContacts, fetchMessages]);

  const connect = useCallback(async (params: ConnectParams): Promise<boolean> => {
    setLoading(true);
    setError(null);
    try {
      // In per-source mode the connection params come from source.config;
      // the generic /api/sources/:id/connect endpoint takes an empty body.
      const url = sourceLifecyclePrefix
        ? `${sourceLifecyclePrefix}/connect`
        : `${mcPrefix}/connect`;
      const body = sourceLifecyclePrefix
        ? {}
        : {
            connectionType: params.connectionType,
            serialPort: params.connectionType === 'serial' ? params.serialPort : undefined,
            tcpHost: params.connectionType === 'tcp' ? params.tcpHost : undefined,
            tcpPort: params.connectionType === 'tcp' ? params.tcpPort : undefined,
          };
      const response = await csrfFetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await response.json();
      if (data.success) {
        await fetchStatus();
        await Promise.all([fetchNodes(), fetchContacts()]);
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
  }, [mcPrefix, sourceLifecyclePrefix, csrfFetch, fetchStatus, fetchNodes, fetchContacts]);

  const disconnect = useCallback(async () => {
    setLoading(true);
    try {
      const url = sourceLifecyclePrefix
        ? `${sourceLifecyclePrefix}/disconnect`
        : `${mcPrefix}/disconnect`;
      await csrfFetch(url, { method: 'POST' });
      await fetchStatus();
      setNodes([]);
      setContacts([]);
      setMessages([]);
      setMeshCoreNodes([]);
    } catch (_err) {
      console.error('Disconnect error:', _err);
    } finally {
      setLoading(false);
    }
  }, [mcPrefix, sourceLifecyclePrefix, csrfFetch, fetchStatus, setMeshCoreNodes]);

  const refreshContacts = useCallback(async () => {
    setLoading(true);
    try {
      const response = await csrfFetch(`${mcPrefix}/contacts/refresh`, { method: 'POST' });
      const data = await response.json();
      if (data.success) {
        setContacts(data.data ?? []);
        setMeshCoreNodes(mapContactsToNodes(data.data ?? []));
      } else {
        setError(data.error || 'Failed to refresh contacts');
      }
    } catch (_err) {
      setError('Failed to refresh contacts');
    } finally {
      setLoading(false);
    }
  }, [mcPrefix, csrfFetch, setMeshCoreNodes]);

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

  const refreshAll = useCallback(async () => {
    const isConnected = await fetchStatus();
    if (isConnected) {
      await Promise.all([fetchNodes(), fetchContacts(), fetchMessages()]);
    }
  }, [fetchStatus, fetchNodes, fetchContacts, fetchMessages]);

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
      refreshAll,
      clearError,
    },
  };
}
