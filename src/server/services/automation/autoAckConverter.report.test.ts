/**
 * `buildAutoAckAutomations()` report tests (#4340 Phase 4, WP2, spec §7).
 *
 * Cross-checks the conversion report against the same 33-key `autoAck*`
 * surface `autoAckParity.test.ts` enforces (`VALID_SETTINGS_KEYS`, filtered).
 * `AUTOACK_PARITY` itself (autoAckParity.test.ts) is a private const in a file
 * WP2 does not own and must not edit, so the notConvertible/deprecated
 * classification is mirrored here as literal data rather than imported —
 * exactly the same 12 keys (2 notConvertible-by-status, 10 deprecated) that
 * file's own `EXPECTED_DEPRECATED_KEYS`/`autoAckTestMessages` assertions pin.
 * Any drift between the two copies would show up as a report acceptance
 * failure here or a parity failure there — see spec §11 exit criteria.
 */
import { describe, it, expect } from 'vitest';
import { buildAutoAckAutomations, type AutoAckConverterInput } from './autoAckConverter.js';
import { VALID_SETTINGS_KEYS } from '../../constants/settings.js';
import { matrixToSettings, type AutoAckMatrix } from '../../../utils/autoAckMatrix.js';

const AUTOACK_KEYS = (VALID_SETTINGS_KEYS as readonly string[]).filter((k) => k.startsWith('autoAck'));

/** Rows whose `autoAckParity.test.ts` status is 'notConvertible'. */
const PARITY_NOT_CONVERTIBLE_KEYS = ['autoAckTestMessages'];

/** Rows whose `autoAckParity.test.ts` status is 'deprecated' (== EXPECTED_DEPRECATED_KEYS there). */
const PARITY_DEPRECATED_KEYS = [
  'autoAckDirectMessages',
  'autoAckUseDM',
  'autoAckDirectEnabled',
  'autoAckDirectTapbackEnabled',
  'autoAckDirectReplyEnabled',
  'autoAckMultihopEnabled',
  'autoAckMultihopTapbackEnabled',
  'autoAckMultihopReplyEnabled',
  'autoAckTapbackEnabled',
  'autoAckReplyEnabled',
].sort();

describe('report cross-check sanity', () => {
  it('every pinned key is one of the 33 autoAck* VALID_SETTINGS_KEYS entries', () => {
    for (const key of [...PARITY_NOT_CONVERTIBLE_KEYS, ...PARITY_DEPRECATED_KEYS]) {
      expect(AUTOACK_KEYS, `${key} missing from VALID_SETTINGS_KEYS`).toContain(key);
    }
    expect(AUTOACK_KEYS.length).toBe(33);
  });
});

