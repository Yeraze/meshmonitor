import { describe, it, expect } from 'vitest';
import {
  buildMessageContext,
  buildMeshCoreMessageContext,
  buildNodeContext,
  buildTelemetryContext,
  buildSystemContext,
  buildScheduleContext,
  deriveHops,
  messageMatchesFilter,
  meshCoreMessageMatchesFilter,
  describeMessageFilterMiss,
  describeMeshCoreFilterMiss,
  resolveTriggerPath,
  BROADCAST_ADDR,
} from './triggerContext.js';
import type { DbMessage } from '../../../services/database.js';
import type { MeshCoreMessage } from '../../meshcoreManager.js';

function mcMsg(overrides: Partial<MeshCoreMessage> = {}): MeshCoreMessage {
  return {
    id: 'm1',
    fromPublicKey: 'aabbccddeeff',
    text: 'hello',
    timestamp: 1000,
    ...overrides,
  } as MeshCoreMessage;
}

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

describe('deriveHops', () => {
  it('computes hopStart - hopLimit when both present', () => {
    expect(deriveHops({ hopStart: 3, hopLimit: 3 })).toBe(0); // direct
    expect(deriveHops({ hopStart: 3, hopLimit: 1 })).toBe(2);
  });
  it('is undefined when either is missing', () => {
    expect(deriveHops({ hopStart: 3, hopLimit: undefined })).toBeUndefined();
    expect(deriveHops({ hopStart: undefined, hopLimit: 1 })).toBeUndefined();
  });
});

describe('buildMessageContext', () => {
  it('maps §5.1 fields incl. derived hops and DM flags', () => {
    const ctx = buildMessageContext(msg(), 'default', 1234);
    expect(ctx.triggerType).toBe('trigger.message');
    expect(ctx.subjectNodeNum).toBe(111);
    expect(ctx.fields.from).toBe(111);
    expect(ctx.fields.text).toBe('ping');
    expect(ctx.fields.hops).toBe(0);
    expect(ctx.fields.isDM).toBe(true);
    expect(ctx.fields.isBroadcast).toBe(false);
    expect(ctx.fields.snr).toBe(5.5);
    expect(ctx.fields.rssi).toBe(-90);
  });

  it('flags broadcast messages', () => {
    const ctx = buildMessageContext(msg({ toNodeNum: BROADCAST_ADDR }), 'default', 1);
    expect(ctx.fields.isBroadcast).toBe(true);
    expect(ctx.fields.isDM).toBe(false);
  });
});

describe('other trigger contexts', () => {
  it('node context carries changed keys + subject node', () => {
    const ctx = buildNodeContext('trigger.nodeUpdated', 999, ['role', 'longName'], 'default', 5);
    expect(ctx.subjectNodeNum).toBe(999);
    expect(ctx.fields.changed).toEqual(['role', 'longName']);
  });

  it('telemetry context carries the reading', () => {
    const ctx = buildTelemetryContext(7, 'batteryLevel', 18, '%', 'default', 5);
    expect(ctx.triggerType).toBe('trigger.telemetry');
    expect(ctx.fields).toMatchObject({ nodeNum: 7, telemetryType: 'batteryLevel', value: 18 });
  });

  it('system context has no subject node for bootup', () => {
    const ctx = buildSystemContext('bootup', null, null, undefined, 5);
    expect(ctx.subjectNodeNum).toBeNull();
    expect(ctx.fields.event).toBe('bootup');
  });

  it('schedule context carries timestamp, no subject node', () => {
    const ctx = buildScheduleContext(null, 1234);
    expect(ctx.triggerType).toBe('trigger.schedule');
    expect(ctx.subjectNodeNum).toBeNull();
    expect(ctx.fields.timestamp).toBe(1234);
  });
});

