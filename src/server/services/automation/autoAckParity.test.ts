/**
 * Auto-Acknowledge ↔ Automation Engine parity (#4340 Phase 3, WP5).
 *
 * This is the phase's EXIT CRITERION, not a nicety. `AUTOACK_PARITY` below is
 * an in-code copy of the mapping table in
 * `docs/internal/dev-notes/AUTOACK_PARITY_PHASE3_SPEC.md` §2, which is itself
 * pasted verbatim into `docs/internal/dev-notes/AUTOACK_AUTOMATION_EPIC.md`
 * under the "Phase 3 close" notes. All three copies must describe the same 33
 * `autoAck*` settings keys. If you change one, change all three.
 *
 * The tests below make the parity claim MECHANICAL:
 *  - it fails if a row is deleted from this table while its key is still in
 *    `VALID_SETTINGS_KEYS` (a) below;
 *  - it fails the moment a new `autoAck*` key is added to
 *    `VALID_SETTINGS_KEYS` without a corresponding row here (a);
 *  - every `type:`/`param:`/`field:`/`op:` reference embedded in a row's
 *    `engine` array is cross-checked against the SHIPPED catalog
 *    (`src/components/automations/catalog.ts`) and engine vocabulary
 *    (`src/types/automation.ts`), not against the spec — so a catalog rename
 *    breaks this file, not just the docs.
 *
 * This table is Phase 4's input: the AutoAck → Automation converter reads the
 * `status` and `engine` columns to know what it must emit.
 */
import { describe, it, expect } from 'vitest';
import { VALID_SETTINGS_KEYS, PER_SOURCE_SETTINGS_KEYS } from '../../constants/settings.js';
import {
  TRIGGER_TYPES,
  CONDITION_TYPES,
  ACTION_TYPES,
  SEND_MAX_ATTEMPTS_MIN,
  SEND_MAX_ATTEMPTS_MAX,
  type NumericOp,
} from '../../../types/automation.js';
import {
  BLOCK_BY_TYPE,
  numericFields,
  stringFields,
  STRING_OP_OPTIONS,
} from '../../../components/automations/catalog.js';

/**
 * Mirrors NUMERIC_OP_OPTIONS in src/components/automations/catalog.ts (not
 * exported there — only STRING_OP_OPTIONS is, per §5.1 of the Phase 3 spec).
 * Typed against `NumericOp` so a change to that union fails this file at
 * compile time rather than silently going stale.
 */
const NUMERIC_OPS: readonly NumericOp[] = ['==', '!=', '>', '<', '>=', '<='];

type ParityStatus = 'exists' | 'phase3' | 'deprecated' | 'notConvertible';

interface ParityRow {
  /** Membership in PER_SOURCE_SETTINGS_KEYS. */
  perSource: boolean;
  status: ParityStatus;
  /**
   * Free-form description PLUS zero or more machine-checked references:
   *   'type:<TriggerType|ConditionType|ActionType>'
   *   'param:<blockType>.<FieldDef.name>'   (FieldDef.name in that block's fields)
   *   'field:<name>'                        (a numericFields/stringFields('trigger.message') option)
   *   'op:<value>'                          (a STRING_OP_OPTIONS/NUMERIC_OPS value)
   * Untagged strings are documentation only and are not validated.
   */
  engine: string[];
}

/**
 * §2 of AUTOACK_PARITY_PHASE3_SPEC.md, verbatim. 33 keys — every
 * `VALID_SETTINGS_KEYS` entry beginning `autoAck`.
 */
