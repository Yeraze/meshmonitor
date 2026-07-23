/**
 * DashboardPage — MeshMonitor 4.0 landing page.
 *
 * Wraps the inner dashboard in a SettingsProvider so map tile preferences
 * are available, then wires together DashboardSidebar + DashboardMap with
 * per-source data fetched via the useDashboardData hooks.
 */

import { useState, useEffect, useRef } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { SettingsProvider, useSettings } from '../contexts/SettingsContext';
import { useAuth } from '../contexts/AuthContext';
import { MapProvider, useMapContext } from '../contexts/MapContext';
import {
  useDashboardSources,
  useSourceStatuses,
  useDashboardSourceData,
  useDashboardUnifiedData,
  useUnifiedStatus,
  UNIFIED_SOURCE_ID,
} from '../hooks/useDashboardData';
import { useMeshCoreNeighbors } from '../hooks/useMapAnalysisData';
import type { DashboardSource } from '../hooks/useDashboardData';
import DashboardSidebar from '../components/Dashboard/DashboardSidebar';
import DashboardMap from '../components/Dashboard/DashboardMap';
import type { NodeSourceRef } from '../components/Dashboard/DashboardNodePopup';
import { buildBridgeConfig, formFromBridgeConfig } from '../components/MQTT/mqttBridgeConfig';
import LoginModal from '../components/LoginModal';
import UserMenu from '../components/UserMenu';
import { NewsPopup } from '../components/NewsPopup';
import { ToastProvider } from '../components/ToastContainer';
import api, { ApiError } from '../services/api';
import { logger } from '../utils/logger';
import { appBasename } from '../init';
import { getReservedLandingPath, isReservedLandingValue } from '../utils/defaultLandingPage';
import '../styles/dashboard.css';
import { UiIcon } from '../components/icons';


// ---------------------------------------------------------------------------
// DashboardInner — rendered inside SettingsProvider
// ---------------------------------------------------------------------------

