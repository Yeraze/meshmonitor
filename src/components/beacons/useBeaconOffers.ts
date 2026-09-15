/**
 * Data layer for the beacons surface (#5232).
 *
 * Two deliberately separate fetches:
 *
 * - **the count** is polled, because the badge has to be right without anyone
 *   opening anything. It is one integer from a `COUNT(*)`, so polling it is
 *   cheap in a way that polling the list would not be.
 * - **the list** is fetched only while the modal is open, and it asks for
 *   dismissed and muted rows too — search and sort then run locally over the
 *   whole table. A beaconing neighbourhood is bounded by radio range, so this
 *   is tens of rows, not a page-through problem.
 *
 * Nothing here touches the mesh: beacons arrive on their own, and accepting one
 * writes a channel to the locally attached radio. No packets are sent.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import apiService from '../../services/api';
import type { PublicBeaconOffer } from './types';

/** How often the badge re-counts. Beacons advertise on the order of minutes. */
const COUNT_POLL_MS = 60_000;

interface Envelope<T> { success?: boolean; data?: T }

export interface UseBeaconOffers {
  /** Pending (neither dismissed nor muted) offers on this source. */
  pendingCount: number;
  /** Every offer on this source, hidden ones included — drives whether the
   *  button exists at all, so muting everything does not strand the un-mute. */
  totalCount: number;
  /**
   * True when no count has EVER come back and the last attempt failed, so a
   * zero is "we do not know" rather than "there are none". The caller renders
   * the button anyway in that case: hiding it would turn a broken fetch into a
   * surface that silently does not exist, which is the same trap #4946 fixed
   * for the list.
   */
  countUnknown: boolean;
  /** Every offer for the source, loaded while `listOpen`. */
  offers: PublicBeaconOffer[];
  loading: boolean;
  error: string | null;
  /** Clear a surfaced error without re-fetching. */
  clearError: () => void;
  /** Tell the hook the list is on screen, so it starts loading rows. */
  setListOpen: (open: boolean) => void;
  dismiss: (nodeNum: number) => Promise<void>;
  mute: (nodeNum: number) => Promise<void>;
  restore: (nodeNum: number) => Promise<void>;
  accept: (nodeNum: number, slot: number, overwrite: boolean) => Promise<void>;
}

export function useBeaconOffers(sourceId: string | null | undefined): UseBeaconOffers {
  const { t } = useTranslation();
  const [pendingCount, setPendingCount] = useState(0);
  const [totalCount, setTotalCount] = useState(0);
  const [countUnknown, setCountUnknown] = useState(false);
  const [offers, setOffers] = useState<PublicBeaconOffer[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [listOpen, setListOpen] = useState(false);

  // Whether a count has ever come back for the CURRENT source. A ref, not
  // state: it is read inside the fetch callback and must not re-create it.
  const loadedOnceRef = useRef(false);
  useEffect(() => { loadedOnceRef.current = false; }, [sourceId]);

  const base = sourceId ? `/api/sources/${encodeURIComponent(sourceId)}/beacon-offers` : null;

  const loadCount = useCallback(async () => {
    if (!base) { setPendingCount(0); setTotalCount(0); setCountUnknown(false); return; }
    try {
      const res = await apiService.get<Envelope<{ pending: number; total: number }>>(`${base}/count`);
      setPendingCount(res?.data?.pending ?? 0);
      setTotalCount(res?.data?.total ?? 0);
      loadedOnceRef.current = true;
      setCountUnknown(false);
    } catch {
      // A failed count leaves the last known badge in place. Beacons
      // rebroadcast and the poll retries, so this self-heals; error chrome on a
      // passive badge would be louder than the problem.
      //
      // But a count that has NEVER loaded is different: the state is still 0,
      // and treating that as "no beacons" hides the button — and with it the
      // only route to a muted offer — on nothing worse than one failed request.
      // Flag it so the caller shows the button and lets the list report the
      // real error.
      // Read the ref HERE, not inside the updater: React calls a functional
      // updater when it flushes, so a lambda would sample the ref at flush time
      // rather than at failure time.
      const neverLoaded = !loadedOnceRef.current;
      setCountUnknown((prev) => prev || neverLoaded);
    }
  }, [base]);

  const loadList = useCallback(async () => {
    if (!base) { setOffers([]); return; }
    setLoading(true);
    try {
      const res = await apiService.get<Envelope<PublicBeaconOffer[]>>(`${base}?includeDismissed=true`);
      setOffers(res?.data ?? []);
      setError(null);
    } catch (e) {
      // An outright failure with nothing to show must NOT render as an empty
      // list — a broken fetch would then be indistinguishable from "no beacons"
      // (#4946). Surface it and let the list render the error instead.
      setError(e instanceof Error ? e.message : t('beacons.load_failed'));
    } finally {
      setLoading(false);
    }
  }, [base, t]);

  useEffect(() => { void loadCount(); }, [loadCount]);

  useEffect(() => {
    if (!base) return;
    const timer = setInterval(() => { void loadCount(); }, COUNT_POLL_MS);
    return () => clearInterval(timer);
  }, [base, loadCount]);

  useEffect(() => { if (listOpen) void loadList(); }, [listOpen, loadList]);

  /**
   * Run a write, then re-read. The server owns which flag a row now carries, so
   * the list is re-fetched rather than patched locally — a mute that also has
   * to clear a dismissal (see `unmute` in the repository) would otherwise need
   * that rule duplicated here to stay in sync.
   */
  const act = useCallback(async (
    nodeNum: number,
    path: string,
    // `undefined` for the endpoints that take no body. `ApiService.request`
    // guards the assignment with `if (body)`, so nothing is sent at all — not
    // an empty string the route would then fail to parse.
    body: unknown,
    failKey: string,
  ) => {
    if (!base) return;
    setError(null);
    try {
      await apiService.post(`${base}/${nodeNum}/${path}`, body);
      await Promise.all([loadCount(), loadList()]);
    } catch (e) {
      setError(e instanceof Error ? e.message : t(failKey));
      throw e;
    }
  }, [base, loadCount, loadList, t]);

  const dismiss = useCallback((nodeNum: number) =>
    act(nodeNum, 'dismiss', undefined, 'beacons.dismiss_failed'), [act]);

  const mute = useCallback((nodeNum: number) =>
    act(nodeNum, 'mute', undefined, 'beacons.mute_failed'), [act]);

  // Un-mute clears both flags server-side, so one action restores a row
  // whichever way it was hidden — the user asked to see it again, and which
  // button hid it is not something they should have to remember.
  const restore = useCallback(async (nodeNum: number) => {
    if (!base) return;
    setError(null);
    try {
      await apiService.post(`${base}/${nodeNum}/unmute`, undefined);
      await Promise.all([loadCount(), loadList()]);
    } catch (e) {
      setError(e instanceof Error ? e.message : t('beacons.restore_failed'));
      throw e;
    }
  }, [base, loadCount, loadList, t]);

  const accept = useCallback((nodeNum: number, slot: number, overwrite: boolean) =>
    act(nodeNum, 'accept', { slot, confirm: true, overwrite }, 'beacons.accept_failed'), [act]);

  const clearError = useCallback(() => setError(null), []);

  return {
    pendingCount, totalCount, countUnknown, offers, loading, error, clearError,
    setListOpen, dismiss, mute, restore, accept,
  };
}
