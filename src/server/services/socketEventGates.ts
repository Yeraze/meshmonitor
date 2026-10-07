/**
 * The gate for every event the WebSocket forwards from `dataEventEmitter`.
 *
 * The socket pushes the same data the REST routes serve, so each event is
 * gated the way the route that serves it is gated, on the event's OWN source.
 * `SOCKET_EVENT_GATES` is typed over `DataEventType`: a new event type does
 * not compile until its gate is declared here, and `webSocketService` drops
 * (for every socket, admins included) any event whose type has no entry.
 *
 * A gate never queries per socket. What it needs about the viewer comes from
 * `SocketViewer` (grants held in memory); what it needs about the event that
 * is not in the payload comes from `prepare`, run at most once per event.
 */
import databaseService, { type DbMessage } from '../../services/database.js';
import type { DataEvent, DataEventType, NodeUpdateData, ConnectionStatusData, TelemetryBatchData } from './dataEventEmitter.js';
import type { SocketViewer } from './socketAccess.js';
import type { ResourceType, PermissionAction } from '../../types/permission.js';
import { canonicalMessageTime, messageReceivedAt } from '../utils/messageTime.js';
import { isVirtualChannelNumber, canReadVirtualChannelNumber } from '../utils/virtualChannelPermissions.js';
import { withholdPrivateOverride } from '../utils/nodeEnhancer.js';
import { transformChannel } from '../utils/channelView.js';
import { canSeeKeyedMessage } from '../utils/meshcoreKeyAccess.js';
import { stripPositions } from '../utils/meshcorePositions.js';
import { getCachedSignFlipContext, applySignFlipToTraceroute, applySignFlipCorrection } from './signFlipCorrection.js';
import { logger } from '../../utils/logger.js';

/** Returned by a gate's `filter` when the viewer gets nothing. */
export const WITHHOLD: unique symbol = Symbol('socket.withhold');

