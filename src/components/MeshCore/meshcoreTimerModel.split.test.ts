import { describe, it, expect } from 'vitest';
import { validateMeshCoreTimer, type MeshCoreTimerTrigger } from './meshcoreTimerModel';

const t = (_k: string, f: string) => f;
const base: MeshCoreTimerTrigger = {
  id: 'a', name: 'x', enabled: true, scheduleType: 'interval', intervalMinutes: 2, responseType: 'text', response: 'hi',
};

describe('validateMeshCoreTimer split floor (#6316)', () => {
  it('rejects a split interval timer under 5 minutes', () => {
    expect(validateMeshCoreTimer({ ...base, multiline: true }, false, t).intervalMinutes).toMatch(/at least/);
  });
  it('allows 5 minutes, non-split timers and adverts', () => {
    expect(validateMeshCoreTimer({ ...base, multiline: true, intervalMinutes: 5 }, false, t).intervalMinutes).toBeUndefined();
    expect(validateMeshCoreTimer(base, false, t).intervalMinutes).toBeUndefined();
    expect(validateMeshCoreTimer({ ...base, multiline: true, responseType: 'advert' }, false, t).intervalMinutes).toBeUndefined();
  });
});
