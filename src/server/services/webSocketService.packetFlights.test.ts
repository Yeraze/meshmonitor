/**
 * Live packet traffic (#4835) over the socket, against real permission rows:
 * subscribe / unsubscribe / disconnect, the `packetmonitor:read` gate, and
 * per-source isolation.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createSocketTestApp, type SocketTestHarness, type SocketTestClient } from '../test-helpers/socketTestApp.js';
import { dataEventEmitter, type DataEvent } from './dataEventEmitter.js';
import { hasPacketFlightWatchers, resetPacketFlightWatchers } from './packetFlightWatchers.js';
import type { PacketFlight } from '../../types/packetFlight.js';

type Ack = { ok: boolean; sourceIds: string[]; error?: string };

const subscribe = (client: SocketTestClient, sourceIds: string[]): Promise<Ack> =>
  new Promise((resolve) => client.socket.emit('packet-flights:subscribe', sourceIds, (ack: Ack) => resolve(ack)));

function flight(sourceId: string, marker: number): PacketFlight {
  return { sourceId, protocol: 'meshtastic', receivedAt: Date.now(), from: marker, to: 1, relay: null, hopsUsed: 0, kind: 'TEXT_MESSAGE_APP' };
}

/** Put a flight on the bus whether or not anyone watches (to test the socket gate itself). */
function forceEmit(sourceId: string, marker: number): void {
  const event: DataEvent = { type: 'packet:flight', data: flight(sourceId, marker), timestamp: Date.now(), sourceId };
  dataEventEmitter.emit('data', event);
}

const froms = (client: SocketTestClient): number[] =>
  client.payloads('packet:flight').map((p) => (p as PacketFlight).from as number).sort((a, b) => a - b);

describe('WebSocket packet flights (#4835)', () => {
  let harness: SocketTestHarness;
  let A: string;
  let B: string;

  beforeEach(async () => {
    resetPacketFlightWatchers();
    harness = await createSocketTestApp();
    A = harness.sourceA;
    B = harness.sourceB;
  });

  afterEach(async () => {
    await harness.close();
    resetPacketFlightWatchers();
  });

  it('emits nothing on the bus while nobody watches', () => {
    const seen: DataEvent[] = [];
    const listener = (e: DataEvent) => seen.push(e);
    dataEventEmitter.on('data', listener);
    dataEventEmitter.emitPacketFlight(flight(A, 1));
    dataEventEmitter.off('data', listener);
    expect(seen).toEqual([]);
  });

  it('subscribe starts the emit and delivers; unsubscribe stops both', async () => {
    const admin = await harness.connectAs(harness.admin);
    expect(await subscribe(admin, [A])).toEqual({ ok: true, sourceIds: [A] });
    expect(hasPacketFlightWatchers(A)).toBe(true);
    expect(hasPacketFlightWatchers(B)).toBe(false);

    dataEventEmitter.emitPacketFlight(flight(A, 10));
    dataEventEmitter.emitPacketFlight(flight(B, 20)); // nobody watches B: never emitted
    await admin.settle();
    expect(froms(admin)).toEqual([10]);

    admin.socket.emit('packet-flights:unsubscribe', [A]);
    await admin.settle();
    expect(hasPacketFlightWatchers(A)).toBe(false);
    forceEmit(A, 11);
    await admin.settle();
    expect(froms(admin)).toEqual([10]);
  });

  it('unsubscribe with no list stops every source', async () => {
    const admin = await harness.connectAs(harness.admin);
    await subscribe(admin, [A, B]);
    admin.socket.emit('packet-flights:unsubscribe');
    await admin.settle();
    expect(hasPacketFlightWatchers(A)).toBe(false);
    expect(hasPacketFlightWatchers(B)).toBe(false);
  });

  it('a disconnect drops the socket\'s subscriptions', async () => {
    const admin = await harness.connectAs(harness.admin);
    await subscribe(admin, [A]);
    const other = await harness.connectAs(harness.admin);
    await subscribe(other, [B]);
    admin.close();
    await other.settle();
    expect(hasPacketFlightWatchers(A)).toBe(false);
    expect(hasPacketFlightWatchers(B)).toBe(true);
  });

  it('joining a source is not enough: only a subscribed socket gets flights', async () => {
    await harness.grantEverythingOn(harness.limited.id, A);
    const joinedOnly = await harness.connectAs(harness.limited, { join: 'all' });
    const watcher = await harness.connectAs(harness.limited, { join: 'all' });
    await subscribe(watcher, [A]);
    dataEventEmitter.emitPacketFlight(flight(A, 30));
    await joinedOnly.settle();
    await watcher.settle();
    expect(froms(joinedOnly)).toEqual([]);
    expect(froms(watcher)).toEqual([30]);
  });

  it('needs packetmonitor:read on the source: a socket that cannot read B gets nothing from B', async () => {
    await harness.grantRow(harness.limited.id, 'packetmonitor', { read: true }, A);
    await harness.grantRow(harness.limited.id, 'nodes', { read: true, viewOnMap: true }, B);
    const user = await harness.connectAs(harness.limited);
    // B is refused at subscribe time, so it never starts B's emit.
    expect(await subscribe(user, [A, B])).toEqual({ ok: true, sourceIds: [A] });
    expect(hasPacketFlightWatchers(B)).toBe(false);

    forceEmit(A, 40);
    forceEmit(B, 50);
    await user.settle();
    expect(froms(user)).toEqual([40]);
  });

  it('a grant revoked after subscribing withholds the next flight', async () => {
    await harness.grantRow(harness.limited.id, 'packetmonitor', { read: true }, A);
    const user = await harness.connectAs(harness.limited);
    await subscribe(user, [A]);
    dataEventEmitter.emitPacketFlight(flight(A, 60));
    await user.settle();
    expect(froms(user)).toEqual([60]);

    await harness.revokeAll(harness.limited.id);
    await harness.grantRow(harness.limited.id, 'nodes', { read: true }, A);
    dataEventEmitter.emitPacketFlight(flight(A, 61));
    await user.settle();
    expect(froms(user)).toEqual([60]);
  });

  it('the delivered payload carries no packet content', async () => {
    const admin = await harness.connectAs(harness.admin);
    await subscribe(admin, [A]);
    dataEventEmitter.emitPacketFlight(flight(A, 70));
    await admin.settle();
    const [payload] = admin.payloads('packet:flight') as PacketFlight[];
    expect(Object.keys(payload).sort()).toEqual(['from', 'hopsUsed', 'kind', 'protocol', 'receivedAt', 'relay', 'sourceId', 'to']);
  });
});
