/**
 * LiveTracePanel — in-app "view logs" for a single automation rule.
 *
 * Opt-in, live-only debugging: while open it asks the server (over the shared
 * Socket.io connection) to stream every event the engine evaluates against THIS
 * rule, and shows why each did or didn't run (fired + step trace / filtered-out
 * + reason / cooldown). Nothing is persisted — entries live in a capped in-memory
 * buffer and the session auto-stops after 5 minutes (and on close / disconnect).
 */
import { useEffect, useRef, useState } from 'react';
import { useWebSocketContext } from '../../contexts/WebSocketContext';
import { StepList, type TraceStep } from './outcomeMeta';
import { UiIcon } from '../icons';

const TRACE_DURATION_MS = 5 * 60_000;
const MAX_ENTRIES = 200;

interface TraceEntry {
  ts: number;
  automationId: string;
  triggerType: string;
  sourceId: string | null;
  event: Record<string, unknown>;
  outcome: 'fired' | 'prefiltered' | 'cooldown';
  reason?: string;
  status?: 'completed' | 'failed';
  conditionResults?: Record<string, boolean>;
  actions?: Array<{ nodeId: string; ok: boolean; error?: string }>;
  steps?: TraceStep[];
}

interface LiveTracePanelProps {
  automationId: string;
  automationName: string;
  /** Whether the rule is enabled — disabled rules never evaluate, so warn. */
  enabled: boolean;
  onClose: () => void;
}

/** A compact one-line summary of the triggering event for the entry header. */
function summarizeEvent(triggerType: string, event: Record<string, unknown>): string {
  const bits: string[] = [];
  if (triggerType === 'trigger.message') {
    if (event.from != null) bits.push(`from ${event.from}`);
    if (event.channel != null) bits.push(`ch ${event.channel}`);
    if (typeof event.text === 'string') bits.push(`"${event.text}"`);
  } else if (triggerType === 'trigger.telemetry') {
    bits.push(`${event.telemetryType ?? '?'} = ${event.value ?? '?'}`);
  } else if (triggerType === 'trigger.geofence') {
    bits.push(`${event.event ?? '?'} · node ${event.nodeNum ?? '?'}`);
  } else if (triggerType === 'trigger.system') {
    bits.push(String(event.event ?? ''));
  } else if (event.nodeNum != null) {
    bits.push(`node ${event.nodeNum}`);
  }
  return bits.join(' · ') || '(no event payload)';
}

const OUTCOME_BADGE: Record<string, { label: string; cls: string }> = {
  prefiltered: { label: 'filtered out', cls: 'no' },
  cooldown: { label: 'cooldown', cls: 'muted' },
};

