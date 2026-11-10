/**
 * Meshtastic Timer Trigger model — multi-channel support (#6230).
 *
 * Covers the editor channel reader, finalize (how the saved shape is built),
 * and the new "a text timer needs at least one real channel" validation. The
 * reader keeps old single-channel timers working.
 */
import { describe, it, expect } from 'vitest';
import type { TimerTrigger } from '../auto-responder/types';
import {
  editableTimerChannels,
  finalizeTimerTrigger,
  validateTimerTrigger,
  hasTimerErrors,
  newTimerTrigger,
} from './timerTriggerModel';

const t = (_key: string, fallback: string) => fallback;

const base = (over: Partial<TimerTrigger>): TimerTrigger => ({
  id: 't1',
  name: 'Daily',
  cronExpression: '0 */6 * * *',
  responseType: 'text',
  response: 'hi',
  channels: [0],
  enabled: true,
  ...over,
});

describe('editableTimerChannels (#6230)', () => {
  it('reads the new channels array once it is set', () => {
    expect(editableTimerChannels(base({ channels: [0, 2], channel: undefined }))).toEqual([0, 2]);
  });

  it('shows an empty selection (channels set, legacy cleared)', () => {
    expect(editableTimerChannels(base({ channels: [], channel: undefined }))).toEqual([]);
  });

  it('migrates an old single-channel timer', () => {
    expect(editableTimerChannels({ ...base({}), channels: undefined, channel: 4 })).toEqual([4]);
  });
});

describe('finalizeTimerTrigger (#6230)', () => {
  it('stores channels and clears the legacy scalar', () => {
    const out = finalizeTimerTrigger({ ...base({}), channels: undefined, channel: 2 });
    expect(out.channels).toEqual([2]);
    expect(out.channel).toBeUndefined();
  });

  it('keeps multiple channels for a text timer', () => {
    const out = finalizeTimerTrigger(base({ responseType: 'text', channels: [0, 1, 3] }));
    expect(out.channels).toEqual([0, 1, 3]);
  });

  it('drops the script-only none from a text timer and falls back to [0]', () => {
    const out = finalizeTimerTrigger(base({ responseType: 'text', channels: ['none'] }));
    expect(out.channels).toEqual([0]);
  });

  it('keeps none for a script timer (no mesh output)', () => {
    const out = finalizeTimerTrigger(base({ responseType: 'script', scriptPath: '/data/scripts/x.sh', channels: ['none'] }));
    expect(out.channels).toEqual(['none']);
  });
});

describe('validateTimerTrigger channels (#6230)', () => {
  it('errors when a text timer has no real channel', () => {
    const errs = validateTimerTrigger(base({ responseType: 'text', channels: ['none'] }), t);
    expect(errs.channels).toBeTruthy();
    expect(hasTimerErrors(errs)).toBe(true);
  });

  it('passes when a text timer has at least one channel', () => {
    const errs = validateTimerTrigger(base({ responseType: 'text', channels: [0, 2] }), t);
    expect(errs.channels).toBeUndefined();
  });

  it('allows a script timer with none selected', () => {
    const errs = validateTimerTrigger(base({ responseType: 'script', scriptPath: '/data/scripts/x.sh', channels: ['none'] }), t);
    expect(errs.channels).toBeUndefined();
  });
});

describe('newTimerTrigger (#6230)', () => {
  it('seeds a one-item channels array', () => {
    expect(newTimerTrigger().channels).toEqual([0]);
  });
});

describe('finalizeTimerTrigger — split long messages (#6330)', () => {
  it('keeps multiline on a timer with mesh output', () => {
    expect(finalizeTimerTrigger(base({ multiline: true })).multiline).toBe(true);
  });
  it('drops multiline for a script with no mesh output', () => {
    const tr = base({ responseType: 'script', scriptPath: '/data/scripts/a.py', response: undefined, channels: ['none'], multiline: true });
    expect(finalizeTimerTrigger(tr).multiline).toBeUndefined();
  });
  it('leaves multiline off by default', () => {
    expect(finalizeTimerTrigger(base({})).multiline).toBeUndefined();
  });
});
