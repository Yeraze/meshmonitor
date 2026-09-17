/**
 * createTracerouteMessage hop limit — pinned at the wire.
 *
 * Traceroutes used to go out at a hardcoded hop_limit 7 whatever the node was
 * configured for. The firmware sends a client-built packet at the hop_limit it
 * carries, so that flooded further than anything else the node originates.
 * These tests decode the real ToRadio bytes.
 */
import { describe, it, expect, vi, beforeAll } from 'vitest';

vi.mock('../services/database.js', () => ({ default: {} }));

import meshtasticProtobufService from './meshtasticProtobufService.js';
import { loadProtobufDefinitions, getProtobufRoot } from './protobufLoader.js';
import { DEFAULT_HOP_LIMIT, MAX_HOP_LIMIT } from './constants/meshtastic.js';

function wireHopLimit(data: Uint8Array): number {
  const ToRadio = getProtobufRoot()!.lookupType('meshtastic.ToRadio');
  const decoded = ToRadio.decode(data) as unknown as { packet: { hopLimit?: number } };
  // proto3 omits zero on the wire.
  return decoded.packet.hopLimit ?? 0;
}

describe('createTracerouteMessage hop limit', () => {
  beforeAll(async () => {
    await loadProtobufDefinitions();
  });

  it('sends at the hop limit it is given', () => {
    expect(wireHopLimit(meshtasticProtobufService.createTracerouteMessage(0x1234, 0, 5))).toBe(5);
    expect(wireHopLimit(meshtasticProtobufService.createTracerouteMessage(0x1234, 0, 2))).toBe(2);
  });

  it('falls back to the firmware default, not 7, when no hop limit is passed', () => {
    expect(wireHopLimit(meshtasticProtobufService.createTracerouteMessage(0x1234, 0))).toBe(DEFAULT_HOP_LIMIT);
  });

  it('never exceeds the 3-bit protocol max', () => {
    expect(wireHopLimit(meshtasticProtobufService.createTracerouteMessage(0x1234, 0, 42))).toBe(MAX_HOP_LIMIT);
  });
});
