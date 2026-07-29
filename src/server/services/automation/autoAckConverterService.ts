/**
 * Auto-Acknowledge → Automation converter — DB-facing layer (#4340 Phase 4, WP3).
 *
 * Mirrors the existing `meshNodeData.ts` ↔ `engineContext.ts` split (spec §1.1):
 * this file does the `getSettingForSource` / `getAllChannels` / `getSource`
 * reads and hands a plain object to WP2's pure builder
 * (`buildAutoAckAutomations` in `autoAckConverter.ts`), so that file stays
 * unit-testable with literals and never imports `services/database.js`.
 *
 * See docs/internal/dev-notes/AUTOACK_CONVERTER_PHASE4_SPEC.md §2 (settings
 * resolution) and §4.7 (re-conversion detection).
 */
import databaseService from '../../../services/database.js';
import type { Source } from '../../../db/repositories/sources.js';
import type { AutomationRecord } from '../../../db/repositories/automations.js';
import { AUTOACK_CELLS, cellServerKeyPrefix } from '../../../utils/autoAckMatrix.js';
import { sourceProtocol } from './channelUnify.js';
import {
  buildAutoAckAutomations,
  type ResolvedAutoAck,
  type ConvertedAutomation,
  type ConversionReport,
  type AutoAckBlockingReason,
} from './autoAckConverter.js';

// ─── §2.1: the settings keys read ─────────────────────────────────────────

/**
 * The 10 base (non-matrix) Auto-Acknowledge keys read for every conversion
 * (spec §2.1's table minus the 12-key matrix row, which is derived below from
 * `AUTOACK_CELLS`/`cellServerKeyPrefix` — the same helpers `autoAckConverter.ts`
 * uses — rather than a hand-typed list).
 */
const BASE_KEYS = [
  'autoAckEnabled',
  'autoAckRegex',
  'autoAckMessage',
  'autoAckMessageDirect',
  'autoAckChannels',
  'autoAckSkipIncompleteNodes',
  'autoAckIgnoredNodes',
  'autoAckCooldownSeconds',
  'autoAckPreSendDelaySeconds',
  'autoAckMaxAttempts',
] as const;

/** The 12 `autoAck{Cell}{Reply,Tapback,ReplyDm}Enabled` matrix keys, derived (not hand-typed). */
const MATRIX_KEYS: string[] = AUTOACK_CELLS.flatMap((c) => {
  const prefix = cellServerKeyPrefix(c.id);
  return [`${prefix}ReplyEnabled`, `${prefix}TapbackEnabled`, `${prefix}ReplyDmEnabled`];
});

/**
 * §2.2's pre-093 legacy keys. Mirrors migration 093's own `LEGACY_SUFFIXES`
 * (minus `autoAckEnabled`, already read as a base key above) and
 * `autoAckConverter.ts`'s internal `LEGACY_KEYS` list. Neither list is
 * exported by its owner file, so the 8 key names are mirrored here as plain
 * data — `computeMatrixValues()` itself (the actual translation logic) is
 * imported, not reimplemented (spec §2.2).
 */
const LEGACY_KEYS = [
  'autoAckDirectMessages',
  'autoAckUseDM',
  'autoAckDirectEnabled',
  'autoAckDirectTapbackEnabled',
  'autoAckDirectReplyEnabled',
  'autoAckMultihopEnabled',
  'autoAckMultihopTapbackEnabled',
  'autoAckMultihopReplyEnabled',
] as const;

/**
 * Reads every Auto-Acknowledge setting `buildAutoAckAutomations()` needs for
 * `sourceId`, via `settings.getSettingForSource` only (spec §2.1) — no global
 * fallback, matching how Auto-Acknowledge itself reads these at runtime.
 */
