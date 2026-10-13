import { describe, it, expect, vi } from 'vitest';
import {
  decideStatusReapply,
  isReapplyEnabled,
  runStatusMessageReapply,
  STATUS_MESSAGE_LAST_VERIFIED_KEY,
  STATUS_MESSAGE_REAPPLY_SETTING,
  type StatusReapplyDeps,
  type StatusReapplyInput,
} from './statusMessageReapply.js';

const base: StatusReapplyInput = {
  enabled: true,
  supported: true,
  remembered: 'Monitoring',
  nodeStatus: '',
  saveInFlight: false,
  alreadyAttempted: false,
};

describe('isReapplyEnabled', () => {
  it.each([['true', true], ['1', true], ['false', false], ['0', false], ['', false], [null, false], [undefined, false], ['yes', false]])(
    '%s -> %s', (raw, expected) => expect(isReapplyEnabled(raw as string | null)).toBe(expected));
});

describe('decideStatusReapply (#5745)', () => {
  it('re-applies when the node is empty and a status is remembered', () => {
    expect(decideStatusReapply(base)).toEqual({ action: 'reapply', value: 'Monitoring' });
  });
  it('does nothing when the setting is off', () => {
    expect(decideStatusReapply({ ...base, enabled: false })).toEqual({ action: 'none', reason: 'disabled' });
  });
  it('does nothing when the firmware lacks the module', () => {
    expect(decideStatusReapply({ ...base, supported: false })).toEqual({ action: 'none', reason: 'unsupported' });
  });
  it('does nothing when this connection already attempted', () => {
    expect(decideStatusReapply({ ...base, alreadyAttempted: true }).action).toBe('none');
  });
  it('does nothing while a status save is in flight', () => {
    expect(decideStatusReapply({ ...base, saveInFlight: true })).toEqual({ action: 'none', reason: 'save-in-flight' });
  });
  it('does nothing when the node did not answer', () => {
    expect(decideStatusReapply({ ...base, nodeStatus: null })).toEqual({ action: 'none', reason: 'node-did-not-answer' });
  });
  it.each([[null], ['']])('does nothing when the remembered value is %j', (remembered) => {
    expect(decideStatusReapply({ ...base, remembered })).toEqual({ action: 'none', reason: 'nothing-remembered' });
  });
  it('adopts a different non-empty node value', () => {
    expect(decideStatusReapply({ ...base, nodeStatus: 'Away' })).toEqual({ action: 'adopt', value: 'Away' });
  });
  it('adopts the node value when nothing was remembered', () => {
    expect(decideStatusReapply({ ...base, remembered: null, nodeStatus: 'Away' })).toEqual({ action: 'adopt', value: 'Away' });
  });
  it('does nothing when the node already holds the remembered value', () => {
    expect(decideStatusReapply({ ...base, nodeStatus: 'Monitoring' })).toEqual({ action: 'none', reason: 'in-sync' });
  });
});

function makeDeps(opts: {
  setting?: string | null;
  remembered?: string | null;
  section?: Record<string, unknown> | null;
  supported?: boolean;
  inFlight?: boolean;
  saveFails?: boolean;
} = {}) {
  const store = new Map<string, string | null>([
    [STATUS_MESSAGE_REAPPLY_SETTING, opts.setting ?? null],
    [STATUS_MESSAGE_LAST_VERIFIED_KEY, opts.remembered ?? null],
  ]);
  const saveVerified = vi.fn(async (_v: string) => { if (opts.saveFails) throw new Error('unverified'); });
  const readNodeSection = vi.fn(async () => (opts.section === undefined ? {} : opts.section));
  const deps: StatusReapplyDeps = {
    sourceId: 'src-1',
    getSetting: async (k) => store.get(k) ?? null,
    setSetting: vi.fn(async (k, v) => { store.set(k, v); }),
    supported: () => opts.supported ?? true,
    saveInFlight: () => opts.inFlight ?? false,
    readNodeSection,
    saveVerified,
  };
  return { deps, store, saveVerified, readNodeSection };
}

describe('runStatusMessageReapply (#5745)', () => {
  it('setting off: no read and no write', async () => {
    const t = makeDeps({ setting: 'false', remembered: 'Monitoring' });
    await runStatusMessageReapply(t.deps, false);
    expect(t.readNodeSection).not.toHaveBeenCalled();
    expect(t.saveVerified).not.toHaveBeenCalled();
  });
  it.each(['true', '1'])('setting %s + empty node + remembered value: exactly one verified save', async (setting) => {
    const t = makeDeps({ setting, remembered: 'Monitoring' });
    await runStatusMessageReapply(t.deps, false);
    expect(t.saveVerified).toHaveBeenCalledTimes(1);
    expect(t.saveVerified).toHaveBeenCalledWith('Monitoring');
  });
  it('node holds a different value: no write, remembered value adopted', async () => {
    const t = makeDeps({ setting: 'true', remembered: 'Monitoring', section: { nodeStatus: 'Away' } });
    await runStatusMessageReapply(t.deps, false);
    expect(t.saveVerified).not.toHaveBeenCalled();
    expect(t.store.get(STATUS_MESSAGE_LAST_VERIFIED_KEY)).toBe('Away');
  });
  it('already attempted this connection: no read, no write', async () => {
    const t = makeDeps({ setting: 'true', remembered: 'Monitoring' });
    await runStatusMessageReapply(t.deps, true);
    expect(t.readNodeSection).not.toHaveBeenCalled();
    expect(t.saveVerified).not.toHaveBeenCalled();
  });
  it('unsupported firmware: nothing', async () => {
    const t = makeDeps({ setting: 'true', remembered: 'Monitoring', supported: false });
    await runStatusMessageReapply(t.deps, false);
    expect(t.readNodeSection).not.toHaveBeenCalled();
    expect(t.saveVerified).not.toHaveBeenCalled();
  });
  it('save in flight: nothing', async () => {
    const t = makeDeps({ setting: 'true', remembered: 'Monitoring', inFlight: true });
    await runStatusMessageReapply(t.deps, false);
    expect(t.saveVerified).not.toHaveBeenCalled();
  });
  it('node did not answer: no write', async () => {
    const t = makeDeps({ setting: 'true', remembered: 'Monitoring', section: null });
    await runStatusMessageReapply(t.deps, false);
    expect(t.saveVerified).not.toHaveBeenCalled();
  });
  it('a failed re-apply is swallowed and not retried', async () => {
    const t = makeDeps({ setting: 'true', remembered: 'Monitoring', saveFails: true });
    await expect(runStatusMessageReapply(t.deps, false)).resolves.toMatchObject({ action: 'reapply' });
    expect(t.saveVerified).toHaveBeenCalledTimes(1);
  });
});