export interface SocketEventGate {
  /**
   * `source`: the event belongs to one source and is checked on it. A viewer
   * who is not an admin never gets one that names no source. `global`: the
   * event has no source and the gate is a global rule.
   */
  scope: 'source' | 'global';
  /** The REST route that serves the same data. */
  rest: string;
  /** What a viewer who is not an admin must hold. Admins get every event. */
  rule: string;
  /**
   * The payload as sent to an admin, computed once per event. Defaults to the
   * event's data unchanged.
   */
  shape?(event: DataEvent): unknown | Promise<unknown>;
  /**
   * Facts about the event that the payload does not carry (the node's channel
   * and so on). Runs at most once per event, and only when some viewer who is
   * not an admin is subscribed.
   */
  prepare?(event: DataEvent): Promise<unknown>;
  /** Per-viewer state this event needs loaded before `filter` (cached on the viewer). */
  ensure?(viewer: SocketViewer, event: DataEvent): Promise<unknown> | undefined;
  /**
   * The payload for one viewer who is not an admin: the shaped payload, a
   * redacted copy, or `WITHHOLD`. Pure and synchronous. `sourceId` is the
   * event's own source ('' for a global event).
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- payload and prep shapes differ per event type
  filter(viewer: SocketViewer, sourceId: string, payload: any, prep: any, event: DataEvent): unknown;
}

const DEVICE_CHANNEL_MAX = 7;
const channelResource = (id: number): ResourceType => `channel_${id}` as ResourceType;
const isDeviceChannel = (id: unknown): id is number =>
  typeof id === 'number' && Number.isInteger(id) && id >= 0 && id <= DEVICE_CHANNEL_MAX;

/** A gate that passes the payload unchanged to a holder of one grant on the source. */
function needs(
  resource: ResourceType,
  action: PermissionAction,
  rest: string,
  rule: string = `\`${resource}:${action}\` on the event's source.`,
): SocketEventGate {
  return {
    scope: 'source',
    rest,
    rule,
    filter: (viewer, sourceId, payload) => (viewer.can(resource, action, sourceId) ? payload : WITHHOLD),
  };
}

/** Events only the automation engine and other server code consume. */
function serverOnly(what: string): SocketEventGate {
  return {
    scope: 'source',
    rest: 'None.',
    rule: `Admins only. ${what} No REST route serves it and no client listens for it.`,
    filter: () => WITHHOLD,
  };
}

/**
 * Transform a DbMessage to the format expected by the client (MeshMessage).
 * This mirrors the transformation in server.ts transformDbMessageToMeshMessage().
 */
function transformMessageForClient(msg: DbMessage): unknown {
  /* eslint-disable @typescript-eslint/no-explicit-any -- DbMessage does not declare the delivery columns */
  const row = msg as any;
  return {
    id: msg.id,
    from: msg.fromNodeId,
    to: msg.toNodeId,
    fromNodeId: msg.fromNodeId,
    toNodeId: msg.toNodeId,
    text: msg.text,
    channel: msg.channel,
    portnum: msg.portnum,
    // The timestamp needs to be a Date (serialized as ISO string) to match poll API format
    timestamp: new Date(canonicalMessageTime(msg)),
    // Server-side ingest time used by the client for sort order (issue #3187).
    receivedAt: new Date(messageReceivedAt(msg)),
    hopStart: msg.hopStart,
    hopLimit: msg.hopLimit,
    relayNode: msg.relayNode,
    replyId: msg.replyId,
    emoji: msg.emoji,
    rxSnr: msg.rxSnr,
    rxRssi: msg.rxRssi,
    requestId: row.requestId,
    wantAck: Boolean(row.wantAck),
    ackFailed: Boolean(row.ackFailed),
    routingErrorReceived: Boolean(row.routingErrorReceived),
    deliveryState: row.deliveryState,
    acknowledged:
      msg.channel === -1
        ? row.deliveryState === 'confirmed'
          ? true
          : undefined
        : row.deliveryState === 'delivered' || row.deliveryState === 'confirmed'
        ? true
        : undefined,
    decryptedBy: msg.decryptedBy ?? row.decrypted_by ?? null,
    spoofSuspected: Boolean(row.spoofSuspected),
  };
  /* eslint-enable @typescript-eslint/no-explicit-any */
}

/** The message rule of `GET /api/poll`, for one message on one source. */
function mayReadMessage(viewer: SocketViewer, sourceId: string, channel: unknown): boolean {
  if (channel === -1) return viewer.can('messages', 'read', sourceId);
  if (typeof channel !== 'number') return false;
  // Virtual channels use per-entry canRead, independent of channel_0..7.
  if (isVirtualChannelNumber(channel)) return canReadVirtualChannelNumber(channel, viewer.readableVirtual);
  return isDeviceChannel(channel)
    && viewer.can('channel_0', 'read', sourceId)
    && viewer.can(channelResource(channel), 'read', sourceId);
}

/** True when the viewer may read some message of the source (the poll's entry test). */
function mayReadSomeMessage(viewer: SocketViewer, sourceId: string): boolean {
  return viewer.can('messages', 'read', sourceId)
    || viewer.can('channel_0', 'read', sourceId)
    || viewer.readableVirtual === 'all'
    || viewer.readableVirtual.size > 0;
}

/** The node row facts the node rule needs. Null: no such row, so nothing to show. */
interface NodeFacts {
  channel: number | null | undefined;
  isPrivate: boolean;
}

async function loadNodeFacts(nodeNum: number, sourceId: string | undefined): Promise<NodeFacts | null> {
  if (!sourceId) return null;
  const row = await databaseService.nodes.getNodeViewFacts(Number(nodeNum), sourceId);
  return row ? { channel: row.channel, isPrivate: row.positionOverrideIsPrivate } : null;
}

/**
 * The slot a MeshCore channel message belongs to, from the synthetic
 * `channel-<idx>` key on either end. Null for a DM or a room post.
 */
export function meshcoreChannelIdx(message: { fromPublicKey?: string | null; toPublicKey?: string | null }): number | null {
  for (const key of [message.toPublicKey, message.fromPublicKey]) {
    const match = typeof key === 'string' ? /^channel-(\d+)$/.exec(key) : null;
    if (match) return Number(match[1]);
  }
  return null;
}

/** `canAccessMeshcoreChannel`: the channel's own grant, or the legacy `messages` one. */
function mayReadMeshcoreChannel(viewer: SocketViewer, sourceId: string, idx: number | null | undefined): boolean {
  if (viewer.can('messages', 'read', sourceId)) return true;
  return isDeviceChannel(idx) && viewer.can(channelResource(idx), 'read', sourceId);
}

const MESHCORE_MESSAGES = 'GET /api/sources/:id/meshcore/messages';
const MESHCORE_STATUS = 'GET /api/sources/:id/meshcore/status';
const RETICULUM_MESSAGES = 'GET /api/sources/:id/reticulum/messages';
const WAYPOINTS = 'GET /api/sources/:id/waypoints';

export const SOCKET_EVENT_GATES: Record<DataEventType, SocketEventGate> = {
  'message:new': {
    scope: 'source',
    rest: 'GET /api/poll (`messages`)',
    rule: 'Channel message: `channel_0:read` and `channel_N:read` on the source. DM: `messages:read` on the source. Virtual channel: the per-entry `canRead` grant.',
    shape: (event) => transformMessageForClient(event.data as DbMessage),
    filter: (viewer, sourceId, payload, _prep, event) =>
      mayReadMessage(viewer, sourceId, (event.data as DbMessage).channel) ? payload : WITHHOLD,
  },

  'node:updated': {
    scope: 'source',
    rest: 'GET /api/poll (`nodes`)',
    rule: '`channel_N:viewOnMap` on the source, N = the channel the node was last heard on. A private position override is removed without `nodes_private:read` on the source.',
    prepare: (event) => loadNodeFacts((event.data as NodeUpdateData).nodeNum, event.sourceId),
    filter: (viewer, sourceId, payload: NodeUpdateData, facts: NodeFacts | null) => {
      if (!facts || !viewer.canViewNode(sourceId, facts.channel)) return WITHHOLD;
      if (!facts.isPrivate || viewer.canViewPrivate(sourceId)) return payload;
      const node = payload.node as Record<string, unknown> | undefined;
      const carriesOverride = !!node
        && ('latitudeOverride' in node || 'longitudeOverride' in node || 'altitudeOverride' in node);
      return carriesOverride ? { ...payload, node: withholdPrivateOverride(node) } : payload;
    },
  },

  'channel:updated': {
    scope: 'source',
    rest: 'GET /api/poll (`channels`)',
    rule: '`channel_N:read` on the source. The PSK: `channel_N:write` on the source.',
    filter: (viewer, sourceId, payload: { id?: number }) => {
      if (!isDeviceChannel(payload?.id) || !viewer.can(channelResource(payload.id), 'read', sourceId)) return WITHHOLD;
      return transformChannel(payload, { includePsk: viewer.can(channelResource(payload.id), 'write', sourceId) });
    },
  },

  'telemetry:batch': {
    scope: 'source',
    rest: 'GET /api/telemetry/:nodeId',
    rule: '`info:read` or `dashboard:read` (global), and per node the node rule: `channel_N:viewOnMap` on the source.',
    prepare: async (event) => {
      const facts = new Map<string, NodeFacts | null>();
      for (const nodeNum of Object.keys(event.data as TelemetryBatchData)) {
        facts.set(nodeNum, await loadNodeFacts(Number(nodeNum), event.sourceId));
      }
      return facts;
    },
    filter: (viewer, sourceId, payload: TelemetryBatchData, facts: Map<string, NodeFacts | null>) => {
      if (!viewer.can('info', 'read', sourceId) && !viewer.can('dashboard', 'read', sourceId)) return WITHHOLD;
      const visible: TelemetryBatchData = {};
      let any = false;
      for (const [nodeNum, rows] of Object.entries(payload)) {
        const node = facts.get(nodeNum);
        if (!node || !viewer.canViewNode(sourceId, node.channel)) continue;
        visible[Number(nodeNum)] = rows;
        any = true;
      }
      return any ? visible : WITHHOLD;
    },
  },

  'connection:status': {
    scope: 'source',
    rest: 'GET /api/poll (`connection`, `config`)',
    rule: 'Any grant on the source. `reason` (it can quote the node address): signed in with `sources:read`.',
    filter: (viewer, sourceId, payload: ConnectionStatusData) => {
      if (!viewer.holdsAnyGrantOn(sourceId)) return WITHHOLD;
      if (viewer.mayViewEndpoint) return payload;
      const { reason: _reason, ...withoutReason } = payload;
      void _reason;
      return withoutReason;
    },
  },

  'client-notification': needs(
    'messages',
    'read',
    'None (a notice from the connected node about its own operation).',
  ),

  'traceroute:complete': {
    scope: 'source',
    rest: 'GET /api/poll (`traceroutes`)',
    rule: '`traceroute:read` on the source, and `viewOnMap` on the row\'s channel there when it has one.',
    // #5363: draw the live traceroute's snapshot at the corrected point. A
    // copy only; the event bus and the stored row keep the reported fix.
    shape: async (event) => {
      const row = event.data as { routePositions?: string | null };
      try {
        return applySignFlipToTraceroute(row, await getCachedSignFlipContext(event.sourceId));
      } catch (err) {
        logger.warn('[WebSocket] Sign-flip traceroute correction failed:', err);
        return row;
      }
    },
    filter: (viewer, sourceId, payload, _prep, event) => {
      if (!viewer.can('traceroute', 'read', sourceId)) return WITHHOLD;
      const channel = (event.data as { channel?: number | null }).channel;
      return channel === undefined || channel === null || viewer.canViewNode(sourceId, channel) ? payload : WITHHOLD;
    },
  },

  'routing:update': {
    scope: 'source',
    rest: 'GET /api/poll (`messages`: the delivery state of a sent message)',
    rule: 'May read some message of the source: `messages:read` or `channel_0:read` there, or a virtual-channel `canRead` grant.',
    filter: (viewer, sourceId, payload) => (mayReadSomeMessage(viewer, sourceId) ? payload : WITHHOLD),
  },

  'waypoint:upserted': needs('waypoints', 'read', WAYPOINTS),
  'waypoint:deleted': needs('waypoints', 'read', WAYPOINTS),
  'waypoint:expired': needs('waypoints', 'read', WAYPOINTS),

  'meshcore:message': {
    scope: 'source',
    rest: `${MESHCORE_MESSAGES}, GET .../messages/channel/:idx`,
    rule: '`messages:read` on the source, or for a channel message `channel_N:read` there. A repeater-decrypted message also needs read access to its key (#5551).',
    ensure: (viewer, event) =>
      (event.data as { keyFingerprint?: string | null })?.keyFingerprint ? viewer.keyAccess() : undefined,
    filter: (viewer, sourceId, payload: { fromPublicKey?: string; toPublicKey?: string | null; keyFingerprint?: string | null }) => {
      if (!mayReadMeshcoreChannel(viewer, sourceId, meshcoreChannelIdx(payload))) return WITHHOLD;
      if (!payload.keyFingerprint) return payload;
      const access = viewer.loadedKeyAccess;
      return access !== undefined && canSeeKeyedMessage(access, payload) ? payload : WITHHOLD;
    },
  },
  'meshcore:messages:deleted': {
    scope: 'source',
    rest: MESHCORE_MESSAGES,
    rule: '`messages:read` on the source, or for a channel purge `channel_N:read` there.',
    filter: (viewer, sourceId, payload: { channelIdx?: number }) =>
      mayReadMeshcoreChannel(viewer, sourceId, payload?.channelIdx) ? payload : WITHHOLD,
  },
  'meshcore:message:updated': needs('messages', 'read', MESHCORE_MESSAGES),
  'meshcore:send-confirmed': needs('messages', 'read', MESHCORE_MESSAGES),
  'meshcore:channel-heard': needs('messages', 'read', MESHCORE_MESSAGES),
  'meshcore:channels:reordered': {
    scope: 'source',
    rest: `${MESHCORE_MESSAGES}, GET .../messages/channel/:idx`,
    rule: '`messages:read` or any `channel_N:read` on the source.',
    filter: (viewer, sourceId, payload) => {
      if (viewer.can('messages', 'read', sourceId)) return payload;
      for (let id = 0; id <= DEVICE_CHANNEL_MAX; id++) {
        if (viewer.can(channelResource(id), 'read', sourceId)) return payload;
      }
      return WITHHOLD;
    },
  },
  'meshcore:filters:changed': {
    scope: 'source',
    rest: 'GET /api/sources/:id/meshcore/filters/...',
    rule: '`nodes:read` or `messages:read` on the source.',
    filter: (viewer, sourceId, payload) =>
      viewer.can('nodes', 'read', sourceId) || viewer.can('messages', 'read', sourceId) ? payload : WITHHOLD,
  },
  'meshcore:contact:updated': {
    scope: 'source',
    rest: 'GET /api/sources/:id/meshcore/contacts',
    rule: '`nodes:read` on the source. Position: `nodes:viewOnMap` on the source.',
    // #5363: a live contact update carries the same corrected position as
    // the snapshot/contacts routes. A copy only.
    shape: async (event) => {
      const payload = event.data as { sourceId: string; contact: object };
      try {
        const ctx = await getCachedSignFlipContext(event.sourceId);
        if (ctx && payload?.contact) {
          const contact = applySignFlipCorrection(payload.contact, ctx);
          if (contact !== payload.contact) return { ...payload, contact };
        }
      } catch (err) {
        logger.warn('[WebSocket] Sign-flip contact correction failed:', err);
      }
      return payload;
    },
    filter: (viewer, sourceId, payload: { contact?: { latitude?: number; longitude?: number } }) => {
      if (!viewer.can('nodes', 'read', sourceId)) return WITHHOLD;
      if (!payload?.contact || viewer.can('nodes', 'viewOnMap', sourceId)) return payload;
      return { ...payload, contact: stripPositions([payload.contact])[0] };
    },
  },
  'meshcore:status:updated': needs('connection', 'read', MESHCORE_STATUS),
  'meshcore:local-node:updated': needs('connection', 'read', MESHCORE_STATUS),
  'meshcore:ota-packet': needs('packetmonitor', 'read', 'GET /api/sources/:id/meshcore/packets'),

  'reticulum:message': needs('messages', 'read', RETICULUM_MESSAGES),
  'reticulum:delivery-state:updated': needs('messages', 'read', RETICULUM_MESSAGES),

  'firmware:status': {
    scope: 'global',
    rest: 'GET /api/firmware/status',
    rule: 'Admins only (the firmware routes are behind `requireAdmin`).',
    filter: () => WITHHOLD,
  },

  'auto-ping:update': serverOnly('Progress of an auto-ping session.'),
  'node:discovered': serverOnly('Feeds `trigger.nodeDiscovered`.'),
  'meshcore:node:changed': serverOnly('Feeds `trigger.nodeUpdated`.'),
  'node:mobility': serverOnly('Feeds `trigger.becameMobile`.'),
  'node:rebooted': serverOnly('Feeds `trigger.nodeRebooted`.'),
  'node:powerChanged': serverOnly('Feeds `trigger.nodePowerChanged`.'),
  'node:aircraft': serverOnly('Feeds `trigger.becameLikelyAircraft`.'),
  'meshbeacon:received': serverOnly('Feeds `trigger.meshBeacon`; the payload carries the offered channel PSK.'),
};

/** The gate for an event type, or undefined for a type that has none declared. */
export function gateFor(type: string): SocketEventGate | undefined {
  return Object.prototype.hasOwnProperty.call(SOCKET_EVENT_GATES, type)
    ? SOCKET_EVENT_GATES[type as DataEventType]
    : undefined;
}
