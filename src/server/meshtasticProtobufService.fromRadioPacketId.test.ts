/**
 * createFromRadioTextMessage packet-id extraction (#6164): stored ids are
 * `${sourceId}_${fromNodeNum}_${packetId}`, so the packet id is the LAST segment.
 */
import { describe, it, expect, vi, beforeAll } from 'vitest';

vi.mock('../services/database.js', () => ({ default: {} }));

import meshtasticProtobufService from './meshtasticProtobufService.js';
import { loadProtobufDefinitions, getProtobufRoot } from './protobufLoader.js';

const base = { fromNodeNum: 111, toNodeNum: 222, text: 'hi', channel: 0, timestamp: 1700000000000 };

async function packetId(id: string): Promise<number> {
  const bytes = await meshtasticProtobufService.createFromRadioTextMessage({ ...base, id });
  const FromRadio = getProtobufRoot()!.lookupType('meshtastic.FromRadio');
  return (FromRadio.decode(bytes!) as unknown as { packet: { id: number } }).packet.id;
}

describe('createFromRadioTextMessage packet id (#6164)', () => {
  beforeAll(async () => {
    await loadProtobufDefinitions();
  });

  it('uses the packet id, not the node number, for sourceId_node_packet ids', async () => {
    expect(await packetId('src-1_111_987654')).toBe(987654);
  });

  it('still handles the legacy node_packet format', async () => {
    expect(await packetId('111_987654')).toBe(987654);
  });
});
