/**
 * "Show coverage" — a small deep link from a node's details into the
 * Coverage Report (#5277 P4a WP5, spec §2a.8), pre-filtered to this sender
 * over the last 24 hours.
 *
 * Falls back to a plain `<a href>` (basename-prefixed, `useInRouterContext()`
 * gated) when rendered outside a Router, so existing node-detail tests that
 * render `NodeDetailsBlock` / `MeshCoreContactDetailPanel` without wrapping
 * in a Router keep passing unchanged.
 */
import React from 'react';
import { Link, useInRouterContext } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { buildCoverageReportPath, parseCoverageDeepLink } from '../../utils/coverageDeepLink';
import { appBasename } from '../../init';
import { UiIcon } from '../icons';
import styles from './ShowCoverageLink.module.css';

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
