import { describe, it, expect, vi, beforeEach } from 'vitest';
import { migrateAutomationChannels } from './automationChannelMigration.js';

describe('migrateAutomationChannels', () => {
  let settingsStore: Record<string, string>;
  let getSetting: (key: string) => Promise<string | null>;
  let setSetting: (key: string, value: string) => Promise<void>;

  beforeEach(() => {
    settingsStore = {};
    getSetting = vi.fn(async (key: string) => settingsStore[key] ?? null);
    setSetting = vi.fn(async (key: string, value: string) => { settingsStore[key] = value; });
  });

  it('does nothing when no moves', async () => {
    await migrateAutomationChannels([], getSetting, setSetting);
    expect(getSetting).not.toHaveBeenCalled();
    expect(setSetting).not.toHaveBeenCalled();
  });

  describe('auto-responder triggers', () => {
    it('remaps channels array', async () => {
      settingsStore['autoResponderTriggers'] = JSON.stringify([
        { id: '1', trigger: 'hello', responseType: 'text', response: 'hi', channels: [2, 'dm'] },
      ]);

      await migrateAutomationChannels([{ from: 2, to: 3 }], getSetting, setSetting);

      const result = JSON.parse(settingsStore['autoResponderTriggers']);
      expect(result[0].channels).toEqual([3, 'dm']);
    });

    it('remaps deprecated channel field', async () => {
      settingsStore['autoResponderTriggers'] = JSON.stringify([
        { id: '1', trigger: 'hello', responseType: 'text', response: 'hi', channel: 2 },
      ]);

      await migrateAutomationChannels([{ from: 2, to: 3 }], getSetting, setSetting);

      const result = JSON.parse(settingsStore['autoResponderTriggers']);
      expect(result[0].channel).toBe(3);
    });

    it('handles swap correctly (2→3 and 3→2)', async () => {
      settingsStore['autoResponderTriggers'] = JSON.stringify([
        { id: '1', trigger: 'a', responseType: 'text', response: 'x', channels: [2] },
        { id: '2', trigger: 'b', responseType: 'text', response: 'y', channels: [3] },
      ]);

      await migrateAutomationChannels(
        [{ from: 2, to: 3 }, { from: 3, to: 2 }],
        getSetting, setSetting
      );

      const result = JSON.parse(settingsStore['autoResponderTriggers']);
      expect(result[0].channels).toEqual([3]);
      expect(result[1].channels).toEqual([2]);
    });

    it('leaves unaffected channels alone', async () => {
      settingsStore['autoResponderTriggers'] = JSON.stringify([
        { id: '1', trigger: 'hello', responseType: 'text', response: 'hi', channels: [0, 'dm', 'none'] },
      ]);

      await migrateAutomationChannels([{ from: 2, to: 3 }], getSetting, setSetting);

      // setSetting should not have been called for autoResponderTriggers since nothing changed
      const calls = (setSetting as any).mock.calls.filter((c: any) => c[0] === 'autoResponderTriggers');
      expect(calls.length).toBe(0);
    });

    it('skips when no setting exists', async () => {
      await migrateAutomationChannels([{ from: 2, to: 3 }], getSetting, setSetting);
      const calls = (setSetting as any).mock.calls.filter((c: any) => c[0] === 'autoResponderTriggers');
      expect(calls.length).toBe(0);
    });
  });

  describe('timer triggers', () => {
    it('remaps channel index', async () => {
      settingsStore['timerTriggers'] = JSON.stringify([
        { id: 't1', name: 'test', cronExpression: '0 * * * *', channel: 2, enabled: true },
      ]);

      await migrateAutomationChannels([{ from: 2, to: 5 }], getSetting, setSetting);

      const result = JSON.parse(settingsStore['timerTriggers']);
      expect(result[0].channel).toBe(5);
    });

    it('leaves "none" channel unchanged', async () => {
      settingsStore['timerTriggers'] = JSON.stringify([
        { id: 't1', name: 'test', cronExpression: '0 * * * *', channel: 'none', enabled: true },
      ]);

      await migrateAutomationChannels([{ from: 2, to: 3 }], getSetting, setSetting);

      const calls = (setSetting as any).mock.calls.filter((c: any) => c[0] === 'timerTriggers');
      expect(calls.length).toBe(0);
    });
  });

  describe('geofence triggers', () => {
    it('remaps channel index', async () => {
      settingsStore['geofenceTriggers'] = JSON.stringify([
        {
          id: 'g1', name: 'fence', enabled: true,
          shape: { type: 'circle', center: { lat: 0, lng: 0 }, radiusKm: 1 },
          event: 'entry', nodeFilter: { type: 'all' },
          responseType: 'text', response: 'entered', channel: 1
        },
      ]);

      await migrateAutomationChannels([{ from: 1, to: 4 }], getSetting, setSetting);

      const result = JSON.parse(settingsStore['geofenceTriggers']);
      expect(result[0].channel).toBe(4);
    });

    it('leaves "dm" channel unchanged', async () => {
      settingsStore['geofenceTriggers'] = JSON.stringify([
        {
          id: 'g1', name: 'fence', enabled: true,
          shape: { type: 'circle', center: { lat: 0, lng: 0 }, radiusKm: 1 },
          event: 'entry', nodeFilter: { type: 'all' },
          responseType: 'text', response: 'entered', channel: 'dm'
        },
      ]);

      await migrateAutomationChannels([{ from: 1, to: 4 }], getSetting, setSetting);

      const calls = (setSetting as any).mock.calls.filter((c: any) => c[0] === 'geofenceTriggers');
      expect(calls.length).toBe(0);
    });
  });

  describe('autoAckChannels', () => {
    it('remaps comma-separated channel indexes', async () => {
      settingsStore['autoAckChannels'] = '0,2,5';

      await migrateAutomationChannels([{ from: 2, to: 3 }], getSetting, setSetting);

      expect(settingsStore['autoAckChannels']).toBe('0,3,5');
    });

    it('handles swap in auto-ack channels', async () => {
      settingsStore['autoAckChannels'] = '1,2';

      await migrateAutomationChannels(
        [{ from: 1, to: 2 }, { from: 2, to: 1 }],
        getSetting, setSetting
      );

      expect(settingsStore['autoAckChannels']).toBe('2,1');
    });

    it('skips empty auto-ack channels', async () => {
      settingsStore['autoAckChannels'] = '';

      await migrateAutomationChannels([{ from: 2, to: 3 }], getSetting, setSetting);

      const calls = (setSetting as any).mock.calls.filter((c: any) => c[0] === 'autoAckChannels');
      expect(calls.length).toBe(0);
    });
  });

  describe('notification preferences', () => {
    it('remaps enabledChannels for all users', async () => {
      const prefs = [
        { userId: 'u1', enabledChannels: [0, 2, 5] },
        { userId: 'u2', enabledChannels: [2] },
      ];
      const getAllPrefs = vi.fn(async () => prefs);
      const updatePrefs = vi.fn(async () => {});

      await migrateAutomationChannels(
        [{ from: 2, to: 3 }],
        getSetting, setSetting,
        getAllPrefs, updatePrefs
      );

      expect(updatePrefs).toHaveBeenCalledWith('u1', [0, 3, 5]);
      expect(updatePrefs).toHaveBeenCalledWith('u2', [3]);
    });

    it('skips users with no affected channels', async () => {
      const prefs = [{ userId: 'u1', enabledChannels: [0, 1] }];
      const getAllPrefs = vi.fn(async () => prefs);
      const updatePrefs = vi.fn(async () => {});

      await migrateAutomationChannels(
        [{ from: 2, to: 3 }],
        getSetting, setSetting,
        getAllPrefs, updatePrefs
      );

      expect(updatePrefs).not.toHaveBeenCalled();
    });
  });

  describe('multiple trigger types together', () => {
    it('migrates all settings in one call', async () => {
      settingsStore['autoResponderTriggers'] = JSON.stringify([
        { id: '1', trigger: 'hi', responseType: 'text', response: 'hey', channels: [2] },
      ]);
      settingsStore['timerTriggers'] = JSON.stringify([
        { id: 't1', name: 'timer', cronExpression: '0 * * * *', channel: 2, enabled: true },
      ]);
      settingsStore['geofenceTriggers'] = JSON.stringify([
        {
          id: 'g1', name: 'fence', enabled: true,
          shape: { type: 'circle', center: { lat: 0, lng: 0 }, radiusKm: 1 },
          event: 'entry', nodeFilter: { type: 'all' },
          responseType: 'text', response: 'test', channel: 2
        },
      ]);
      settingsStore['autoAckChannels'] = '2,5';

      await migrateAutomationChannels([{ from: 2, to: 7 }], getSetting, setSetting);

      expect(JSON.parse(settingsStore['autoResponderTriggers'])[0].channels).toEqual([7]);
      expect(JSON.parse(settingsStore['timerTriggers'])[0].channel).toBe(7);
      expect(JSON.parse(settingsStore['geofenceTriggers'])[0].channel).toBe(7);
      expect(settingsStore['autoAckChannels']).toBe('7,5');
    });
  });
});
