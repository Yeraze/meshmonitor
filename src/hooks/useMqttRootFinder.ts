/**
 * Client for the MQTT root finder (#6287): start a sample, poll it once a
 * second, stop it, and cancel it when the component unmounts.
 *
 * Nothing here saves anything. The server samples a broker with a
 * subscribe-only connection; the hook only reads the result.
 *
 * The routes answer `ok(res, ...)`; `ApiService` returns the raw body, so
 * `data` is unwrapped here.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import apiService, { ApiError } from '../services/api';

const BASE = '/api/mqtt/root-finder/samples';
const POLL_MS = 1000;

export type RootFinderContext = 'bridge' | 'device' | 'remote_device' | 'preset' | 'meshcore_mqtt';
export type RootFinderProtocol = 'meshtastic' | 'meshcore';
export type SampleStatus = 'connecting' | 'sampling' | 'done' | 'failed' | 'cancelled';

export interface LadderRowView {
  root: string;
  kind: 'region' | 'country' | 'subdivision' | 'city';
  heard: boolean;
  nodes?: number;
  messages?: number;
  floor?: boolean;
}

export interface CommunityRowView {
  root: string;
  name: string;
  heard: boolean;
  nodes?: number;
  messages?: number;
  floor?: boolean;
}

export interface HeardRowView {
  root: string;
  nodes: number;
  messages: number;
  depth: number;
  nearestKm?: number;
  tier: 1 | 2 | 3;
  retainedOnly: boolean;
  floor: boolean;
}

export interface SampleViewData {
  protocol?: RootFinderProtocol;
  status: SampleStatus;
  elapsedMs: number;
  durationMs: number;
  regionFloor: boolean;
  hasLocation: boolean;
  ladder: LadderRowView[];
  community: CommunityRowView[];
  heard: HeardRowView[];
  error?: 'UNREACHABLE' | 'TIMEOUT' | 'AUTH_REJECTED' | 'SUBSCRIBE_DENIED' | 'EVICTED' | 'BLOCKED_TARGET';
}

export interface RootFinderBroker {
  /** Bridge and preset forms. */
  url?: string;
  /** Device forms. */
  address?: string;
  tlsEnabled?: boolean;
}

export interface RootFinderTarget {
  broker: RootFinderBroker;
  username?: string;
  password?: string;
  brokerPresetId?: number | null;
  /** MeshCore ingest only: the form's TLS-verify checkbox, sent when off. */
  rejectUnauthorized?: boolean;
}

export interface StartParams {
  context: RootFinderContext;
  sourceId?: string | null;
  nodeNum?: number | null;
  target: RootFinderTarget;
  /** Meshtastic only. MeshCore samples every region and sends none. */
  regionRoot?: string;
}

export type RootFinderPhase = 'idle' | 'starting' | 'running' | 'finished' | 'rejected';

export interface RootFinderState {
  phase: RootFinderPhase;
  view: SampleViewData | null;
  /** Machine code of a rejected start, e.g. `ROOT_FINDER_BUSY`. */
  errorCode?: string;
  errorMessage?: string;
  retryAfterSeconds?: number;
}

const IDLE: RootFinderState = { phase: 'idle', view: null };

export function useMqttRootFinder() {
  const [state, setState] = useState<RootFinderState>(IDLE);
  const sampleId = useRef<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const alive = useRef(true);
  const running = useRef(false);

  const clearTimer = () => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  };

  const poll = useCallback(async () => {
    const id = sampleId.current;
    if (!id || !alive.current) return;
    try {
      const body = await apiService.get<{ data?: SampleViewData }>(`${BASE}/${id}`);
      if (!alive.current || sampleId.current !== id) return;
      const view = body?.data ?? null;
      if (!view) throw new Error('empty');
      const done = view.status !== 'connecting' && view.status !== 'sampling';
      setState({ phase: done ? 'finished' : 'running', view });
      if (done) {
        running.current = false;
        return;
      }
    } catch (e) {
      if (!alive.current || sampleId.current !== id) return;
      if (e instanceof ApiError && e.status === 404) {
        running.current = false;
        setState((s) => ({ ...s, phase: 'finished' }));
        return;
      }
      // A transient failure: keep the last view and try again.
    }
    timer.current = setTimeout(() => void poll(), POLL_MS);
  }, []);

  const start = useCallback(
    async (p: StartParams) => {
      clearTimer();
      setState({ phase: 'starting', view: null });
      const body = {
        context: p.context,
        ...(p.regionRoot ? { regionRoot: p.regionRoot } : {}),
        broker: p.target.broker,
        ...(p.sourceId ? { sourceId: p.sourceId } : {}),
        ...(p.nodeNum != null ? { nodeNum: p.nodeNum } : {}),
        ...(p.target.username ? { username: p.target.username } : {}),
        ...(p.target.password ? { password: p.target.password } : {}),
        ...(p.target.brokerPresetId ? { brokerPresetId: p.target.brokerPresetId } : {}),
        ...(p.target.rejectUnauthorized === false ? { rejectUnauthorized: false } : {}),
      };
      try {
        const res = await apiService.post<{ data?: { sampleId: string } }>(BASE, body);
        if (!alive.current) return;
        const id = res?.data?.sampleId;
        if (!id) throw new Error('no id');
        sampleId.current = id;
        running.current = true;
        setState({ phase: 'running', view: null });
        timer.current = setTimeout(() => void poll(), POLL_MS);
      } catch (e) {
        if (!alive.current) return;
        const err = e instanceof ApiError ? e : null;
        setState({
          phase: 'rejected',
          view: null,
          errorCode: err?.code ?? 'INTERNAL_ERROR',
          errorMessage: err?.message,
          // 429: back off for as long as the server said.
          retryAfterSeconds: err?.retryAfterSeconds,
        });
      }
    },
    [poll],
  );

  /** Stop early. Partial results stay on screen. */
  const stop = useCallback(async () => {
    const id = sampleId.current;
    clearTimer();
    if (!id || !running.current) return;
    running.current = false;
    try {
      await apiService.delete(`${BASE}/${id}`);
      const body = await apiService.get<{ data?: SampleViewData }>(`${BASE}/${id}`);
      if (alive.current && body?.data) setState({ phase: 'finished', view: body.data });
    } catch {
      if (alive.current) setState((s) => ({ ...s, phase: 'finished' }));
    }
  }, []);

  const reset = useCallback(() => {
    clearTimer();
    const id = sampleId.current;
    if (id && running.current) {
      void apiService.delete(`${BASE}/${id}`).catch(() => undefined);
    }
    sampleId.current = null;
    running.current = false;
    setState(IDLE);
  }, []);

  // Cancel a running sample when the component goes away.
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      clearTimer();
      const id = sampleId.current;
      if (id && running.current) {
        running.current = false;
        void apiService.delete(`${BASE}/${id}`).catch(() => undefined);
      }
    };
  }, []);

  return { state, start, stop, reset };
}
