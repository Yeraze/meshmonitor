/**
 * Walkabout report (#5891 Phase 1, spec §2.9).
 *
 * The phone's GPS tags every packet the source's radio hears while the user
 * walks. MeshMonitor sends nothing on the mesh. The page posts at most every
 * 10 s and never polls (the sample response carries the counts), so a
 * two-hour walk over cellular stays far below the API rate limit (§2.8).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import { UiIcon } from '../icons';
import Modal from '../common/Modal';
import { useAuth } from '../../contexts/AuthContext';
import { useNow } from '../../hooks/useNow';
import { useGeolocationWatch } from '../../hooks/useGeolocationWatch';
import {
  useDeleteWalkabout,
  useLiveWalkabout,
  useStartWalkabout,
  useWalkaboutSessions,
  useWalkaboutSources,
  walkaboutKeys,
} from '../../hooks/useWalkabout';
import { postWalkaboutSamples, stopWalkabout } from '../../services/walkaboutApi';
import { createWalkaboutSampler } from '../../utils/walkaboutSampler';
import { formatClock, pausedMinutes } from '../../utils/walkaboutFormat';
import {
  WALKABOUT_MAX_ACCURACY_M,
  WALKABOUT_MAX_DURATION_MS,
  WALKABOUT_NAME_MAX,
  WALKABOUT_POST_INTERVAL_MS,
  WALKABOUT_READ_GRANT,
  WALKABOUT_WARN_ACCURACY_M,
  WALKABOUT_WRITE_GRANT,
} from '../../utils/walkabout';
import type { WalkaboutSessionDto, WalkaboutSkipCounts } from '../../types/walkabout';
import styles from './WalkaboutReport.module.css';

const WALKABOUT_SOURCE_TYPES = new Set(['meshtastic_tcp', 'meshcore']);

type EndNotice = 'cap' | 'user' | 'lost' | null;

const errCode = (e: unknown): string | undefined => (e as { code?: string } | null)?.code;
const errStatus = (e: unknown): number | undefined => (e as { status?: number } | null)?.status;
/** The session is gone or no longer ours: retrying cannot help. */
const isTerminalError = (e: unknown): boolean => {
  const c = errCode(e);
  const st = errStatus(e);
  return c === 'WALKABOUT_NOT_FOUND' || c === 'WALKABOUT_NOT_OWNER' || c === 'FORBIDDEN' || st === 403 || st === 404;
};

