/**
 * `zeroHop` derived field tests (#4340 Phase 4, WP1, spec §3.1/§7).
 *
 * `zeroHop` exists because a plain `condition.numeric` on `hops` cannot express
 * Auto-Acknowledge's ZeroHop cell: `hops` is `undefined` → NaN for a hopless
 * packet, and `numericCompare` returns false for non-finite operands, so both
 * `== 0` and `> 0` are false. `zeroHop` is computed through Auto-Acknowledge's
 * own `autoAckIsZeroHop()` on Auto-Acknowledge's own floored hop count, so it is
 * TOTAL (never NaN) and faithful to the runtime AutoAck decision.
 */
import { describe, it, expect } from 'vitest';
import { buildMessageContext, buildMeshCoreMessageContext, BROADCAST_ADDR } from './triggerContext.js';
import { autoAckIsZeroHop } from '../../utils/autoAckDecision.js';
import type { DbMessage } from '../../../services/database.js';
import type { MeshCoreMessage } from '../../meshcoreManager.js';

function msg(overrides: Partial<DbMessage> = {}): DbMessage {
  return {
    id: 's_1_2',
    fromNodeNum: 111,
    toNodeNum: 222,
    fromNodeId: '!0000006f',
    toNodeId: '!000000de',
    text: 'ping',
    channel: 0,
    portnum: 1,
    timestamp: 1000,
    hopStart: 3,
    hopLimit: 3,
    rxSnr: 5.5,
    rxRssi: -90,
    createdAt: 1000,
    ...overrides,
  } as DbMessage;
}

function mcMsg(overrides: Partial<MeshCoreMessage> = {}): MeshCoreMessage {
  return {
    id: 'm1',
    fromPublicKey: 'aabbccddeeff',
    text: 'hello',
    timestamp: 1000,
    ...overrides,
  } as MeshCoreMessage;
}

// Mirrors conditionEvaluator.ts's private `asNumber` — not exported, so a small
// local mirror pins the "never NaN after asNumber" guarantee without reaching
// into the module's internals.
function asNumber(v: unknown): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') return Number(v);
  if (typeof v === 'boolean') return v ? 1 : 0;
  return NaN;
}

