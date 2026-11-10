import { describe, it, expect } from 'vitest';
import type { TFunction } from 'i18next';
import { ApiError } from '../../services/api';
import { mqttRootErrorMessage } from './mqttRootApiError';

const t = ((key: string, opts?: { defaultValue?: string }) =>
  key === 'mqtt_root_finder.validation.WILDCARD' ? 'localised wildcard' : (opts?.defaultValue ?? key)) as unknown as TFunction;

describe('mqttRootErrorMessage (#6338)', () => {
  it('localises a refused root by its reason', () => {
    const err = new ApiError('A root cannot contain + or #.', 400, {
      code: 'INVALID_MQTT_ROOT',
      body: { success: false, code: 'INVALID_MQTT_ROOT', error: 'A root cannot contain + or #.', field: 'root', reason: 'WILDCARD' },
    });
    expect(mqttRootErrorMessage(err, t)).toBe('localised wildcard');
  });

  it('falls back to the server message for an unknown or missing reason', () => {
    const unknown = new ApiError('server text', 400, { code: 'INVALID_MQTT_ROOT', body: { reason: 'NEW_RULE' } });
    expect(mqttRootErrorMessage(unknown, t)).toBe('server text');
    const missing = new ApiError('server text', 400, { code: 'INVALID_MQTT_ROOT', body: {} });
    expect(mqttRootErrorMessage(missing, t)).toBe('server text');
  });

  it('ignores any other error', () => {
    expect(mqttRootErrorMessage(new ApiError('nope', 400, { code: 'OTHER' }), t)).toBeNull();
    expect(mqttRootErrorMessage(new Error('plain'), t)).toBeNull();
    expect(mqttRootErrorMessage('text', t)).toBeNull();
  });
});
