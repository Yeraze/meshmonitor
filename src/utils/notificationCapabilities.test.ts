import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../services/api', () => ({ default: { get: vi.fn() } }));

import api from '../services/api';
import { notificationCapabilities, loadNotificationChannels } from './notificationCapabilities.js';

describe('notificationCapabilities', () => {
  it('Meshtastic keeps every control', () => {
    const c = notificationCapabilities('meshtastic');
    expect(c).toMatchObject({ dm: true, mqtt: true, traceroute: true, newNode: 'on', waypoint: true, emoji: true, mention: false, batteryUnit: 'percent' });
  });
  it('Companion: no mqtt/waypoint, has dm/trace/newNode/mention', () => {
    const c = notificationCapabilities('meshcore', 1);
    expect(c).toMatchObject({ dm: true, rooms: true, mqtt: false, waypoint: false, traceroute: true, newNode: 'on', mention: true, channels: true, emoji: true, batteryUnit: 'voltage' });
  });
  it('Repeater hides dm/trace/mention and gets new-node with the learning note (#6306)', () => {
    const c = notificationCapabilities('meshcore', 2);
    expect(c).toMatchObject({ dm: false, traceroute: false, newNode: 'on', newNodeNote: 'repeater_learning', mention: false, channels: true, emoji: true });
  });
  it('only the Repeater carries the new-node note (#6306)', () => {
    expect(notificationCapabilities('meshcore', 1).newNodeNote).toBeNull();
    expect(notificationCapabilities('meshtastic').newNodeNote).toBeNull();
  });
  it('MeshCore MQTT ingest: channels, emoji, filters, volts; no DM/mqtt/trace/mention/waypoint/new-node (#6307)', () => {
    const c = notificationCapabilities('meshcore_mqtt');
    expect(c).toMatchObject({
      dm: false, rooms: false, channels: true, emoji: true, mqtt: false, traceroute: false,
      newNode: 'unsupported', waypoint: false, mention: false, batteryUnit: 'voltage',
      messageFilters: true, unsupportedHint: 'ingest', connectionEvents: 'broker',
    });
  });
  it('unsupportedHint and connectionEvents per source type (#6307)', () => {
    expect(notificationCapabilities('meshcore', 2)).toMatchObject({ unsupportedHint: 'repeater', connectionEvents: 'radio' });
    expect(notificationCapabilities('meshcore', 1)).toMatchObject({ unsupportedHint: null, connectionEvents: 'radio' });
    expect(notificationCapabilities('meshtastic_tcp')).toMatchObject({ unsupportedHint: null, connectionEvents: 'radio' });
    expect(notificationCapabilities(undefined).connectionEvents).toBe('radio');
    expect(notificationCapabilities('mqtt_bridge').connectionEvents).toBe('broker');
    expect(notificationCapabilities('mqtt_broker').connectionEvents).toBe('none');
  });
  it('unknown device type behaves as Companion', () => {
    expect(notificationCapabilities('meshcore', undefined).dm).toBe(true);
  });
});

describe('loadNotificationChannels', () => {
  beforeEach(() => vi.mocked(api.get).mockReset());
  it('uses /api/channels for Meshtastic', async () => {
    vi.mocked(api.get).mockResolvedValue([{ id: 0 }]);
    expect(await loadNotificationChannels('s1', 'meshtastic')).toEqual([{ id: 0 }]);
    expect(api.get).toHaveBeenCalledWith('/api/channels?sourceId=s1');
  });
  it('uses /api/channels/all for MeshCore', async () => {
    vi.mocked(api.get).mockResolvedValue([{ id: 9 }]);
    await loadNotificationChannels('s 2', 'meshcore');
    expect(api.get).toHaveBeenCalledWith('/api/channels/all?sourceId=s%202');
  });
  it('uses the ingest channels route for MeshCore MQTT and unwraps the envelope (#6307)', async () => {
    vi.mocked(api.get).mockResolvedValue({ success: true, data: [{ id: 3, name: '' }] });
    expect(await loadNotificationChannels('s 3', 'meshcore_mqtt')).toEqual([{ id: 3, name: '' }]);
    expect(api.get).toHaveBeenCalledWith('/api/sources/s%203/meshcore/ingest/channels');
  });
  it('returns [] for a non-array reply', async () => {
    vi.mocked(api.get).mockResolvedValue({});
    expect(await loadNotificationChannels(null, 'meshtastic')).toEqual([]);
    expect(api.get).toHaveBeenCalledWith('/api/channels');
  });
});
