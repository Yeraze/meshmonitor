/**
 * Walkabout map panel (#5891 P2, spec §2.11). Window chips and a session
 * picker around the lazy hex map. Windows are state, never `Date.now()` in
 * render, so query keys stay stable.
 */
import { Suspense, useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import { UiIcon } from '../icons';
import { MapLoadingOverlay } from '../map/MapLoadingOverlay';
import { WalkaboutHexMapLazy } from './walkaboutHexMapLazy';
import WalkaboutSnrBandsEditor from './WalkaboutSnrBandsEditor';
import { useAuth } from '../../contexts/AuthContext';
import { useWalkaboutSnrBands } from '../../hooks/useWalkaboutSnrBands';
import type { WalkaboutMapQuery, WalkaboutMapWindow, WalkaboutSessionDto } from '../../types/walkabout';
import styles from './WalkaboutMapPanel.module.css';

const WINDOWS: WalkaboutMapWindow[] = ['24h', '7d', '14d', '30d'];

export interface WalkaboutMapPanelProps {
  sourceId: string;
  sessions: WalkaboutSessionDto[];
  /** A session picked from the list ("Map" button); null = window mode. */
  selectedSessionId: string | null;
  onSelectSession: (id: string | null) => void;
}

export default function WalkaboutMapPanel({
  sourceId,
  sessions,
  selectedSessionId,
  onSelectSession,
}: WalkaboutMapPanelProps) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [windowKey, setWindowKey] = useState<WalkaboutMapWindow>('7d');
  const { hasPermission } = useAuth();
  // #6571: per-source band edges. Editing them is a source settings write.
  const snrBands = useWalkaboutSnrBands(sourceId);
  const canEditBands = hasPermission('settings', 'write', { sourceId });

  const sessionId = selectedSessionId && sessions.some((s) => s.id === selectedSessionId) ? selectedSessionId : null;

  const query = useMemo<WalkaboutMapQuery>(
    () => (sessionId ? { kind: 'session', sessionId } : { kind: 'window', window: windowKey }),
    [sessionId, windowKey],
  );
  const fitKey = `${sourceId}|${query.kind}|${sessionId ?? windowKey}`;

  const refresh = useCallback(() => {
    void qc.invalidateQueries({ queryKey: ['walkabout', sourceId, 'cells'] });
    void qc.invalidateQueries({ queryKey: ['walkabout', sourceId, 'track'] });
  }, [qc, sourceId]);

  const sessionLabel = (s: WalkaboutSessionDto) => s.name || new Date(s.startedAt).toLocaleString();

  return (
    <section className={styles.panel} data-testid="walkabout-map-panel" aria-label={t('analysis.walkabout.map.title', 'Walkabout map')}>
      <h3 className={styles.title}>{t('analysis.walkabout.map.title', 'Walkabout map')}</h3>
      <div className={styles.controls}>
        <div className={styles.chips} role="group" aria-label={t('analysis.walkabout.map.window', 'Time window')}>
          {WINDOWS.map((w) => (
            <button
              key={w}
              type="button"
              className={`${styles.chip} ${!sessionId && windowKey === w ? styles.chipActive : ''}`}
              aria-pressed={!sessionId && windowKey === w}
              onClick={() => { setWindowKey(w); onSelectSession(null); }}
              data-testid={`walkabout-window-${w}`}
            >
              {w}
            </button>
          ))}
        </div>
        <select
          className={styles.select}
          value={sessionId ?? ''}
          onChange={(e) => onSelectSession(e.target.value || null)}
          aria-label={t('analysis.walkabout.map.session', 'Session')}
          data-testid="walkabout-map-session"
        >
          <option value="">{t('analysis.walkabout.map.all_sessions', 'All sessions in window')}</option>
          {sessions.map((s) => <option key={s.id} value={s.id}>{sessionLabel(s)}</option>)}
        </select>
        <button type="button" className={styles.refresh} onClick={refresh} data-testid="walkabout-map-refresh">
          <UiIcon name="refresh" size={16} /> {t('analysis.walkabout.map.refresh', 'Refresh')}
        </button>
      </div>
      {canEditBands && <WalkaboutSnrBandsEditor sourceId={sourceId} bands={snrBands} />}
      <Suspense fallback={<MapLoadingOverlay />}>
        <WalkaboutHexMapLazy sourceId={sourceId} query={query} fitKey={fitKey} snrBands={snrBands} />
      </Suspense>
    </section>
  );
}
