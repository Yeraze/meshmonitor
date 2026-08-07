/**
 * Regression guard for #4593 — MQTT-sourced text messages must raise the same
 * `dataEventEmitter` event every other ingestion path raises after an insert.
 *
 * Before the fix `mqttIngestion.ts` inserted the row fire-and-forget and
 * stopped, so nothing downstream of the event bus ever saw an `mqtt_bridge`
 * message: the Automation Engine (which only wakes on `dataEventEmitter`'s
 * `data` event) never fired, and WebSocket clients got no live update.
 *
 * The companion self-loop guard is covered in mqttIngestion.automationBus.test.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../services/database.js', () => ({
  default: {
    upsertNodeAsync: vi.fn(async () => undefined),
    nodes: {
      getNode: vi.fn(async () => null),
      getNodesByNums: vi.fn(async () => new Map()),
      upsertNode: vi.fn(async () => undefined),
    },
    ignoredNodes: {
      isIgnoredCached: vi.fn(() => false),
      addGeoIgnoreAsync: vi.fn(async () => true),
      liftGeoIgnoreAsync: vi.fn(async () => false),
    },
    messages: {
      getMessage: vi.fn(async () => null),
      insertMessage: vi.fn(async (_msg: any, _sourceId?: string) => true),
    },
    channels: {
      upsertChannel: vi.fn(async () => undefined),
      getChannelById: vi.fn(async () => null),
    },
    channelDatabase: {
      findOrCreateByNameAndHashAsync: vi.fn(async () => undefined),
      findOrCreatePassiveByNameAsync: vi.fn(async () => undefined),
      getEnabledAsync: vi.fn(async () => []),
    },
    settings: {
      getSettingForSource: vi.fn(async () => null),
    },
    sources: {
      getSource: vi.fn(async () => null),
    },
  },
}));

vi.mock('./meshtasticProtobufService.js', () => ({
  default: {
    processPayload: vi.fn((portnum: number, payload: Uint8Array) => {
      if (portnum === 1 /* TEXT_MESSAGE_APP */) {
        return new TextDecoder('utf-8').decode(payload);
      }
      if (portnum === 4 /* NODEINFO_APP */) {
        return { longName: 'Test', shortName: 'TST', hwModel: 1 };
      }
      if (portnum === 65 /* STORE_FORWARD_APP */) {
        return { rr: 9 /* ROUTER_TEXT_BROADCAST */, text: new TextEncoder().encode('replayed') };
      }
      return null;
    }),
    getPortNumName: vi.fn((portnum: number) => `PORT_${portnum}`),
  },
}));

vi.mock('./services/mqttPacketLogService.js', () => ({
  default: { logEnvelope: vi.fn(async () => undefined) },
}));

vi.mock('./services/messagePushNotifier.js', () => ({
  sendMessagePushNotification: vi.fn(async () => undefined),
}));

import { ingestServiceEnvelope, _resetMqttIngestCachesForTest } from './mqttIngestion.js';
import { dataEventEmitter, type DataEvent } from './services/dataEventEmitter.js';
import { sendMessagePushNotification } from './services/messagePushNotifier.js';
import databaseService from '../services/database.js';
import type { ServiceEnvelopeShape } from './mqttPacketFilter.js';

const SOURCE = 'bridge-1';
const SENDER = 0x0a0b0c0d;

function envFor(portnum: number, opts: { to?: number; text?: string; id?: number } = {}): ServiceEnvelopeShape {
  return {
    channelId: 'LongFast',
    gatewayId: '!00000001',
    packet: {
      id: opts.id ?? 0x12345678,
      from: SENDER,
      to: opts.to ?? 0xffffffff,
      channel: 0,
      decoded: {
        portnum,
        payload: new TextEncoder().encode(opts.text ?? 'hello mesh'),
      },
    },
  } as ServiceEnvelopeShape;
}

