import { describe, it, expect, vi } from 'vitest';
import {
  runStatusMessageReapply,
  STATUS_MESSAGE_LAST_VERIFIED_KEY,
  STATUS_MESSAGE_REAPPLY_SETTING,
  type StatusReapplyDeps,
} from './statusMessageReapply.js';

/** Per-source isolation (#5745): source A's setting and remembered value never drive a write on B. */
describe('statusMessageReapply per-source isolation', () => {
  const rows = new Map<string, string>([
    ['A|' + STATUS_MESSAGE_REAPPLY_SETTING, 'true'],
    ['A|' + STATUS_MESSAGE_LAST_VERIFIED_KEY, 'Monitoring'],
    // B: no setting, no remembered value
  ]);
  function depsFor(sourceId: string) {
    const saveVerified = vi.fn(async (_v: string) => {});
    const deps: StatusReapplyDeps = {
      sourceId,
      getSetting: async (k) => rows.get(`${sourceId}|${k}`) ?? null,
      setSetting: async (k, v) => { rows.set(`${sourceId}|${k}`, v); },
      supported: () => true,
      saveInFlight: () => false,
      readNodeSection: async () => ({}),
      saveVerified,
    };
    return { deps, saveVerified };
  }

  it('A writes, B does not', async () => {
    const a = depsFor('A');
    const b = depsFor('B');
    await runStatusMessageReapply(a.deps, false);
    await runStatusMessageReapply(b.deps, false);
    expect(a.saveVerified).toHaveBeenCalledWith('Monitoring');
    expect(b.saveVerified).not.toHaveBeenCalled();
  });

  it('B with the setting on but its own empty memory does not borrow A\'s', async () => {
    rows.set('B|' + STATUS_MESSAGE_REAPPLY_SETTING, 'true');
    const b = depsFor('B');
    await runStatusMessageReapply(b.deps, false);
    expect(b.saveVerified).not.toHaveBeenCalled();
  });

  it('adopting on B leaves A\'s remembered value alone', async () => {
    const b = depsFor('B');
    b.deps.readNodeSection = async () => ({ nodeStatus: 'Other' });
    await runStatusMessageReapply(b.deps, false);
    expect(rows.get('B|' + STATUS_MESSAGE_LAST_VERIFIED_KEY)).toBe('Other');
    expect(rows.get('A|' + STATUS_MESSAGE_LAST_VERIFIED_KEY)).toBe('Monitoring');
  });
});