describe('messageMatchesFilter', () => {
  it('matches when unconstrained', () => {
    expect(messageMatchesFilter(msg(), {})).toBe(true);
  });
  it('filters by portnum/from/to/channel', () => {
    expect(messageMatchesFilter(msg(), { portnum: 1 })).toBe(true);
    expect(messageMatchesFilter(msg(), { portnum: 3 })).toBe(false);
    expect(messageMatchesFilter(msg(), { from: 111 })).toBe(true);
    expect(messageMatchesFilter(msg(), { from: 999 })).toBe(false);
    expect(messageMatchesFilter(msg(), { channel: 2 })).toBe(false);
  });
  it('matches textContains case-insensitively', () => {
    expect(messageMatchesFilter(msg({ text: 'PING me' }), { textContains: 'ping' })).toBe(true);
    expect(messageMatchesFilter(msg({ text: 'hello' }), { textContains: 'ping' })).toBe(false);
  });
  it('matches regex and treats an invalid regex as no-match', () => {
    expect(messageMatchesFilter(msg({ text: 'ping' }), { regex: '^(test|ping)' })).toBe(true);
    expect(messageMatchesFilter(msg({ text: 'nope' }), { regex: '^(test|ping)' })).toBe(false);
    expect(messageMatchesFilter(msg({ text: 'x' }), { regex: '(' })).toBe(false);
  });
  it('filters by channel name case-insensitively against the resolved name', () => {
    // The resolved name is passed in (3rd arg) — the engine looks up msg.channel→name per source.
    expect(messageMatchesFilter(msg(), { channelName: 'gauntlet' }, 'Gauntlet')).toBe(true);
    expect(messageMatchesFilter(msg(), { channelName: 'gauntlet' }, 'Primary')).toBe(false);
  });
  it('channel-name filter never matches when the name could not be resolved', () => {
    expect(messageMatchesFilter(msg(), { channelName: 'gauntlet' }, null)).toBe(false);
    expect(messageMatchesFilter(msg(), { channelName: 'gauntlet' })).toBe(false);
  });
  it('an empty channelName does not constrain', () => {
    expect(messageMatchesFilter(msg(), { channelName: '' }, null)).toBe(true);
  });
});

describe('buildMeshCoreMessageContext (#3833)', () => {
  it('maps a channel message: synthetic from, channel index, broadcast, scope', () => {
    const ctx = buildMeshCoreMessageContext(
      mcMsg({ fromPublicKey: 'channel-3', fromName: 'Alice', text: 'hi', scopeCode: 7, scopeName: 'paris', hopCount: 2 }),
      'default',
      555,
    );
    expect(ctx.triggerType).toBe('trigger.message');
    expect(ctx.subjectNodeNum).toBeNull();
    expect(ctx.fields.channel).toBe(3);
    expect(ctx.fields.isBroadcast).toBe(true);
    expect(ctx.fields.isDM).toBe(false);
    expect(ctx.fields.fromName).toBe('Alice');
    expect(ctx.fields.protocol).toBe('meshcore');
    expect(ctx.fields.scopeCode).toBe(7);
    expect(ctx.fields.scopeName).toBe('paris');
    expect(ctx.fields.scoped).toBe(true);
    expect(ctx.fields.hops).toBe(2);
  });

  it('maps a DM: recipient pubkey present, no channel, isDM', () => {
    const ctx = buildMeshCoreMessageContext(
      mcMsg({ fromPublicKey: 'aabbcc', toPublicKey: 'localkey', scopeCode: 0 }),
      'default',
      1,
    );
    expect(ctx.fields.channel).toBeUndefined();
    expect(ctx.fields.isDM).toBe(true);
    expect(ctx.fields.isBroadcast).toBe(false);
    expect(ctx.fields.from).toBe('aabbcc');
    // scopeCode 0 = explicitly unscoped → not "scoped"
    expect(ctx.fields.scoped).toBe(false);
  });

  it('a room post is neither DM nor broadcast and has no channel', () => {
    const ctx = buildMeshCoreMessageContext(
      mcMsg({ fromPublicKey: 'authorkey', toPublicKey: 'roomkey', messageType: 'room_post' }),
      'default',
      1,
    );
    expect(ctx.fields.channel).toBeUndefined();
    expect(ctx.fields.isDM).toBe(false);
    expect(ctx.fields.isBroadcast).toBe(false);
  });
});

