/**
 * #5689: the one preset table and its per-form mapping.
 */
import { describe, it, expect } from 'vitest';
import {
  BROKER_PRESETS,
  BROKER_DISCOVERY_LINKS,
  CUSTOM_PRESET_ID,
  applyPresetToBridge,
  applyPresetToDevice,
  bridgeUrlForPreset,
  findBrokerPreset,
  matchBridgePreset,
  matchDevicePreset,
} from './brokerPresets';

const tcp = findBrokerPreset('meshtastic_public')!;
const tls = findBrokerPreset('meshtastic_public_tls')!;

describe('BROKER_PRESETS', () => {
  it('holds exactly the official broker over TCP and TLS, with its published login', () => {
    expect(BROKER_PRESETS.map((p) => p.id)).toEqual(['meshtastic_public', 'meshtastic_public_tls']);
    expect(tcp).toMatchObject({ host: 'mqtt.meshtastic.org', port: 1883, tls: false, username: 'meshdev', password: 'large4cats' });
    expect(tls).toMatchObject({ host: 'mqtt.meshtastic.org', port: 8883, tls: true, username: 'meshdev', password: 'large4cats' });
  });

  it('never uses the custom id, and every preset has a label key', () => {
    for (const p of BROKER_PRESETS) {
      expect(p.id).not.toBe(CUSTOM_PRESET_ID);
      expect(p.labelKey).toMatch(/^mqtt_presets\./);
    }
    expect(new Set(BROKER_PRESETS.map((p) => p.id)).size).toBe(BROKER_PRESETS.length);
  });

  it('links discovery to the two pages, and nothing else', () => {
    expect(BROKER_DISCOVERY_LINKS).toEqual({
      localGroups: 'https://meshtastic.org/docs/community/local-groups/',
      siteGallery: 'https://meshmonitor.org/site-gallery.html',
    });
  });
});

describe('device forms (address + tlsEnabled)', () => {
  it.each([
    ['', false, 'meshtastic_public'], // firmware: empty address = default public server
    ['', true, 'meshtastic_public_tls'],
    ['mqtt.meshtastic.org', false, 'meshtastic_public'],
    ['MQTT.Meshtastic.org ', false, 'meshtastic_public'],
    ['mqtt.meshtastic.org', true, 'meshtastic_public_tls'],
    ['mqtt.meshtastic.org:1883', false, 'meshtastic_public'],
    ['mqtt.meshtastic.org:8883', true, 'meshtastic_public_tls'],
    ['mqtt.meshtastic.org:1883', true, null], // TLS to the plain port
    ['mqtt.meshtastic.org:8883', false, null],
    ['broker.example.org', false, null],
    ['192.168.1.5', false, null],
  ])('address %j tls=%s matches %s', (address, tlsEnabled, expected) => {
    expect(matchDevicePreset({ address, tlsEnabled })?.id ?? null).toBe(expected);
  });

  it('fills host, TLS and an empty login', () => {
    const { fields, kept } = applyPresetToDevice(tls, { address: 'broker.example.org', username: '', password: '', tlsEnabled: false });
    expect(fields).toEqual({ address: 'mqtt.meshtastic.org', username: 'meshdev', password: 'large4cats', tlsEnabled: true });
    expect(kept).toEqual({ username: false, password: false, storedPassword: false });
  });

  it('keeps an address that already reaches the broker, including the empty default', () => {
    expect(applyPresetToDevice(tcp, { address: '', username: '', password: '', tlsEnabled: false }).fields.address).toBe('');
    expect(applyPresetToDevice(tls, { address: '', username: '', password: '', tlsEnabled: false }).fields.address).toBe('');
    // A port that is wrong for the new mode is replaced.
    expect(applyPresetToDevice(tls, { address: 'mqtt.meshtastic.org:1883', username: '', password: '', tlsEnabled: false }).fields.address).toBe('mqtt.meshtastic.org');
  });

  it('keeps a login the user already has, and says so', () => {
    const { fields, kept } = applyPresetToDevice(tcp, { address: 'x', username: 'me', password: 'secret', tlsEnabled: true });
    expect(fields).toEqual({ address: 'mqtt.meshtastic.org', username: 'me', password: 'secret', tlsEnabled: false });
    expect(kept).toEqual({ username: true, password: true, storedPassword: false });
  });

  it('does not report the preset’s own login as kept', () => {
    const { kept } = applyPresetToDevice(tcp, { address: '', username: 'meshdev', password: 'large4cats', tlsEnabled: false });
    expect(kept).toEqual({ username: false, password: false, storedPassword: false });
  });

  it('returns only the fields a preset owns', () => {
    const { fields } = applyPresetToDevice(tcp, { address: '', username: '', password: '', tlsEnabled: false });
    expect(Object.keys(fields).sort()).toEqual(['address', 'password', 'tlsEnabled', 'username']);
  });
});

