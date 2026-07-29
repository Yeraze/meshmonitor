/**
 * `buildAutoAckAutomations()` unit tests (#4340 Phase 4, WP2, spec §7 (a)-(o)).
 *
 * Pure, literals only — no DB. Each `it` in this file corresponds to the
 * lettered case in docs/internal/dev-notes/AUTOACK_CONVERTER_PHASE4_SPEC.md §7.
 */
import { describe, it, expect } from 'vitest';
import { buildAutoAckAutomations, type AutoAckConverterInput, type ResolvedAutoAck } from './autoAckConverter.js';
import {
  AUTOACK_CELLS,
  DEFAULT_AUTOACK_MATRIX,
  matrixToSettings,
  type AutoAckMatrix,
  type AutoAckCellId,
  type AutoAckCellConfig,
} from '../../../utils/autoAckMatrix.js';
import { resolveAutoAckReplyRouting } from '../../utils/autoAckDecision.js';
import { computeMatrixValues } from '../../migrations/093_autoack_matrix.js';

// ─── Fixture helpers ────────────────────────────────────────────────────────

function allOffMatrixRaw(): Record<string, string | undefined> {
  return matrixToSettings(DEFAULT_AUTOACK_MATRIX);
}

/** A matrix with exactly one cell overridden from all-off, serialised as raw settings. */
function matrixWith(cell: AutoAckCellId, cfg: Partial<AutoAckCellConfig>): Record<string, string | undefined> {
  const m: AutoAckMatrix = {
    channelZeroHop: { ...DEFAULT_AUTOACK_MATRIX.channelZeroHop },
    channelMultiHop: { ...DEFAULT_AUTOACK_MATRIX.channelMultiHop },
    directZeroHop: { ...DEFAULT_AUTOACK_MATRIX.directZeroHop },
    directMultiHop: { ...DEFAULT_AUTOACK_MATRIX.directMultiHop },
  };
  m[cell] = { ...m[cell], ...cfg };
  return matrixToSettings(m);
}

function baseSettings(overrides: Partial<ResolvedAutoAck> = {}): ResolvedAutoAck {
  return {
    enabled: true,
    regex: undefined,
    message: undefined,
    messageDirect: undefined,
    channelsRaw: undefined,
    skipIncompleteNodes: false,
    ignoredNodesRaw: undefined,
    cooldownSecondsRaw: undefined,
    preSendDelaySecondsRaw: undefined,
    maxAttemptsRaw: undefined,
    rawMatrixAndLegacy: allOffMatrixRaw(),
    ...overrides,
  };
}

function baseInput(overrides: Partial<AutoAckConverterInput> = {}): AutoAckConverterInput {
  return {
    sourceId: 'src1',
    sourceName: 'Home Base',
    settings: baseSettings(),
    channels: [],
    now: new Date('2026-07-28T00:00:00Z'),
    ...overrides,
  };
}

/**
 * A valid, resolvable channel allowlist (index 0 → "gauntlet"). Tests that enable a
 * Channel-type cell but aren't specifically exercising channel-allowlist resolution
 * (§4.2) need this — since the CORRECTION to §4.2, an EMPTY `autoAckChannels` means
 * "no channel automation at all" (AutoAck never acked on an empty allowlist), not
 * "no restriction". Most non-channel-specific tests below use a Direct cell instead,
 * which has no allowlist dependency at all; this fixture is for the few that
 * specifically need a live Channel automation.
 */
const VALID_CHANNEL_ALLOWLIST = { channelsRaw: '0' };
const VALID_CHANNEL_ROWS = [{ index: 0, name: 'gauntlet', role: 1 }];

// ─── (a) ─────────────────────────────────────────────────────────────────────