export default function WalkaboutReport() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { hasPermission } = useAuth();
  const sourcesQ = useWalkaboutSources();

  const { options, readOnlyMode } = useMemo(() => {
    const usable = (sourcesQ.data ?? []).filter(
      (s) => s.enabled !== false && WALKABOUT_SOURCE_TYPES.has(s.type ?? ''),
    );
    const writable = usable.filter((s) =>
      hasPermission(WALKABOUT_WRITE_GRANT.resource, WALKABOUT_WRITE_GRANT.action, { sourceId: s.id }),
    );
    if (writable.length > 0) return { options: writable, readOnlyMode: false };
    const readable = usable.filter((s) =>
      hasPermission(WALKABOUT_READ_GRANT.resource, WALKABOUT_READ_GRANT.action, { sourceId: s.id }),
    );
    return { options: readable, readOnlyMode: true };
  }, [sourcesQ.data, hasPermission]);

  const [pickedId, setPickedId] = useState('');
  const sourceId = options.some((o) => o.id === pickedId) ? pickedId : (options[0]?.id ?? '');

  const sessionsQ = useWalkaboutSessions(sourceId || null);
  const liveQ = useLiveWalkabout(sourceId || null);
  const startMut = useStartWalkabout(sourceId);
  const deleteMut = useDeleteWalkabout(sourceId);

  const [active, setActive] = useState<WalkaboutSessionDto | null>(null);
  const [skipped, setSkipped] = useState<WalkaboutSkipCounts | null>(null);
  const [ended, setEnded] = useState<EndNotice>(null);
  const [sendTrouble, setSendTrouble] = useState(false);
  const [showStart, setShowStart] = useState(false);
  const [name, setName] = useState('');
  const [startError, setStartError] = useState<string | null>(null);
  const [stopError, setStopError] = useState<string | null>(null);
  const [toDelete, setToDelete] = useState<WalkaboutSessionDto | null>(null);

  const samplerRef = useRef(createWalkaboutSampler());
  const activeRef = useRef<WalkaboutSessionDto | null>(null);
  activeRef.current = active;
  const sourceRef = useRef(sourceId);
  sourceRef.current = sourceId;
  const inFlightRef = useRef(false);

  const watch = useGeolocationWatch(
    useCallback((fix) => {
      samplerRef.current.offer(fix);
    }, []),
  );
  const { stop: stopWatch } = watch;

  const refreshLists = useCallback(() => {
    const id = sourceRef.current;
    void qc.invalidateQueries({ queryKey: walkaboutKeys.sessions(id) });
    void qc.invalidateQueries({ queryKey: walkaboutKeys.live(id) });
  }, [qc]);

  const endWalk = useCallback((reason: Exclude<EndNotice, null>) => {
    stopWatch();
    setActive(null);
    setEnded(reason);
    setSendTrouble(false);
    refreshLists();
  }, [stopWatch, refreshLists]);

  // Post cadence. Reads refs only, so the interval is never re-armed by a render.
  const activeId = active?.id ?? null;
  useEffect(() => {
    if (!activeId) return undefined;
    const tick = async () => {
      const s = activeRef.current;
      if (!s || inFlightRef.current) return;
      if (Date.now() >= s.endsAt) {
        endWalk('cap');
        return;
      }
      const batch = samplerRef.current.takeBatch(Date.now());
      if (batch.length === 0) return;
      inFlightRef.current = true;
      try {
        const res = await postWalkaboutSamples(s.sourceId, s.id, batch);
        if (res?.session) setActive(res.session);
        if (res?.skipped) setSkipped(res.skipped);
        setSendTrouble(false);
      } catch (err) {
        if (errCode(err) === 'WALKABOUT_NOT_LIVE') {
          const reason = (err as { body?: { endReason?: string } }).body?.endReason;
          endWalk(reason === 'cap' || Date.now() >= s.startedAt + WALKABOUT_MAX_DURATION_MS ? 'cap' : 'user');
        } else if (isTerminalError(err)) {
          endWalk('lost');
        } else {
          // Retry on the next tick; the server drops fixes older than 30 s.
          samplerRef.current.requeue(batch);
          setSendTrouble(true);
        }
      } finally {
        inFlightRef.current = false;
      }
    };
    const id = setInterval(() => { void tick(); }, WALKABOUT_POST_INTERVAL_MS);
    return () => clearInterval(id);
  }, [activeId, endWalk]);

  const now = useNow(1000, active != null);

  const beginWalk = (session: WalkaboutSessionDto) => {
    samplerRef.current = createWalkaboutSampler();
    setSkipped(null);
    setEnded(null);
    setActive(session);
    watch.start();
  };

  const confirmStart = async () => {
    setStartError(null);
    try {
      const trimmed = name.trim();
      const session = await startMut.mutateAsync(trimmed ? trimmed : undefined);
      setShowStart(false);
      setName('');
      beginWalk(session);
    } catch (err) {
      setStartError(
        errCode(err) === 'WALKABOUT_ALREADY_LIVE'
          ? t('analysis.walkabout.already_live', 'A walkabout is already running on this source.')
          : (err as Error)?.message || t('analysis.walkabout.start_failed', 'Could not start the walkabout.'),
      );
    }
  };

  const stopWalkNow = async () => {
    const s = active;
    if (!s) return;
    setStopError(null);
    stopWatch();
    // Best effort: send what is still queued, then close the session.
    const rest = samplerRef.current.takeBatch(Date.now());
    if (rest.length > 0) {
      try { await postWalkaboutSamples(s.sourceId, s.id, rest); } catch { /* the stop still goes through */ }
    }
    try {
      await stopWalkabout(s.sourceId, s.id);
      refreshLists();
    } catch (err) {
      if (errCode(err) !== 'WALKABOUT_NOT_LIVE') {
        setStopError((err as Error)?.message || t('analysis.walkabout.stop_failed', 'Could not stop the session. Try again.'));
        return;
      }
    }
    setActive(null);
    setEnded('user');
    setSendTrouble(false);
  };

  const confirmDelete = async () => {
    const s = toDelete;
    if (!s) return;
    try {
      await deleteMut.mutateAsync(s.id);
    } finally {
      setToDelete(null);
    }
  };

  // The live row shows the freshest counts from the last post; no polling.
  const sessionRows = (sessionsQ.data ?? []).map((r) => (active && r.id === active.id ? active : r));
  const fmtDate = (ms: number) => new Date(ms).toLocaleString();
  const liveSession = liveQ.data?.session ?? null;
  const otherUserLive = !active && liveSession != null && !liveSession.startedByMe;
  const canResume = !active && liveSession != null && liveSession.startedByMe;
  const supportBlocked = watch.support !== 'ok';
  const startDisabled = readOnlyMode || supportBlocked || !sourceId || active != null || liveSession != null;
  const accuracy = watch.accuracy;

  const screenLockLine = t(
    'analysis.walkabout.screen_lock',
    'Keep this page open and the screen on. Your phone stops sending GPS while the screen is locked.',
  );

  const noticeFor = (): string | null => {
    if (watch.support === 'insecure') {
      return t('analysis.walkabout.insecure', 'Phone GPS needs HTTPS (or localhost). Open MeshMonitor over HTTPS to use Walkabout.');
    }
    if (watch.support === 'unavailable') {
      return t('analysis.walkabout.unavailable', 'This browser has no location support. Try a current browser on your phone, and allow location for this site.');
    }
    if (watch.state === 'denied') {
      return t('analysis.walkabout.denied', 'Location access is blocked. Allow location for this site in your browser settings, then try again.');
    }
    return null;
  };
  const notice = noticeFor();

  return (
    <div className={styles.report} data-testid="walkabout-report">
      <h2 className={styles.title}>
        <UiIcon name="location" size={20} /> {t('analysis.walkabout.title', 'Walkabout')}
      </h2>
      <p className={styles.intro}>
        {t('analysis.walkabout.intro', 'Walk or drive with your phone. Every packet this source hears is tagged with where you are. MeshMonitor sends nothing on the mesh.')}
      </p>

      {sourcesQ.isLoading ? null : options.length === 0 ? (
        <p className={styles.note} data-testid="walkabout-no-sources">
          {t('analysis.walkabout.no_sources', 'No Meshtastic or MeshCore source is available to you for Walkabout.')}
        </p>
      ) : (
        <label className={styles.field}>
          {t('analysis.walkabout.source', 'Source')}
          <select
            value={sourceId}
            disabled={active != null}
            onChange={(e) => { setPickedId(e.target.value); setEnded(null); }}
            data-testid="walkabout-source"
          >
            {options.map((o) => <option key={o.id} value={o.id}>{o.name || o.id}</option>)}
          </select>
        </label>
      )}

      {notice && (
        <p className={styles.warn} role="alert" data-testid="walkabout-notice">
          <UiIcon name="alert" size={16} /> {notice}
        </p>
      )}

      {ended && (
        <p className={styles.note} role="status" data-testid="walkabout-ended">
          <UiIcon name="info" size={16} />
          {ended === 'cap'
            ? t('analysis.walkabout.ended_cap', 'Session ended (2 h limit).')
            : ended === 'lost'
              ? t('analysis.walkabout.ended_lost', 'Session is gone or no longer yours. GPS tracking stopped.')
              : t('analysis.walkabout.ended_user', 'Session stopped.')}
        </p>
      )}

      {otherUserLive && (
        <p className={styles.note} data-testid="walkabout-other-user">
          <UiIcon name="info" size={16} />
          {t('analysis.walkabout.other_user', 'Another user is walking this source.')}
        </p>
      )}

      {active && (
        <section className={styles.panel} data-testid="walkabout-live">
          <h3 className={styles.panelTitle}>{t('analysis.walkabout.live_title', 'Walkabout running')}</h3>
          <dl className={styles.stats}>
            <div className={styles.stat}>
              <dt>{t('analysis.walkabout.elapsed', 'Elapsed')}</dt>
              <dd data-testid="walkabout-elapsed">{formatClock(now - active.startedAt)}</dd>
            </div>
            <div className={styles.stat}>
              <dt>{t('analysis.walkabout.remaining', 'Auto-ends in')}</dt>
              <dd data-testid="walkabout-remaining">{formatClock(active.endsAt - now)}</dd>
            </div>
            <div className={styles.stat}>
              <dt>{t('analysis.walkabout.samples', 'Samples')}</dt>
              <dd data-testid="walkabout-samples">{active.sampleCount}</dd>
            </div>
            <div className={styles.stat}>
              <dt>{t('analysis.walkabout.receptions', 'Receptions')}</dt>
              <dd data-testid="walkabout-receptions">{active.receptionCount}</dd>
            </div>
            <div className={styles.stat}>
              <dt>{t('analysis.walkabout.nodes', 'Nodes heard')}</dt>
              <dd data-testid="walkabout-nodes">{active.nodeCount}</dd>
            </div>
            <div className={styles.stat}>
              <dt>{t('analysis.walkabout.accuracy', 'GPS accuracy')}</dt>
              <dd data-testid="walkabout-accuracy">{accuracy == null ? '–' : `${Math.round(accuracy)} m`}</dd>
            </div>
          </dl>

          {accuracy != null && accuracy > WALKABOUT_MAX_ACCURACY_M && (
            <p className={styles.warn} role="status" data-testid="walkabout-accuracy-wait">
              <UiIcon name="alert" size={16} />
              {t('analysis.walkabout.accuracy_wait', 'Waiting for a better GPS fix. Fixes worse than 100 m are not sent.')}
            </p>
          )}
          {accuracy != null && accuracy > WALKABOUT_WARN_ACCURACY_M && accuracy <= WALKABOUT_MAX_ACCURACY_M && (
            <p className={styles.warn} role="status" data-testid="walkabout-accuracy-warn">
              <UiIcon name="alert" size={16} />
              {t('analysis.walkabout.accuracy_warn', 'GPS accuracy is poor (over 30 m). Coverage points will be rough.')}
            </p>
          )}
          {sendTrouble && (
            <p className={styles.warn} role="status" data-testid="walkabout-send-trouble">
              <UiIcon name="alert" size={16} />
              {t('analysis.walkabout.send_trouble', 'Could not reach the server. Retrying. Samples older than 30 seconds are dropped.')}
            </p>
          )}
          {skipped && (skipped.noFix + skipped.relayAmbiguous + skipped.relayUnknown + skipped.noSender) > 0 && (
            <p className={styles.note} data-testid="walkabout-skipped">
              {t('analysis.walkabout.skipped', 'Not counted: {{noFix}} without a fresh fix, {{relay}} relayed by an unknown or shared relay, {{noSender}} without a sender.', {
                noFix: skipped.noFix,
                relay: skipped.relayAmbiguous + skipped.relayUnknown,
                noSender: skipped.noSender,
              })}
            </p>
          )}
          {watch.pausedMs != null && (
            <p className={styles.warn} role="status" data-testid="walkabout-paused">
              <UiIcon name="alert" size={16} />
              {t('analysis.walkabout.paused', 'GPS paused for {{minutes}} min while the screen was off.', {
                minutes: pausedMinutes(watch.pausedMs),
              })}
              {' '}
              <button type="button" className={styles.secondary} onClick={watch.clearPaused}>
                {t('analysis.walkabout.dismiss', 'Dismiss')}
              </button>
            </p>
          )}
          <p className={styles.note} data-testid="walkabout-live-screen-lock">
            <UiIcon name="info" size={16} /> {screenLockLine}
          </p>
          {watch.wakeLockSupported && (
            <p className={styles.note} data-testid="walkabout-wakelock">
              {watch.wakeLockActive
                ? t('analysis.walkabout.wake_on', 'Keeping the screen on.')
                : t('analysis.walkabout.wake_off', 'The screen may turn off. Your browser did not allow keeping it on.')}
            </p>
          )}
          {stopError && <p className={styles.error} role="alert" data-testid="walkabout-stop-error">{stopError}</p>}
          <div className={styles.actions}>
            <button type="button" className={styles.danger} onClick={() => { void stopWalkNow(); }} data-testid="walkabout-stop">
              <UiIcon name="close" size={16} /> {t('analysis.walkabout.stop', 'Stop')}
            </button>
          </div>
        </section>
      )}

      {!active && !readOnlyMode && options.length > 0 && (
        <div className={styles.actions}>
          {canResume ? (
            <button
              type="button"
              className={styles.primary}
              disabled={supportBlocked}
              onClick={() => { if (liveSession) beginWalk(liveSession); }}
              data-testid="walkabout-resume"
            >
              <UiIcon name="play" size={16} /> {t('analysis.walkabout.resume', 'Resume')}
            </button>
          ) : (
            <button
              type="button"
              className={styles.primary}
              disabled={startDisabled}
              onClick={() => { setStartError(null); setShowStart(true); }}
              data-testid="walkabout-start"
            >
              <UiIcon name="play" size={16} /> {t('analysis.walkabout.start', 'Start')}
            </button>
          )}
        </div>
      )}

      <Modal
        isOpen={showStart}
        onClose={() => setShowStart(false)}
        title={t('analysis.walkabout.start_title', 'Start a walkabout')}
      >
        <div className={styles.modalBody} data-testid="walkabout-start-modal">
          <p className={styles.note}>
            {t('analysis.walkabout.start_carry', 'Carry the radio MeshMonitor is connected to with you. A radio left at home hears the same nodes wherever you walk.')}
          </p>
          <p className={styles.note}>
            {t('analysis.walkabout.start_how', 'MeshMonitor sends nothing. Every packet this source radio hears while you walk is tagged with your phone position. Sessions stop after 2 hours.')}
          </p>
          <p className={styles.note}>
            {t('analysis.walkabout.start_visible', 'The session and its track are visible to anyone who can read this source.')}
          </p>
          <p className={styles.note} data-testid="walkabout-modal-screen-lock">{screenLockLine}</p>
          <label className={styles.field}>
            {t('analysis.walkabout.name', 'Name (optional)')}
            <input
              type="text"
              value={name}
              maxLength={WALKABOUT_NAME_MAX}
              onChange={(e) => setName(e.target.value)}
              data-testid="walkabout-name"
            />
          </label>
          {startError && <p className={styles.error} role="alert">{startError}</p>}
          <div className={styles.actions}>
            <button type="button" className={styles.primary} disabled={startMut.isPending} onClick={() => { void confirmStart(); }} data-testid="walkabout-confirm-start">
              {t('analysis.walkabout.confirm_start', 'Start walking')}
            </button>
            <button type="button" className={styles.secondary} onClick={() => setShowStart(false)}>
              {t('analysis.walkabout.cancel', 'Cancel')}
            </button>
          </div>
        </div>
      </Modal>

      <Modal
        isOpen={toDelete != null}
        onClose={() => setToDelete(null)}
        title={t('analysis.walkabout.delete_title', 'Delete session')}
      >
        <div className={styles.modalBody} data-testid="walkabout-delete-modal">
          <p className={styles.note}>
            {t('analysis.walkabout.delete_body', 'Delete this session and every sample and reception in it? This cannot be undone.')}
          </p>
          <div className={styles.actions}>
            <button type="button" className={styles.danger} disabled={deleteMut.isPending} onClick={() => { void confirmDelete(); }} data-testid="walkabout-confirm-delete">
              {t('analysis.walkabout.delete', 'Delete')}
            </button>
            <button type="button" className={styles.secondary} onClick={() => setToDelete(null)}>
              {t('analysis.walkabout.cancel', 'Cancel')}
            </button>
          </div>
        </div>
      </Modal>

      {sourceId && (
        <section aria-label={t('analysis.walkabout.sessions', 'Sessions')}>
          <h3 className={styles.panelTitle}>{t('analysis.walkabout.sessions', 'Sessions')}</h3>
          {sessionsQ.isLoading ? null : sessionRows.length === 0 ? (
            <p className={styles.note} data-testid="walkabout-empty">
              {t('analysis.walkabout.no_sessions', 'No walkabout sessions yet.')}
            </p>
          ) : (
            <ul className={styles.list} data-testid="walkabout-sessions">
              {sessionRows.map((s) => {
                const endMs = s.endedAt ?? s.endsAt;
                const live = s.isLive;
                return (
                  <li key={s.id} className={styles.row} data-testid="walkabout-session">
                    <div className={styles.rowMain}>
                      <span className={styles.rowName}>{s.name || fmtDate(s.startedAt)}</span>
                      <span className={styles.rowMeta}>
                        {live
                          ? t('analysis.walkabout.row_live', 'Running')
                          : formatClock(endMs - s.startedAt)}
                        {' · '}
                        {t('analysis.walkabout.row_counts', '{{samples}} samples, {{receptions}} receptions, {{nodes}} nodes', {
                          samples: s.sampleCount,
                          receptions: s.receptionCount,
                          nodes: s.nodeCount,
                        })}
                      </span>
                    </div>
                    {!readOnlyMode && !live && (
                      <button
                        type="button"
                        className={styles.secondary}
                        onClick={() => setToDelete(s)}
                        aria-label={t('analysis.walkabout.delete', 'Delete')}
                        data-testid="walkabout-delete"
                      >
                        <UiIcon name="delete" size={16} />
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      )}
    </div>
  );
}
