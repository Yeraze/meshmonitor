/**
 * The WebSocket gate, against real permission rows.
 *
 * A real socket.io server and client in-process (`createSocketTestApp`): a
 * socket signs in with a real session, and every check below is decided by
 * rows in the `permissions` table, as in production.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { createSocketTestApp, type SocketTestHarness, type SocketTestClient } from '../test-helpers/socketTestApp.js';
import { dataEventEmitter, type DataEvent, type DataEventType } from './dataEventEmitter.js';
import { SOCKET_EVENT_GATES, WITHHOLD, gateFor, meshcoreChannelIdx } from './socketEventGates.js';
import { SOCKET_ACCESS_TTL_MS, loadSocketViewer, peekSocketViewer } from './socketAccess.js';
import { notifyAccessChange } from '../../db/accessChanges.js';
import { automationTraceBus } from './automation/automationTraceBus.js';
import { getSocketIO } from './webSocketService.js';
import { CHANNEL_DB_OFFSET } from '../constants/meshtastic.js';

const NODE_NUM = 0x10203040;
const NODE_ID = '!10203040';

/** A payload for every event type, carrying `marker` somewhere in it. */
const PAYLOADS: Record<DataEventType, (marker: string) => unknown> = {
  'message:new': (marker) => ({
    id: marker, fromNodeNum: NODE_NUM, toNodeNum: 0xffffffff, fromNodeId: NODE_ID, toNodeId: '!ffffffff',
    text: marker, channel: 0, portnum: 1, timestamp: Date.now(), rxTime: Date.now(), createdAt: Date.now(),
  }),
  'node:updated': (marker) => ({ nodeNum: NODE_NUM, node: { longName: marker, latitude: 30.1, longitude: -90.1 } }),
  'node:discovered': (marker) => ({ nodeNum: NODE_NUM, name: marker }),
  'meshcore:node:changed': (marker) => ({ publicKey: 'ab'.repeat(32), name: marker, changed: ['name'] }),
  'node:mobility': (marker) => ({ nodeNum: NODE_NUM, previous: 0, current: 1, marker }),
  'node:rebooted': (marker) => ({ nodeNum: NODE_NUM, previousUptimeSeconds: 9, uptimeSeconds: 1, marker }),
  'node:powerChanged': (marker) => ({ nodeNum: NODE_NUM, previousPowered: false, powered: true, batteryLevel: 101, marker }),
  'node:aircraft': (marker) => ({ nodeNum: NODE_NUM, previous: null, current: true, basis: 'agl', marker }),
  'channel:updated': (marker) => ({ id: 0, name: marker, psk: 'AQ==', role: 1 }),
  'telemetry:batch': (marker) => ({ [NODE_NUM]: [{ nodeId: NODE_ID, nodeNum: NODE_NUM, telemetryType: 'batteryLevel', value: 80, unit: marker }] }),
  'connection:status': (marker) => ({ connected: false, nodeId: marker, reason: `reset ${marker} at 192.0.2.7:4403` }),
  'client-notification': (marker) => ({ level: 30, message: marker }),
  'traceroute:complete': (marker) => ({
    fromNodeNum: NODE_NUM, toNodeNum: 2, fromNodeId: NODE_ID, toNodeId: marker, route: '[]', routeBack: '[]',
    snrTowards: '[]', snrBack: '[]', timestamp: Date.now(), createdAt: Date.now(), channel: 0,
  }),
  'routing:update': (marker) => ({ requestId: 7, status: 'ack', errorReason: marker }),
  'auto-ping:update': (marker) => ({ requestedBy: NODE_NUM, requestedByName: marker, status: 'started', results: [] }),
  'waypoint:upserted': (marker) => ({ waypointId: 5, name: marker, latitude: 30, longitude: -90 }),
  'waypoint:deleted': (marker) => ({ sourceId: marker, waypointId: 5 }),
  'waypoint:expired': (marker) => ({ sourceId: marker, waypointId: 5 }),
  'meshcore:message': (marker) => ({ id: marker, fromPublicKey: 'cd'.repeat(32), toPublicKey: 'channel-1', text: marker, timestamp: Date.now() }),
  'meshcore:messages:deleted': (marker) => ({ ids: [marker] }),
  'meshcore:message:updated': (marker) => ({ id: marker, deliveryStatus: 'delivered' }),
  'meshcore:contact:updated': (marker) => ({ sourceId: marker, contact: { publicKey: 'ef'.repeat(32), advName: marker, latitude: 30.5, longitude: -90.5 } }),
  'meshcore:status:updated': (marker) => ({ sourceId: marker, connected: true, node: { publicKey: 'ef'.repeat(32), name: marker } }),
  'meshcore:local-node:updated': (marker) => ({ sourceId: marker, node: { publicKey: 'ef'.repeat(32), name: marker } }),
  'meshcore:send-confirmed': (marker) => ({ sourceId: marker, ackCode: 1, roundTripMs: 2 }),
  'meshcore:channel-heard': (marker) => ({ sourceId: marker, id: marker, heardBy: [] }),
  'meshcore:channels:reordered': (marker) => ({ sourceId: marker, moves: [{ from: 1, to: 2 }] }),
  'meshcore:filters:changed': (marker) => ({ sourceId: marker }),
  'meshcore:ota-packet': (marker) => ({ timestamp: Date.now(), payloadType: 2, rawHex: marker }),
  'meshbeacon:received': (marker) => ({ nodeNum: NODE_NUM, message: marker, offerChannelPsk: 'c2VjcmV0' }),
  'reticulum:message': (marker) => ({ id: marker, fromHash: 'aa', content: marker }),
  'reticulum:delivery-state:updated': (marker) => ({ sourceId: marker, id: marker, hash: 'aa', state: 'delivered' }),
  'firmware:status': (marker) => ({ state: 'idle', logs: [marker] }),
};

