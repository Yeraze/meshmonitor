import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { checkMqttRootSave, restoredMqttRootProblem, MQTT_ROOT_REASON_MESSAGES } from './mqttRootGuard.js';

describe('checkMqttRootSave (#6338)', () => {
  it('passes a root that was not sent', () => {
    expect(checkMqttRootSave(undefined, 'msh')).toBeNull();
    expect(checkMqttRootSave(undefined, undefined, { allowEmpty: false })).toBeNull();
  });

  it('refuses a root that is not text, even when unchanged', () => {
    expect(checkMqttRootSave(42, 42)).toMatchObject({ code: 'INVALID_MQTT_ROOT', reason: 'NOT_STRING' });
    expect(checkMqttRootSave(null, undefined)?.reason).toBe('NOT_STRING');
  });

  it('passes an unchanged root, even a bad one', () => {
    expect(checkMqttRootSave('msh/US ', 'msh/US ')).toBeNull();
    expect(checkMqttRootSave('msh/#', 'msh/#', { allowEmpty: false })).toBeNull();
  });

  it('checks a changed root', () => {
    expect(checkMqttRootSave('msh/US/2', 'msh/US')?.reason).toBe('ENDS_WITH_2');
    expect(checkMqttRootSave('msh/US/FL', 'msh/US')).toBeNull();
  });

  it('treats an unknown previous root as a change', () => {
    expect(checkMqttRootSave('msh/#', undefined)?.reason).toBe('WILDCARD');
    expect(checkMqttRootSave('msh/US', undefined)).toBeNull();
  });

  it('allows an empty root unless told not to', () => {
    expect(checkMqttRootSave('', 'msh')).toBeNull();
    expect(checkMqttRootSave('', 'msh', { allowEmpty: false })?.reason).toBe('EMPTY');
    expect(checkMqttRootSave('', undefined, { allowEmpty: false })?.reason).toBe('EMPTY');
  });

  it('carries the English message for the reason', () => {
    const err = checkMqttRootSave('a'.repeat(32), 'msh');
    expect(err).toEqual({ code: 'INVALID_MQTT_ROOT', reason: 'TOO_LONG', message: MQTT_ROOT_REASON_MESSAGES.TOO_LONG });
    expect(err?.message).toBe('A root can be at most 31 bytes.');
  });

  it('names the problem with a restored root', () => {
    expect(restoredMqttRootProblem('msh/US/2')).toBe('ENDS_WITH_2');
    expect(restoredMqttRootProblem('msh/US')).toBeNull();
    expect(restoredMqttRootProblem(undefined)).toBeNull();
    expect(restoredMqttRootProblem('')).toBeNull();
  });
});

describe('MQTT_ROOT_REASON_MESSAGES', () => {
  it('matches the en.json strings the UI shows for the same reason', () => {
    const enPath = fileURLToPath(new URL('../../../public/locales/en.json', import.meta.url));
    const en = JSON.parse(readFileSync(enPath, 'utf8')) as Record<string, string>;
    for (const [reason, message] of Object.entries(MQTT_ROOT_REASON_MESSAGES)) {
      expect(en[`mqtt_root_finder.validation.${reason}`]).toBe(message);
    }
  });
});
