import { describe, it, expect } from 'vitest';
import {
  CONFIG_TYPES,
  CONFIG_TYPE_MAP,
  MODULE_FIELD_BY_ID,
  DEVICE_FIELD_BY_ID,
} from './configTypes.js';
import { VALID_MODULE_CONFIG_TYPES } from './moduleConfig.js';

describe('config type registry', () => {
  // Regression snapshot: these numeric enum values and field names are the
  // Meshtastic admin protocol contract. A wrong value silently breaks config
  // get/set, so pin the full expected table here. Update deliberately if the
  // protocol changes.
  const EXPECTED: Record<string, { type: number; isModule: boolean; field: string }> = {
    device: { type: 0, isModule: false, field: 'device' },
    position: { type: 1, isModule: false, field: 'position' },
    power: { type: 2, isModule: false, field: 'power' },
    network: { type: 3, isModule: false, field: 'network' },
    display: { type: 4, isModule: false, field: 'display' },
    lora: { type: 5, isModule: false, field: 'lora' },
    bluetooth: { type: 6, isModule: false, field: 'bluetooth' },
    security: { type: 7, isModule: false, field: 'security' },
    sessionkey: { type: 8, isModule: false, field: 'sessionkey' },
    deviceui: { type: 9, isModule: false, field: 'deviceui' },
    mqtt: { type: 0, isModule: true, field: 'mqtt' },
    serial: { type: 1, isModule: true, field: 'serial' },
    extnotif: { type: 2, isModule: true, field: 'externalNotification' },
    storeforward: { type: 3, isModule: true, field: 'storeForward' },
    rangetest: { type: 4, isModule: true, field: 'rangeTest' },
    telemetry: { type: 5, isModule: true, field: 'telemetry' },
    cannedmsg: { type: 6, isModule: true, field: 'cannedMessage' },
    audio: { type: 7, isModule: true, field: 'audio' },
    remotehardware: { type: 8, isModule: true, field: 'remoteHardware' },
    neighborinfo: { type: 9, isModule: true, field: 'neighborInfo' },
    ambientlighting: { type: 10, isModule: true, field: 'ambientLighting' },
    detectionsensor: { type: 11, isModule: true, field: 'detectionSensor' },
    paxcounter: { type: 12, isModule: true, field: 'paxcounter' },
    statusmessage: { type: 13, isModule: true, field: 'statusmessage' },
    trafficmanagement: { type: 14, isModule: true, field: 'trafficManagement' },
  };

  it('matches the known admin protocol enum/field table exactly', () => {
    const actual: Record<string, { type: number; isModule: boolean; field: string }> = {};
    for (const e of CONFIG_TYPES) {
      actual[e.id] = { type: e.adminType, isModule: e.kind === 'module', field: e.field };
    }
    expect(actual).toEqual(EXPECTED);
  });

  it('derives CONFIG_TYPE_MAP / MODULE_FIELD_BY_ID / DEVICE_FIELD_BY_ID consistently', () => {
    expect(CONFIG_TYPE_MAP.trafficmanagement).toEqual({ type: 14, isModule: true });
    expect(CONFIG_TYPE_MAP.lora).toEqual({ type: 5, isModule: false });
    expect(MODULE_FIELD_BY_ID.extnotif).toBe('externalNotification');
    expect(MODULE_FIELD_BY_ID.lora).toBeUndefined(); // device, not a module
    expect(DEVICE_FIELD_BY_ID.lora).toBe('lora');
    expect(DEVICE_FIELD_BY_ID.serial).toBeUndefined(); // module, not a device
  });

  it('has unique adminType per kind (device enum / module enum are independent)', () => {
    for (const kind of ['device', 'module'] as const) {
      const types = CONFIG_TYPES.filter((e) => e.kind === kind).map((e) => e.adminType);
      expect(new Set(types).size).toBe(types.length);
    }
  });

  it('every generic-route-saveable module (VALID_MODULE_CONFIG_TYPES) is a module in the registry with a field', () => {
    // Drift guard: the save allow-list (moduleConfig.ts) and the encoder/registry
    // diverging was the root cause of #3464.
    for (const id of VALID_MODULE_CONFIG_TYPES) {
      const entry = CONFIG_TYPES.find((e) => e.id === id);
      expect(entry, `missing registry entry for module '${id}'`).toBeDefined();
      expect(entry!.kind).toBe('module');
      expect(MODULE_FIELD_BY_ID[id]).toBeTruthy();
    }
  });
});
