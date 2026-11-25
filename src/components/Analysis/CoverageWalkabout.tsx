/**
 * Coverage Report "Walkabout" view pieces (#5891 P2, spec §2.13).
 *
 * Kept out of CoverageReport so the report's own hooks stay as they were:
 * the button reads the auth context without throwing (anonymous and test
 * renders have none) and runs the source query only for a signed-in viewer.
 */
import { Suspense, useContext, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AuthContext } from '../../contexts/authContextObject';
import { MapLoadingOverlay } from '../map/MapLoadingOverlay';
import { useWalkaboutSessions, useWalkaboutSources } from '../../hooks/useWalkabout';
import { WALKABOUT_READ_GRANT } from '../../utils/walkabout';
import { WalkaboutHexMapLazy } from './walkaboutHexMapLazy';
import type { WalkaboutMapQuery } from '../../types/walkabout';
import styles from './CoverageWalkabout.module.css';

const WALKABOUT_SOURCE_TYPES = new Set(['meshtastic_tcp', 'meshcore']);

/** Enabled walkabout-capable sources the viewer can read (`nodes:read`). */
function useReadableWalkaboutSources() {
  const auth = useContext(AuthContext);
  const sourcesQ = useWalkaboutSources();
  const rows = useMemo(
    () =>
      (sourcesQ.data ?? []).filter(
        (s) =>
          s.enabled !== false &&
          WALKABOUT_SOURCE_TYPES.has(s.type ?? '') &&
          !!auth?.hasPermission(WALKABOUT_READ_GRANT.resource, WALKABOUT_READ_GRANT.action, { sourceId: s.id }),
      ),
    [sourcesQ.data, auth],
  );
  return rows;
}

function ViewButtonInner({ active, onClick }: { active: boolean; onClick: () => void }) {
  const { t } = useTranslation();
  const rows = useReadableWalkaboutSources();
  if (rows.length === 0) return null;
  return (
    <button
      type="button"
      className={`reports-btn reports-btn--ghost${active ? ` ${styles.activeView}` : ''}`}
      aria-pressed={active}
      onClick={onClick}
      data-testid="coverage-view-walkabout"
    >
      {t('analysis.coverage.view_walkabout', 'Walkabout')}
    </button>
  );
}

/** Signed-in viewers only: every walkabout route needs a login (anonymous would get 401s). */
export function WalkaboutViewButton(props: { active: boolean; onClick: () => void }) {
  const auth = useContext(AuthContext);
  if (!auth?.authStatus?.authenticated) return null;
  return <ViewButtonInner {...props} />;
}

export interface CoverageWalkaboutPanelProps {
  sinceMs: number;
  untilMs: number;
  /** Coverage sender picker value; '' = all. Becomes the `node` filter. */
  senderId: string;
  /** Stable text for the report's time range (preset or custom), part of fitKey. */
  rangeKey: string;
}

export function CoverageWalkaboutPanel({ sinceMs, untilMs, senderId, rangeKey }: CoverageWalkaboutPanelProps) {
  const { t } = useTranslation();
  const sources = useReadableWalkaboutSources();
  const [pickedSource, setPickedSource] = useState('');
  const [pickedSession, setPickedSession] = useState('');
  const sourceId = sources.some((s) => s.id === pickedSource) ? pickedSource : (sources[0]?.id ?? '');
  const sessionsQ = useWalkaboutSessions(sourceId || null);

  const sessions = useMemo(
    () => (sessionsQ.data ?? []).filter((s) => s.startedAt <= untilMs && (s.endedAt ?? s.endsAt) >= sinceMs),
    [sessionsQ.data, sinceMs, untilMs],
  );
  const sessionId = sessions.some((s) => s.id === pickedSession) ? pickedSession : '';

  const query = useMemo<WalkaboutMapQuery>(() => {
    const node = senderId || undefined;
    return sessionId
      ? { kind: 'session', sessionId, node }
      : { kind: 'range', sinceMs, untilMs, node };
  }, [sessionId, sinceMs, untilMs, senderId]);

  const fitKey = `${sourceId}|${sessionId || rangeKey}|${senderId}`;

  return (
    <div className={styles.panel} data-testid="coverage-walkabout">
      <div className={styles.controls}>
        <label className={styles.field}>
          <span>{t('analysis.coverage.walkabout_source', 'Source')}</span>
          <select
            value={sourceId}
            onChange={(e) => { setPickedSource(e.target.value); setPickedSession(''); }}
            data-testid="coverage-walkabout-source"
          >
            {sources.map((s) => <option key={s.id} value={s.id}>{s.name || s.id}</option>)}
          </select>
        </label>
        <label className={styles.field}>
          <span>{t('analysis.coverage.walkabout_session', 'Session')}</span>
          <select
            value={sessionId}
            onChange={(e) => setPickedSession(e.target.value)}
            data-testid="coverage-walkabout-session"
          >
            <option value="">{t('analysis.coverage.walkabout_all_sessions', 'All sessions in range')}</option>
            {sessions.map((s) => (
              <option key={s.id} value={s.id}>{s.name || new Date(s.startedAt).toLocaleString()}</option>
            ))}
          </select>
        </label>
      </div>
      <p className={styles.hint} data-testid="coverage-walkabout-hint">
        {t(
          'analysis.coverage.walkabout_sender_hint',
          'Sender filter: heard directly from, or relayed last by, this node.',
        )}
      </p>
      {sourceId && (
        <Suspense fallback={<MapLoadingOverlay />}>
          <WalkaboutHexMapLazy sourceId={sourceId} query={query} fitKey={fitKey} />
        </Suspense>
      )}
    </div>
  );
}