describe('buildAutoAckAutomations report (maximal config)', () => {
  // A source with every failure mode + every token bucket + a legacy-free, fully populated
  // matrix, so every possible report entry fires in one pass.
  const fullMatrix: AutoAckMatrix = {
    channelZeroHop: { reply: true, tapback: true, replyDm: true },
    channelMultiHop: { reply: true, tapback: true, replyDm: false },
    directZeroHop: { reply: true, tapback: true, replyDm: false },
    directMultiHop: { reply: true, tapback: true, replyDm: false },
  };

  const messageTemplate =
    '{NUMBER_HOPS} {HOPS} hops from {NODE_ID} ({LONG_NAME}), snr {SNR} rssi {RSSI} on {CHANNEL} at {DATE} {TIME} — '
    + '{SHORT_NAME} {RABBIT_HOPS} {LAST_HOP} {TRANSPORT} {VERSION} {DURATION} {FEATURES} {NODECOUNT} {DIRECTCOUNT} {IP} {PORT}';

  const input: AutoAckConverterInput = {
    sourceId: 'src-maximal',
    sourceName: 'Maximal Source',
    now: new Date('2026-07-28T00:00:00Z'),
    channels: [
      { index: 0, name: 'gauntlet', role: 1 },
      // index 1 intentionally missing
      { index: 2, name: 'Disabled Slot', role: 0 },
      { index: 3, name: '   ', role: 1 },
      { index: 6, name: 'Secondary', role: 1 },
      { index: 7, name: 'secondary', role: 1 },
    ],
    settings: {
      enabled: true,
      regex: '^(test|ping|range)',
      message: messageTemplate,
      messageDirect: 'Direct: {NODE_ID}',
      channelsRaw: '0,1,2,3,6,7',
      skipIncompleteNodes: true,
      ignoredNodesRaw: '!deadbeef, deadbee1, nothexatall',
      cooldownSecondsRaw: '90',
      preSendDelaySecondsRaw: '15',
      maxAttemptsRaw: '3',
      rawMatrixAndLegacy: matrixToSettings(fullMatrix),
    },
  };

  const result = buildAutoAckAutomations(input);

  it('is not blocked and produces both automations', () => {
    expect(result.blocking).toBeUndefined();
    expect(result.automations).toHaveLength(2);
  });

  it('names every parity row with status notConvertible, by key', () => {
    for (const key of PARITY_NOT_CONVERTIBLE_KEYS) {
      expect(result.report.notConvertible.some((e) => e.key === key), `missing notConvertible entry for ${key}`).toBe(true);
    }
  });

  it('additionally pins autoAckMaxAttempts in notConvertible (a converter decision, not a parity-status row)', () => {
    const entry = result.report.notConvertible.find((e) => e.key === 'autoAckMaxAttempts');
    expect(entry, 'missing notConvertible entry for autoAckMaxAttempts').toBeDefined();
    expect(entry!.detail.toLowerCase()).toContain('queue');
  });

  it('names every parity row with status deprecated, by key, in dropped', () => {
    const droppedKeys = result.report.dropped.map((e) => e.key).sort();
    expect(droppedKeys).toEqual(PARITY_DEPRECATED_KEYS);
  });

  it('names every channel failure mode by key', () => {
    expect(result.report.notConvertible.some((e) => e.key === 'channel-1-missing')).toBe(true);
    expect(result.report.notConvertible.some((e) => e.key === 'channel-2-disabled')).toBe(true);
    expect(result.report.notConvertible.some((e) => e.key === 'channel-3-unnamed')).toBe(true);
    expect(result.report.approximated.some((e) => e.key === 'channel-name-collision')).toBe(true);
  });

  it('names every untranslatable token by key in notConvertible', () => {
    for (const token of ['{SHORT_NAME}', '{RABBIT_HOPS}', '{LAST_HOP}', '{TRANSPORT}', '{VERSION}', '{DURATION}', '{FEATURES}', '{NODECOUNT}', '{DIRECTCOUNT}', '{IP}', '{PORT}']) {
      expect(result.report.notConvertible.some((e) => e.key === `token-${token}`), `missing notConvertible entry for token ${token}`).toBe(true);
    }
  });

  it('names every approximated token by key', () => {
    for (const token of ['{NUMBER_HOPS}', '{HOPS}', '{LONG_NAME}', '{SNR}', '{RSSI}', '{CHANNEL}', '{DATE}', '{TIME}']) {
      expect(result.report.approximated.some((e) => e.key === `token-${token}`), `missing approximated entry for token ${token}`).toBe(true);
    }
  });

  it('names the converted NODE_ID token', () => {
    expect(result.report.converted.some((e) => e.key === 'token-{NODE_ID}')).toBe(true);
  });

  it('reports the discarded ignore-list token', () => {
    expect(result.report.approximated.some((e) => e.key === 'ignored-node-unparseable' && e.detail.includes('nothexatall'))).toBe(true);
  });

  it('reports the pre-send delay as approximated', () => {
    expect(result.report.approximated.some((e) => e.key === 'autoAckPreSendDelaySeconds')).toBe(true);
  });

  it('reports skipIncompleteNodes and ignoredNodes as converted', () => {
    expect(result.report.converted.some((e) => e.key === 'autoAckSkipIncompleteNodes')).toBe(true);
    expect(result.report.converted.some((e) => e.key === 'autoAckIgnoredNodes')).toBe(true);
  });

  it('does not report a legacy-matrix-derived entry (matrix keys were present)', () => {
    expect(result.report.converted.some((e) => e.key === 'legacy-matrix-derived')).toBe(false);
  });
});