describe('zeroHop (Meshtastic buildMessageContext)', () => {
  it('is 1 for a 0-hop RF message (hopStart === hopLimit, viaMqtt false)', () => {
    const ctx = buildMessageContext(msg({ hopStart: 3, hopLimit: 3, viaMqtt: false }), 'default', 1);
    expect(ctx.fields.zeroHop).toBe(1);
  });

  it('is 0 when hops > 0', () => {
    const ctx = buildMessageContext(msg({ hopStart: 3, hopLimit: 1, viaMqtt: false }), 'default', 1);
    expect(ctx.fields.hops).toBe(2);
    expect(ctx.fields.zeroHop).toBe(0);
  });

  it('is 0 for a 0-hop message received via MQTT', () => {
    const ctx = buildMessageContext(msg({ hopStart: 3, hopLimit: 3, viaMqtt: true }), 'default', 1);
    expect(ctx.fields.zeroHop).toBe(0);
  });

  it('is 1 for hopStart: null (the hopless case — the whole point of this field)', () => {
    const ctx = buildMessageContext(
      msg({ hopStart: null as unknown as number, hopLimit: null as unknown as number, viaMqtt: false }),
      'default',
      1,
    );
    expect(ctx.fields.hops).toBeUndefined(); // deriveHops stays raw/undefined — untouched
    expect(ctx.fields.zeroHop).toBe(1);
  });

  it('is 1 for a malformed hopStart < hopLimit packet (negative deriveHops)', () => {
    const ctx = buildMessageContext(msg({ hopStart: 1, hopLimit: 3, viaMqtt: false }), 'default', 1);
    expect(ctx.fields.hops).toBe(-2); // deriveHops stays raw — untouched
    expect(ctx.fields.zeroHop).toBe(1);
  });

  it.each([
    { hopStart: 3, hopLimit: 3, viaMqtt: false, flooredHops: 0 },
    { hopStart: 3, hopLimit: 3, viaMqtt: true, flooredHops: 0 },
    { hopStart: 3, hopLimit: 1, viaMqtt: false, flooredHops: 2 },
    { hopStart: 3, hopLimit: 1, viaMqtt: true, flooredHops: 2 },
    { hopStart: null, hopLimit: null, viaMqtt: false, flooredHops: 0 },
    { hopStart: null, hopLimit: null, viaMqtt: true, flooredHops: 0 },
    { hopStart: 1, hopLimit: 3, viaMqtt: false, flooredHops: 0 },
    { hopStart: 0, hopLimit: 0, viaMqtt: false, flooredHops: 0 },
  ])(
    'matches autoAckIsZeroHop(flooredHops, viaMqtt) for hopStart=$hopStart hopLimit=$hopLimit viaMqtt=$viaMqtt',
    ({ hopStart, hopLimit, viaMqtt, flooredHops }) => {
      const ctx = buildMessageContext(
        msg({ hopStart: hopStart as unknown as number, hopLimit: hopLimit as unknown as number, viaMqtt }),
        'default',
        1,
      );
      const expected = autoAckIsZeroHop(flooredHops, viaMqtt) ? 1 : 0;
      expect(ctx.fields.zeroHop).toBe(expected);
    },
  );

  it('is never NaN after asNumber, across every case above', () => {
    const cases: Array<Partial<DbMessage>> = [
      { hopStart: 3, hopLimit: 3, viaMqtt: false },
      { hopStart: 3, hopLimit: 1, viaMqtt: false },
      { hopStart: 3, hopLimit: 3, viaMqtt: true },
      { hopStart: null as unknown as number, hopLimit: null as unknown as number, viaMqtt: false },
      { hopStart: 1, hopLimit: 3, viaMqtt: false },
    ];
    for (const overrides of cases) {
      const ctx = buildMessageContext(msg(overrides), 'default', 1);
      expect(Number.isNaN(asNumber(ctx.fields.zeroHop))).toBe(false);
    }
  });

  it('does not touch hops/deriveHops for a broadcast or DM', () => {
    const dm = buildMessageContext(msg({ toNodeNum: 222, hopStart: 3, hopLimit: 3 }), 'default', 1);
    const bcast = buildMessageContext(msg({ toNodeNum: BROADCAST_ADDR, hopStart: 3, hopLimit: 3 }), 'default', 1);
    expect(dm.fields.zeroHop).toBe(1);
    expect(bcast.fields.zeroHop).toBe(1);
  });
});

describe('zeroHop (MeshCore buildMeshCoreMessageContext)', () => {
  it('is 1 for a 0-hop MeshCore message', () => {
    const ctx = buildMeshCoreMessageContext(mcMsg({ hopCount: 0 } as Partial<MeshCoreMessage>), 'mc-source', 1);
    expect(ctx.fields.zeroHop).toBe(1);
  });

  it('is 0 for hops > 0', () => {
    const ctx = buildMeshCoreMessageContext(mcMsg({ hopCount: 2 } as Partial<MeshCoreMessage>), 'mc-source', 1);
    expect(ctx.fields.zeroHop).toBe(0);
  });

  it('is 1 when hopCount is absent (undefined viaMqtt reads as not-MQTT)', () => {
    const ctx = buildMeshCoreMessageContext(mcMsg(), 'mc-source', 1);
    expect(ctx.fields.hops).toBeUndefined();
    expect(ctx.fields.zeroHop).toBe(1);
  });

  it('is never NaN after asNumber', () => {
    const ctx = buildMeshCoreMessageContext(mcMsg(), 'mc-source', 1);
    expect(Number.isNaN(asNumber(ctx.fields.zeroHop))).toBe(false);
  });
});
