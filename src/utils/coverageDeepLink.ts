/**
 * Coverage Report deep-link build/parse (#5277 Phase 4a WP1).
 *
 * `/reports?report=coverage&sender=…&range=24h[&survey=…]`. Pure, no router
 * dependency — `AnalysisTab.tsx` (WP4) calls `parseCoverageDeepLink` with
 * `useSearchParams()`'s value; `ShowCoverageLink.tsx` (WP5) calls
 * `buildCoverageReportPath`. See `COVERAGE_P4_SPEC.md` §2a.5.
 *
 * Untrusted input (URL query params) is validated strictly: anything that
 * doesn't match the expected shape is dropped rather than passed through —
 * in particular, a bad `sender` must never reach the `/receptions` API.
 *
 * `src/utils/**` is in `tsconfig.server.json`'s include set, so relative
 * imports need an explicit `.js` extension (#4596).
 */
import type { CoverageDeepLink } from '../types/coverageAnalysis.js';
import type { CoverageRangePreset } from './coverageTimeRange.js';
import { COVERAGE_RANGE_PRESET_MS } from './coverageTimeRange.js';
import { isMeshCorePubKeyId } from './coverage.js';

type NonCustomRangePreset = Exclude<CoverageRangePreset, 'custom'>;

const VALID_RANGE_IDS = new Set<string>(Object.keys(COVERAGE_RANGE_PRESET_MS));

/** `!xxxxxxxx`, lowercase hex. */
const MESHTASTIC_SENDER_RE = /^![0-9a-f]{8}$/;

/** Loose RFC 4122 shape (any version/variant) — good enough for a wire id we only echo back to the survey API, which does the real validation. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isValidSenderId(lowered: string): boolean {
  return MESHTASTIC_SENDER_RE.test(lowered) || isMeshCorePubKeyId(lowered);
}

/**
 * Build the coverage report path for `link`. Always includes `report=coverage`.
 * `sender` is lower-cased (canonical form); fields left undefined are omitted
 * from the query string entirely (no `sender=` / `range=` / `survey=` with an
 * empty value).
 */
export function buildCoverageReportPath(link: CoverageDeepLink): string {
  const params = new URLSearchParams();
  params.set('report', 'coverage');
  if (link.sender) params.set('sender', link.sender.toLowerCase());
  if (link.range) params.set('range', link.range);
  if (link.survey) params.set('survey', link.survey);
  return `/reports?${params.toString()}`;
}

/**
 * Parse `params` into a {@link CoverageDeepLink}, or `null` when
 * `report` isn't `'coverage'` (lets `AnalysisTab` ignore every other
 * `report=` value it doesn't own).
 *
 * - `sender`: accepted only as `^![0-9a-f]{8}$` (case-insensitive, stored
 *   lower-cased) or a MeshCore pubkey id ({@link isMeshCorePubKeyId}, also
 *   lower-cased). Anything else is silently dropped — never forwarded to the
 *   API.
 * - `range`: accepted only as one of the non-`'custom'` `CoverageRangePreset`
 *   ids (`COVERAGE_RANGE_PRESET_MS`'s keys). Anything else is dropped.
 * - `survey` (P4b): accepted as a UUID-shaped string; P4a parses it (so the
 *   type round-trips) but the P4a report does not act on it. Anything else
 *   is dropped.
 */
export function parseCoverageDeepLink(params: URLSearchParams): CoverageDeepLink | null {
  if (params.get('report') !== 'coverage') return null;

  const link: CoverageDeepLink = {};

  const senderRaw = params.get('sender');
  if (senderRaw) {
    const lowered = senderRaw.toLowerCase();
    if (isValidSenderId(lowered)) link.sender = lowered;
  }

  const rangeRaw = params.get('range');
  if (rangeRaw && VALID_RANGE_IDS.has(rangeRaw)) {
    link.range = rangeRaw as NonCustomRangePreset;
  }

  const surveyRaw = params.get('survey');
  if (surveyRaw && UUID_RE.test(surveyRaw)) {
    link.survey = surveyRaw;
  }

  return link;
}
