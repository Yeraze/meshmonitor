import { describe, it, expect } from 'vitest';
import { sourceProtocol, isConfiguredChannel, unifyChannels } from './channelUnify.js';

describe('sourceProtocol', () => {
  it('maps source types to coarse protocols', () => {
    expect(sourceProtocol('meshtastic_tcp')).toBe('meshtastic');
    expect(sourceProtocol('meshtastic_serial')).toBe('meshtastic');
    expect(sourceProtocol('meshcore')).toBe('meshcore');
    expect(sourceProtocol('mqtt_broker')).toBe('other');
    expect(sourceProtocol(undefined)).toBe('other');
  });
});

describe('isConfiguredChannel', () => {
  it('excludes the Meshtastic Disabled role (0), keeps others incl. null', () => {
    expect(isConfiguredChannel({ role: 0 })).toBe(false);
    expect(isConfiguredChannel({ role: 1 })).toBe(true);
    expect(isConfiguredChannel({ role: 2 })).toBe(true);
    expect(isConfiguredChannel({ role: null })).toBe(true); // MeshCore channels carry null role
  });
});

describe('unifyChannels', () => {
  // Two Meshtastic radios + two MeshCore radios, mirroring the real data.
  const perSource = [
    { sourceId: 'mt1', sourceName: 'Sandbox', protocol: 'meshtastic' as const, channels: [
      { id: 0, name: '', psk: 'AQ==', role: 1 },              // primary
      { id: 2, name: 'gauntlet', psk: 'MT-KEY', role: 2 },
      { id: 3, name: 'Channel 3', psk: '', role: 0 },          // disabled placeholder
    ] },
    { sourceId: 'mt2', sourceName: 'BLESandbox', protocol: 'meshtastic' as const, channels: [
      { id: 0, name: '', psk: 'AQ==', role: 1 },
      { id: 5, name: 'gauntlet', psk: 'MT-KEY', role: 2 },
    ] },
    { sourceId: 'mc1', sourceName: 'MC-Sandbox', protocol: 'meshcore' as const, channels: [
      { id: 1, name: 'gauntlet', psk: 'MC-KEY', role: null },
    ] },
    { sourceId: 'mc2', sourceName: 'MC-BLESandbox', protocol: 'meshcore' as const, channels: [
      { id: 1, name: 'gauntlet', psk: 'MC-KEY', role: null },
    ] },
  ];

  it('excludes disabled slots', () => {
    const names = unifyChannels(perSource).map((u) => u.name);
    expect(names).not.toContain('Channel 3');
  });

  it('keeps MeshCore and Meshtastic channels of the same name SEPARATE, tagged by protocol', () => {
    const gauntlets = unifyChannels(perSource).filter((u) => u.name.toLowerCase() === 'gauntlet');
    expect(gauntlets).toHaveLength(2);
    const mt = gauntlets.find((g) => g.protocol === 'meshtastic')!;
    const mc = gauntlets.find((g) => g.protocol === 'meshcore')!;
    expect(mt.sources.map((s) => s.sourceId)).toEqual(['mt1', 'mt2']);   // both MT radios, local slots 2 & 5
    expect(mt.sources.map((s) => s.slot)).toEqual([2, 5]);
    expect(mc.sources.map((s) => s.sourceId)).toEqual(['mc1', 'mc2']);
  });

  it('combines same-name channels across sources of the same protocol', () => {
    const primary = unifyChannels(perSource).find((u) => u.protocol === 'meshtastic' && u.name === '')!;
    expect(primary.sources).toHaveLength(2);
  });

  it('does not expose the raw psk', () => {
    const json = JSON.stringify(unifyChannels(perSource));
    expect(json).not.toContain('MT-KEY');
    expect(json).not.toContain('MC-KEY');
  });
});