describe('mqttIngestion → dataEventEmitter (#4593)', () => {
  let events: DataEvent[];
  let listener: (e: DataEvent) => void;

  beforeEach(() => {
    vi.clearAllMocks();
    _resetMqttIngestCachesForTest();
    (databaseService.messages.insertMessage as any).mockResolvedValue(true);
    (databaseService.messages.getMessage as any).mockResolvedValue(null);
    (databaseService.ignoredNodes.isIgnoredCached as any).mockReturnValue(false);
    events = [];
    listener = (e: DataEvent) => events.push(e);
    dataEventEmitter.on('data', listener);
  });

  afterEach(() => {
    dataEventEmitter.off('data', listener);
  });

  it('emits message:new for a broadcast text message ingested from an mqtt_bridge source', async () => {
    const result = await ingestServiceEnvelope({ sourceId: SOURCE, envelope: envFor(1, { text: 'ping' }) });

    expect(result.ingested).toBe(true);
    const msgEvents = events.filter((e) => e.type === 'message:new');
    expect(msgEvents).toHaveLength(1);
    expect(msgEvents[0].sourceId).toBe(SOURCE);
    const emitted = msgEvents[0].data as any;
    expect(emitted.text).toBe('ping');
    expect(emitted.fromNodeNum).toBe(SENDER);
    expect(emitted.channel).toBe(0);
    // The emitted row is the same one that was inserted (row id convention intact).
    expect(emitted.id).toBe((databaseService.messages.insertMessage as any).mock.calls[0][0].id);
  });

  it('emits with channel -1 for a directed (DM) text message', async () => {
    const result = await ingestServiceEnvelope({
      sourceId: SOURCE,
      envelope: envFor(1, { to: 0x99887766, text: 'psst' }),
    });

    expect(result.ingested).toBe(true);
    const emitted = events.find((e) => e.type === 'message:new')?.data as any;
    expect(emitted).toBeDefined();
    expect(emitted.channel).toBe(-1);
    expect(emitted.toNodeNum).toBe(0x99887766);
  });

  it('does NOT emit when the insert was a duplicate (second gateway relaying the same packet)', async () => {
    (databaseService.messages.insertMessage as any).mockResolvedValue(false);

    const result = await ingestServiceEnvelope({ sourceId: SOURCE, envelope: envFor(1, { text: 'ping' }) });

    // The packet was still processed (node lastHeard refresh etc.)…
    expect(result.ingested).toBe(true);
    // …but no row was created, so nothing may re-trigger downstream consumers.
    expect(events.filter((e) => e.type === 'message:new')).toHaveLength(0);
  });

  it('does NOT emit message:new for a non-text portnum', async () => {
    await ingestServiceEnvelope({ sourceId: SOURCE, envelope: envFor(4 /* NODEINFO_APP */) });
    expect(events.filter((e) => e.type === 'message:new')).toHaveLength(0);
  });

  it('emits message:new for a Store & Forward replayed text message', async () => {
    const result = await ingestServiceEnvelope({ sourceId: SOURCE, envelope: envFor(65 /* STORE_FORWARD_APP */) });

    expect(result.ingested).toBe(true);
    const msgEvents = events.filter((e) => e.type === 'message:new');
    expect(msgEvents).toHaveLength(1);
    expect((msgEvents[0].data as any).text).toBe('replayed');
    expect((msgEvents[0].data as any).viaStoreForward).toBe(true);
  });

  // Bug 2 of #4593: message push/Apprise alerts were TCP-only because
  // sendMessagePushNotification was called inline from meshtasticManager and
  // nowhere else. New-NODE alerts were unaffected (they fire from
  // upsertNodeAsync, which mqttIngestion already calls).
  it('raises a message push notification for an ingested MQTT text message', async () => {
    await ingestServiceEnvelope({ sourceId: SOURCE, envelope: envFor(1, { text: 'ping' }) });

    expect(sendMessagePushNotification).toHaveBeenCalledTimes(1);
    const arg = (sendMessagePushNotification as any).mock.calls[0][0];
    expect(arg.sourceId).toBe(SOURCE);
    expect(arg.messageText).toBe('ping');
    expect(arg.isDirectMessage).toBe(false);
  });

  it('flags a directed message as a DM for the push notification', async () => {
    await ingestServiceEnvelope({ sourceId: SOURCE, envelope: envFor(1, { to: 0x99887766, text: 'psst' }) });

    expect((sendMessagePushNotification as any).mock.calls[0][0].isDirectMessage).toBe(true);
  });

  it('does not notify when the insert was a duplicate', async () => {
    (databaseService.messages.insertMessage as any).mockResolvedValue(false);
    await ingestServiceEnvelope({ sourceId: SOURCE, envelope: envFor(1, { text: 'ping' }) });
    expect(sendMessagePushNotification).not.toHaveBeenCalled();
  });

  it('does NOT emit for a Store & Forward replay of a message we already hold', async () => {
    (databaseService.messages.getMessage as any).mockResolvedValue({ id: 'already-here' });

    await ingestServiceEnvelope({ sourceId: SOURCE, envelope: envFor(65 /* STORE_FORWARD_APP */) });

    expect(events.filter((e) => e.type === 'message:new')).toHaveLength(0);
    expect(databaseService.messages.insertMessage).not.toHaveBeenCalled();
  });
});