describe('buildAutoAckAutomations', () => {
  it('(a) an all-off matrix produces no automations and blocks with NO_CELLS_ENABLED', () => {
    const result = buildAutoAckAutomations(baseInput());
    expect(result.automations).toEqual([]);
    expect(result.blocking).toBe('NO_CELLS_ENABLED');
  });

  // ─── (b) ───────────────────────────────────────────────────────────────────
  it.each([
    { cell: 'channelZeroHop' as const, isDM: '0', zeroHop: '1' },
    { cell: 'channelMultiHop' as const, isDM: '0', zeroHop: '0' },
    { cell: 'directZeroHop' as const, isDM: '1', zeroHop: '1' },
    { cell: 'directMultiHop' as const, isDM: '1', zeroHop: '0' },
  ])('(b) cell $cell alone produces one automation, one rule, correct isDM/zeroHop, correct actions', ({ cell, isDM, zeroHop }) => {
    const isChannelCell = cell.startsWith('channel');
    const input = baseInput({
      settings: baseSettings({
        ...(isChannelCell ? VALID_CHANNEL_ALLOWLIST : {}),
        rawMatrixAndLegacy: matrixWith(cell, { reply: true }),
      }),
      channels: isChannelCell ? VALID_CHANNEL_ROWS : [],
    });
    const result = buildAutoAckAutomations(input);
    expect(result.blocking).toBeUndefined();
    expect(result.automations).toHaveLength(1);
    const rule = result.automations[0].form.rules[0];
    expect(result.automations[0].form.rules).toHaveLength(1);
    const c1 = rule.conditions.find((c) => c.type === 'condition.numeric' && c.params.field === 'isDM');
    const c2 = rule.conditions.find((c) => c.type === 'condition.numeric' && c.params.field === 'zeroHop');
    expect(c1?.params.value).toBe(isDM);
    expect(c2?.params.value).toBe(zeroHop);
    expect(rule.actions.map((a) => a.type)).toEqual(['action.sendMessage']);
  });

  // ─── (c) ───────────────────────────────────────────────────────────────────
  it('(c) a cell with only replyDm set produces no rule (mirrors AutoAck\'s own early-out)', () => {
    const input = baseInput({ settings: baseSettings({ rawMatrixAndLegacy: matrixWith('channelZeroHop', { replyDm: true }) }) });
    const result = buildAutoAckAutomations(input);
    expect(result.automations).toEqual([]);
    expect(result.blocking).toBe('NO_CELLS_ENABLED');
  });

  // ─── (d) ───────────────────────────────────────────────────────────────────
  it('(d) all four cells enabled produces two automations; only the channel one carries `channels`', () => {
    const fullMatrix: AutoAckMatrix = {
      channelZeroHop: { reply: true, tapback: true, replyDm: false },
      channelMultiHop: { reply: true, tapback: false, replyDm: false },
      directZeroHop: { reply: true, tapback: true, replyDm: false },
      directMultiHop: { reply: true, tapback: false, replyDm: false },
    };
    const input = baseInput({
      settings: baseSettings({ channelsRaw: '0', rawMatrixAndLegacy: matrixToSettings(fullMatrix) }),
      channels: [{ index: 0, name: 'gauntlet', role: 1 }],
    });
    const result = buildAutoAckAutomations(input);
    expect(result.blocking).toBeUndefined();
    expect(result.automations).toHaveLength(2);
    const chan = result.automations.find((a) => a.key === 'channel')!;
    const dir = result.automations.find((a) => a.key === 'direct')!;
    expect(chan.form.trigger.params.channels).toEqual([{ name: 'gauntlet', protocol: 'meshtastic' }]);
    expect(dir.form.trigger.params.channels).toBeUndefined();
    expect(chan.name).toBe('Auto-Ack — Home Base (Channels)');
    expect(dir.name).toBe('Auto-Ack — Home Base (Direct messages)');
  });

  // ─── (e) ───────────────────────────────────────────────────────────────────
  it('(e) blank autoAckRegex emits the Auto-Acknowledge default', () => {
    const input = baseInput({ settings: baseSettings({ regex: undefined, rawMatrixAndLegacy: matrixWith('directZeroHop', { reply: true }) }) });
    const result = buildAutoAckAutomations(input);
    expect(result.automations[0].form.trigger.params.regex).toBe('^(test|ping)');
  });

  it('(e) a non-blank autoAckRegex is emitted verbatim', () => {
    const input = baseInput({ settings: baseSettings({ regex: '^weather', rawMatrixAndLegacy: matrixWith('directZeroHop', { reply: true }) }) });
    const result = buildAutoAckAutomations(input);
    expect(result.automations[0].form.trigger.params.regex).toBe('^weather');
  });

  // ─── (f) ───────────────────────────────────────────────────────────────────
  it('(f) blank autoAckCooldownSeconds emits 60 with cooldownScope node', () => {
    const input = baseInput({ settings: baseSettings({ rawMatrixAndLegacy: matrixWith('directZeroHop', { reply: true }) }) });
    const result = buildAutoAckAutomations(input);
    expect(result.automations[0].form.trigger.params.cooldownSeconds).toBe(60);
    expect(result.automations[0].form.trigger.params.cooldownScope).toBe('node');
  });

  it('(f) a set autoAckCooldownSeconds is emitted as-is', () => {
    const input = baseInput({ settings: baseSettings({ cooldownSecondsRaw: '120', rawMatrixAndLegacy: matrixWith('directZeroHop', { reply: true }) }) });
    const result = buildAutoAckAutomations(input);
    expect(result.automations[0].form.trigger.params.cooldownSeconds).toBe(120);
  });

  // ─── (g) ───────────────────────────────────────────────────────────────────
  it('(g) channel index→name resolution handles missing/disabled/blank/duplicate plus success', () => {
    const input = baseInput({
      settings: baseSettings({
        channelsRaw: '0,1,2,3,4,5',
        rawMatrixAndLegacy: matrixWith('channelZeroHop', { reply: true }),
      }),
      channels: [
        { index: 0, name: 'gauntlet', role: 1 },
        // index 1 intentionally missing from the channels array
        { index: 2, name: 'Disabled', role: 0 },
        { index: 3, name: '   ', role: 1 },
        { index: 4, name: 'Dup', role: 1 },
        { index: 5, name: 'dup', role: 1 },
      ],
    });
    const result = buildAutoAckAutomations(input);
    expect(result.blocking).toBeUndefined();
    const chan = result.automations.find((a) => a.key === 'channel')!;
    const channelsParam = chan.form.trigger.params.channels as Array<{ name: string; protocol: string }>;
    expect(channelsParam.map((c) => c.name).sort()).toEqual(['Dup', 'gauntlet']);
    expect(channelsParam.every((c) => c.protocol === 'meshtastic')).toBe(true);

    const { report } = result;
    expect(report.notConvertible.some((e) => e.key === 'channel-1-missing')).toBe(true);
    expect(report.notConvertible.some((e) => e.key === 'channel-2-disabled')).toBe(true);
    expect(report.notConvertible.some((e) => e.key === 'channel-3-unnamed')).toBe(true);
    expect(report.approximated.some((e) => e.key === 'channel-name-collision')).toBe(true);
  });

  // ─── (h) ───────────────────────────────────────────────────────────────────
  it('(h) every allowlisted channel unconvertible blocks with CHANNEL_ALLOWLIST_UNCONVERTIBLE', () => {
    const input = baseInput({
      settings: baseSettings({
        channelsRaw: '1,2',
        rawMatrixAndLegacy: matrixWith('channelZeroHop', { reply: true }),
      }),
      channels: [{ index: 2, name: '', role: 1 }], // index 1 missing; index 2 blank name
    });
    const result = buildAutoAckAutomations(input);
    expect(result.blocking).toBe('CHANNEL_ALLOWLIST_UNCONVERTIBLE');
    expect(result.automations.find((a) => a.key === 'channel')).toBeUndefined();
  });

  // ─── (g)/(h) correction: an EMPTY allowlist ≠ "no channels configured but none resolved" ──
  // §4.2 correction (orchestrator, 2026-07-28): AutoAck never acks on an empty allowlist
  // (meshtasticManager.ts's enabledChannelsSet.has(channelIndex) gate rejects everything when
  // the set is empty), so an empty `autoAckChannels` must NOT produce a Channel automation with
  // no `channels` filter (that would answer on every channel — the opposite of dead behaviour).
  it('an empty allowlist with all four cells on produces a Direct-only automation plus a notConvertible report entry', () => {
    const fullMatrix: AutoAckMatrix = {
      channelZeroHop: { reply: true, tapback: true, replyDm: false },
      channelMultiHop: { reply: true, tapback: false, replyDm: false },
      directZeroHop: { reply: true, tapback: true, replyDm: false },
      directMultiHop: { reply: true, tapback: false, replyDm: false },
    };
    const input = baseInput({ settings: baseSettings({ rawMatrixAndLegacy: matrixToSettings(fullMatrix) }) }); // channelsRaw left undefined
    const result = buildAutoAckAutomations(input);
    expect(result.blocking).toBeUndefined();
    expect(result.automations).toHaveLength(1);
    expect(result.automations[0].key).toBe('direct');
    expect(result.automations[0].name).toBe('Auto-Ack — Home Base'); // only automation ⇒ no "(Direct messages)" suffix
    const entry = result.report.notConvertible.find((e) => e.key === 'channel-allowlist-empty');
    expect(entry).toBeDefined();
    expect(entry!.detail).toContain('never acknowledged channel messages');
  });

  it('an empty allowlist with only Channel cells on produces zero automations and blocks with NO_CELLS_ENABLED', () => {
    const input = baseInput({
      settings: baseSettings({ rawMatrixAndLegacy: matrixWith('channelZeroHop', { reply: true, tapback: true }) }),
      // channelsRaw left undefined — the allowlist is empty
    });
    const result = buildAutoAckAutomations(input);
    expect(result.automations).toEqual([]);
    expect(result.blocking).toBe('NO_CELLS_ENABLED');
    expect(result.report.notConvertible.some((e) => e.key === 'channel-allowlist-empty')).toBe(true);
  });

  it('CHANNEL_ALLOWLIST_UNCONVERTIBLE (listed but unresolvable) stays distinct from an empty allowlist', () => {
    // Same cell config as the empty-allowlist case above, but this time the user DID list
    // channels — they just don't resolve. This must block with the "must fix" reason, not the
    // generic NO_CELLS_ENABLED, and must NOT carry the channel-allowlist-empty entry.
    const input = baseInput({
      settings: baseSettings({
        channelsRaw: '9', // listed, but...
        rawMatrixAndLegacy: matrixWith('channelZeroHop', { reply: true, tapback: true }),
      }),
      channels: [], // ...index 9 doesn't exist for this source
    });
    const result = buildAutoAckAutomations(input);
    expect(result.blocking).toBe('CHANNEL_ALLOWLIST_UNCONVERTIBLE');
    expect(result.blocking).not.toBe('NO_CELLS_ENABLED');
    expect(result.report.notConvertible.some((e) => e.key === 'channel-allowlist-empty')).toBe(false);
    expect(result.report.notConvertible.some((e) => e.key === 'channel-9-missing')).toBe(true);
  });

  // ─── (i) ───────────────────────────────────────────────────────────────────
  it('(i) to/replyToTrigger match resolveAutoAckReplyRouting() for every cell × replyDm combination', () => {
    for (const cellMeta of AUTOACK_CELLS) {
      for (const replyDm of [false, true]) {
        const isChannelCell = cellMeta.type === 'channel';
        const input = baseInput({
          settings: baseSettings({
            ...(isChannelCell ? VALID_CHANNEL_ALLOWLIST : {}),
            rawMatrixAndLegacy: matrixWith(cellMeta.id, { reply: true, replyDm }),
          }),
          channels: isChannelCell ? VALID_CHANNEL_ROWS : [],
        });
        const result = buildAutoAckAutomations(input);
        const rule = result.automations[0].form.rules[0];
        const send = rule.actions.find((a) => a.type === 'action.sendMessage')!;
        const isDirectCell = cellMeta.type === 'direct';
        const routing = resolveAutoAckReplyRouting({
          isDirectMessage: isDirectCell, cellReplyDmEnabled: replyDm, channelIndex: 0, fromNum: 0, packetId: 1,
        });
        if (routing.replyViaDm) expect(send.params.to).toBe('{{ trigger.from }}');
        else expect(send.params.to).toBeUndefined();
        if (routing.replyId !== undefined) expect(send.params.replyToTrigger).toBe(true);
        else expect(send.params.replyToTrigger).toBeUndefined();
      }
    }
  });

  // ─── (j) ───────────────────────────────────────────────────────────────────
  it('(j) ignore-list normalisation matches AutoAck\'s own parser and reports discards', () => {
    const input = baseInput({
      settings: baseSettings({
        ignoredNodesRaw: '!DEADBEEF, deadbee1 nothexatall',
        rawMatrixAndLegacy: matrixWith('directZeroHop', { reply: true }),
      }),
    });
    const result = buildAutoAckAutomations(input);
    const rule = result.automations[0].form.rules[0];
    const s3 = rule.conditions.find((c) => c.type === 'condition.string' && c.params.field === 'fromId');
    expect(s3?.params).toEqual({ field: 'fromId', op: 'notIn', value: '!deadbeef, !deadbee1' });
    expect(result.report.approximated.some((e) => e.key === 'ignored-node-unparseable' && e.detail.includes('nothexatall'))).toBe(true);
  });

  it('(j) an empty ignore list omits the fromId condition entirely', () => {
    const input = baseInput({ settings: baseSettings({ rawMatrixAndLegacy: matrixWith('directZeroHop', { reply: true }) }) });
    const result = buildAutoAckAutomations(input);
    const rule = result.automations[0].form.rules[0];
    expect(rule.conditions.some((c) => c.type === 'condition.string')).toBe(false);
  });

  // ─── (k) ───────────────────────────────────────────────────────────────────
  it('(k) skipIncompleteNodes adds a node.completeness "in" condition; off omits it', () => {
    const on = buildAutoAckAutomations(baseInput({
      settings: baseSettings({ skipIncompleteNodes: true, rawMatrixAndLegacy: matrixWith('directZeroHop', { reply: true }) }),
    }));
    const onRule = on.automations[0].form.rules[0];
    const s2 = onRule.conditions.find((c) => c.type === 'condition.string' && c.params.field === 'node.completeness');
    expect(s2?.params).toEqual({ field: 'node.completeness', op: 'in', value: 'complete, unknown' });

    const off = buildAutoAckAutomations(baseInput({
      settings: baseSettings({ rawMatrixAndLegacy: matrixWith('directZeroHop', { reply: true }) }),
    }));
    const offRule = off.automations[0].form.rules[0];
    expect(offRule.conditions.some((c) => c.type === 'condition.string' && c.params.field === 'node.completeness')).toBe(false);
  });

  // ─── (l) ───────────────────────────────────────────────────────────────────
  it('(l) pre-send delay 0 emits no action.delay; 45 emits it first in every rule', () => {
    const matrix = matrixWith('directZeroHop', { reply: true, tapback: true });

    const zero = buildAutoAckAutomations(baseInput({ settings: baseSettings({ rawMatrixAndLegacy: matrix }) }));
    expect(zero.automations[0].form.rules[0].actions.map((a) => a.type)).not.toContain('action.delay');

    const withDelay = buildAutoAckAutomations(baseInput({
      settings: baseSettings({ preSendDelaySecondsRaw: '45', rawMatrixAndLegacy: matrix }),
    }));
    const actions = withDelay.automations[0].form.rules[0].actions;
    expect(actions[0]).toEqual({ type: 'action.delay', params: { seconds: 45 } });
  });

  // ─── (m) ───────────────────────────────────────────────────────────────────
  it('(m) translates every §4.5 token, leaving unmapped tokens verbatim', () => {
    const template = '{NUMBER_HOPS} {HOPS} {NODE_ID} {LONG_NAME} {SNR} {RSSI} {CHANNEL} {DATE} {TIME} {SHORT_NAME} {IP}';
    const input = baseInput({
      settings: baseSettings({ message: template, rawMatrixAndLegacy: matrixWith('directZeroHop', { reply: true }) }),
    });
    const result = buildAutoAckAutomations(input);
    const send = result.automations[0].form.rules[0].actions.find((a) => a.type === 'action.sendMessage')!;
    const text = send.params.text as string;
    expect(text).toContain('{{ trigger.hops }}');
    expect(text).toContain('{{ trigger.fromId }}');
    expect(text).toContain('{{ trigger.fromName }}');
    expect(text).toContain('{{ trigger.snr }}');
    expect(text).toContain('{{ trigger.rssi }}');
    expect(text).toContain('{{ trigger.channelName }}');
    expect(text).toContain('{{ NOW }}');
    expect(text).toContain('{SHORT_NAME}'); // left verbatim — no engine equivalent
    expect(text).toContain('{IP}'); // left verbatim
    expect(text).not.toContain('{NUMBER_HOPS}');
    expect(text).not.toContain('{NODE_ID}');

    const { report } = result;
    expect(report.notConvertible.some((e) => e.key === 'token-{SHORT_NAME}')).toBe(true);
    expect(report.notConvertible.some((e) => e.key === 'token-{IP}')).toBe(true);
    expect(report.converted.some((e) => e.key === 'token-{NODE_ID}')).toBe(true);
    expect(report.approximated.some((e) => e.key === 'token-{SNR}')).toBe(true);
    expect(report.approximated.some((e) => e.key === 'token-{NUMBER_HOPS}')).toBe(true);
    // {HOPS} translates to the same engine token as {NUMBER_HOPS} — a single report entry.
    expect(report.approximated.filter((e) => e.key === 'token-{NUMBER_HOPS}' || e.key === 'token-{HOPS}')).toHaveLength(2);
  });

  // ─── (n) ───────────────────────────────────────────────────────────────────
  it('(n) blank messageDirect falls back to message on ZeroHop cells', () => {
    const input = baseInput({
      settings: baseSettings({
        message: 'standard {NODE_ID}',
        messageDirect: undefined,
        rawMatrixAndLegacy: matrixWith('directZeroHop', { reply: true }),
      }),
    });
    const result = buildAutoAckAutomations(input);
    const send = result.automations[0].form.rules[0].actions.find((a) => a.type === 'action.sendMessage')!;
    expect(send.params.text).toContain('standard');
  });

  it('(n) a non-blank messageDirect is used on ZeroHop cells only, not MultiHop', () => {
    const matrix: AutoAckMatrix = {
      channelZeroHop: { reply: true, tapback: false, replyDm: false },
      channelMultiHop: { reply: true, tapback: false, replyDm: false },
      directZeroHop: { reply: false, tapback: false, replyDm: false },
      directMultiHop: { reply: false, tapback: false, replyDm: false },
    };
    const input = baseInput({
      settings: baseSettings({
        ...VALID_CHANNEL_ALLOWLIST,
        message: 'standard', messageDirect: 'direct-only', rawMatrixAndLegacy: matrixToSettings(matrix),
      }),
      channels: VALID_CHANNEL_ROWS,
    });
    const result = buildAutoAckAutomations(input);
    const chan = result.automations.find((a) => a.key === 'channel')!;
    const zeroHopRule = chan.form.rules.find((r) => r.conditions.some((c) => c.type === 'condition.numeric' && c.params.field === 'zeroHop' && c.params.value === '1'))!;
    const multiHopRule = chan.form.rules.find((r) => r.conditions.some((c) => c.type === 'condition.numeric' && c.params.field === 'zeroHop' && c.params.value === '0'))!;
    expect(zeroHopRule.actions.find((a) => a.type === 'action.sendMessage')!.params.text).toBe('direct-only');
    expect(multiHopRule.actions.find((a) => a.type === 'action.sendMessage')!.params.text).toBe('standard');
  });

  // ─── (o) ───────────────────────────────────────────────────────────────────
  it('(o) legacy fallback derives the same matrix computeMatrixValues() would, and reports it', () => {
    const legacy: Record<string, string | undefined> = {
      autoAckDirectMessages: 'true',
      autoAckUseDM: 'true',
      autoAckMultihopEnabled: 'false',
    };
    const expectedRaw = computeMatrixValues(legacy);
    const viaLegacy = buildAutoAckAutomations(baseInput({ settings: baseSettings({ rawMatrixAndLegacy: legacy }) }));
    const viaDirectMatrix = buildAutoAckAutomations(baseInput({ settings: baseSettings({ rawMatrixAndLegacy: expectedRaw }) }));

    expect(viaLegacy.automations).toEqual(viaDirectMatrix.automations);
    expect(viaLegacy.blocking).toBe(viaDirectMatrix.blocking);

    const entry = viaLegacy.report.converted.find((e) => e.key === 'legacy-matrix-derived');
    expect(entry).toBeDefined();
    expect(entry!.detail).toContain('autoAckDirectMessages');
    expect(entry!.detail).toContain('autoAckUseDM');
    expect(entry!.detail).toContain('autoAckMultihopEnabled');
    // The direct-matrix path never sees a legacy fallback.
    expect(viaDirectMatrix.report.converted.some((e) => e.key === 'legacy-matrix-derived')).toBe(false);
  });

  it('(o) no matrix keys and no legacy keys yields the all-off matrix (§2.2 case 3)', () => {
    const result = buildAutoAckAutomations(baseInput({ settings: baseSettings({ rawMatrixAndLegacy: {} }) }));
    expect(result.automations).toEqual([]);
    expect(result.blocking).toBe('NO_CELLS_ENABLED');
  });
});