describe('meshCoreMessageMatchesFilter (#3833)', () => {
  it('matches text/regex/channel for MeshCore messages', () => {
    expect(meshCoreMessageMatchesFilter(mcMsg({ text: 'PING me' }), { textContains: 'ping' })).toBe(true);
    expect(meshCoreMessageMatchesFilter(mcMsg({ text: 'nope' }), { regex: '^(test|ping)' })).toBe(false);
    expect(meshCoreMessageMatchesFilter(mcMsg({ fromPublicKey: 'channel-2' }), { channel: 2 })).toBe(true);
    expect(meshCoreMessageMatchesFilter(mcMsg({ fromPublicKey: 'channel-2' }), { channel: 5 })).toBe(false);
  });
  it('matches channel name case-insensitively against the resolved name', () => {
    expect(meshCoreMessageMatchesFilter(mcMsg({ fromPublicKey: 'channel-1' }), { channelName: 'gauntlet' }, 'Gauntlet')).toBe(true);
    expect(meshCoreMessageMatchesFilter(mcMsg({ fromPublicKey: 'channel-1' }), { channelName: 'gauntlet' }, 'Primary')).toBe(false);
  });
  it('Meshtastic-only params force a non-match (no pubkey↔nodeNum coercion)', () => {
    expect(meshCoreMessageMatchesFilter(mcMsg(), { from: 111 })).toBe(false);
    expect(meshCoreMessageMatchesFilter(mcMsg(), { to: 222 })).toBe(false);
    expect(meshCoreMessageMatchesFilter(mcMsg(), { portnum: 1 })).toBe(false);
  });
});

describe('describeMessageFilterMiss (live-trace reasons)', () => {
  it('returns the first failing constraint as a human reason', () => {
    expect(describeMessageFilterMiss(msg({ text: 'hello' }), { textContains: 'ping' })).toBe('text does not contain "ping"');
    expect(describeMessageFilterMiss(msg(), { from: 999 })).toBe('sender #111 ≠ from #999');
    expect(describeMessageFilterMiss(msg(), { channel: 2 })).toBe('channel 0 ≠ 2');
    expect(describeMessageFilterMiss(msg({ text: 'nope' }), { regex: '^(test|ping)' })).toBe('text does not match /^(test|ping)/');
    expect(describeMessageFilterMiss(msg(), { channelName: 'gauntlet' }, 'Primary')).toBe('channel name "Primary" ≠ "gauntlet"');
  });
  it('returns undefined when the message actually matches', () => {
    expect(describeMessageFilterMiss(msg({ text: 'ping' }), { textContains: 'ping' })).toBeUndefined();
  });
});

describe('describeMeshCoreFilterMiss (live-trace reasons)', () => {
  it('explains Meshtastic-only filters never matching MeshCore', () => {
    expect(describeMeshCoreFilterMiss(mcMsg(), { from: 5 })).toMatch(/Meshtastic-only/);
  });
  it('explains channel and text misses', () => {
    expect(describeMeshCoreFilterMiss(mcMsg({ fromPublicKey: 'channel-2' }), { channel: 5 })).toBe('channel 2 ≠ 5');
    expect(describeMeshCoreFilterMiss(mcMsg({ text: 'hi' }), { textContains: 'ping' })).toBe('text does not contain "ping"');
    expect(describeMeshCoreFilterMiss(mcMsg({ text: 'ping' }), { textContains: 'ping' })).toBeUndefined();
  });
});

describe('resolveTriggerPath', () => {
  const ctx = buildMessageContext(msg(), 'default', 1234);
  it('resolves trigger fields and system vars', () => {
    expect(resolveTriggerPath(ctx, 'trigger.from', 9999)).toBe(111);
    expect(resolveTriggerPath(ctx, 'trigger.sourceId', 9999)).toBe('default');
    expect(resolveTriggerPath(ctx, 'NOW', 9999)).toBe(9999);
    expect(resolveTriggerPath(ctx, 'trigger.missing', 9999)).toBeUndefined();
    expect(resolveTriggerPath(ctx, 'var.x', 9999)).toBeUndefined();
  });
});
