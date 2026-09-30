/**
 * ChannelSettings.use_aead (#5248 Phase 1) survives every channel encoder:
 * set_channel admin messages, channel URLs, and the virtual-node Channel
 * FromRadio. set_channel replaces the whole ChannelSettings on the device, so
 * a dropped flag silently turns AES-CCM off.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';

vi.mock('../services/database.js', () => ({
  default: {},
}));

import protobufService from './protobufService.js';
import meshtasticProtobufService from './meshtasticProtobufService.js';
import channelUrlService from './services/channelUrlService.js';
import { loadProtobufDefinitions, getProtobufRoot } from './protobufLoader.js';

describe('use_aead encoding (#5248)', () => {
  beforeAll(async () => {
    await loadProtobufDefinitions();
  });

  const decodeAdmin = (encoded: Uint8Array) => {
    const AdminMessage = getProtobufRoot()!.lookupType('meshtastic.AdminMessage');
    return AdminMessage.toObject(AdminMessage.decode(encoded), { defaults: true, oneofs: true }) as any;
  };

  it('createSetChannelMessage encodes useAead=true into the set_channel bytes', () => {
    const bytes = protobufService.createSetChannelMessage(2, {
      name: 'Secure', psk: Buffer.alloc(16, 7).toString('base64'), role: 2, useAead: true,
    });
    const msg = decodeAdmin(bytes);
    expect(msg.setChannel.index).toBe(2);
    expect(msg.setChannel.settings.name).toBe('Secure');
    expect(msg.setChannel.settings.useAead).toBe(true);
  });

  it('createSetChannelMessage without useAead reaches the device as false (why callers must fill it)', () => {
    const msg = decodeAdmin(protobufService.createSetChannelMessage(2, { name: 'Secure', role: 2 }));
    expect(msg.setChannel.settings.useAead).toBe(false);
  });

  it('channel URL round-trips useAead per channel', () => {
    const url = channelUrlService.encodeUrl([
      { name: 'Plain', psk: 'default', useAead: false },
      { name: 'Secure', psk: Buffer.alloc(16, 3).toString('base64'), useAead: true },
    ]);
    expect(url).toBeTruthy();
    const decoded = channelUrlService.decodeUrl(url!);
    expect(decoded!.channels.map((c) => [c.name, c.useAead])).toEqual([
      ['Plain', false],
      ['Secure', true],
    ]);
  });

  it('a URL built without use_aead decodes as false (proto3 default)', () => {
    const decoded = channelUrlService.decodeUrl(channelUrlService.encodeUrl([{ name: 'Old', psk: 'default' }])!);
    expect(decoded!.channels[0].useAead).toBe(false);
  });

  it('virtual-node Channel FromRadio carries useAead to clients', async () => {
    const bytes = await meshtasticProtobufService.createChannel({
      index: 1, role: 2, settings: { name: 'Secure', useAead: true },
    });
    const FromRadio = getProtobufRoot()!.lookupType('meshtastic.FromRadio');
    const obj = FromRadio.toObject(FromRadio.decode(bytes!), { defaults: true, oneofs: true }) as any;
    expect(obj.channel.settings.useAead).toBe(true);
  });
});