function DashboardInner() {
  const { t } = useTranslation();
  const { authStatus } = useAuth();
  const queryClient = useQueryClient();
  const { mapTileset, customTilesets, defaultMapCenterLat, defaultMapCenterLon, maxNodeAgeHours, defaultLandingPage } = useSettings();
  const navigate = useNavigate();
  const location = useLocation();

  /**
   * Invalidate the source list cache after a mutation so the sidebar
   * reflects the new/edited/toggled/deleted source immediately instead of
   * waiting for the 15s poll interval. Same key as `useDashboardSources`.
   */
  const refreshSources = () => {
    void queryClient.invalidateQueries({ queryKey: ['dashboard', 'sources'] });
  };

  /**
   * Debounced variant for bursty mutations (rapid on/off/on source toggling).
   * Coalesces a flurry of toggles into a single cache invalidation so we fire
   * one refetch cycle instead of one per click — which, with the batched
   * dashboard endpoints, keeps toggling comfortably under the API rate limit
   * (#3735). The PUTs themselves still go through per click (each one changes
   * server state); only the follow-up refetch is coalesced.
   */
  const refreshSourcesTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refreshSourcesDebounced = () => {
    if (refreshSourcesTimer.current) clearTimeout(refreshSourcesTimer.current);
    refreshSourcesTimer.current = setTimeout(() => {
      void queryClient.invalidateQueries({ queryKey: ['dashboard', 'sources'] });
    }, 400);
  };

  /**
   * Unified map: clicking a "seen by" source row in a node popup jumps to that
   * source's Node Details view for the node. Meshtastic sources open the
   * Node Details (Messages) tab focused on the node's DM; MeshCore sources use
   * their own internal panes, so we just switch to that source.
   */
  const handleNodeSourceSelect = (source: NodeSourceRef, nodeId: string | undefined) => {
    if (source.protocol === 'MeshCore') {
      void navigate(`/source/${source.sourceId}/`);
      return;
    }
    void navigate(`/source/${source.sourceId}/#messages`, {
      state: nodeId ? { focusDmNodeId: nodeId } : undefined,
    });
  };

  const isAuthenticated = authStatus?.authenticated ?? false;
  const isAdmin = authStatus?.user?.isAdmin ?? false;

  const defaultCenter = {
    lat: defaultMapCenterLat ?? 30.0,
    lng: defaultMapCenterLon ?? -90.0,
  };

  // ----- state -----
  const [selectedSourceId, setSelectedSourceId] = useState<string | null>(null);
  const [showLogin, setShowLogin] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);
  const [pruneConfirm, setPruneConfirm] = useState<string | null>(null);
  const [pruneResult, setPruneResult] = useState<{ sourceId: string; count: number } | null>(null);
  const [pruneError, setPruneError] = useState<string | null>(null);
  const [prunePending, setPrunePending] = useState(false);
  // Mobile drawer state — hamburger toggles; source selection auto-closes.
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);

  // News popup state — auto-opens on unread news, can be reopened via sidebar footer button.
  const [showNewsPopup, setShowNewsPopup] = useState(false);
  const [forceShowAllNews, setForceShowAllNews] = useState(false);

  // Source IDs with an in-flight /connect request — drives the "Connecting..."
  // button label and status dot while the POST is outstanding (issue #2773).
  const [connectingIds, setConnectingIds] = useState<Set<string>>(new Set());

  // Source add/edit modal state
  const [showSourceModal, setShowSourceModal] = useState(false);
  const [editingSourceId, setEditingSourceId] = useState<string | null>(null);
  const [formType, setFormType] = useState<
    'meshtastic_tcp' | 'meshcore' | 'mqtt_broker' | 'mqtt_bridge'
  >('meshtastic_tcp');
  const [formName, setFormName] = useState('');
  const [formHost, setFormHost] = useState('');
  const [formPort, setFormPort] = useState('4403');
  const [formVnEnabled, setFormVnEnabled] = useState(false);
  const [formVnPort, setFormVnPort] = useState('');
  const [formVnAllowAdmin, setFormVnAllowAdmin] = useState(false);
  const [formHeartbeat, setFormHeartbeat] = useState('30'); // seconds, 0 = disabled (issue 2609)
  const [formAutoConnect, setFormAutoConnect] = useState(true); // issue #2773
  const [formPassiveMode, setFormPassiveMode] = useState(false); // issue #3122 — large/fragile TCP nodes
  // Empty string = "use default 4 h". Numeric string in hours when overridden (#3122 follow-up).
  const [formPassiveResyncStaleHours, setFormPassiveResyncStaleHours] = useState('');
  // MeshCore-specific (slice 4): companion-USB v1 — serial path + device type.
  // TCP transport added in v2: same Companion firmware reachable over a TCP
  // socket (e.g. esp-link, ser2net, native TCP-capable MeshCore firmware).
  const [formMcTransport, setFormMcTransport] = useState<'usb' | 'tcp'>('usb');
  const [formMcSerialPort, setFormMcSerialPort] = useState('');
  const [formMcTcpHost, setFormMcTcpHost] = useState('');
  const [formMcTcpPort, setFormMcTcpPort] = useState('4403');
  const [formMcDeviceType, setFormMcDeviceType] = useState<'companion' | 'repeater'>('companion');
  // MQTT broker (mqtt_broker) form state.
  const [formMqttListenPort, setFormMqttListenPort] = useState('1883');
  const [formMqttUsername, setFormMqttUsername] = useState('');
  const [formMqttPassword, setFormMqttPassword] = useState('');
  const [formMqttRootTopic, setFormMqttRootTopic] = useState('msh');
  const [formMqttZeroHopInjection, setFormMqttZeroHopInjection] = useState(false);
  // Per-bridge topic-rewrite form state, surfaced inside the broker's
  // edit modal so an operator can manage all rewrites for the bridges
  // attached to this broker in one place. Keyed by bridge source id.
  // Schema: { downlinkFrom, downlinkTo, uplinkFrom, uplinkTo } — empty
  // strings mean "not configured" and a partial entry (only `from` or
  // only `to` filled in) is a client-side validation error matching the
  // server-side `error_rewrite_incomplete` rule.
  const [formBrokerBridgeRewrites, setFormBrokerBridgeRewrites] = useState<
    Record<string, { downlinkFrom: string; downlinkTo: string; uplinkFrom: string; uplinkTo: string }>
  >({});
  // Snapshot at modal-open time so onSaveSource knows which bridges
  // actually changed and skips PUTs for the rest.
  const [originalBrokerBridgeRewrites, setOriginalBrokerBridgeRewrites] = useState<
    Record<string, { downlinkFrom: string; downlinkTo: string; uplinkFrom: string; uplinkTo: string }>
  >({});
  // MQTT bridge (mqtt_bridge) form state.
  const [formMqttBridgeBrokerId, setFormMqttBridgeBrokerId] = useState('');
  const [formMqttBridgeUrl, setFormMqttBridgeUrl] = useState('');
  const [formMqttBridgeUsername, setFormMqttBridgeUsername] = useState('');
  const [formMqttBridgePassword, setFormMqttBridgePassword] = useState('');
  const [formMqttBridgeSubscriptions, setFormMqttBridgeSubscriptions] = useState('msh/#');
  // Advanced bridge settings (mode, forwarding, ok_to_mqtt, publish/subscribe
  // filters, geofence, topic rewrites) are NOT edited here — they live on the
  // bridge's Configuration page. buildBridgeConfig preserves them on save.
  // Meshtastic source ↔ embedded MQTT broker proxy link (issue #3003
  // follow-up). Empty string = unset / no proxy bridge.
  const [formMtMqttLinkBrokerId, setFormMtMqttLinkBrokerId] = useState('');
  const [formError, setFormError] = useState('');
  const [formSaving, setFormSaving] = useState(false);

  // ----- data -----
  const { data: sources = [], isSuccess } = useDashboardSources();
  const sourceIds = sources.map((s) => s.id);

  // Apply admin-configured default landing page (issue #2917, expanded
  // for issue #3183 to allow cross-source unified pages). When the user
  // lands on `/`:
  //   - `'unified'` (or unset / unknown): stay here.
  //   - Other reserved values: redirect to the matching unified route
  //     (e.g. `unified-messages` → `/unified/messages`).
  //   - Source UUID: redirect to `/source/<id>/`.
  // The "Sources" button always passes `location.state.showList=true` so
  // users can return to the unified dashboard even with a default
  // configured.
  const skipDefaultLanding = (location.state as { showList?: boolean } | null)?.showList === true;
  useEffect(() => {
    if (skipDefaultLanding) return;
    if (!isSuccess) return;
    if (!defaultLandingPage || defaultLandingPage === 'unified') return;

    // Reserved values (built-in unified routes) take precedence over the
    // source-id lookup so a legitimate keyword can't be shadowed by a
    // hypothetical source whose UUID happens to collide.
    if (isReservedLandingValue(defaultLandingPage)) {
      const reservedPath = getReservedLandingPath(defaultLandingPage);
      if (reservedPath) void navigate(reservedPath, { replace: true });
      return;
    }

    const target = sources.find((s) => s.id === defaultLandingPage);
    if (!target) return;
    void navigate(`/source/${target.id}/`, { replace: true });
  }, [skipDefaultLanding, isSuccess, defaultLandingPage, sources, navigate]);
  const statusMap = useSourceStatuses(sourceIds);
  const unifiedStatus = useUnifiedStatus();

  // Show a synthetic "Unified" entry in the sidebar only when the user has
  // configured 2+ sources — otherwise it would just duplicate the single
  // source's data and add UI noise.
  const showUnified = sources.length >= 2;
  const isUnifiedSelected = selectedSourceId === UNIFIED_SOURCE_ID;

  // Run both data hooks but disable whichever is not active so we don't fan
  // out N parallel fetches when the user is on a single-source view.
  const singleSourceData = useDashboardSourceData(isUnifiedSelected ? null : selectedSourceId);
  const unifiedSourceData = useDashboardUnifiedData(sources, isUnifiedSelected);
  const sourceData = isUnifiedSelected ? unifiedSourceData : singleSourceData;

  // MeshCore neighbor links for the map. Fetched only when the "Show Neighbors"
  // toggle is on (DashboardInner sits inside MapProvider, so we can read it
  // here to gate the request). Unified pulls every source; single-source pulls
  // just the selected one. Non-MeshCore sources simply return no edges.
  const { showNeighborInfo } = useMapContext();
  const neighborSourceIds = isUnifiedSelected
    ? sourceIds
    : (selectedSourceId && selectedSourceId !== UNIFIED_SOURCE_ID ? [selectedSourceId] : []);
  const meshcoreNeighborsQuery = useMeshCoreNeighbors({
    enabled: showNeighborInfo && neighborSourceIds.length > 0,
    sources: neighborSourceIds,
    lookbackHours: maxNodeAgeHours,
  });
  const meshcoreNeighbors = (meshcoreNeighborsQuery.data?.items as unknown[] | undefined) ?? [];

  // Synthetic Unified pseudo-source for the sidebar. Recognized by its sentinel ID
  // so DashboardSidebar can hide admin/open controls that don't apply.
  const unifiedSource: DashboardSource | null = showUnified
    ? {
        id: UNIFIED_SOURCE_ID,
        name: t('source.unified', 'Unified'),
        type: '__unified__',
        enabled: true,
      }
    : null;
  const sidebarSources: DashboardSource[] = unifiedSource ? [unifiedSource, ...sources] : sources;

  // Auto-select first enabled source when list loads. Default to Unified when
  // the user has multiple sources — that's the most useful at-a-glance view.
  useEffect(() => {
    if (!isSuccess || sources.length === 0 || selectedSourceId !== null) return;
    if (showUnified) {
      setSelectedSourceId(UNIFIED_SOURCE_ID);
      return;
    }
    const firstEnabled = sources.find((s) => s.enabled);
    setSelectedSourceId(firstEnabled?.id ?? sources[0].id);
  }, [isSuccess, sources, selectedSourceId, showUnified]);

  // Auto-show news popup when authenticated user has unread news.
  useEffect(() => {
    if (!isAuthenticated) return;
    let cancelled = false;
    void (async () => {
      try {
        const response = await api.getUnreadNews();
        if (cancelled) return;
        if (response.items && response.items.length > 0) {
          setForceShowAllNews(false);
          setShowNewsPopup(true);
        }
      } catch (err) {
        logger.debug('Failed to fetch unread news:', err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isAuthenticated]);

  // Build node-count map. Each source's count comes from its /status response
  // (added in sourceRoutes.ts), polled in parallel by useSourceStatuses. The
  // currently-selected source uses the live `sourceData.nodes.length` so the
  // counter updates immediately as new nodes arrive instead of waiting for the
  // next status poll. The Unified entry uses the deduped count from
  // /api/unified/status — a single source of truth that stays stable as the
  // user clicks between sources (issue #2805). Falls back to the live merged
  // count when Unified is selected and the polled value hasn't arrived yet.
  const nodeCounts = new Map<string, number>(
    sources.map((s) => {
      if (s.id === selectedSourceId) return [s.id, sourceData.nodes.length];
      const status = statusMap.get(s.id);
      return [s.id, status?.nodeCount ?? 0];
    }),
  );
  if (unifiedSource) {
    const polled = unifiedStatus?.nodeCount;
    const fallback = isUnifiedSelected ? unifiedSourceData.nodes.length : 0;
    nodeCounts.set(UNIFIED_SOURCE_ID, polled ?? fallback);
  }

  // ----- admin actions -----
  const onAddSource = () => {
    setEditingSourceId(null);
    setFormType('meshtastic_tcp');
    setFormName('');
    setFormHost('');
    setFormPort('4403');
    setFormVnEnabled(false);
    setFormVnPort('');
    setFormVnAllowAdmin(false);
    setFormHeartbeat('30');
    setFormAutoConnect(true);
    setFormPassiveMode(false);
    setFormPassiveResyncStaleHours('');
    setFormMcTransport('usb');
    setFormMcSerialPort('');
    setFormMcTcpHost('');
    setFormMcTcpPort('4403');
    setFormMcDeviceType('companion');
    setFormMqttListenPort('1883');
    setFormMqttUsername('');
    setFormMqttPassword('');
    setFormMqttRootTopic('msh');
    setFormMqttZeroHopInjection(false);
    setFormMqttBridgeBrokerId('');
    setFormMqttBridgeUrl('');
    setFormMqttBridgeUsername('');
    setFormMqttBridgePassword('');
    setFormMqttBridgeSubscriptions('msh/#');
    setFormMtMqttLinkBrokerId('');
    setFormBrokerBridgeRewrites({});
    setOriginalBrokerBridgeRewrites({});
    setFormError('');
    setShowSourceModal(true);
  };

  const onEditSource = (id: string) => {
    const source = sources.find((s) => s.id === id);
    if (!source) return;
    const cfg = source.config as Record<string, any> | undefined;
    setEditingSourceId(id);
    if (source.type === 'mqtt_broker') {
      setFormType('mqtt_broker');
      setFormName(source.name);
      setFormMqttListenPort(String(cfg?.listener?.port ?? 1883));
      setFormMqttUsername(cfg?.auth?.username ?? '');
      // Non-admin GETs strip the password — leave the field empty, the
      // backend round-trips the existing value when the field stays empty.
      setFormMqttPassword('');
      setFormMqttRootTopic(cfg?.rootTopic ?? 'msh');
      setFormMqttZeroHopInjection(Boolean(cfg?.zeroHopInjection));
      // Build the per-bridge rewrite form data from every mqtt_bridge
      // source that points at this broker. Empty rewrites are fine —
      // the UI just shows blank inputs.
      const attached = sources.filter(
        (s) => s.type === 'mqtt_bridge' && (s.config as any)?.brokerSourceId === id,
      );
      const rewrites: Record<string, { downlinkFrom: string; downlinkTo: string; uplinkFrom: string; uplinkTo: string }> = {};
      for (const b of attached) {
        const bcfg = b.config as any;
        rewrites[b.id] = {
          downlinkFrom: bcfg?.downlinkTopicRewrite?.from ?? '',
          downlinkTo: bcfg?.downlinkTopicRewrite?.to ?? '',
          uplinkFrom: bcfg?.uplinkTopicRewrite?.from ?? '',
          uplinkTo: bcfg?.uplinkTopicRewrite?.to ?? '',
        };
      }
      setFormBrokerBridgeRewrites(rewrites);
      // Deep clone for the comparison-on-save baseline. Object spread
      // would alias the nested rewrite objects and falsely report "no
      // changes" once the user edits.
      setOriginalBrokerBridgeRewrites(JSON.parse(JSON.stringify(rewrites)));
      setFormError('');
      setShowSourceModal(true);
      return;
    }
    if (source.type === 'mqtt_bridge') {
      // Hydrate via the shared serializer so the modal and the dedicated
      // bridge Configuration page never drift on config shape.
      // Only the basics are edited here; advanced settings are preserved on
      // save (buildBridgeConfig merges over the existing config) and edited on
      // the Configuration page.
      const bf = formFromBridgeConfig(cfg);
      setFormType('mqtt_bridge');
      setFormName(source.name);
      setFormMqttBridgeBrokerId(bf.brokerId);
      setFormMqttBridgeUrl(bf.url);
      setFormMqttBridgeUsername(bf.username);
      setFormMqttBridgePassword('');
      setFormMqttBridgeSubscriptions(bf.subscriptions);
      setFormError('');
      setShowSourceModal(true);
      return;
    }
    setFormType(source.type === 'meshcore' ? 'meshcore' : 'meshtastic_tcp');
    setFormName(source.name);
    setFormHost(cfg?.host ?? '');
    setFormPort(String(cfg?.port ?? 4403));
    const vn = cfg?.virtualNode as { enabled?: boolean; port?: number; allowAdminCommands?: boolean } | undefined;
    setFormVnEnabled(vn?.enabled === true);
    setFormVnPort(vn?.port != null ? String(vn.port) : '');
    setFormVnAllowAdmin(vn?.allowAdminCommands === true);
    setFormHeartbeat(String(cfg?.heartbeatIntervalSeconds ?? 0));
    // Default to true when unset (legacy sources pre-#2773 auto-connected).
    setFormAutoConnect(cfg?.autoConnect !== false);
    setFormPassiveMode(cfg?.passiveMode === true);
    // Stored as ms; the UI works in whole hours for operator ergonomics.
    // Anything not a positive number leaves the field blank → server default.
    const staleMs = cfg?.passiveResyncStaleMs;
    setFormPassiveResyncStaleHours(
      typeof staleMs === 'number' && staleMs > 0
        ? String(Math.round((staleMs / (60 * 60 * 1000)) * 100) / 100)
        : '',
    );
    // MeshCore-specific config. transport=tcp is a v2 addition; legacy rows
    // with no transport field are treated as USB (the original v1 default).
    const mcTransport: 'usb' | 'tcp' = cfg?.transport === 'tcp' ? 'tcp' : 'usb';
    setFormMcTransport(mcTransport);
    setFormMcSerialPort(cfg?.serialPort ?? cfg?.port ?? '');
    setFormMcTcpHost(cfg?.tcpHost ?? '');
    setFormMcTcpPort(cfg?.tcpPort != null ? String(cfg.tcpPort) : '4403');
    setFormMcDeviceType(cfg?.deviceType === 'repeater' ? 'repeater' : 'companion');
    const link = cfg?.mqttLink as { enabled?: boolean; mqttBrokerSourceId?: string } | undefined;
    setFormMtMqttLinkBrokerId(link?.enabled && link.mqttBrokerSourceId ? link.mqttBrokerSourceId : '');
    setFormError('');
    setShowSourceModal(true);
  };

  const onSaveSource = async () => {
    if (!formName.trim()) { setFormError(t('source.form.error_name_required')); return; }

    let cfg: Record<string, any>;
    if (formType === 'mqtt_broker') {
      const port = parseInt(formMqttListenPort, 10);
      if (isNaN(port) || port < 1 || port > 65535) {
        setFormError(t('source.form.error_port_range'));
        return;
      }
      if (!formMqttUsername.trim()) {
        setFormError(t('source.form.error_mqtt_username_required', 'Broker username is required'));
        return;
      }
      if (!editingSourceId && !formMqttPassword) {
        setFormError(t('source.form.error_mqtt_password_required', 'Broker password is required'));
        return;
      }
      // Generate a synthetic gateway identity. nodeNum bit 31 set keeps it
      // outside the legitimate Meshtastic node-id range so it can't be
      // confused with a real radio.
      const nodeNum = (Math.floor(Math.random() * 0x7fffffff) | 0x80000000) >>> 0;
      const nodeId = '!' + nodeNum.toString(16).padStart(8, '0');
      const shortName = formName.trim().substring(0, 4) || 'MM';
      cfg = {
        listener: { port, host: '0.0.0.0' },
        auth: { username: formMqttUsername.trim(), password: formMqttPassword },
        gateway: { nodeNum, nodeId, longName: formName.trim(), shortName },
        rootTopic: formMqttRootTopic.trim() || 'msh',
        zeroHopInjection: formMqttZeroHopInjection,
      };
      if (editingSourceId && !formMqttPassword) {
        // Empty password on edit → tell server to keep the existing one.
        // Drop the password field so the merge logic on the server preserves it.
        delete (cfg.auth as { password?: string }).password;
      }
    } else if (formType === 'mqtt_bridge') {
      // Serialize via the shared helper. The modal manages connection /
      // forwarding / subscribe-side fields; publish (uplink) filters and topic
      // rewrites are edited on the dedicated Configuration page, so we pass the
      // existing config as `base` to preserve them instead of clobbering.
      const base = editingSourceId
        ? (sources.find((s) => s.id === editingSourceId)?.config as Record<string, any> | undefined)
        : undefined;
      // Only the basics are posted from the modal; every advanced field
      // (mode, forwarding, ok_to_mqtt, downlink/uplink filters, geofence,
      // rewrites) is omitted so buildBridgeConfig preserves it from `base`.
      const result = buildBridgeConfig(
        {
          brokerId: formMqttBridgeBrokerId,
          url: formMqttBridgeUrl,
          username: formMqttBridgeUsername,
          password: formMqttBridgePassword,
          subscriptions: formMqttBridgeSubscriptions,
        },
        { editing: !!editingSourceId, base },
      );
      if (result.error) {
        setFormError(t(result.error.key, result.error.fallback));
        return;
      }
      cfg = result.config!;
    } else if (formType === 'meshcore') {
      // MeshCore source: USB/serial or TCP. Both transports flow through the
      // same MeshCoreManager via the Python bridge — only the connect params
      // differ. BLE remains out of scope.
      if (formMcTransport === 'tcp') {
        const host = formMcTcpHost.trim();
        if (!host) {
          setFormError(t('meshcore.form.error_tcp_host_required', 'Host is required'));
          return;
        }
        const tcpPort = parseInt(formMcTcpPort, 10);
        if (isNaN(tcpPort) || tcpPort < 1 || tcpPort > 65535) {
          setFormError(t('source.form.error_port_range'));
          return;
        }
        cfg = {
          transport: 'tcp',
          tcpHost: host,
          tcpPort,
          deviceType: formMcDeviceType,
          autoConnect: formAutoConnect,
        };
      } else {
        const port = formMcSerialPort.trim();
        if (!port) {
          setFormError(t('meshcore.form.error_port_required', 'Serial port is required'));
          return;
        }
        cfg = {
          transport: 'usb',
          port,
          deviceType: formMcDeviceType,
          autoConnect: formAutoConnect,
        };
      }

      // Companion heartbeat / auto-reconnect (mirrors the Meshtastic setting).
      // 0 = disabled; otherwise probe + reconnect with backoff. Only the native
      // backend (companion) honours it; repeater ignores it.
      const mcHeartbeat = parseInt(formHeartbeat, 10);
      if (isNaN(mcHeartbeat) || mcHeartbeat < 0 || mcHeartbeat > 3600) {
        setFormError(t('source.form.error_heartbeat_range'));
        return;
      }
      if (mcHeartbeat > 0) cfg.heartbeatIntervalSeconds = mcHeartbeat;

      // Virtual Node server (opt-in): expose this MeshCore node to the MeshCore
      // mobile app over WiFi/TCP (#3535). Shares the formVn* state with the
      // Meshtastic form.
      if (formVnEnabled) {
        const vnPort = parseInt(formVnPort, 10);
        if (isNaN(vnPort) || vnPort < 1 || vnPort > 65535) {
          setFormError(t('source.form.error_vn_port_range'));
          return;
        }
        cfg.virtualNode = { enabled: true, port: vnPort, allowAdminCommands: formVnAllowAdmin };
      }
    } else {
      if (!formHost.trim()) { setFormError(t('source.form.error_host_required')); return; }
      const port = parseInt(formPort, 10);
      if (isNaN(port) || port < 1 || port > 65535) { setFormError(t('source.form.error_port_range')); return; }

      // Heartbeat interval (issue 2609): 0 = disabled, otherwise a positive
      // number of seconds. We clamp to a sane range to prevent pathological
      // configurations (sub-second floods or 24h naps that defeat the point).
      const heartbeatSeconds = parseInt(formHeartbeat, 10);
      if (isNaN(heartbeatSeconds) || heartbeatSeconds < 0 || heartbeatSeconds > 3600) {
        setFormError(t('source.form.error_heartbeat_range'));
        return;
      }

      let vnConfig: { enabled: boolean; port: number; allowAdminCommands: boolean } | undefined;
      if (formVnEnabled) {
        const vnPort = parseInt(formVnPort, 10);
        if (isNaN(vnPort) || vnPort < 1 || vnPort > 65535) {
          setFormError(t('source.form.error_vn_port_range'));
          return;
        }
        vnConfig = { enabled: true, port: vnPort, allowAdminCommands: formVnAllowAdmin };
      }

      cfg = { host: formHost.trim(), port };
      if (heartbeatSeconds > 0) cfg.heartbeatIntervalSeconds = heartbeatSeconds;
      if (vnConfig) cfg.virtualNode = vnConfig;
      // Persist autoConnect explicitly so the server can distinguish legacy
      // sources (undefined → treat as true) from ones the user opted out of.
      cfg.autoConnect = formAutoConnect;
      // Passive Mode (#3122): disables outbound config bursts and preserves
      // cached state across reconnects. Only persist when true so legacy
      // sources continue to send the standard handshake.
      if (formPassiveMode) {
        cfg.passiveMode = true;
        // Optional per-source override of the 4h default resync staleness
        // (#3122 follow-up). Stored as ms. Server clamps to [1m, 7d];
        // anything blank/invalid falls back to the default.
        const hours = parseFloat(formPassiveResyncStaleHours);
        if (Number.isFinite(hours) && hours > 0) {
          cfg.passiveResyncStaleMs = Math.round(hours * 60 * 60 * 1000);
        }
      }
      // MQTT proxy bridge — if set, MeshMonitor relays
      // FromRadio.mqttClientProxyMessage to/from the selected embedded
      // broker. Empty selection clears the link.
      if (formMtMqttLinkBrokerId) {
        cfg.mqttLink = { enabled: true, mqttBrokerSourceId: formMtMqttLinkBrokerId };
      } else {
        cfg.mqttLink = { enabled: false };
      }
    }

    setFormSaving(true);
    setFormError('');
    try {
      const body = {
        name: formName.trim(),
        type: formType,
        config: cfg,
        enabled: true,
      };

      try {
        if (editingSourceId) {
          await api.put(`/api/sources/${editingSourceId}`, body);
        } else {
          await api.post('/api/sources', body);
        }
      } catch (err) {
        if (err instanceof ApiError) {
          setFormError((err.body as any)?.error ?? t('source.form.error_save_failed'));
          return;
        }
        throw err;
      }

      // Broker save succeeded — now push per-bridge topic-rewrite
      // changes for any bridges whose rewrite config differs from the
      // snapshot taken at modal-open. Each bridge gets its own PUT so a
      // failure on one doesn't roll back the others; we collect errors
      // and surface them at the end instead of aborting.
      if (formType === 'mqtt_broker' && editingSourceId) {
        const bridgeErrors: string[] = [];
        for (const [bridgeId, rewrites] of Object.entries(formBrokerBridgeRewrites)) {
          const before = originalBrokerBridgeRewrites[bridgeId];
          const unchanged =
            before &&
            before.downlinkFrom === rewrites.downlinkFrom &&
            before.downlinkTo === rewrites.downlinkTo &&
            before.uplinkFrom === rewrites.uplinkFrom &&
            before.uplinkTo === rewrites.uplinkTo;
          if (unchanged) continue;

          // Client-side mirror of the server's `error_rewrite_incomplete`
          // rule — both From and To are required for a direction, or
          // both must be empty.
          const dlPartial =
            (rewrites.downlinkFrom && !rewrites.downlinkTo) ||
            (!rewrites.downlinkFrom && rewrites.downlinkTo);
          const ulPartial =
            (rewrites.uplinkFrom && !rewrites.uplinkTo) ||
            (!rewrites.uplinkFrom && rewrites.uplinkTo);
          if (dlPartial || ulPartial) {
            const bridge = sources.find((s) => s.id === bridgeId);
            bridgeErrors.push(
              `${bridge?.name ?? bridgeId}: ${t(
                'source.form.error_rewrite_incomplete',
                'Both from and to are required when a topic rewrite is set',
              )}`,
            );
            continue;
          }

          const bridge = sources.find((s) => s.id === bridgeId);
          if (!bridge) continue;
          const bridgeConfig: Record<string, any> = { ...(bridge.config as any) };
          if (rewrites.downlinkFrom && rewrites.downlinkTo) {
            bridgeConfig.downlinkTopicRewrite = {
              from: rewrites.downlinkFrom,
              to: rewrites.downlinkTo,
            };
          } else {
            delete bridgeConfig.downlinkTopicRewrite;
          }
          if (rewrites.uplinkFrom && rewrites.uplinkTo) {
            bridgeConfig.uplinkTopicRewrite = {
              from: rewrites.uplinkFrom,
              to: rewrites.uplinkTo,
            };
          } else {
            delete bridgeConfig.uplinkTopicRewrite;
          }
          // GETs strip credential fields for non-admins; defensively drop
          // any masked password marker so we don't try to round-trip it.
          if (bridgeConfig.upstream?.password === '••••••••') {
            delete bridgeConfig.upstream.password;
          }
          try {
            await api.put(`/api/sources/${bridgeId}`, {
              name: bridge.name,
              type: 'mqtt_bridge',
              config: bridgeConfig,
              enabled: bridge.enabled,
            });
          } catch (e) {
            if (e instanceof ApiError) {
              bridgeErrors.push(`${bridge.name}: ${(e.body as any)?.error ?? 'save failed'}`);
            } else {
              bridgeErrors.push(`${bridge.name}: ${(e as Error).message}`);
            }
          }
        }
        if (bridgeErrors.length > 0) {
          // Broker is saved; only the bridge updates partially failed.
          // Keep the modal open so the user can correct the issues
          // (probably partial-row validation problems above).
          setFormError(
            t(
              'source.form.bridge_rewrite_partial_error',
              'Broker saved but some bridge rewrites failed: ',
            ) + bridgeErrors.join('; '),
          );
          refreshSources();
          return;
        }
      }

      setShowSourceModal(false);
      refreshSources();
    } catch {
      setFormError(t('source.form.error_network'));
    } finally {
      setFormSaving(false);
    }
  };

  // Manually start the manager for a source whose autoConnect is disabled
  // (issue #2773). The /connect POST returns as soon as the manager is
  // registered, but the upstream TCP handshake happens asynchronously — so we
  // keep `connectingIds` set (and aggressively poll /status) until the status
  // endpoint reports connected=true, or a timeout elapses. Without this the
  // dashboard would sit on "Connecting…" for up to DASHBOARD_POLL_INTERVAL
  // (15s) before the next normal status poll fires.
  const onConnectSource = async (id: string) => {
    setConnectingIds((prev) => {
      const next = new Set(prev);
      next.add(id);
      return next;
    });
    try {
      try {
        await api.post(`/api/sources/${id}/connect`);
      } catch (err) {
        if (err instanceof ApiError) return;
        throw err;
      }

      refreshSources();

      // Poll the per-source status endpoint up to 20s, bailing early on
      // connect success. Uses refetchQueries (not invalidate) so the loop
      // doesn't have to re-check cache state each tick — the refetched value
      // lands in the cache and fuels the next iteration's check.
      const deadlineMs = Date.now() + 20_000;
      while (Date.now() < deadlineMs) {
        await queryClient.refetchQueries({ queryKey: ['dashboard', 'status', id], type: 'active' });
        const cached = queryClient.getQueriesData<{ connected?: boolean } | null>({ queryKey: ['dashboard', 'status', id] });
        const connected = cached.some(([, data]) => data?.connected === true);
        if (connected) break;
        await new Promise((r) => setTimeout(r, 1500));
      }
    } finally {
      setConnectingIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  };

  // Counterpart to onConnectSource — stops the manager without disabling the
  // source. Exposed in the kebab menu when the source has autoConnect=false
  // and is currently connected.
  const onDisconnectSource = async (id: string) => {
    try {
      await api.post(`/api/sources/${id}/disconnect`);
    } catch (err) {
      if (err instanceof ApiError) return;
      throw err;
    }
    refreshSources();
    // Force an immediate status refetch so the "Connected" dot flips to
    // "Idle" without waiting for the next 15s poll tick.
    void queryClient.refetchQueries({ queryKey: ['dashboard', 'status', id], type: 'active' });
  };

  const onToggleSource = async (id: string, enabled: boolean) => {
    try {
      await api.put(`/api/sources/${id}`, { enabled });
    } catch (err) {
      if (err instanceof ApiError) return;
      throw err;
    }
    refreshSourcesDebounced();
  };

  const onDeleteSource = (id: string) => {
    setDeleteConfirm(id);
  };

  // Persist a drag-reorder of the source list (issue #3338). Optimistically
  // reorders the cached `['dashboard','sources']` array so the sidebar updates
  // instantly, POSTs the new order, then invalidates to reconcile with the
  // server (which also reverts the optimistic move if the request failed).
  const onReorderSources = async (orderedIds: string[]) => {
    queryClient.setQueryData<DashboardSource[]>(['dashboard', 'sources'], (prev) => {
      if (!prev) return prev;
      const byId = new Map(prev.map((s) => [s.id, s]));
      const reordered = orderedIds.map((id) => byId.get(id)).filter((s): s is DashboardSource => s != null);
      // Keep any sources the payload didn't mention (defensive) at the end.
      const trailing = prev.filter((s) => !orderedIds.includes(s.id));
      return [...reordered, ...trailing];
    });

    try {
      await api.post('/api/sources/reorder', { order: orderedIds });
      refreshSources();
    } catch (err) {
      if (!(err instanceof ApiError)) throw err;
      refreshSources();
      logger.warn('Failed to reorder sources:', err.status);
    }
  };

  const confirmDelete = async () => {
    if (!deleteConfirm) return;
    let ok = true;
    try {
      await api.delete(`/api/sources/${deleteConfirm}`);
    } catch (err) {
      if (!(err instanceof ApiError)) throw err;
      ok = false;
    }
    if (selectedSourceId === deleteConfirm) {
      setSelectedSourceId(null);
    }
    setDeleteConfirm(null);
    if (ok) refreshSources();
  };

  const onPruneOutsideRoi = (id: string) => {
    setPruneError(null);
    setPruneResult(null);
    setPruneConfirm(id);
  };

  // Manual Resync (#3122 follow-up). Operator-initiated full config refresh
  // for Meshtastic TCP sources — useful for Passive Mode sources where the
  // automatic reconnect skips want_config_id while the cache is fresh.
  // Cooldown / single-flight / watchdog all live on the server; the click
  // either succeeds (200) or is rejected (409) with state describing why.
  const onResyncSource = async (id: string) => {
    try {
      await api.post(`/api/sources/${id}/resync`);
      // Refresh source status either way — a successful resync changes the
      // connection state once configComplete arrives, and a rejected click
      // doesn't hurt to re-poll.
      void queryClient.refetchQueries({ queryKey: ['dashboard', 'status', id], type: 'active' });
    } catch (err) {
      if (err instanceof ApiError) {
        void queryClient.refetchQueries({ queryKey: ['dashboard', 'status', id], type: 'active' });
        if (err.status !== 409) {
          logger.warn('Manual resync request failed', { status: err.status });
        }
        return;
      }
      logger.error('Manual resync request errored', err);
    }
  };

  const confirmPrune = async () => {
    if (!pruneConfirm || prunePending) return;
    setPrunePending(true);
    setPruneError(null);
    try {
      const body = await api.post<{ count?: number }>(`/api/sources/${pruneConfirm}/prune-outside-roi`);
      setPruneResult({ sourceId: pruneConfirm, count: body.count ?? 0 });
      setPruneConfirm(null);
      refreshSources();
    } catch (err) {
      setPruneError(err instanceof Error ? err.message : 'Request failed');
    } finally {
      setPrunePending(false);
    }
  };

  // ----- render -----
  return (
    <div className="dashboard-page">
      {/* Top bar */}
      <header className="dashboard-topbar">
        <button
          className="dashboard-topbar-hamburger"
          aria-label={mobileSidebarOpen ? t('source.sidebar.close_sources') : t('source.sidebar.open_sources')}
          aria-expanded={mobileSidebarOpen}
          onClick={() => setMobileSidebarOpen((v) => !v)}
        >
          <UiIcon name={mobileSidebarOpen ? 'close' : 'menu'} size={20} />
        </button>
        <div className="dashboard-topbar-logo">
          <img src={`${appBasename}/logo.png`} alt={t('source.topbar.logo_alt')} className="dashboard-topbar-logo-img" />
          <span className="dashboard-topbar-title">MeshMonitor</span>
        </div>
        <div className="dashboard-topbar-actions">
          {isAuthenticated ? (
            <UserMenu />
          ) : (
            <button
              className="dashboard-signin-btn"
              onClick={() => setShowLogin(true)}
            >
              {t('source.topbar.sign_in')}
            </button>
          )}
        </div>
      </header>

      {/* Body */}
      <div className="dashboard-body">
        <DashboardSidebar
          sources={sidebarSources}
          statusMap={statusMap}
          unifiedStatus={unifiedStatus}
          nodeCounts={nodeCounts}
          selectedSourceId={selectedSourceId}
          onSelectSource={setSelectedSourceId}
          isAdmin={isAdmin}
          isAuthenticated={isAuthenticated}
          onAddSource={onAddSource}
          onEditSource={onEditSource}
          onToggleSource={onToggleSource}
          onReorderSources={onReorderSources}
          onDeleteSource={onDeleteSource}
          onConnectSource={onConnectSource}
          onDisconnectSource={onDisconnectSource}
          onPruneOutsideRoi={onPruneOutsideRoi}
          onResyncSource={onResyncSource}
          connectingIds={connectingIds}
          mobileOpen={mobileSidebarOpen}
          onMobileClose={() => setMobileSidebarOpen(false)}
          onNewsClick={() => {
            setForceShowAllNews(true);
            setShowNewsPopup(true);
          }}
        />

        <DashboardMap
          nodes={sourceData.nodes}
          traceroutes={sourceData.traceroutes}
          neighborInfo={sourceData.neighborInfo}
          meshcoreNeighbors={meshcoreNeighbors}
          channels={sourceData.channels}
          tilesetId={mapTileset}
          customTilesets={customTilesets}
          defaultCenter={defaultCenter}
          sourceId={selectedSourceId}
          maxNodeAgeHours={maxNodeAgeHours}
          onNodeSourceSelect={handleNodeSourceSelect}
          isLoading={sourceData.isLoading}
        />
      </div>

      {/* Login modal */}
      <LoginModal isOpen={showLogin} onClose={() => setShowLogin(false)} />

      {/* News popup — auto-opens on unread news, reopened via sidebar footer. */}
      <NewsPopup
        isOpen={showNewsPopup}
        onClose={() => {
          setShowNewsPopup(false);
          setForceShowAllNews(false);
        }}
        forceShowAll={forceShowAllNews}
        isAuthenticated={isAuthenticated}
      />

      {/* Delete confirmation dialog */}
      {deleteConfirm && (
        <div className="dashboard-confirm-overlay">
          <div className="dashboard-confirm-dialog">
            <h3>{t('source.delete')}</h3>
            <p>{t('source.delete_confirm')}</p>
            <div className="dashboard-confirm-actions">
              <button onClick={() => setDeleteConfirm(null)}>{t('common.cancel')}</button>
              <button onClick={confirmDelete}>{t('source.kebab.delete')}</button>
            </div>
          </div>
        </div>
      )}

      {/* Prune Outside ROI confirmation */}
      {pruneConfirm && (
        <div className="dashboard-confirm-overlay">
          <div className="dashboard-confirm-dialog">
            <h3>{t('source.kebab.prune_outside_roi')}</h3>
            <p>{t('source.prune_outside_roi_confirm')}</p>
            {pruneError && (
              <p style={{ color: 'var(--ctp-red)', fontSize: 13 }}>{pruneError}</p>
            )}
            <div className="dashboard-confirm-actions">
              <button onClick={() => setPruneConfirm(null)} disabled={prunePending}>
                {t('common.cancel')}
              </button>
              <button onClick={confirmPrune} disabled={prunePending}>
                {prunePending
                  ? t('source.prune_pending', 'Pruning…')
                  : t('source.kebab.prune_outside_roi')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Prune result toast — simple modal, dismissed on click */}
      {pruneResult && (
        <div className="dashboard-confirm-overlay" onClick={() => setPruneResult(null)}>
          <div className="dashboard-confirm-dialog" onClick={(e) => e.stopPropagation()}>
            <h3>{t('source.kebab.prune_outside_roi')}</h3>
            <p>{t('source.prune_outside_roi_result', { count: pruneResult.count })}</p>
            <div className="dashboard-confirm-actions">
              <button onClick={() => setPruneResult(null)}>{t('common.ok')}</button>
            </div>
          </div>
        </div>
      )}

      {/* Add/Edit source modal */}
      {showSourceModal && (
        <div className="dashboard-confirm-overlay" onClick={() => setShowSourceModal(false)}>
          <div className="dashboard-confirm-dialog" style={{ maxWidth: 480, maxHeight: '85vh', overflowY: 'auto' }} onClick={(e) => e.stopPropagation()}>
            <h3>{editingSourceId ? t('source.edit') : t('source.add')}</h3>

            {/* Type selector (slice 4): only meaningful when adding — type is
                immutable on edit because backend tables and managers are
                bound to the type that was chosen at creation time. */}
            {!editingSourceId && (
              <label className="dashboard-form-field">
                <span className="dashboard-form-label">{t('source.form.type', 'Type')}</span>
                <select
                  className="dashboard-form-input"
                  value={formType}
                  onChange={(e) =>
                    setFormType(
                      e.target.value as
                        | 'meshtastic_tcp'
                        | 'meshcore'
                        | 'mqtt_broker'
                        | 'mqtt_bridge',
                    )
                  }
                >
                  <option value="meshtastic_tcp">{t('source.form.type_meshtastic', 'Meshtastic (TCP)')}</option>
                  <option value="meshcore">{t('source.form.type_meshcore', 'MeshCore')}</option>
                  <option value="mqtt_broker">{t('source.form.type_mqtt_broker', 'Embedded MQTT Broker (devices connect here)')}</option>
                  <option value="mqtt_bridge">{t('source.form.type_mqtt_bridge', 'MQTT Bridge (forward to/from an upstream broker)')}</option>
                </select>
              </label>
            )}

            <label className="dashboard-form-field">
              <span className="dashboard-form-label">{t('source.form.name')}</span>
              <input
                className="dashboard-form-input"
                type="text"
                value={formName}
                onChange={(e) => setFormName(e.target.value)}
                placeholder={t('source.form.name_placeholder')}
                autoFocus
              />
            </label>

            {formType === 'mqtt_broker' ? (
              <>
                <label className="dashboard-form-field">
                  <span className="dashboard-form-label">{t('source.form.mqtt_listen_port', 'Listen port')}</span>
                  <input
                    className="dashboard-form-input"
                    type="number"
                    value={formMqttListenPort}
                    onChange={(e) => setFormMqttListenPort(e.target.value)}
                    placeholder="1883"
                  />
                  <p style={{ fontSize: 11, color: 'var(--ctp-subtext0)', margin: '4px 0 0' }}>
                    {t('source.form.mqtt_listen_port_help', 'Devices configure their MQTT module to point at this port on the MeshMonitor host.')}
                  </p>
                </label>
                <label className="dashboard-form-field">
                  <span className="dashboard-form-label">{t('source.form.mqtt_username', 'Username')}</span>
                  <input
                    className="dashboard-form-input"
                    type="text"
                    value={formMqttUsername}
                    onChange={(e) => setFormMqttUsername(e.target.value)}
                  />
                </label>
                <label className="dashboard-form-field">
                  <span className="dashboard-form-label">{t('source.form.mqtt_password', 'Password')}</span>
                  <input
                    className="dashboard-form-input"
                    type="password"
                    value={formMqttPassword}
                    onChange={(e) => setFormMqttPassword(e.target.value)}
                    placeholder={editingSourceId ? '••••••••' : ''}
                  />
                </label>
                <label className="dashboard-form-field">
                  <span className="dashboard-form-label">{t('source.form.mqtt_root_topic', 'Root topic')}</span>
                  <input
                    className="dashboard-form-input"
                    type="text"
                    value={formMqttRootTopic}
                    onChange={(e) => setFormMqttRootTopic(e.target.value)}
                    placeholder="msh"
                  />
                </label>
                <label className="dashboard-form-field" style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 8 }}>
                  <input
                    type="checkbox"
                    checked={formMqttZeroHopInjection}
                    onChange={(e) => setFormMqttZeroHopInjection(e.target.checked)}
                    style={{ marginTop: 3 }}
                  />
                  <span>
                    <span className="dashboard-form-label" style={{ display: 'block' }}>
                      {t('source.form.mqtt_zero_hop_injection', 'Zero-hop injection')}
                    </span>
                    <span style={{ fontSize: 11, color: 'var(--ctp-subtext0)' }}>
                      {t(
                        'source.form.mqtt_zero_hop_injection_help',
                        'Clamp hop_limit to 0 on packets the broker delivers to connected devices, matching the public Meshtastic broker. Prevents MQTT-bridged packets from being rebroadcast over RF.',
                      )}
                    </span>
                  </span>
                </label>

                {/* Per-bridge topic rewrites. Only meaningful when editing
                    an existing broker — a brand-new broker has no bridges
                    attached yet, so we render nothing in that case. */}
                {editingSourceId && (() => {
                  const attachedBridges = sources.filter(
                    (s) => s.type === 'mqtt_bridge' && (s.config as any)?.brokerSourceId === editingSourceId,
                  );
                  if (attachedBridges.length === 0) return null;
                  return (
                    <div className="dashboard-form-field">
                      <span className="dashboard-form-label">
                        {t('source.form.bridge_topic_rewrites', 'Bridge topic rewrites')}
                      </span>
                      <p style={{ fontSize: 11, color: 'var(--ctp-subtext0)', margin: '4px 0 8px' }}>
                        {t(
                          'source.form.bridge_topic_rewrites_help',
                          'For each bridge attached to this broker, replace a literal topic prefix on inbound (downlink) or outbound (uplink) messages. Leave both From and To empty to disable that direction.',
                        )}
                      </p>
                      {attachedBridges.map((bridge) => {
                        const rw = formBrokerBridgeRewrites[bridge.id] ?? {
                          downlinkFrom: '',
                          downlinkTo: '',
                          uplinkFrom: '',
                          uplinkTo: '',
                        };
                        const patch = (next: Partial<typeof rw>) => {
                          setFormBrokerBridgeRewrites((prev) => ({
                            ...prev,
                            [bridge.id]: { ...rw, ...next },
                          }));
                        };
                        const hasAny =
                          rw.downlinkFrom || rw.downlinkTo || rw.uplinkFrom || rw.uplinkTo;
                        return (
                          <details
                            key={bridge.id}
                            open={Boolean(hasAny)}
                            style={{
                              border: '1px solid var(--ctp-surface1)',
                              borderRadius: 4,
                              padding: '6px 10px',
                              marginBottom: 6,
                              background: 'var(--ctp-surface0)',
                            }}
                          >
                            <summary style={{ cursor: 'pointer', fontWeight: 500 }}>
                              {bridge.name}
                              {hasAny && (
                                <span style={{ marginLeft: 8, fontSize: 10, color: 'var(--ctp-blue)' }}>
                                  • {t('source.form.bridge_topic_rewrites_active', 'configured')}
                                </span>
                              )}
                            </summary>
                            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginTop: 8 }}>
                              <div>
                                <span style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--ctp-subtext0)' }}>
                                  {t('source.form.bridge_topic_rewrites_downlink', 'Downlink (to local broker)')}
                                </span>
                                <input
                                  type="text"
                                  className="dashboard-form-input"
                                  placeholder={t('source.form.bridge_topic_rewrites_from', 'From prefix') as string}
                                  value={rw.downlinkFrom}
                                  onChange={(e) => patch({ downlinkFrom: e.target.value })}
                                  style={{ marginTop: 4 }}
                                />
                                <input
                                  type="text"
                                  className="dashboard-form-input"
                                  placeholder={t('source.form.bridge_topic_rewrites_to', 'To prefix') as string}
                                  value={rw.downlinkTo}
                                  onChange={(e) => patch({ downlinkTo: e.target.value })}
                                  style={{ marginTop: 4 }}
                                />
                              </div>
                              <div>
                                <span style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--ctp-subtext0)' }}>
                                  {t('source.form.bridge_topic_rewrites_uplink', 'Uplink (to upstream)')}
                                </span>
                                <input
                                  type="text"
                                  className="dashboard-form-input"
                                  placeholder={t('source.form.bridge_topic_rewrites_from', 'From prefix') as string}
                                  value={rw.uplinkFrom}
                                  onChange={(e) => patch({ uplinkFrom: e.target.value })}
                                  style={{ marginTop: 4 }}
                                />
                                <input
                                  type="text"
                                  className="dashboard-form-input"
                                  placeholder={t('source.form.bridge_topic_rewrites_to', 'To prefix') as string}
                                  value={rw.uplinkTo}
                                  onChange={(e) => patch({ uplinkTo: e.target.value })}
                                  style={{ marginTop: 4 }}
                                />
                              </div>
                            </div>
                          </details>
                        );
                      })}
                    </div>
                  );
                })()}
              </>
            ) : formType === 'mqtt_bridge' ? (
              <>
                <label className="dashboard-form-field">
                  <span className="dashboard-form-label">{t('source.form.mqtt_bridge_broker', 'Parent broker (optional)')}</span>
                  <select
                    className="dashboard-form-input"
                    value={formMqttBridgeBrokerId}
                    onChange={(e) => setFormMqttBridgeBrokerId(e.target.value)}
                  >
                    <option value="">{t('source.form.mqtt_bridge_broker_none', 'None — standalone client proxy')}</option>
                    {sources
                      .filter((s) => s.type === 'mqtt_broker')
                      .map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.name}
                        </option>
                      ))}
                  </select>
                  <span style={{ fontSize: 11, color: 'var(--ctp-subtext0)', marginTop: 4 }}>
                    {t(
                      'source.form.mqtt_bridge_broker_help',
                      'With a parent broker, the bridge also republishes upstream traffic to local devices and forwards their packets upstream. Without one, it runs as a pure MQTT client — useful for monitoring or as a client-proxy target for a Meshtastic source.',
                    )}
                  </span>
                </label>
                <label className="dashboard-form-field">
                  <span className="dashboard-form-label">{t('source.form.mqtt_upstream_url', 'Upstream URL')}</span>
                  <input
                    className="dashboard-form-input"
                    type="text"
                    value={formMqttBridgeUrl}
                    onChange={(e) => setFormMqttBridgeUrl(e.target.value)}
                    placeholder="mqtt://mqtt.meshtastic.org:1883"
                  />
                </label>
                <label className="dashboard-form-field">
                  <span className="dashboard-form-label">{t('source.form.mqtt_username', 'Username')}</span>
                  <input
                    className="dashboard-form-input"
                    type="text"
                    value={formMqttBridgeUsername}
                    onChange={(e) => setFormMqttBridgeUsername(e.target.value)}
                  />
                </label>
                <label className="dashboard-form-field">
                  <span className="dashboard-form-label">{t('source.form.mqtt_password', 'Password')}</span>
                  <input
                    className="dashboard-form-input"
                    type="password"
                    value={formMqttBridgePassword}
                    onChange={(e) => setFormMqttBridgePassword(e.target.value)}
                    placeholder={editingSourceId ? '••••••••' : ''}
                  />
                </label>
                <label className="dashboard-form-field">
                  <span className="dashboard-form-label">{t('source.form.mqtt_subscriptions', 'Upstream topics (one per line)')}</span>
                  <textarea
                    className="dashboard-form-input"
                    rows={3}
                    value={formMqttBridgeSubscriptions}
                    onChange={(e) => setFormMqttBridgeSubscriptions(e.target.value)}
                  />
                </label>
                {/* Advanced bridge settings (mode, forwarding, ok_to_mqtt,
                    publish channel/topic filters, geofence, topic rewrites)
                    live on the bridge's Configuration page so they're
                    maintained in one place — not duplicated here. When editing
                    an existing source we can deep-link straight to it. */}
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginTop: 4 }}>
                  <span style={{ fontSize: 11, color: 'var(--ctp-subtext0)', flex: 1 }}>
                    {t(
                      'source.form.mqtt_bridge_advanced_hint',
                      'Mode, forwarding, publish/subscribe filters, geofence, and topic rewrites are on the bridge’s Configuration page.',
                    )}
                  </span>
                  {editingSourceId && (
                    <button
                      type="button"
                      style={{
                        flexShrink: 0,
                        whiteSpace: 'nowrap',
                        fontSize: 11,
                        padding: '4px 8px',
                        background: 'transparent',
                        color: 'var(--ctp-blue)',
                        border: '1px solid var(--ctp-blue)',
                        borderRadius: 4,
                        cursor: 'pointer',
                      }}
                      title={t('source.form.mqtt_bridge_advanced_open', 'Open Configuration page')}
                      onClick={() => {
                        setShowSourceModal(false);
                        void navigate(`/source/${editingSourceId}/#mqtt-config`);
                      }}
                    >
                      {t('source.form.mqtt_bridge_advanced_open', 'Configuration')} <UiIcon name="forward" size={14} />
                    </button>
                  )}
                </div>
              </>
            ) : formType === 'meshcore' ? (
              <>
                <label className="dashboard-form-field">
                  <span className="dashboard-form-label">{t('meshcore.form.transport', 'Transport')}</span>
                  <select
                    className="dashboard-form-input"
                    value={formMcTransport}
                    onChange={(e) => setFormMcTransport(e.target.value as 'usb' | 'tcp')}
                  >
                    <option value="usb">{t('meshcore.form.transport_usb', 'USB / Serial')}</option>
                    <option value="tcp">{t('meshcore.form.transport_tcp', 'TCP')}</option>
                  </select>
                </label>

                {formMcTransport === 'tcp' ? (
                  <>
                    <label className="dashboard-form-field">
                      <span className="dashboard-form-label">{t('source.form.host')}</span>
                      <input
                        className="dashboard-form-input"
                        type="text"
                        value={formMcTcpHost}
                        onChange={(e) => setFormMcTcpHost(e.target.value)}
                        placeholder={t('source.form.host_placeholder')}
                      />
                      <p style={{ fontSize: 11, color: 'var(--ctp-subtext0)', margin: '4px 0 0' }}>
                        {t('meshcore.form.tcp_host_help', 'Hostname or IP of the MeshCore companion reachable over TCP (e.g. esp-link, ser2net, or native TCP firmware).')}
                      </p>
                    </label>

                    <label className="dashboard-form-field">
                      <span className="dashboard-form-label">{t('source.form.tcp_port')}</span>
                      <input
                        className="dashboard-form-input"
                        type="number"
                        value={formMcTcpPort}
                        onChange={(e) => setFormMcTcpPort(e.target.value)}
                        placeholder="4403"
                      />
                    </label>
                  </>
                ) : (
                  <label className="dashboard-form-field">
                    <span className="dashboard-form-label">{t('meshcore.form.serial_port', 'Serial Port')}</span>
                    <input
                      className="dashboard-form-input"
                      type="text"
                      value={formMcSerialPort}
                      onChange={(e) => setFormMcSerialPort(e.target.value)}
                      placeholder="/dev/ttyACM0"
                    />
                    <p style={{ fontSize: 11, color: 'var(--ctp-subtext0)', margin: '4px 0 0' }}>
                      {t('meshcore.form.serial_port_help', 'OS path of the USB-connected MeshCore companion (e.g. /dev/ttyACM0, COM3).')}
                    </p>
                  </label>
                )}

                <label className="dashboard-form-field">
                  <span className="dashboard-form-label">{t('meshcore.form.device_type', 'Device Type')}</span>
                  <select
                    className="dashboard-form-input"
                    value={formMcDeviceType}
                    onChange={(e) => setFormMcDeviceType(e.target.value as 'companion' | 'repeater')}
                  >
                    <option value="companion">{t('meshcore.device_type.companion', 'Companion')}</option>
                    <option value="repeater">{t('meshcore.device_type.repeater', 'Repeater')}</option>
                  </select>
                </label>

                <label className="dashboard-form-field">
                  <span className="dashboard-form-label">{t('source.form.heartbeat')}</span>
                  <input
                    className="dashboard-form-input"
                    type="number"
                    min={0}
                    max={3600}
                    value={formHeartbeat}
                    onChange={(e) => setFormHeartbeat(e.target.value)}
                    placeholder="0"
                  />
                  <p style={{ fontSize: 11, color: 'var(--ctp-subtext0)', margin: '4px 0 0' }}>
                    {t('meshcore.form.heartbeat_help', 'Seconds between companion keepalive probes (0 = disabled). On repeated failure the source reconnects automatically with backoff. Applies to Companion devices only.')}
                  </p>
                </label>

                <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, margin: '8px 0 4px' }}>
                  <input
                    type="checkbox"
                    checked={formAutoConnect}
                    onChange={(e) => setFormAutoConnect(e.target.checked)}
                  />
                  {t('source.form.auto_connect')}
                </label>
                <p style={{ fontSize: 11, color: 'var(--ctp-subtext0)', margin: '0 0 8px 24px' }}>
                  {t('source.form.auto_connect_help')}
                </p>

                <fieldset style={{ border: '1px solid var(--ctp-surface1)', borderRadius: 6, padding: '8px 12px 12px', margin: '8px 0' }}>
                  <legend style={{ fontSize: 12, padding: '0 6px', color: 'var(--ctp-subtext0)' }}>{t('source.form.virtual_node')}</legend>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, marginTop: 4 }}>
                    <input
                      type="checkbox"
                      checked={formVnEnabled}
                      onChange={(e) => setFormVnEnabled(e.target.checked)}
                    />
                    {t('meshcore.form.enable_virtual_node', 'Expose this node to the MeshCore app over WiFi')}
                  </label>
                  {formVnEnabled && (
                    <>
                      <label className="dashboard-form-field" style={{ marginTop: 8 }}>
                        <span className="dashboard-form-label">{t('source.form.virtual_node_port')}</span>
                        <input
                          className="dashboard-form-input"
                          type="number"
                          min={1}
                          max={65535}
                          value={formVnPort}
                          onChange={(e) => setFormVnPort(e.target.value)}
                          placeholder="5000"
                        />
                        <p style={{ fontSize: 11, color: 'var(--ctp-subtext0)', margin: '4px 0 0' }}>
                          {t('meshcore.form.virtual_node_help', 'TCP port the MeshCore mobile app connects to. Point the app at this host and port over WiFi.')}
                        </p>
                      </label>
                      <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, marginTop: 8 }}>
                        <input
                          type="checkbox"
                          checked={formVnAllowAdmin}
                          onChange={(e) => setFormVnAllowAdmin(e.target.checked)}
                        />
                        {t('meshcore.form.allow_admin_commands', 'Allow admin commands')}
                      </label>
                      <p style={{ fontSize: 11, color: 'var(--ctp-subtext0)', margin: '4px 0 0' }}>
                        {t('meshcore.form.allow_admin_help', 'Third-party clients connected to the virtual node can send config/admin commands to your MeshCore node. Leave off unless you trust the clients.')}
                      </p>
                    </>
                  )}
                </fieldset>
              </>
            ) : (
            <>
            <label className="dashboard-form-field">
              <span className="dashboard-form-label">{t('source.form.host')}</span>
              <input
                className="dashboard-form-input"
                type="text"
                value={formHost}
                onChange={(e) => setFormHost(e.target.value)}
                placeholder={t('source.form.host_placeholder')}
              />
            </label>

            <label className="dashboard-form-field">
              <span className="dashboard-form-label">{t('source.form.tcp_port')}</span>
              <input
                className="dashboard-form-input"
                type="number"
                value={formPort}
                onChange={(e) => setFormPort(e.target.value)}
                placeholder="4403"
              />
            </label>

            <label className="dashboard-form-field">
              <span className="dashboard-form-label">{t('source.form.heartbeat')}</span>
              <input
                className="dashboard-form-input"
                type="number"
                min={0}
                max={3600}
                value={formHeartbeat}
                onChange={(e) => setFormHeartbeat(e.target.value)}
                placeholder="0"
              />
              <p style={{ fontSize: 11, color: 'var(--ctp-subtext0)', margin: '4px 0 0' }}>
                {t('source.form.heartbeat_help')}
              </p>
            </label>

            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, margin: '8px 0 4px' }}>
              <input
                type="checkbox"
                checked={formAutoConnect}
                onChange={(e) => setFormAutoConnect(e.target.checked)}
              />
              {t('source.form.auto_connect')}
            </label>
            <p style={{ fontSize: 11, color: 'var(--ctp-subtext0)', margin: '0 0 8px 24px' }}>
              {t('source.form.auto_connect_help')}
            </p>

            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, margin: '8px 0 4px' }}>
              <input
                type="checkbox"
                checked={formPassiveMode}
                onChange={(e) => setFormPassiveMode(e.target.checked)}
              />
              {t('source.form.passive_mode', 'Passive Mode')}
            </label>
            <p style={{ fontSize: 11, color: 'var(--ctp-subtext0)', margin: '0 0 8px 24px' }}>
              {t(
                'source.form.passive_mode_help',
                'Reduces outbound requests to large or fragile TCP nodes. Preserves cached config across reconnects and skips post-config device requests. Recommended for router-class nodes with large NodeDBs.'
              )}
            </p>

            {formPassiveMode && (
              <label className="dashboard-form-field" style={{ marginLeft: 24, marginBottom: 8 }}>
                <span className="dashboard-form-label">
                  {t('source.form.passive_resync_stale_hours', 'Resync staleness window (hours)')}
                </span>
                <input
                  className="dashboard-form-input"
                  type="number"
                  min={0.0167}
                  max={168}
                  step={0.5}
                  value={formPassiveResyncStaleHours}
                  onChange={(e) => setFormPassiveResyncStaleHours(e.target.value)}
                  placeholder={t('source.form.passive_resync_stale_default', '4 (default)')}
                />
                <p style={{ fontSize: 11, color: 'var(--ctp-subtext0)', margin: '4px 0 0' }}>
                  {t(
                    'source.form.passive_resync_stale_help',
                    'How long the cached config stays valid after a disconnect before the next reconnect forces a full sync. Leave blank for 4 hours (default). Range: 1 minute – 7 days.'
                  )}
                </p>
              </label>
            )}

            <fieldset style={{ border: '1px solid var(--ctp-surface1)', borderRadius: 6, padding: '8px 12px 12px', margin: '8px 0' }}>
              <legend style={{ fontSize: 12, padding: '0 6px', color: 'var(--ctp-subtext0)' }}>{t('source.form.virtual_node')}</legend>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, marginTop: 4 }}>
                <input
                  type="checkbox"
                  checked={formVnEnabled}
                  onChange={(e) => setFormVnEnabled(e.target.checked)}
                />
                {t('source.form.enable_virtual_node')}
              </label>
              {formVnEnabled && (
                <>
                  <label className="dashboard-form-field" style={{ marginTop: 8 }}>
                    <span className="dashboard-form-label">{t('source.form.virtual_node_port')}</span>
                    <input
                      className="dashboard-form-input"
                      type="number"
                      value={formVnPort}
                      onChange={(e) => setFormVnPort(e.target.value)}
                      placeholder="4403"
                    />
                  </label>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, marginTop: 8 }}>
                    <input
                      type="checkbox"
                      checked={formVnAllowAdmin}
                      onChange={(e) => setFormVnAllowAdmin(e.target.checked)}
                    />
                    {t('source.form.allow_admin_commands')}
                  </label>
                  <p style={{ fontSize: 11, color: 'var(--ctp-subtext0)', margin: '4px 0 0' }}>
                    {t('source.form.allow_admin_help')}
                  </p>
                </>
              )}
            </fieldset>

            {sources.some((s) => s.type === 'mqtt_broker') && (
              <label className="dashboard-form-field">
                <span className="dashboard-form-label">
                  {t('source.form.mqtt_proxy_link', 'Bridge MQTT proxy to')}
                </span>
                <select
                  className="dashboard-form-input"
                  value={formMtMqttLinkBrokerId}
                  onChange={(e) => setFormMtMqttLinkBrokerId(e.target.value)}
                >
                  <option value="">{t('source.form.mqtt_proxy_none', 'None — device handles MQTT directly')}</option>
                  {sources
                    .filter((s) => s.type === 'mqtt_broker')
                    .map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                </select>
                <p style={{ fontSize: 11, color: 'var(--ctp-subtext0)', margin: '4px 0 0' }}>
                  {t(
                    'source.form.mqtt_proxy_link_help',
                    'When set, MeshMonitor relays the device’s mqttClientProxyMessage traffic to the selected embedded broker. Requires the device’s MQTT module to have proxy_to_client_enabled = true.',
                  )}
                </p>
              </label>
            )}
            </>
            )}

            {formError && (
              <p style={{ color: 'var(--ctp-red)', fontSize: 12, margin: '8px 0 0' }}>{formError}</p>
            )}

            <div className="dashboard-confirm-actions" style={{ marginTop: 16 }}>
              <button onClick={() => setShowSourceModal(false)}>{t('common.cancel')}</button>
              <button onClick={onSaveSource} disabled={formSaving} style={{ background: 'var(--ctp-blue)', color: 'var(--ctp-base)' }}>
                {formSaving ? t('common.saving') : t('common.save')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// DashboardPage — public export; wraps in SettingsProvider
// ---------------------------------------------------------------------------

export default function DashboardPage() {
  return (
    <SettingsProvider>
      <ToastProvider>
        <MapProvider>
          <DashboardInner />
        </MapProvider>
      </ToastProvider>
    </SettingsProvider>
  );
}