const AUTOACK_PARITY: Record<string, ParityRow> = {
  // 1
  autoAckEnabled: {
    perSource: true, status: 'exists',
    engine: ["the automation's own enabled column", 'type:condition.sourceFilter'],
  },
  // 2 — AutoAck defaults to ^(test|ping) when blank; the engine's blank regex means
  // "match anything". Converter must emit the literal default.
  autoAckRegex: {
    perSource: true, status: 'exists',
    engine: ['type:trigger.message', 'param:trigger.message.regex'],
  },
  // 3 — token dialects differ ({NUMBER_HOPS}/{TIME}/{NODE_NAME} vs {{ trigger.hops }}/
  // {{ NOW }}/{{ trigger.fromName }}); Phase 4 translation work.
  autoAckMessage: {
    perSource: true, status: 'exists',
    engine: ['type:action.sendMessage', 'param:action.sendMessage.text'],
  },
  // 4 — a second action.sendMessage on the ZeroHop+RespondViaDM branch.
  autoAckMessageDirect: {
    perSource: true, status: 'exists',
    engine: ['type:action.sendMessage', 'param:action.sendMessage.text'],
  },
  // 5 — AutoAck stores channel indices; trigger.message.channels is unified by name.
  autoAckChannels: {
    perSource: true, status: 'exists',
    engine: ['type:trigger.message', 'param:trigger.message.channels'],
  },
  // 6 — deprecated; migration 093 folds it into the Direct* cells.
  autoAckDirectMessages: { perSource: true, status: 'deprecated', engine: [] },
  // 7 — deprecated; folded into the *ReplyDmEnabled cells.
  autoAckUseDM: { perSource: true, status: 'deprecated', engine: [] },
  // 8 — tri-state required for fidelity: AutoAck skips only when the row EXISTS
  // and is incomplete. `complete, unknown` reproduces that exactly (§9.1).
  autoAckSkipIncompleteNodes: {
    perSource: true, status: 'phase3',
    engine: ['type:condition.string', 'field:node.completeness', 'op:in'],
  },
  // 9 — in/notIn split on the same separators + casing as AutoAck's own parser.
  // Converter normalises each entry to canonical !xxxxxxxx.
  autoAckIgnoredNodes: {
    perSource: true, status: 'phase3',
    engine: ['type:condition.string', 'field:fromId', 'op:notIn'],
  },
  // 10 — global-only (NOT in PER_SOURCE_SETTINGS_KEYS); deprecated.
  autoAckTapbackEnabled: { perSource: false, status: 'deprecated', engine: [] },
  // 11 — global-only; deprecated.
  autoAckReplyEnabled: { perSource: false, status: 'deprecated', engine: [] },
  // 12-17 — deprecated; migration 093 folds these hop-only keys into the 2x2 matrix.
  autoAckDirectEnabled: { perSource: true, status: 'deprecated', engine: [] },
  autoAckDirectTapbackEnabled: { perSource: true, status: 'deprecated', engine: [] },
  autoAckDirectReplyEnabled: { perSource: true, status: 'deprecated', engine: [] },
  autoAckMultihopEnabled: { perSource: true, status: 'deprecated', engine: [] },
  autoAckMultihopTapbackEnabled: { perSource: true, status: 'deprecated', engine: [] },
  autoAckMultihopReplyEnabled: { perSource: true, status: 'deprecated', engine: [] },
  // 18 — NOT CONVERTIBLE, AND DOES NOT NEED TO BE. No server code reads this key —
  // it is a UI scratchpad on AutoAcknowledgeSection.tsx for pasting sample text.
  // Its "engine analogue" (the Test panel) is a mechanism, not a setting, so there
  // is deliberately no equivalent recorded here.
  autoAckTestMessages: { perSource: false, status: 'notConvertible', engine: [] },
  // 19 — AutoAck's default is 60s when unset; the engine's is 0. Converter must
  // emit 60 explicitly. cooldownScope:'node' is mandatory (AutoAck keys by fromNum).
  autoAckCooldownSeconds: {
    perSource: true, status: 'exists',
    engine: ['type:trigger.message', 'param:trigger.message.cooldownSeconds', 'param:trigger.message.cooldownScope'],
  },
  // 20 — AutoAck's delay is non-blocking and independently applied to tapback+reply;
  // action.delay blocks its own run and caps at 300s. A converted chain needs it once.
  autoAckPreSendDelaySeconds: {
    perSource: true, status: 'exists',
    engine: ['type:action.delay', 'param:action.delay.seconds'],
  },
  // 21 — READ THIS ROW CAREFULLY. checkAutoAcknowledge NEVER reads this setting.
  // MessageQueueService.resolveDmMaxAttempts() reads it per-source and applies it
  // to EVERY queued DM on that source (auto-responder, welcome, mailbox, AND the
  // AutoAck reply when — and only when — that reply is a DM). AutoAck's own
  // tapback hardcodes 1 ("tapbacks are best-effort, don't retry") and its channel
  // sends hardcode 1 too (messageQueueService.ts). So maxAttempts on
  // action.sendMessage was NOT required for converter fidelity — the user was
  // shown that trade-off explicitly (spec §9.2, orchestrator sign-off) and chose
  // to ship it anyway, as a capability in its own right, not a parity gap-filler.
  // Converting AutoAck itself does not need to touch this row: the setting keeps
  // governing the source's OTHER queued DMs after conversion regardless.
  autoAckMaxAttempts: {
    perSource: true, status: 'phase3',
    engine: ['type:action.sendMessage', 'param:action.sendMessage.maxAttempts'],
  },
  // 22 — cell = isDM==0 AND hops==0 AND viaMqtt==0. Phase 3 adds isDM/viaMqtt to
  // the field picker (they already resolved at runtime, but a converter-written
  // value rendered blank and was clobbered on first edit — see spec §9 finding 4).
  autoAckChannelZeroHopReplyEnabled: {
    perSource: true, status: 'phase3',
    engine: ['type:action.sendMessage', 'field:isDM', 'field:viaMqtt', 'field:hops', 'op:=='],
  },
  // 23 — same cell → action.tapback emojiMode:'hopCount'.
  autoAckChannelZeroHopTapbackEnabled: {
    perSource: true, status: 'exists',
    engine: ['type:action.tapback', 'param:action.tapback.emojiMode'],
  },
  // 24 — that cell's action.sendMessage gets to: {{ trigger.from }}.
  autoAckChannelZeroHopReplyDmEnabled: {
    perSource: true, status: 'exists',
    engine: ['type:action.sendMessage', 'param:action.sendMessage.to'],
  },
  // 25 — cell = isDM==0 AND NOT(hops==0 AND viaMqtt==0). See spec §3.6: the
  // hops>0 BRANCH (not two independent conditions) is required so a packet
  // with no hop info (undefined → NaN) still lands in ZeroHop, matching AutoAck.
  autoAckChannelMultiHopReplyEnabled: {
    perSource: true, status: 'phase3',
    engine: ['type:action.sendMessage', 'field:isDM', 'field:viaMqtt', 'field:hops', 'op:=='],
  },
  autoAckChannelMultiHopTapbackEnabled: {
    perSource: true, status: 'exists',
    engine: ['type:action.tapback', 'param:action.tapback.emojiMode'],
  },
  autoAckChannelMultiHopReplyDmEnabled: {
    perSource: true, status: 'exists',
    engine: ['type:action.sendMessage', 'param:action.sendMessage.to'],
  },
  // 28 — cell = isDM==1 AND hops==0 AND viaMqtt==0.
  autoAckDirectZeroHopReplyEnabled: {
    perSource: true, status: 'phase3',
    engine: ['type:action.sendMessage', 'field:isDM', 'field:viaMqtt', 'field:hops', 'op:=='],
  },
  autoAckDirectZeroHopTapbackEnabled: {
    perSource: true, status: 'exists',
    engine: ['type:action.tapback', 'param:action.tapback.emojiMode'],
  },
  // 30 — no-op for Direct cells (a DM reply is inherently a DM); converter emits
  // to: {{ trigger.from }} regardless.
  autoAckDirectZeroHopReplyDmEnabled: {
    perSource: true, status: 'exists',
    engine: ['param:action.sendMessage.to'],
  },
  autoAckDirectMultiHopReplyEnabled: {
    perSource: true, status: 'phase3',
    engine: ['type:action.sendMessage', 'field:isDM', 'field:viaMqtt', 'field:hops', 'op:=='],
  },
  autoAckDirectMultiHopTapbackEnabled: {
    perSource: true, status: 'exists',
    engine: ['type:action.tapback', 'param:action.tapback.emojiMode'],
  },
  autoAckDirectMultiHopReplyDmEnabled: {
    perSource: true, status: 'exists',
    engine: ['param:action.sendMessage.to'],
  },
};

