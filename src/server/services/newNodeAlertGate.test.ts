import { describe, it, expect, beforeEach } from 'vitest';
import {
  NewNodeAlertGate,
  LEARN_MS,
  CAP_PER_HOUR,
  CAP_WINDOW_MS,
  SETTING_LEARN_UNTIL,
  SETTING_RATE,
  parseRateState,
  type NewNodeAlertGateDeps,
} from './newNodeAlertGate.js';

const T0 = 1_800_000_000_000;

function makeEnv() {
  const store = new Map<string, string>();
  const env = {
    clock: T0,
    earliest: null as number | null,
    store,
    deps: {
      now: () => env.clock,
      getSourceSetting: async (s: string, k: string) => store.get(`${s}:${k}`) ?? null,
      setSourceSetting: async (s: string, k: string, v: string) => {
        store.set(`${s}:${k}`, v);
      },
      getEarliestNodeCreatedAt: async () => env.earliest,
    } satisfies NewNodeAlertGateDeps,
  };
  return env;
}

describe('NewNodeAlertGate', () => {
  let env: ReturnType<typeof makeEnv>;
  let gate: NewNodeAlertGate;
  beforeEach(() => {
    env = makeEnv();
    gate = new NewNodeAlertGate(env.deps);
  });

  it('a brand-new source (no rows) learns for the full window from now', async () => {
    expect(await gate.admit('s')).toEqual({ allow: false, reason: 'learning' });
    expect(env.store.get(`s:${SETTING_LEARN_UNTIL}`)).toBe(String(T0 + LEARN_MS));
    env.clock = T0 + LEARN_MS - 1;
    expect((await gate.admit('s')).allow).toBe(false);
    env.clock = T0 + LEARN_MS;
    expect((await gate.admit('s')).allow).toBe(true);
  });

  it('an existing source that logged for weeks is armed at once', async () => {
    env.earliest = T0 - 21 * 24 * 3600_000;
    expect((await gate.admit('s')).allow).toBe(true);
  });

  it('a source that started logging 10 h ago has 38 h left', async () => {
    env.earliest = T0 - 10 * 3600_000;
    expect((await gate.admit('s')).allow).toBe(false);
    expect(env.store.get(`s:${SETTING_LEARN_UNTIL}`)).toBe(String(T0 - 10 * 3600_000 + LEARN_MS));
  });

  it('a row timestamp in the future is ignored (starts from now)', async () => {
    env.earliest = T0 + 5 * 24 * 3600_000;
    await gate.admit('s');
    expect(env.store.get(`s:${SETTING_LEARN_UNTIL}`)).toBe(String(T0 + LEARN_MS));
  });

  it('state survives a new instance (restart) and ignores later row changes', async () => {
    await gate.admit('s');
    const stored = env.store.get(`s:${SETTING_LEARN_UNTIL}`);
    env.earliest = T0 - 30 * 24 * 3600_000; // rows appear: must not shorten the window
    const gate2 = new NewNodeAlertGate(env.deps);
    expect((await gate2.admit('s')).reason).toBe('learning');
    expect(env.store.get(`s:${SETTING_LEARN_UNTIL}`)).toBe(stored);
  });

  it('is per source', async () => {
    env.earliest = T0 - LEARN_MS;
    await gate.admit('a');
    env.earliest = null;
    expect((await gate.admit('b')).reason).toBe('learning');
    expect((await gate.admit('a')).allow).toBe(true);
  });

  it('learningUntil is read only', async () => {
    expect(await gate.learningUntil('s')).toBeNull();
    expect(env.store.size).toBe(0);
    await gate.admit('s');
    expect(await gate.learningUntil('s')).toBe(T0 + LEARN_MS);
  });

  describe('rearm', () => {
    it('restarts the window from now and blocks alerts again', async () => {
      env.earliest = T0 - LEARN_MS * 2;
      expect((await gate.admit('s')).allow).toBe(true);
      env.clock = T0 + 1000;
      await gate.rearm('s');
      expect((await gate.admit('s')).reason).toBe('learning');
      expect(await gate.learningUntil('s')).toBe(T0 + 1000 + LEARN_MS);
    });

    it('never shortens an open window', async () => {
      await gate.admit('s'); // until T0 + LEARN
      env.clock = T0 + 1000;
      await gate.rearm('s');
      expect(await gate.learningUntil('s')).toBe(T0 + 1000 + LEARN_MS);
      env.clock = T0;
      await gate.rearm('s');
      expect(await gate.learningUntil('s')).toBe(T0 + 1000 + LEARN_MS);
    });
  });

  describe('hourly cap', () => {
    beforeEach(() => {
      env.earliest = T0 - 10 * LEARN_MS;
    });

    it('allows the cap, drops and counts the rest', async () => {
      for (let i = 0; i < CAP_PER_HOUR; i++) expect((await gate.admit('s')).allow).toBe(true);
      expect(await gate.admit('s')).toEqual({ allow: false, reason: 'capped' });
      expect(await gate.admit('s')).toEqual({ allow: false, reason: 'capped' });
      expect(parseRateState(env.store.get(`s:${SETTING_RATE}`))).toMatchObject({ sent: CAP_PER_HOUR, suppressed: 2 });
    });

    it('the next allowed alert carries the dropped count once', async () => {
      for (let i = 0; i < CAP_PER_HOUR + 3; i++) await gate.admit('s');
      env.clock = T0 + CAP_WINDOW_MS;
      expect(await gate.admit('s')).toEqual({ allow: true, suppressedSinceLast: 3 });
      expect(await gate.admit('s')).toEqual({ allow: true });
    });

    it('a restart cannot reopen a full hour', async () => {
      for (let i = 0; i < CAP_PER_HOUR; i++) await gate.admit('s');
      const gate2 = new NewNodeAlertGate(env.deps);
      env.clock = T0 + 60_000;
      expect((await gate2.admit('s')).reason).toBe('capped');
    });

    it('a clock stepping back keeps the current window', async () => {
      for (let i = 0; i < CAP_PER_HOUR; i++) await gate.admit('s');
      env.clock = T0 - 5 * 3600_000;
      expect((await gate.admit('s')).reason).toBe('capped');
    });

    it('serialises concurrent admits so the cap holds', async () => {
      const results = await Promise.all(Array.from({ length: CAP_PER_HOUR + 5 }, () => gate.admit('s')));
      expect(results.filter((r) => r.allow).length).toBe(CAP_PER_HOUR);
    });

    it('corrupt JSON starts a fresh window instead of throwing', async () => {
      env.store.set(`s:${SETTING_RATE}`, '{not json');
      expect((await gate.admit('s')).allow).toBe(true);
      env.store.set(`s:${SETTING_RATE}`, '[1,2]');
      expect((await gate.admit('s')).allow).toBe(true);
      env.store.set(`s:${SETTING_RATE}`, JSON.stringify({ windowStart: 'x', sent: -1, suppressed: 0 }));
      expect((await gate.admit('s')).allow).toBe(true);
    });

    it('corrupt learn-until falls back to deriving it', async () => {
      env.store.set(`s:${SETTING_LEARN_UNTIL}`, 'garbage');
      env.earliest = T0 - LEARN_MS;
      expect((await gate.admit('s')).allow).toBe(true);
    });
  });
});
