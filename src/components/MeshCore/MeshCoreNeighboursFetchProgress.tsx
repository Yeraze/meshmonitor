/**
 * MeshCoreNeighboursFetchProgress (#5413)
 *
 * Status line for a paged neighbour fetch. While it runs: which page, how
 * many neighbours so far out of the table size, a countdown to the next page
 * (each waits the shared 60 s mesh-TX floor) with a draining bar, and a
 * Cancel button. Once it ends short of the full table (page cap, cancel, no
 * reply) it says so; a complete fetch needs no note.
 *
 * Shared by Contact Details (Neighbours button) and Neighbours Retrieval
 * (Poll Neighbours button). Mirrors MeshCoreLoginProgress (#5400).
 */

import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { UiIcon } from '../icons';
import type { MeshCoreNeighboursFetchState } from './hooks/useMeshCoreNeighboursFetch';
import styles from './MeshCoreNeighboursFetchProgress.module.css';

interface MeshCoreNeighboursFetchProgressProps {
  fetch: MeshCoreNeighboursFetchState;
  onCancel: () => void;
}

/** Re-render often enough for the countdown to move smoothly. */
const TICK_MS = 250;

export const MeshCoreNeighboursFetchProgress: React.FC<MeshCoreNeighboursFetchProgressProps> = ({ fetch, onCancel }) => {
  const { t } = useTranslation();
  const [now, setNow] = useState(() => Date.now());
  const running = fetch.phase !== 'done';

  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(id);
  }, [running]);

  const collected = fetch.neighbours.length;
  const total = fetch.total;

  if (!running) {
    if (fetch.outcome === 'complete' || fetch.outcome === null) return null;
    let note: string;
    if (fetch.outcome === 'cancelled') {
      note = total !== null
        ? t('meshcore.neighbours_fetch.cancelled', 'Cancelled: showing {{collected}} of {{total}} neighbours. Stored neighbours were kept and updated, not replaced.', { collected, total })
        : t('meshcore.neighbours_fetch.cancelled_none', 'Cancelled before any page arrived. Stored neighbours were left as they were.');
    } else if (fetch.outcome === 'capped') {
      note = t('meshcore.neighbours_fetch.capped', 'Stopped at the {{pages}}-page limit: showing {{collected}} of {{total}} neighbours.', {
        pages: fetch.maxPages,
        collected,
        total: total ?? collected,
      });
    } else {
      note = collected > 0
        ? t('meshcore.neighbours_fetch.failed_partial', 'Page {{page}} got no reply: showing {{collected}} of {{total}} neighbours. Stored neighbours were kept and updated, not replaced.', {
          page: fetch.pagesFetched + 1,
          collected,
          total: total ?? '?',
        })
        : t('meshcore.neighbours_fetch.failed', 'No reply from the repeater. Stored neighbours were left as they were.');
    }
    return (
      <div className={styles.notice} role="status" data-testid="meshcore-neighbours-fetch-notice">
        {note}
      </div>
    );
  }

  const remainingMs = fetch.waitEndsAt !== null ? Math.max(0, fetch.waitEndsAt - now) : null;
  const seconds = remainingMs !== null ? Math.ceil(remainingMs / 1000) : null;
  const fraction = remainingMs !== null && fetch.waitMs ? remainingMs / fetch.waitMs : null;
  const page = Math.max(1, fetch.page);
  const pages = Math.max(page, fetch.plannedPages || fetch.maxPages || 1);

  const parts: string[] = [];
  if (fetch.phase === 'starting') {
    parts.push(t('meshcore.neighbours_fetch.starting', 'Starting neighbour fetch…'));
  } else {
    parts.push(t('meshcore.neighbours_fetch.page', 'Page {{page}} of {{pages}}', { page, pages }));
    if (total !== null) {
      parts.push(t('meshcore.neighbours_fetch.collected', '{{collected}} of {{total}} neighbours', { collected, total }));
    }
    if (fetch.cancelling) {
      parts.push(t('meshcore.neighbours_fetch.cancelling', 'cancelling…'));
    } else if (fetch.phase === 'waiting') {
      parts.push(
        seconds !== null
          ? t('meshcore.neighbours_fetch.next_in', 'next page in {{seconds}} s', { seconds })
          : t('meshcore.neighbours_fetch.waiting', 'waiting for the radio…'),
      );
    } else {
      parts.push(t('meshcore.neighbours_fetch.requesting', 'waiting for a reply…'));
    }
  }

  return (
    <div className={styles.container} role="status" aria-live="polite" data-testid="meshcore-neighbours-fetch-progress">
      <div className={styles.row}>
        <UiIcon name="timer" size={16} className={styles.icon} />
        <span className={styles.message}>{parts.join(' · ')}</span>
        <button type="button" className={styles.cancel} onClick={onCancel} disabled={fetch.cancelling}>
          {t('meshcore.neighbours_fetch.cancel', 'Cancel')}
        </button>
      </div>
      {fraction !== null && !fetch.cancelling && fetch.phase === 'waiting' && (
        <div className={styles.track} aria-hidden="true">
          <div className={styles.bar} style={{ width: `${Math.round(fraction * 100)}%` }} />
        </div>
      )}
      <div className={styles.hint}>
        {t('meshcore.neighbours_fetch.hint', 'A repeater sends at most 10 neighbours per reply, and each page waits 60 s so the mesh is not flooded.')}
      </div>
    </div>
  );
};