/**
 * Deprecated by migration 093 (src/server/migrations/093_autoack_matrix.ts).
 * Mirrors its `LEGACY_SUFFIXES` array (:29-36 there — everything EXCEPT
 * `autoAckEnabled`, which the migration reads as an input signal but does not
 * itself deprecate) plus the two global-only DM-routing keys
 * (`autoAckTapbackEnabled`, `autoAckReplyEnabled`) that predate the matrix and
 * are NOT in `LEGACY_SUFFIXES` because they are global-only, never per-source,
 * so the migration's per-source translation never touches them (spec §9
 * finding 7). Hardcoded rather than imported: this test owns only itself, and
 * `093_autoack_matrix.ts` does not export `LEGACY_SUFFIXES`.
 */
const EXPECTED_DEPRECATED_KEYS = [
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

describe('autoAckParity (#4340 Phase 3 exit criterion)', () => {
  const settingsAutoAckKeys = (VALID_SETTINGS_KEYS as readonly string[]).filter((k) => k.startsWith('autoAck'));
  const tableKeys = Object.keys(AUTOACK_PARITY);

  it('(a) has exactly one row per autoAck* key in VALID_SETTINGS_KEYS, both directions', () => {
    // A key removed from AUTOACK_PARITY while still in VALID_SETTINGS_KEYS...
    const missingFromTable = settingsAutoAckKeys.filter((k) => !tableKeys.includes(k));
    expect(missingFromTable, `keys in VALID_SETTINGS_KEYS but missing from AUTOACK_PARITY: ${missingFromTable.join(', ')}`).toEqual([]);
    // ...and a new autoAck* key added to VALID_SETTINGS_KEYS without a row here.
    const extraInTable = tableKeys.filter((k) => !settingsAutoAckKeys.includes(k));
    expect(extraInTable, `keys in AUTOACK_PARITY but not in VALID_SETTINGS_KEYS: ${extraInTable.join(', ')}`).toEqual([]);
    expect(tableKeys.length).toBe(33);
  });

  it('perSource flag matches PER_SOURCE_SETTINGS_KEYS membership for every row', () => {
    const perSourceSet = new Set(PER_SOURCE_SETTINGS_KEYS as readonly string[]);
    for (const [key, row] of Object.entries(AUTOACK_PARITY)) {
      expect(perSourceSet.has(key), `${key}.perSource=${row.perSource} but PER_SOURCE_SETTINGS_KEYS membership is ${perSourceSet.has(key)}`).toBe(row.perSource);
    }
  });

  describe('every tagged engine reference resolves against the shipped catalog', () => {
    const allNodeTypes = new Set<string>([...TRIGGER_TYPES, ...CONDITION_TYPES, ...ACTION_TYPES]);
    // trigger.message is the trigger every convertible row is expressed under.
    const flatNumericFields = new Set(numericFields('trigger.message').flatMap((g) => g.options.map((o) => o.value)));
    const flatStringFields = new Set(stringFields('trigger.message').flatMap((g) => g.options.map((o) => o.value)));
    const stringOps = new Set(STRING_OP_OPTIONS.map((o) => o.value));
    const numericOps = new Set<string>(NUMERIC_OPS);

    for (const [key, row] of Object.entries(AUTOACK_PARITY)) {
      for (const ref of row.engine) {
        if (ref.startsWith('type:')) {
          const type = ref.slice('type:'.length);
          it(`${key}: type "${type}" is a real TriggerType/ConditionType/ActionType`, () => {
            expect(allNodeTypes.has(type)).toBe(true);
          });
        } else if (ref.startsWith('param:')) {
          const path = ref.slice('param:'.length);
          // LAST dot: blockType itself is dotted (e.g. "trigger.message", "action.sendMessage").
          const dot = path.lastIndexOf('.');
          const blockType = path.slice(0, dot);
          const fieldName = path.slice(dot + 1);
          it(`${key}: param "${path}" is a real FieldDef.name on ${blockType}`, () => {
            const block = BLOCK_BY_TYPE[blockType];
            expect(block, `no BLOCK_BY_TYPE entry for "${blockType}"`).toBeDefined();
            expect(block.fields.some((f) => f.name === fieldName), `${blockType} has no field named "${fieldName}"`).toBe(true);
          });
        } else if (ref.startsWith('field:')) {
          const field = ref.slice('field:'.length);
          it(`${key}: field "${field}" is offered by numericFields/stringFields('trigger.message')`, () => {
            expect(flatNumericFields.has(field) || flatStringFields.has(field), `"${field}" not found in either field group`).toBe(true);
          });
        } else if (ref.startsWith('op:')) {
          const op = ref.slice('op:'.length);
          it(`${key}: op "${op}" is a real STRING_OP_OPTIONS or NUMERIC_OPS value`, () => {
            expect(stringOps.has(op) || numericOps.has(op), `"${op}" not found in either operator set`).toBe(true);
          });
        }
      }
    }
  });

  it('(f) deprecated rows are exactly migration 093\'s legacy keys + the two global-only DM-routing keys', () => {
    const actualDeprecated = Object.entries(AUTOACK_PARITY)
      .filter(([, row]) => row.status === 'deprecated')
      .map(([key]) => key)
      .sort();
    expect(actualDeprecated).toEqual(EXPECTED_DEPRECATED_KEYS);
  });

  it('(g) SEND_MAX_ATTEMPTS_MIN/MAX are 1/3, pinning the duplication of MessageQueueService\'s clamp', () => {
    expect(SEND_MAX_ATTEMPTS_MIN).toBe(1);
    expect(SEND_MAX_ATTEMPTS_MAX).toBe(3);
  });

  it('(h) every "exists" or "phase3" row names at least one engine reference (no empty promises)', () => {
    const emptyPromises = Object.entries(AUTOACK_PARITY)
      .filter(([, row]) => (row.status === 'exists' || row.status === 'phase3') && row.engine.length === 0)
      .map(([key]) => key);
    expect(emptyPromises).toEqual([]);
  });

  it('notConvertible/deprecated rows carry no engine reference (nothing to fake)', () => {
    const fakedPromises = Object.entries(AUTOACK_PARITY)
      .filter(([, row]) => (row.status === 'notConvertible' || row.status === 'deprecated') && row.engine.length > 0)
      .map(([key]) => key);
    expect(fakedPromises).toEqual([]);
  });

  it('autoAckTestMessages is documented honestly: global, not convertible, no engine claim', () => {
    const row = AUTOACK_PARITY.autoAckTestMessages;
    expect(row.perSource).toBe(false);
    expect(row.status).toBe('notConvertible');
    expect(row.engine).toEqual([]);
  });

  it('autoAckMaxAttempts is a Phase 3 capability, not a converter-fidelity requirement, and stays per-source', () => {
    const row = AUTOACK_PARITY.autoAckMaxAttempts;
    expect(row.perSource).toBe(true);
    expect(row.status).toBe('phase3');
    expect(row.engine).toContain('param:action.sendMessage.maxAttempts');
  });
});