const ALL_TYPES = Object.keys(PAYLOADS) as DataEventType[];
/** Types a viewer who is not an admin can never receive. */
const ADMIN_ONLY: DataEventType[] = [
  'node:discovered', 'meshcore:node:changed', 'node:mobility', 'node:rebooted', 'node:powerChanged',
  'node:aircraft', 'meshbeacon:received', 'auto-ping:update', 'firmware:status',
];

function emit(type: DataEventType, sourceId: string | undefined, marker: string, data: unknown = PAYLOADS[type](marker)): void {
  const event: DataEvent = { type, data, timestamp: Date.now(), sourceId };
  dataEventEmitter.emit('data', event);
}

/** Emit one event of every type for `sourceId` (`firmware:status` has none). */
function emitEveryType(sourceId: string, marker: string): void {
  for (const type of ALL_TYPES) {
    emit(type, SOCKET_EVENT_GATES[type].scope === 'global' ? undefined : sourceId, marker);
  }
}

const has = (client: SocketTestClient, marker: string): boolean => JSON.stringify(client.received).includes(marker);
const typesWith = (client: SocketTestClient, marker: string): string[] =>
  client.received.filter((event) => JSON.stringify(event).includes(marker)).map((event) => event.type).sort();

/** The server's side of a test client: its state and the session store. */
function serverSide(client: SocketTestClient): {
  access: { sessionId: string; verifiedAt: number };
  store: { destroy(id: string, done: () => void): void };
} {
  const socket = getSocketIO()!.sockets.sockets.get(client.socket.id!)!;
  return {
    access: (socket.data as { access: { sessionId: string; verifiedAt: number } }).access,
    store: (socket.request as unknown as { sessionStore: { destroy(id: string, done: () => void): void } }).sessionStore,
  };
}