export async function resolveAutoAckSettings(sourceId: string): Promise<ResolvedAutoAck> {
  const settings = databaseService.settings;
  const get = (key: string) => settings.getSettingForSource(sourceId, key);

  const [
    enabledRaw, regex, message, messageDirect, channelsRaw,
    skipIncompleteNodesRaw, ignoredNodesRaw, cooldownSecondsRaw,
    preSendDelaySecondsRaw, maxAttemptsRaw,
  ] = await Promise.all(BASE_KEYS.map(get));

  const matrixAndLegacyKeys = [...MATRIX_KEYS, ...LEGACY_KEYS];
  const matrixAndLegacyValues = await Promise.all(matrixAndLegacyKeys.map(get));
  const rawMatrixAndLegacy: Record<string, string | undefined> = {};
  matrixAndLegacyKeys.forEach((k, i) => {
    rawMatrixAndLegacy[k] = matrixAndLegacyValues[i] ?? undefined;
  });

  return {
    enabled: enabledRaw === 'true',
    regex: regex ?? undefined,
    message: message ?? undefined,
    messageDirect: messageDirect ?? undefined,
    channelsRaw: channelsRaw ?? undefined,
    skipIncompleteNodes: skipIncompleteNodesRaw === 'true',
    ignoredNodesRaw: ignoredNodesRaw ?? undefined,
    cooldownSecondsRaw: cooldownSecondsRaw ?? undefined,
    preSendDelaySecondsRaw: preSendDelaySecondsRaw ?? undefined,
    maxAttemptsRaw: maxAttemptsRaw ?? undefined,
    rawMatrixAndLegacy,
  };
}

// ─── Source resolution + the pure build ────────────────────────────────────

export type AutoAckConversionErrorCode = 'SOURCE_NOT_FOUND' | 'SOURCE_NOT_MESHTASTIC';

export interface AutoAckConversionContext {
  source: Source;
  automations: ConvertedAutomation[];
  report: ConversionReport;
  blocking?: AutoAckBlockingReason;
  /** The source's current `autoAckEnabled` value — surfaced in the preview response (§5.2). */
  autoAckEnabled: boolean;
}

export type AutoAckConversionOutcome =
  | { ok: true; context: AutoAckConversionContext }
  | { ok: false; code: AutoAckConversionErrorCode };

/**
 * Resolve `sourceId`'s current settings + channels and run them through
 * WP2's pure `buildAutoAckAutomations()`. Read-only — never writes.
 * Used by BOTH routes: `preview` calls it once, and `create` calls it again
 * to re-run the conversion from current settings rather than trusting a
 * client-supplied graph (spec §5.3).
 */
export async function convertAutoAckForSource(
  sourceId: string,
  now?: Date,
): Promise<AutoAckConversionOutcome> {
  const source = await databaseService.sources.getSource(sourceId);
  if (!source) return { ok: false, code: 'SOURCE_NOT_FOUND' };
  if (sourceProtocol(source.type) !== 'meshtastic') return { ok: false, code: 'SOURCE_NOT_MESHTASTIC' };

  const [settings, channelRows] = await Promise.all([
    resolveAutoAckSettings(sourceId),
    databaseService.channels.getAllChannels(sourceId),
  ]);
  const channels = channelRows.map((c) => ({ index: c.id, name: c.name, role: c.role ?? null }));

  const result = buildAutoAckAutomations({ sourceId, sourceName: source.name, settings, channels, now });

  return {
    ok: true,
    context: {
      source,
      automations: result.automations,
      report: result.report,
      blocking: result.blocking,
      autoAckEnabled: settings.enabled,
    },
  };
}

// ─── §4.7: re-conversion detection ─────────────────────────────────────────

export interface ExistingConversion {
  id: string;
  name: string;
  updatedAt: number;
  enabled: boolean;
  /** Parsed from the description's `Kind: (channel|direct).` line; null if unparseable (hand-edited). */
  kind: 'channel' | 'direct' | null;
}

/** Builds the same machine-readable marker prefix `autoAckConverter.ts`'s `buildDescription()` writes. */
export function autoAckConversionMarker(sourceId: string): string {
  return `Converted from Auto-Acknowledge (source ${sourceId})`;
}

const KIND_LINE_RE = /\nKind: (channel|direct)\./;

/**
 * Automations previously converted from this source's Auto-Acknowledge
 * config, detected by the description marker `buildDescription()` writes
 * (spec §4.7). A renamed/hand-edited description no longer matches and is
 * treated as un-converted, by design.
 */
export async function findExistingConversions(sourceId: string): Promise<ExistingConversion[]> {
  const marker = autoAckConversionMarker(sourceId);
  const all: AutomationRecord[] = await databaseService.automations.listAutomations();
  return all
    .filter((a) => (a.description ?? '').startsWith(marker))
    .map((a) => {
      const m = a.description ? KIND_LINE_RE.exec(a.description) : null;
      return {
        id: a.id,
        name: a.name,
        updatedAt: a.updatedAt,
        enabled: a.enabled,
        kind: (m?.[1] as 'channel' | 'direct' | undefined) ?? null,
      };
    });
}
