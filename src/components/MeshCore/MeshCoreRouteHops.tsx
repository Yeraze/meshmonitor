/**
 * RouteHopRows — the shared per-hop relay-chain rows for the MeshCore Message
 * Route and Packet Decode modals (#6190). Each hop is one `#N` row: the hash
 * bytes first, a forward arrow, then the resolved (or best-guess) repeater
 * name, with a collapsible candidate list when another source offers several.
 * An empty route renders the "Direct (no relays)" fallback row.
 *
 * The resolution hook and pure helpers live in `useResolvedRouteHops.ts` so
 * this file exports components only (react-refresh ratchet).
 */
import React from 'react';
import { useTranslation } from 'react-i18next';
import type { ResolvedRouteHopWithFallback } from '../../utils/meshcorePath';
import { candidatesTitle } from './useResolvedRouteHops';
import { UiIcon } from '../icons';
import styles from './MeshCoreRouteHops.module.css';

/** One hop's name, styled by where it came from. */
const HopName: React.FC<{ row: ResolvedRouteHopWithFallback }> = ({ row }) => {
  const { t } = useTranslation();
  if (row.origin === 'own') return <>{row.name}</>;
  if (row.origin === 'none') return <>{t('meshcore.route_detail_unknown', 'unknown repeater')}</>;
  const count = row.candidates.length;
  const via = row.via?.sourceName ?? '';
  if (row.tentative) {
    return (
      <>
        <span className={styles.tentativeName}>{row.name}?</span>{' '}
        <span className={styles.via}>
          ({t('meshcore.route_detail_via_candidates', 'via {{source}}, {{count}} candidates', { source: via, count })})
        </span>
      </>
    );
  }
  if (row.name) {
    return (
      <>
        <span className={styles.otherName}>{row.name}</span>{' '}
        <span className={styles.via}>({t('meshcore.route_detail_via', 'via {{source}}', { source: via })})</span>
      </>
    );
  }
  return (
    <span className={styles.tentativeName}>
      {t('meshcore.route_detail_candidates', '{{count}} candidates', { count })}
    </span>
  );
};

/** The full candidate list for a shared hash, collapsed by default. */
const CandidateList: React.FC<{ row: ResolvedRouteHopWithFallback }> = ({ row }) => {
  const { t } = useTranslation();
  if (row.origin !== 'other' || row.candidates.length < 2) return null;
  return (
    <details className={styles.candidates}>
      <summary>
        {row.tentative
          ? t('meshcore.route_detail_show_candidates_ranked', 'Show all {{count}} candidates (nearest first)', { count: row.candidates.length })
          : t('meshcore.route_detail_show_candidates', 'Show all {{count}} candidates', { count: row.candidates.length })}
      </summary>
      <ol className={styles.candidateList}>
        {row.candidates.map((c) => (
          <li key={`${c.sourceId}-${c.publicKey}`}>
            {c.name}{' '}
            <span className={styles.via}>({t('meshcore.route_detail_via', 'via {{source}}', { source: c.sourceName })})</span>{' '}
            <span className={styles.candidateKey}>{c.publicKey.slice(0, 8)}…</span>
          </li>
        ))}
      </ol>
    </details>
  );
};

/** One labeled detail row, matching the modals' `mcpm-dl-*` layout. */
const Row: React.FC<{ label: string; children: React.ReactNode; mono?: boolean; wrap?: boolean }> = ({ label, children, mono, wrap }) => (
  <div className="mcpm-dl-row">
    <span className="mcpm-dl-label">{label}</span>
    <span className={`mcpm-dl-value${mono ? ' mcpm-mono' : ''}${wrap ? ' mcpm-dl-wrap' : ''}`}>{children}</span>
  </div>
);

/**
 * Render a resolved route as per-hop rows, or the "Direct (no relays)" row when
 * there are none. Callers supply the rows from {@link useResolvedRouteHops} and
 * own the surrounding section heading and any hash-width row.
 */
export const RouteHopRows: React.FC<{ rows: ResolvedRouteHopWithFallback[] }> = ({ rows }) => {
  const { t } = useTranslation();
  if (rows.length === 0) {
    return (
      <Row label={t('meshcore.packets.routing', 'Routing')}>
        {t('meshcore.packets.directNoRelay', 'Direct (no relays)')}
      </Row>
    );
  }
  return (
    <>
      {rows.map((r, i) => (
        <Row key={`${r.byte}-${i}`} label={`#${i + 1}`} mono>
          {r.byte}
          {' '}<UiIcon name="forward" size={12} />{' '}
          <span title={candidatesTitle(r)}><HopName row={r} /></span>
          {r.origin === 'own' && r.matchCount > 1 && (
            <span className={styles.bestGuess}>
              {' '}({t('meshcore.route_detail_best_guess', 'best guess of')} {r.matchCount} {t('meshcore.route_detail_matches', 'matches')})
            </span>
          )}
          <CandidateList row={r} />
        </Row>
      ))}
    </>
  );
};

export default RouteHopRows;
