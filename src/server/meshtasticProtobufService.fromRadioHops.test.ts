/**
 * createFromRadioTextMessage hop fields: a replayed packet carries the stored
 * hop_start / hop_limit (and via_mqtt), so clients can show how many hops it took.
 */
import { describe, it, expect, vi, beforeAll } from 'vitest';

vi.mock('../services/database.js', () => ({ default: {} }));

import meshtasticProtobufService from './meshtasticProtobufService.js';
import { loadProtobufDefinitions, getProtobufRoot } from './protobufLoader.js';

const base = { id: 'src-1_111_987654', fromNodeNum: 111, toNodeNum: 222, text: 'hi', channel: 0, timestamp: 1700000000000 };

type Packet = { hopStart?: number; hopLimit?: number; viaMqtt?: boolean };

async function packet(over: Record<string, unknown>): Promise<Packet> {
  const bytes = await meshtasticProtobufService.createFromRadioTextMessage({ ...base, ...over });
  const FromRadio = getProtobufRoot()!.lookupType('meshtastic.FromRadio');
  const decoded = FromRadio.toObject(FromRadio.decode(bytes!), { defaults: true }) as { packet: Packet };
  return decoded.packet;
}

describe('createFromRadioTextMessage hop fields', () => {
  beforeAll(async () => {
    await loadProtobufDefinitions();
  });

  it('passes hopStart and the stored hopLimit through', async () => {
    const p = await packet({ hopStart: 7, hopLimit: 4 });
    expect(p.hopStart).toBe(7);
    expect(p.hopLimit).toBe(4);
  });

  it('keeps hopLimit 0 when hopStart is set (all hops used)', async () => {
    const p = await packet({ hopStart: 6, hopLimit: 0 });
    expect(p.hopStart).toBe(6);
    expect(p.hopLimit).toBe(0);
  });

  it('keeps the old hopLimit default when there is no hopStart', async () => {
    const p = await packet({ hopLimit: null, hopStart: null });
    expect(p.hopStart).toBe(0);
    expect(p.hopLimit).toBe(3);
  });

  it('sets viaMqtt only when the message came over MQTT', async () => {
    expect((await packet({ viaMqtt: true })).viaMqtt).toBe(true);
    expect((await packet({ viaMqtt: false })).viaMqtt).toBe(false);
  });
});