describe('WebSocket event gates', () => {
  let harness: SocketTestHarness;
  let A: string;
  let B: string;

  beforeEach(async () => {
    harness = await createSocketTestApp();
    A = harness.sourceA;
    B = harness.sourceB;
    for (const sourceId of [A, B]) {
      await harness.db.nodes.upsertNode({ nodeNum: NODE_NUM, nodeId: NODE_ID, longName: 'Node', shortName: 'N', channel: 0 }, sourceId);
    }
  });

  afterEach(async () => {
    await harness.close();
  });

  describe('the gate table', () => {
    it('declares a gate for every event type the emitter can raise', () => {
      // `SOCKET_EVENT_GATES` is `Record<DataEventType, …>`, so a new member of
      // the union does not compile without a gate. This reads the sources as
      // well, for a type raised with a string the union does not know.
      const serverDir = path.resolve(__dirname, '..');
      const raised = new Set<string>();
      const emitterSource = fs.readFileSync(path.join(__dirname, 'dataEventEmitter.ts'), 'utf8');
      for (const match of emitterSource.matchAll(/type: '([a-z-]+(?::[A-Za-z-]+)+)'/g)) raised.add(match[1]);
      const walk = (dir: string): void => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) walk(full);
          else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
            const source = fs.readFileSync(full, 'utf8');
            for (const match of source.matchAll(/\.emit\(\s*'data'\s*,\s*\{\s*type:\s*'([^']+)'/g)) raised.add(match[1]);
          }
        }
      };
      walk(serverDir);

      expect(raised.size).toBeGreaterThan(25);
      const undeclared = [...raised].filter((type) => !gateFor(type));
      expect(undeclared).toEqual([]);
      // And nothing is declared that the test fixtures do not exercise.
      expect(Object.keys(SOCKET_EVENT_GATES).sort()).toEqual([...ALL_TYPES].sort());
      for (const gate of Object.values(SOCKET_EVENT_GATES)) {
        expect(gate.rule.length).toBeGreaterThan(10);
        expect(gate.rest.length).toBeGreaterThan(3);
      }
    });

    it('sends an event with no declared gate to no one, admins included', async () => {
      const admin = await harness.connectAs(harness.admin, { join: 'all' });
      dataEventEmitter.emit('data', { type: 'brand:new-event', data: { text: 'UNDECLARED' }, timestamp: Date.now(), sourceId: A });
      emit('client-notification', A, 'SENTINEL');
      await admin.settle();
      expect(has(admin, 'SENTINEL')).toBe(true);
      expect(has(admin, 'UNDECLARED')).toBe(false);
    });
  });

  describe('per-source isolation, every event type', () => {
    it('a user with every grant on A receives nothing of B, and an admin receives all of both', async () => {
      await harness.grantEverythingOn(harness.limited.id, A);
      const user = await harness.connectAs(harness.limited, { join: 'all' });
      const admin = await harness.connectAs(harness.admin, { join: 'all' });

      emitEveryType(B, 'MARK-B');
      emitEveryType(A, 'MARK-A');
      await user.settle();
      await admin.settle();

      // Admin: every type, both sources, as before.
      expect(typesWith(admin, 'MARK-B')).toEqual([...ALL_TYPES].sort());
      expect(typesWith(admin, 'MARK-A')).toEqual([...ALL_TYPES].sort());

      // The user: nothing of B at all (the settle above would have caught a
      // late one), and of A every type that is not admin only.
      expect(typesWith(user, 'MARK-B')).toEqual([]);
      expect(typesWith(user, 'MARK-A')).toEqual(ALL_TYPES.filter((type) => !ADMIN_ONLY.includes(type)).sort());
    });

    it('joining B does not help: the grant decides, not the subscription', async () => {
      await harness.grantEverythingOn(harness.limited.id, A);
      const user = await harness.connectAs(harness.limited, { join: A });
      expect(await user.join(B)).toEqual({ ok: false, error: 'forbidden' });
      emitEveryType(B, 'MARK-B');
      await user.settle();
      expect(typesWith(user, 'MARK-B')).toEqual([]);
    });

    it('a source event that names no source goes to admins only', async () => {
      await harness.grantEverythingOn(harness.limited.id, A);
      const user = await harness.connectAs(harness.limited, { join: 'all' });
      const admin = await harness.connectAs(harness.admin, { join: A });
      emit('message:new', undefined, 'NO-SOURCE');
      await user.settle();
      await admin.settle();
      expect(has(admin, 'NO-SOURCE')).toBe(true);
      expect(has(user, 'NO-SOURCE')).toBe(false);
    });
  });

  describe('subscription', () => {
    it('a socket that joined nothing receives no source event; an admin one still does', async () => {
      await harness.grantEverythingOn(harness.limited.id, A);
      const user = await harness.connectAs(harness.limited);
      const admin = await harness.connectAs(harness.admin);
      emitEveryType(A, 'MARK-A');
      await user.settle();
      await admin.settle();
      expect(typesWith(user, 'MARK-A')).toEqual([]);
      expect(typesWith(admin, 'MARK-A')).toEqual([...ALL_TYPES].sort());
    });

    it('a socket joined to A gets A and not another source it could read', async () => {
      await harness.grantEverythingOn(harness.limited.id, A);
      await harness.grantEverythingOn(harness.limited.id, B);
      const user = await harness.connectAs(harness.limited, { join: A });
      emit('client-notification', B, 'MARK-B');
      emit('client-notification', A, 'MARK-A');
      await user.settle();
      expect(has(user, 'MARK-A')).toBe(true);
      expect(has(user, 'MARK-B')).toBe(false);

      user.socket.emit('leave-source', A);
      await user.settle();
      emit('client-notification', A, 'AFTER-LEAVE');
      await user.settle();
      expect(has(user, 'AFTER-LEAVE')).toBe(false);
    });

    it('the unified subscription (join-all-sources) delivers every permitted source', async () => {
      await harness.grantRow(harness.limited.id, 'messages', { read: true }, A);
      await harness.grantRow(harness.limited.id, 'messages', { read: true }, B);
      const user = await harness.connectAs(harness.limited, { join: 'all' });
      emit('client-notification', A, 'MARK-A');
      emit('client-notification', B, 'MARK-B');
      await user.settle();
      expect(has(user, 'MARK-A')).toBe(true);
      expect(has(user, 'MARK-B')).toBe(true);

      await harness.revokeAll(harness.limited.id);
      await harness.grantRow(harness.limited.id, 'messages', { read: true }, A);
      emit('client-notification', A, 'LATER-A');
      emit('client-notification', B, 'LATER-B');
      await user.settle();
      expect(has(user, 'LATER-A')).toBe(true);
      expect(has(user, 'LATER-B')).toBe(false);
    });

    it('join-source succeeds on any grant: node grants alone bring node updates and no messages', async () => {
      await harness.grantRow(harness.limited.id, 'channel_0', { viewOnMap: true }, A);
      const user = await harness.connectAs(harness.limited);
      expect(await user.join(A)).toEqual({ ok: true });
      emit('node:updated', A, 'NODE-A');
      emit('message:new', A, 'MSG-A');
      emit('traceroute:complete', A, 'TR-A');
      await user.settle();
      expect(typesWith(user, 'NODE-A')).toEqual(['node:updated']);
      expect(has(user, 'MSG-A')).toBe(false);
      expect(has(user, 'TR-A')).toBe(false);
    });

    it('join-source is refused with no grant on the source, and nothing arrives', async () => {
      const user = await harness.connectAs(harness.limited);
      expect(await user.join(A)).toEqual({ ok: false, error: 'forbidden' });
      expect(user.payloads('join-source:error')).toEqual([{ sourceId: A, error: 'forbidden' }]);
      emitEveryType(A, 'MARK-A');
      await user.settle();
      expect(typesWith(user, 'MARK-A')).toEqual([]);
    });
  });

  describe('messages', () => {
    const message = (marker: string, channel: number) => ({ ...(PAYLOADS['message:new'](marker) as object), channel });

    it('filters channel messages per channel and DMs on messages:read', async () => {
      await harness.grantRow(harness.limited.id, 'channel_0', { read: true }, A);
      await harness.grantRow(harness.limited.id, 'channel_2', { read: true }, A);
      const user = await harness.connectAs(harness.limited, { join: A });
      emit('message:new', A, '', message('CH0', 0));
      emit('message:new', A, '', message('CH1', 1));
      emit('message:new', A, '', message('CH2', 2));
      emit('message:new', A, '', message('DM', -1));
      await user.settle();
      expect(has(user, 'CH0')).toBe(true);
      expect(has(user, 'CH2')).toBe(true);
      expect(has(user, 'CH1')).toBe(false);
      expect(has(user, 'DM')).toBe(false);
    });

    it('channel_N:read without channel_0:read reads no channel message (the poll rule)', async () => {
      await harness.grantRow(harness.limited.id, 'channel_2', { read: true }, A);
      const user = await harness.connectAs(harness.limited, { join: A });
      emit('message:new', A, '', message('CH2', 2));
      await user.settle();
      expect(has(user, 'CH2')).toBe(false);
    });

    it('messages:read alone brings DMs and no channel message', async () => {
      await harness.grantRow(harness.limited.id, 'messages', { read: true }, A);
      const user = await harness.connectAs(harness.limited, { join: A });
      emit('message:new', A, '', message('DM', -1));
      emit('message:new', A, '', message('CH0', 0));
      await user.settle();
      expect(has(user, 'DM')).toBe(true);
      expect(has(user, 'CH0')).toBe(false);
    });

    it('a virtual channel message needs the per-entry canRead grant', async () => {
      const readable = await harness.db.channelDatabase.createAsync({ name: 'readable', psk: 'AQ==', pskLength: 1, isEnabled: true } as never);
      const hidden = await harness.db.channelDatabase.createAsync({ name: 'hidden', psk: 'Ag==', pskLength: 1, isEnabled: true } as never);
      await harness.db.channelDatabase.setPermissionAsync({ userId: harness.limited.id, channelDatabaseId: readable, canViewOnMap: false, canRead: true });
      const user = await harness.connectAs(harness.limited);
      // A virtual-channel grant is global, so the join succeeds with no grant on A.
      expect(await user.join(A)).toEqual({ ok: true });
      emit('message:new', A, '', message('VIRT-OK', CHANNEL_DB_OFFSET + readable));
      emit('message:new', A, '', message('VIRT-NO', CHANNEL_DB_OFFSET + hidden));
      emit('message:new', A, '', message('CH0', 0));
      await user.settle();
      expect(has(user, 'VIRT-OK')).toBe(true);
      expect(has(user, 'VIRT-NO')).toBe(false);
      expect(has(user, 'CH0')).toBe(false);

      await harness.db.channelDatabase.deletePermissionAsync(harness.limited.id, readable);
      emit('message:new', A, '', message('VIRT-REVOKED', CHANNEL_DB_OFFSET + readable));
      await user.settle();
      expect(has(user, 'VIRT-REVOKED')).toBe(false);
    });

    it('routing:update follows "may read some message of the source"', async () => {
      const user = await harness.connectAs(harness.limited, { join: 'all' });
      emit('routing:update', A, 'ACK-1');
      await user.settle();
      expect(has(user, 'ACK-1')).toBe(false);
      await harness.grantRow(harness.limited.id, 'channel_0', { read: true }, A);
      emit('routing:update', A, 'ACK-2');
      emit('routing:update', B, 'ACK-B');
      await user.settle();
      expect(has(user, 'ACK-2')).toBe(true);
      expect(has(user, 'ACK-B')).toBe(false);
    });
  });

  describe('nodes', () => {
    it('gates a node update on viewOnMap for the channel the node was last heard on', async () => {
      await harness.db.nodes.upsertNode({ nodeNum: 77, nodeId: '!0000004d', channel: 3 }, A);
      await harness.grantRow(harness.limited.id, 'channel_0', { viewOnMap: true }, A);
      const user = await harness.connectAs(harness.limited, { join: A });
      emit('node:updated', A, '', { nodeNum: NODE_NUM, node: { longName: 'ON-CH0' } });
      emit('node:updated', A, '', { nodeNum: 77, node: { longName: 'ON-CH3' } });
      emit('node:updated', A, '', { nodeNum: 4242, node: { longName: 'NO-ROW' } });
      await user.settle();
      expect(has(user, 'ON-CH0')).toBe(true);
      expect(has(user, 'ON-CH3')).toBe(false);
      expect(has(user, 'NO-ROW')).toBe(false);
    });

    it('channel read without viewOnMap brings no node update', async () => {
      await harness.grantRow(harness.limited.id, 'channel_0', { read: true }, A);
      const user = await harness.connectAs(harness.limited, { join: A });
      emit('node:updated', A, 'NODE-A');
      await user.settle();
      expect(has(user, 'NODE-A')).toBe(false);
    });

    it('removes a private position override without nodes_private:read on that source', async () => {
      await harness.db.nodes.upsertNode({
        nodeNum: NODE_NUM, nodeId: NODE_ID, channel: 0,
        positionOverrideEnabled: true, positionOverrideIsPrivate: true, latitudeOverride: 11.5, longitudeOverride: 22.5,
      }, A);
      await harness.grantRow(harness.limited.id, 'channel_0', { viewOnMap: true }, A);
      // A grant on ANOTHER source must not unlock it.
      await harness.grantRow(harness.limited.id, 'nodes_private', { read: true }, B);
      const user = await harness.connectAs(harness.limited, { join: A });
      const admin = await harness.connectAs(harness.admin, { join: A });
      const update = { nodeNum: NODE_NUM, node: { longName: 'PRIVATE', latitudeOverride: 11.5, longitudeOverride: 22.5, altitudeOverride: 3 } };
      emit('node:updated', A, '', update);
      await user.settle();
      await admin.settle();
      expect(admin.payloads('node:updated')).toEqual([update]);
      expect(user.payloads('node:updated')).toEqual([{ nodeNum: NODE_NUM, node: { longName: 'PRIVATE' } }]);

      await harness.grantRow(harness.limited.id, 'nodes_private', { read: true }, A);
      emit('node:updated', A, '', update);
      await user.settle();
      expect(user.payloads('node:updated')[1]).toEqual(update);
    });

    it('telemetry:batch keeps only the nodes the viewer may see, and needs info or dashboard read', async () => {
      await harness.db.nodes.upsertNode({ nodeNum: 77, nodeId: '!0000004d', channel: 3 }, A);
      await harness.grantRow(harness.limited.id, 'channel_0', { viewOnMap: true }, A);
      const user = await harness.connectAs(harness.limited, { join: A });
      const batch = { [NODE_NUM]: [{ unit: 'SEEN' }], 77: [{ unit: 'HIDDEN' }] };
      emit('telemetry:batch', A, '', batch);
      await user.settle();
      expect(user.payloads('telemetry:batch')).toEqual([]);

      await harness.grantRow(harness.limited.id, 'info', { read: true });
      emit('telemetry:batch', A, '', batch);
      await user.settle();
      expect(user.payloads('telemetry:batch')).toEqual([{ [NODE_NUM]: [{ unit: 'SEEN' }] }]);
    });
  });

  describe('traceroutes', () => {
    it('needs traceroute:read on the source and viewOnMap on the row channel', async () => {
      await harness.grantRow(harness.limited.id, 'traceroute', { read: true }, A);
      await harness.grantRow(harness.limited.id, 'channel_0', { viewOnMap: true }, A);
      const user = await harness.connectAs(harness.limited, { join: 'all' });
      const row = (marker: string, channel: number | null) => ({ ...(PAYLOADS['traceroute:complete'](marker) as object), channel });
      emit('traceroute:complete', A, '', row('TR-CH0', 0));
      emit('traceroute:complete', A, '', row('TR-CH4', 4));
      emit('traceroute:complete', A, '', row('TR-NOCH', null));
      emit('traceroute:complete', B, '', row('TR-B', 0));
      await user.settle();
      expect(typesWith(user, 'TR-CH0')).toEqual(['traceroute:complete']);
      expect(has(user, 'TR-NOCH')).toBe(true);
      expect(has(user, 'TR-CH4')).toBe(false);
      expect(has(user, 'TR-B')).toBe(false);
    });
  });

  describe('connection status and channels', () => {
    it('sends the link state to any grant holder, and the reason only with sources:read', async () => {
      await harness.grantRow(harness.limited.id, 'nodes', { read: true }, A);
      const user = await harness.connectAs(harness.limited, { join: 'all' });
      emit('connection:status', A, 'LINK-A');
      emit('connection:status', B, 'LINK-B');
      await user.settle();
      expect(user.payloads('connection:status')).toEqual([{ connected: false, nodeId: 'LINK-A' }]);

      await harness.grantRow(harness.limited.id, 'sources', { read: true });
      emit('connection:status', A, 'LINK-2');
      await user.settle();
      expect(user.payloads('connection:status')[1]).toEqual({ connected: false, nodeId: 'LINK-2', reason: 'reset LINK-2 at 192.0.2.7:4403' });
    });

    it('channel:updated carries the PSK only with channel write', async () => {
      await harness.grantRow(harness.limited.id, 'channel_0', { read: true }, A);
      await harness.grantRow(harness.limited.id, 'channel_1', { read: true, write: true }, A);
      const user = await harness.connectAs(harness.limited, { join: A });
      emit('channel:updated', A, '', { id: 0, name: 'zero', psk: 'c2VjcmV0MA==', role: 1 });
      emit('channel:updated', A, '', { id: 1, name: 'one', psk: 'c2VjcmV0MQ==', role: 2 });
      emit('channel:updated', A, '', { id: 2, name: 'two', psk: 'c2VjcmV0Mg==', role: 2 });
      await user.settle();
      const seen = user.payloads('channel:updated') as Array<{ id: number; psk?: string }>;
      expect(seen.map((channel) => channel.id)).toEqual([0, 1]);
      expect(JSON.stringify(seen[0])).not.toContain('c2VjcmV0MA==');
      expect(seen[1].psk).toBe('c2VjcmV0MQ==');
      expect(has(user, 'c2VjcmV0Mg==')).toBe(false);
    });
  });

  describe('MeshCore', () => {
    it('a channel message needs messages:read or that channel; a DM needs messages:read', async () => {
      await harness.grantRow(harness.limited.id, 'channel_1', { read: true }, A);
      const user = await harness.connectAs(harness.limited, { join: A });
      const text = (marker: string, toPublicKey: string) => ({ id: marker, fromPublicKey: 'cd'.repeat(32), toPublicKey, text: marker, timestamp: 1 });
      emit('meshcore:message', A, '', text('MC-CH1', 'channel-1'));
      emit('meshcore:message', A, '', text('MC-CH2', 'channel-2'));
      emit('meshcore:message', A, '', text('MC-DM', 'ee'.repeat(32)));
      emit('meshcore:messages:deleted', A, '', { channelIdx: 1, note: 'DEL-CH1' });
      emit('meshcore:messages:deleted', A, '', { channelIdx: 2, note: 'DEL-CH2' });
      await user.settle();
      expect(has(user, 'MC-CH1')).toBe(true);
      expect(has(user, 'MC-CH2')).toBe(false);
      expect(has(user, 'MC-DM')).toBe(false);
      expect(has(user, 'DEL-CH1')).toBe(true);
      expect(has(user, 'DEL-CH2')).toBe(false);
    });

    it('a repeater-decrypted message also needs access to its key', async () => {
      await harness.grantRow(harness.limited.id, 'messages', { read: true }, A);
      const user = await harness.connectAs(harness.limited, { join: A });
      const admin = await harness.connectAs(harness.admin, { join: A });
      emit('meshcore:message', A, '', { id: 'KEYED', fromPublicKey: 'channel-9', text: 'KEYED', timestamp: 1, keyFingerprint: 'feedface' });
      emit('meshcore:message', A, '', { id: 'PLAIN', fromPublicKey: 'channel-9', text: 'PLAIN', timestamp: 1 });
      await user.settle();
      await admin.settle();
      expect(has(admin, 'KEYED')).toBe(true);
      expect(has(user, 'PLAIN')).toBe(true);
      expect(has(user, 'KEYED')).toBe(false);
    });

    it('a contact update needs nodes:read, and its position nodes:viewOnMap', async () => {
      await harness.grantRow(harness.limited.id, 'nodes', { read: true }, A);
      const user = await harness.connectAs(harness.limited, { join: 'all' });
      emit('meshcore:contact:updated', A, 'CONTACT-A');
      emit('meshcore:contact:updated', B, 'CONTACT-B');
      await user.settle();
      expect(user.payloads('meshcore:contact:updated')).toEqual([
        { sourceId: 'CONTACT-A', contact: { publicKey: 'ef'.repeat(32), advName: 'CONTACT-A' } },
      ]);
    });

    it('parses the channel slot from either end of a message', () => {
      expect(meshcoreChannelIdx({ fromPublicKey: 'aa', toPublicKey: 'channel-3' })).toBe(3);
      expect(meshcoreChannelIdx({ fromPublicKey: 'channel-12' })).toBe(12);
      expect(meshcoreChannelIdx({ fromPublicKey: 'aa', toPublicKey: 'bb' })).toBeNull();
      expect(meshcoreChannelIdx({ fromPublicKey: 'xchannel-1' })).toBeNull();
    });
  });

  describe('events with no source', () => {
    it('firmware:status reaches admins only, whatever the user holds or joined', async () => {
      await harness.grantEverythingOn(harness.limited.id, A);
      await harness.grantEverythingOn(harness.limited.id, B);
      const user = await harness.connectAs(harness.limited, { join: 'all' });
      const idleAdmin = await harness.connectAs(harness.admin);
      emit('firmware:status', undefined, '', { state: 'flashing', logs: ['FW-MARK'] });
      await user.settle();
      await idleAdmin.settle();
      expect(has(idleAdmin, 'FW-MARK')).toBe(true);
      expect(has(user, 'FW-MARK')).toBe(false);
      expect(SOCKET_EVENT_GATES['firmware:status'].filter(null as never, '', {}, undefined, null as never)).toBe(WITHHOLD);
    });
  });

  describe('changes take effect without a reconnect', () => {
    it('a revoked grant stops events at once; a new grant starts them', async () => {
      await harness.grantRow(harness.limited.id, 'messages', { read: true }, A);
      const user = await harness.connectAs(harness.limited, { join: A });
      emit('client-notification', A, 'BEFORE');
      await user.settle();
      expect(has(user, 'BEFORE')).toBe(true);

      await harness.revokeAll(harness.limited.id);
      emit('client-notification', A, 'REVOKED');
      await user.settle();
      expect(has(user, 'REVOKED')).toBe(false);
      expect(user.socket.connected).toBe(true);

      await harness.grantRow(harness.limited.id, 'messages', { read: true }, A);
      emit('client-notification', A, 'REGRANTED');
      await user.settle();
      expect(has(user, 'REGRANTED')).toBe(true);
    });

    it('an admin who loses the flag is held to their grants from the next event', async () => {
      const admin = await harness.connectAs(harness.admin, { join: 'all' });
      emit('message:new', B, 'AS-ADMIN');
      await admin.settle();
      expect(has(admin, 'AS-ADMIN')).toBe(true);

      await harness.db.auth.updateUser(harness.admin.id, { isAdmin: false });
      emit('message:new', B, 'DEMOTED');
      emit('firmware:status', undefined, '', { logs: ['DEMOTED-FW'] });
      await admin.settle();
      expect(has(admin, 'DEMOTED')).toBe(false);
      expect(has(admin, 'DEMOTED-FW')).toBe(false);
      expect(admin.socket.connected).toBe(true);
    });

    it('a deactivated user is disconnected and cannot connect again', async () => {
      await harness.grantEverythingOn(harness.limited.id, A);
      const user = await harness.connectAs(harness.limited, { join: A });
      const closed = user.disconnected();
      await harness.db.auth.updateUser(harness.limited.id, { isActive: false });
      expect(await closed).toBe('io server disconnect');
      expect(user.payloads('access-revoked')).toHaveLength(1);
      emit('client-notification', A, 'AFTER-DEACTIVATION');
      await user.settle();
      expect(has(user, 'AFTER-DEACTIVATION')).toBe(false);
      await expect(harness.connectAs(harness.limited)).rejects.toThrow('Authentication required');
    });

    it('a deleted user is disconnected', async () => {
      const user = await harness.connectAs(harness.limited, { join: 'all' });
      const closed = user.disconnected();
      await harness.db.auth.deleteUser(harness.limited.id);
      expect(await closed).toBe('io server disconnect');
    });

    it('logging out closes the sockets of that session only', async () => {
      await harness.grantEverythingOn(harness.limited.id, A);
      const first = await harness.connectAs(harness.limited, { join: A });
      const second = await harness.connectAs(harness.limited, { join: A });
      // What the logout route reports: the id of the session it destroyed.
      const closed = first.disconnected();
      notifyAccessChange({ kind: 'session', sessionId: serverSide(first).access.sessionId });
      expect(await closed).toBe('io server disconnect');
      expect(second.socket.connected).toBe(true);
    });

    it('a socket whose session is gone from the store is closed at its next re-check', async () => {
      await harness.grantEverythingOn(harness.limited.id, A);
      const user = await harness.connectAs(harness.limited, { join: A });
      const { access, store } = serverSide(user);
      await new Promise<void>((resolve) => store.destroy(access.sessionId, resolve));
      // Past the TTL: the next event re-checks the session before sending.
      access.verifiedAt = Date.now() - SOCKET_ACCESS_TTL_MS - 1;
      const closed = user.disconnected();
      emit('client-notification', A, 'EXPIRED');
      expect(await closed).toBe('io server disconnect');
      expect(has(user, 'EXPIRED')).toBe(false);
    });

    it('a revoked API token closes the socket that signed in with it', async () => {
      await harness.grantRow(harness.limited.id, 'messages', { read: true }, A);
      const token = await harness.tokenFor(harness.limited);
      const user = await harness.connectAs(harness.limited, { token, join: A });
      emit('client-notification', A, 'TOKEN-OK');
      await user.settle();
      expect(has(user, 'TOKEN-OK')).toBe(true);
      const closed = user.disconnected(5000);
      await harness.db.auth.revokeAllUserApiTokens(harness.limited.id, harness.limited.id);
      expect(await closed).toBe('io server disconnect');
    }, 15000);

    it('holds nothing past the TTL, and drops it on a change', async () => {
      const viewer = await loadSocketViewer(harness.limited.id);
      expect(viewer?.isAdmin).toBe(false);
      const now = Date.now();
      expect(peekSocketViewer(harness.limited.id, now)).toBe(viewer);
      expect(peekSocketViewer(harness.limited.id, now + SOCKET_ACCESS_TTL_MS + 5)).toBeUndefined();
      expect(SOCKET_ACCESS_TTL_MS).toBeLessThanOrEqual(30_000);
      notifyAccessChange({ kind: 'all' });
      expect(peekSocketViewer(harness.limited.id, now)).toBeUndefined();
    });

    it('removing a source drops every held grant', async () => {
      await harness.grantRow(harness.limited.id, 'messages', { read: true }, A);
      const user = await harness.connectAs(harness.limited, { join: A });
      emit('client-notification', A, 'WARM');
      await user.settle();
      expect(peekSocketViewer(harness.limited.id)).toBeDefined();
      await harness.db.sources.deleteSource(B);
      expect(peekSocketViewer(harness.limited.id)).toBeUndefined();
    });
  });

  describe('signing in', () => {
    it('refuses a socket with no session and no token', async () => {
      await expect(harness.connectAs(null)).rejects.toThrow('Authentication required');
    });

    it('refuses a bad token', async () => {
      await expect(harness.connectAs(null, { token: 'mm_v1_not-a-real-token-000000000000' })).rejects.toThrow('Authentication required');
    });

    it('a token socket is held to its user\'s grants', async () => {
      await harness.grantRow(harness.limited.id, 'messages', { read: true }, A);
      const user = await harness.connectAs(harness.limited, { token: await harness.tokenFor(harness.limited), join: 'all' });
      emit('client-notification', A, 'MARK-A');
      emit('client-notification', B, 'MARK-B');
      await user.settle();
      expect(has(user, 'MARK-A')).toBe(true);
      expect(has(user, 'MARK-B')).toBe(false);
    }, 15000);
  });

  describe('automation trace', () => {
    it('stops when automations:read is revoked', async () => {
      await harness.grantRow(harness.limited.id, 'automations', { read: true });
      const user = await harness.connectAs(harness.limited);
      user.socket.emit('automation-trace:start', { automationId: 'rule-1' });
      await user.settle();
      expect(user.payloads('automation-trace:started')).toHaveLength(1);
      automationTraceBus.emit('rule-1', { step: 'TRACE-1' } as never);
      await user.settle();
      expect(has(user, 'TRACE-1')).toBe(true);

      await harness.revokeAll(harness.limited.id);
      automationTraceBus.emit('rule-1', { step: 'TRACE-2' } as never);
      await user.settle();
      expect(has(user, 'TRACE-2')).toBe(false);
    });

    it('is refused without automations:read', async () => {
      const user = await harness.connectAs(harness.limited);
      user.socket.emit('automation-trace:start', { automationId: 'rule-1' });
      await user.settle();
      expect(user.payloads('automation-trace:error')).toEqual([{ automationId: 'rule-1', error: 'forbidden' }]);
    });
  });
});
