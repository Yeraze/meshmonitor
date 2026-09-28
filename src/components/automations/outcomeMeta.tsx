/**
 * Shared rendering vocabulary for automation evaluation steps — used by both the
 * offline Test panel (AutomationTester) and the live trace panel (LiveTracePanel)
 * so the two never drift in how a `condition:true` / `action:error` / … step looks.
 */
import { UiIcon, type UiIconName } from '../icons';

export interface TraceStep {
  nodeId?: string;
  type: string;
  outcome: string;
  error?: string;
  /** Resolved result summary or halt reason (#5445). */
  detail?: Record<string, unknown>;
}

/** One-line text for a step's `detail` (#5445). A `reason` reads as prose; anything else as key=value pairs. */
function formatStepDetail(detail: Record<string, unknown> | undefined): string {
  if (!detail) return '';
  if (typeof detail.reason === 'string') return detail.reason;
  return Object.entries(detail)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : String(v)}`)
    .join(', ');
}

export const OUTCOME_META: Record<string, { icon: UiIconName; cls: string; label: string }> = {
  'condition:true': { icon: 'check', cls: 'ok', label: 'condition true' },
  'condition:false': { icon: 'close', cls: 'no', label: 'condition false' },
  'action:ok': { icon: 'forward', cls: 'ok', label: 'action ran' },
  'action:error': { icon: 'alert', cls: 'err', label: 'action error' },
  'setVar:ok': { icon: 'edit', cls: 'ok', label: 'variable set' },
  'setVar:error': { icon: 'alert', cls: 'err', label: 'variable error' },
  'activated': { icon: 'activity', cls: 'muted', label: 'activated' },
  'guard:maxActions': { icon: 'blocked', cls: 'err', label: 'action cap hit' },
  'engine:error': { icon: 'error', cls: 'err', label: 'engine error' },
  'run:halted': { icon: 'pause', cls: 'muted', label: 'run stopped' },
};

/** Render a list of evaluation steps with consistent icons/labels. */
export function StepList({ steps }: { steps: TraceStep[] }) {
  if (steps.length === 0) return <div className="ae-muted">No steps.</div>;
  return (
    <div className="ae-trace">
      {steps.map((s, i) => {
        const m = OUTCOME_META[s.outcome] ?? { icon: 'info' as const, cls: 'muted', label: s.outcome };
        const detail = formatStepDetail(s.detail);
        return (
          <div className={`ae-trace-step ae-trace-step--${m.cls}`} key={i}>
            <span className="ae-trace-icon"><UiIcon name={m.icon} size={15} /></span>
            <span className="ae-trace-type">{s.type}</span>
            <span className="ae-muted">{m.label}{s.error ? ` — ${s.error}` : ''}{detail ? ` — ${detail}` : ''}</span>
          </div>
        );
      })}
    </div>
  );
}