export default function LiveTracePanel({ automationId, automationName, enabled, onClose }: LiveTracePanelProps) {
  const { state } = useWebSocketContext();
  const socket = state.socket;
  const [entries, setEntries] = useState<TraceEntry[]>([]);
  const [status, setStatus] = useState<'connecting' | 'live' | 'stopped' | 'error'>('connecting');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [remaining, setRemaining] = useState<number>(TRACE_DURATION_MS);
  const expiresAtRef = useRef<number>(0);

  // Arm the trace + subscribe while mounted. Re-runs if the socket (re)connects:
  // cleanup stops on the old socket (a no-op once it's gone) and we re-arm on the
  // new one, which re-fires `automation-trace:started` and resets the countdown —
  // intended, since a reconnect starts a fresh 5-minute server-side session.
  useEffect(() => {
    if (!socket) {
      setStatus('connecting');
      return;
    }
    const onTrace = (payload: TraceEntry) => {
      if (!payload || payload.automationId !== automationId) return;
      setEntries((prev) => {
        const next = [payload, ...prev];
        return next.length > MAX_ENTRIES ? next.slice(0, MAX_ENTRIES) : next;
      });
    };
    const onStarted = (data: { automationId: string; expiresAt: number }) => {
      if (data?.automationId !== automationId) return;
      expiresAtRef.current = data.expiresAt;
      setStatus('live');
    };
    const onError = (data: { automationId?: string; error: string }) => {
      if (data?.automationId && data.automationId !== automationId) return;
      setErrorMsg(data?.error ?? 'trace error');
      setStatus('error');
    };

    socket.on('automation:trace', onTrace);
    socket.on('automation-trace:started', onStarted);
    socket.on('automation-trace:error', onError);
    socket.emit('automation-trace:start', { automationId, durationMs: TRACE_DURATION_MS });

    return () => {
      socket.emit('automation-trace:stop', { automationId });
      socket.off('automation:trace', onTrace);
      socket.off('automation-trace:started', onStarted);
      socket.off('automation-trace:error', onError);
    };
  }, [socket, automationId]);

  // Countdown to auto-stop (the server expires it too).
  useEffect(() => {
    if (status !== 'live') return;
    const tick = () => {
      const left = Math.max(0, expiresAtRef.current - Date.now());
      setRemaining(left);
      if (left <= 0) setStatus('stopped');
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [status]);

  const mmss = (ms: number) => {
    const s = Math.ceil(ms / 1000);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  };

  return (
    <div className="ae-trace-panel">
      <div className="ae-trace-panel-head">
        <div>
          <strong>Live trace</strong> · {automationName}
          {status === 'live' && <span className="ae-chip" style={{ marginLeft: '0.5rem' }}><UiIcon name="statusOn" size={11} /> live · {mmss(remaining)} left</span>}
          {status === 'connecting' && <span className="ae-chip" style={{ marginLeft: '0.5rem' }}>connecting…</span>}
          {status === 'stopped' && <span className="ae-chip" style={{ marginLeft: '0.5rem' }}>stopped (auto)</span>}
          {status === 'error' && <span className="ae-test-badge ae-test-badge--err" style={{ marginLeft: '0.5rem' }}>error: {errorMsg}</span>}
        </div>
        <div className="ae-row" style={{ gap: '0.4rem' }}>
          <button className="ae-btn ae-btn--ghost" onClick={() => setEntries([])}>Clear</button>
          <button className="ae-btn ae-btn--ghost" onClick={onClose}>Close</button>
        </div>
      </div>

      {!enabled && (
        <div className="ae-test-note">This rule is <strong>disabled</strong> — the engine never evaluates it, so no events will appear. Enable the rule to see live evaluations.</div>
      )}

      <div className="ae-trace-feed">
        {entries.length === 0 && (
          <div className="ae-muted" style={{ padding: '0.6rem 0' }}>
            Waiting for events… send traffic that this rule's trigger listens for (e.g. a message on its channel) and each evaluation will appear here.
          </div>
        )}
        {entries.map((e, i) => {
          const fired = e.outcome === 'fired';
          const badge = fired
            ? { label: e.status === 'failed' ? 'fired · failed' : 'fired', cls: e.status === 'failed' ? 'err' : 'ok' }
            : (OUTCOME_BADGE[e.outcome] ?? { label: e.outcome, cls: 'muted' });
          return (
            <div className="ae-trace-entry" key={`${e.ts}-${i}`}>
              <div className="ae-trace-entry-head">
                <span className={`ae-test-badge ae-test-badge--${badge.cls}`}>{badge.label}</span>
                <span className="ae-muted">{new Date(e.ts).toLocaleTimeString()}</span>
                <span className="ae-trace-entry-summary">{summarizeEvent(e.triggerType, e.event)}</span>
              </div>
              {!fired && e.reason && <div className="ae-muted ae-trace-reason">↳ {e.reason}</div>}
              {fired && e.steps && e.steps.length > 0 && (
                <details className="ae-trace-steps-wrap">
                  <summary className="ae-muted">execution trace ({e.steps.length} steps)</summary>
                  <StepList steps={e.steps} />
                </details>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
