import { describe, it, expect } from 'vitest';
import { CONFIG_REBOOT_RULES, rebootExpectation, type ConfigSaveSection } from './configRebootRules';

const V279 = '2.7.9.70724be';
const V281 = '2.8.1.8e6a88d';

describe('configRebootRules (#5823)', () => {
  it.each([
    'position', 'network', 'bluetooth', 'security',
    'mqtt', 'serial', 'extnotif', 'storeforward', 'rangetest', 'telemetry', 'cannedmsg',
    'audio', 'remotehardware', 'neighborinfo', 'ambientlighting', 'detectionsensor',
    'paxcounter', 'trafficmanagement', 'tak',
  ] as ConfigSaveSection[])('%s always reboots on 2.7 and 2.8', section => {
    expect(rebootExpectation(section, V279)).toBe('always');
    expect(rebootExpectation(section, V281)).toBe('always');
  });

  it.each(['owner', 'device', 'power', 'display'] as ConfigSaveSection[])(
    '%s may reboot, depending on the fields changed',
    section => {
      expect(rebootExpectation(section, V279)).toBe('possible');
      expect(rebootExpectation(section, V281)).toBe('possible');
    },
  );

  it.each(['statusmessage', 'meshbeacon'] as ConfigSaveSection[])('%s never reboots', section => {
    expect(rebootExpectation(section, V281)).toBe('never');
    expect(rebootExpectation(section, '2.7.20.6658ec2')).toBe('never');
  });

  it('LoRa reboots before 2.8 and applies live from 2.8.0', () => {
    expect(rebootExpectation('lora', V279)).toBe('always');
    expect(rebootExpectation('lora', '2.7.26.54e0d8d')).toBe('always');
    expect(rebootExpectation('lora', '2.8.0.7239fe8')).toBe('never');
    expect(rebootExpectation('lora', V281)).toBe('never');
  });

  it('an unknown firmware version reads as pre-2.8, so a reboot is never missed', () => {
    expect(rebootExpectation('lora', null)).toBe('always');
    expect(rebootExpectation('lora', undefined)).toBe('always');
    expect(rebootExpectation('lora', 'garbage')).toBe('always');
  });

  it('every section has a rule for both firmware lines', () => {
    for (const [section, rule] of Object.entries(CONFIG_REBOOT_RULES)) {
      expect(['always', 'possible', 'never'], section).toContain(rule.before28);
      expect(['always', 'possible', 'never'], section).toContain(rule.from28);
    }
  });
});
