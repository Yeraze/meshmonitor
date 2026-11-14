/**
 * A position request is a pure request: an empty Position with wantResponse.
 * A request carrying our coordinates can be dropped silently by Traffic
 * Management position dedup on a relay, while an empty one is answered (#6047).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import meshtasticProtobufService from './meshtasticProtobufService.js';
import { loadProtobufDefinitions, getProtobufRoot } from './protobufLoader.js';
import { PortNum } from './constants/meshtastic.js';

describe('createPositionRequestMessage (#6047)', () => {
  beforeAll(async () => {
    await loadProtobufDefinitions();
  });

  it('sends an empty Position payload with wantResponse set', () => {
    const { data } = meshtasticProtobufService.createPositionRequestMessage(0x435adc2c, 0, 3);
    const root = getProtobufRoot()!;
    const decoded = (root.lookupType('meshtastic.ToRadio').decode(data) as any).packet.decoded;
    expect(decoded.portnum).toBe(PortNum.POSITION_APP);
    expect(decoded.wantResponse).toBe(true);
    expect(decoded.payload.length).toBe(0);
  });
});