describe('bridge form (URL with scheme and port)', () => {
  it('builds the URL from scheme, host and port', () => {
    expect(bridgeUrlForPreset(tcp)).toBe('mqtt://mqtt.meshtastic.org:1883');
    expect(bridgeUrlForPreset(tls)).toBe('mqtts://mqtt.meshtastic.org:8883');
  });

  it.each([
    ['mqtt://mqtt.meshtastic.org:1883', 'meshtastic_public'],
    ['mqtt://mqtt.meshtastic.org', 'meshtastic_public'],
    ['mqtt://mqtt.meshtastic.org/', 'meshtastic_public'],
    ['mqtt://meshdev:large4cats@mqtt.meshtastic.org:1883', 'meshtastic_public'],
    ['mqtts://mqtt.meshtastic.org:8883', 'meshtastic_public_tls'],
    ['mqtts://mqtt.meshtastic.org', 'meshtastic_public_tls'],
    ['mqtts://mqtt.meshtastic.org:1883', null],
    ['mqtt://mqtt.meshtastic.org:8883', null],
    ['ws://mqtt.meshtastic.org', null],
    ['mqtt://upstream.example:1883', null],
    ['', null],
  ])('%j matches %s', (url, expected) => {
    expect(matchBridgePreset(url)?.id ?? null).toBe(expected);
  });

  it('fills URL and an empty login when no password is stored', () => {
    const { fields, kept } = applyPresetToBridge(tls, { url: 'mqtt://upstream.example:1883', username: '', password: '' }, { passwordStored: false });
    expect(fields).toEqual({ url: 'mqtts://mqtt.meshtastic.org:8883', username: 'meshdev', password: 'large4cats' });
    expect(kept).toEqual({ username: false, password: false, storedPassword: false });
  });

  it('leaves the password blank (server keeps it) when one is stored, and says so', () => {
    const { fields, kept } = applyPresetToBridge(tcp, { url: 'mqtt://upstream.example:1883', username: '', password: '' }, { passwordStored: true });
    expect(fields.password).toBe('');
    expect(kept.password).toBe(true);
    expect(kept.storedPassword).toBe(true);
  });

  it('leaves a masked username blank rather than replacing it', () => {
    const { fields, kept } = applyPresetToBridge(tcp, { url: '', username: '', password: '' }, { passwordStored: true, usernameStored: true });
    expect(fields.username).toBe('');
    expect(kept.username).toBe(true);
  });

  it('keeps a typed username and password', () => {
    const { fields, kept } = applyPresetToBridge(tcp, { url: '', username: 'bridge-user', password: 'typed' }, { passwordStored: true });
    expect(fields).toEqual({ url: 'mqtt://mqtt.meshtastic.org:1883', username: 'bridge-user', password: 'typed' });
    expect(kept).toEqual({ username: true, password: true, storedPassword: false });
  });

  it('keeps a URL that already points at the preset', () => {
    const url = 'mqtt://mqtt.meshtastic.org';
    expect(applyPresetToBridge(tcp, { url, username: '', password: '' }, { passwordStored: false }).fields.url).toBe(url);
  });
});
