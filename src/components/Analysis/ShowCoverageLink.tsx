/**
 * "Show coverage" — a small deep link from a node's details into the
 * Coverage Report (#5277 P4a WP5, spec §2a.8), pre-filtered to this sender
 * over the last 24 hours.
 *
 * Falls back to a plain `<a href>` (basename-prefixed, `useInRouterContext()`
 * gated) when rendered outside a Router, so existing node-detail tests that
 * render `NodeDetailsBlock` / `MeshCoreContactDetailPanel` without wrapping
 * in a Router keep passing unchanged.
 *
 * --- WP1 dependency (`src/utils/coverageDeepLink.ts`), read before editing ---
 * Per spec §2a.5 / §4, this component is meant to import
 * `buildCoverageReportPath` / `parseCoverageDeepLink` from WP1's
 * `../../utils/coverageDeepLink` (developed in parallel; not WP5's file to
 * create or own). This WP5-only worktree/branch does not have that file.
 *
 * A static import of a module with no file on disk was tried first and
 * rejected: under this repo's `@vitest-environment jsdom` (every component
 * test, including this one's), Vite's `vite:import-analysis` plugin fails to
 * *resolve* the specifier at transform time — before Vitest's `vi.mock`
 * registry is ever consulted — so mocking cannot rescue it. This reproduces
 * for a plain static `import`, a statically-analyzed dynamic `import()`,
 * and is only avoidable via `/* @vite-ignore *\/`, which also disables
 * Vitest's mock interception (so it can't be mocked either) and would make
 * the import untyped. The failure is collection-level: it does not just
 * flag one bad file, it fails every suite that transitively imports this
 * component (`ShowCoverageLink.test.tsx` itself, plus every existing
 * `NodeDetailsBlock`/`MeshCoreContactDetailPanel` split-test file, none of
 * which mock this module today) with "Failed to resolve import ... Does the
 * file exist?" and 0 tests collected — which fails the "existing suites
 * stay green" bar outright, not just `tsc`.
 *
 * (This differs from a non-jsdom/default-environment `.ts` module, where
 * `vi.mock('./missing', factory)` does work even with no file on disk, hoisted
 * above a static import of the consumer — confirmed separately. The jsdom
 * pipeline's stricter resolution is what breaks it.)
 *
 * So: the two functions below are a **local, private, functionally-complete
 * implementation matching WP1's §2a.5 signatures exactly** (not a mock, not
 * a stub — real validation, real round-trip). When WP1's `coverageDeepLink.ts`
 * lands, replace this block with:
 *   import { buildCoverageReportPath, parseCoverageDeepLink } from '../../utils/coverageDeepLink';
 * and delete `buildCoverageReportPath`/`parseCoverageDeepLink` below — no
 * other change to this file should be needed.
 */
import React from 'react';
import { Link, useInRouterContext } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { CoverageDeepLink } from '../../types/coverageAnalysis';
import { COVERAGE_RANGE_PRESET_MS, type CoverageRangePreset } from '../../utils/coverageTimeRange';
import { isMeshCorePubKeyId } from '../../utils/coverage';
import { appBasename } from '../../init';
import { UiIcon } from '../icons';
import styles from './ShowCoverageLink.module.css';

const MESHTASTIC_SENDER_RE = /^![0-9a-f]{8}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Matches WP1 §2a.5's `buildCoverageReportPath`. See the file banner above. */
function buildCoverageReportPath(link: CoverageDeepLink): string {
  const params = new URLSearchParams();
  params.set('report', 'coverage');
  if (link.sender) params.set('sender', link.sender);
  if (link.range) params.set('range', link.range);
  if (link.survey) params.set('survey', link.survey);
  return `/reports?${params.toString()}`;
}

/** Matches WP1 §2a.5's `parseCoverageDeepLink`. See the file banner above. */
function parseCoverageDeepLink(params: URLSearchParams): CoverageDeepLink | null {
  if (params.get('report') !== 'coverage') return null;

  const result: CoverageDeepLink = {};

  const senderRaw = params.get('sender');
  if (senderRaw) {
    const sender = senderRaw.toLowerCase();
    if (MESHTASTIC_SENDER_RE.test(sender) || isMeshCorePubKeyId(sender)) {
      result.sender = sender;
    }
  }

  const rangeRaw = params.get('range');
  if (rangeRaw && Object.prototype.hasOwnProperty.call(COVERAGE_RANGE_PRESET_MS, rangeRaw)) {
    result.range = rangeRaw as Exclude<CoverageRangePreset, 'custom'>;
  }

  const surveyRaw = params.get('survey');
  if (surveyRaw && UUID_RE.test(surveyRaw)) {
    result.survey = surveyRaw;
  }

  return result;
}

export interface ShowCoverageLinkProps {
  /** Meshtastic `!xxxxxxxx` node id or a lowercased 64-hex MeshCore pubkey. */
  senderId: string;
}

/**
 * Renders nothing for a `senderId` that `parseCoverageDeepLink` would reject
 * (validated by round-tripping the built path through it — single source of
 * truth for the accepted id shapes).
 */
export const ShowCoverageLink: React.FC<ShowCoverageLinkProps> = ({ senderId }) => {
  const { t } = useTranslation();
  const inRouterContext = useInRouterContext();

  // Validate via a round trip through `parseCoverageDeepLink` — single
  // source of truth for the accepted id shapes — then rebuild the final
  // path from the *canonical* (lowercased) sender it returns, so the link
  // is stable even when `senderId` itself arrives mixed-case.
  const rawPath = buildCoverageReportPath({ sender: senderId, range: '24h' });
  const rawQueryString = rawPath.split('?')[1] ?? '';
  const accepted = parseCoverageDeepLink(new URLSearchParams(rawQueryString));

  if (!accepted?.sender) return null;

  const path = buildCoverageReportPath({ sender: accepted.sender, range: accepted.range ?? '24h' });

  const label = t('analysis.coverage.show_coverage', 'Show coverage');
  const title = t(
    'analysis.coverage.show_coverage_title',
    'Open the Coverage Report for this node (last 24 hours)',
  );

  const content = (
    <>
      <UiIcon name="radioSignal" size={14} />
      <span>{label}</span>
    </>
  );

  if (inRouterContext) {
    return (
      <Link to={path} className={styles.link} title={title}>
        {content}
      </Link>
    );
  }

  return (
    <a href={`${appBasename}${path}`} className={styles.link} title={title}>
      {content}
    </a>
  );
};

export default ShowCoverageLink;
