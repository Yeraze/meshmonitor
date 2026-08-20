/**
 * Automation Engine page (#3653) — Phase 1a management UI.
 *
 * Styled to the app theme. Automations are edited with an IFTTT/Maintainerr-style
 * structured builder (AutomationBuilder) over the graph model, with a raw-JSON
 * "advanced" fallback for imported/complex graphs. Variables have a help drawer
 * explaining types and scopes.
 */
import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { isValidCron } from 'cron-validator';
import apiService from '../../services/api';
import AutomationBuilder, { type VariableOption, type SourceOption, type UnifiedChannelOption, type ScriptOption, type NodeMultiOption } from './AutomationBuilder';
import AutomationTester from './AutomationTester';
import LiveTracePanel from './LiveTracePanel';
import TemplateGallery, { type InstalledAutomationRow } from './TemplateGallery';
import { StepList, type TraceStep } from './outcomeMeta';
import { summarizeTriggerEvent, parseJsonColumn } from './eventSummary';
import { UiIcon } from '../icons';
import { compile, decompile, type WorkflowForm } from './compile';
import './AutomationsPage.css';

interface Automation {
  id: string; name: string; description: string | null; enabled: boolean; config: string;
  createdAt: number; updatedAt: number;
}
interface Variable {
  id: string; name: string; description: string | null;
  type: 'string' | 'integer' | 'float' | 'boolean' | 'flag';
  scope: 'global' | 'source' | 'node' | 'sourceNode'; readonly: boolean; config: string;
}
interface Run {
  id: string; status: string; sourceId: string | null; startedAt: number; log: string | null;
  /** JSON `ctx.fields` bag captured when the rule fired — the triggering message (#4711). */
  triggerEvent: string | null;
}

const VARIABLE_TYPES = ['string', 'integer', 'float', 'boolean', 'flag', 'json'] as const;
const VARIABLE_SCOPES: { value: Variable['scope']; label: string }[] = [
  { value: 'global', label: 'Global' }, { value: 'source', label: 'Per Source' },
  { value: 'node', label: 'Per Node' }, { value: 'sourceNode', label: 'Per Source + Node' },
];

const DEFAULT_FORM: WorkflowForm = {
  trigger: { type: 'trigger.message', params: { textContains: 'ping' } },
  rules: [{ conditions: [], actions: [{ type: 'action.tapback', params: { emoji: '👍' } }] }],
  combine: null,
};

/** Builder-form validation: each rule needs an action (unless it only feeds a combine). */
function validateForm(form: WorkflowForm): string[] {
  const errs: string[] = [];
  if (form.trigger.type === 'trigger.geofence') {
    const shape = form.trigger.params.shape as { type?: string; vertices?: unknown[] } | undefined;
    if (!shape || (shape.type === 'polygon' && (shape.vertices?.length ?? 0) < 3)) {
      errs.push('Draw a geofence region (circle or polygon) on the map.');
    }
  }
  if (form.trigger.type === 'trigger.becameMobile' || form.trigger.type === 'trigger.leftHome') {
    const nums = form.trigger.params.nodeNums;
    if (!Array.isArray(nums) || nums.length === 0) {
      errs.push('Select at least one node to watch.');
    }
  }
  if (form.trigger.type === 'trigger.leftHome') {
    const thr = form.trigger.params.thresholdMeters;
    if (thr != null && thr !== '' && !(Number(thr) > 0)) {
      errs.push('Home-distance threshold must be greater than 0 metres.');
    }
  }
  if (form.trigger.type === 'trigger.schedule') {
    const cron = String(form.trigger.params.cron ?? '').trim();
    if (!cron || !isValidCron(cron, { seconds: false, alias: true, allowBlankDay: true })) {
      errs.push('Enter a valid 5-field cron expression for the schedule (e.g. "0 * * * *").');
    }
  }
  if (form.rules.length === 0) errs.push('Add at least one rule.');
  form.rules.forEach((r, i) => {
    if (r.actions.length === 0 && !(form.combine && r.conditions.length > 0)) {
      errs.push(`Rule ${i + 1} needs at least one action.`);
    }
  });
  if (form.combine && form.combine.actions.length === 0) errs.push('The FINALLY step needs at least one action.');
  return errs;
}

export default function AutomationsPage() {
  const [view, setView] = useState<'automations' | 'variables'>('automations');
  const navigate = useNavigate();
  return (
    <div className="ae-page">
      <div className="ae-container">
        <div className="ae-topbar">
          {/* Router navigation, not window.location: only a client-side navigate
              carries `showList`, which is what tells DashboardPage to show the
              source list instead of bouncing to the default landing page (#4447). */}
          <button className="ae-btn ae-btn--ghost" onClick={() => navigate('/', { state: { showList: true } })}><UiIcon name="back" size={15} /> Dashboard</button>
        </div>
        <h1 className="ae-title">Automation Engine</h1>
        <p className="ae-subtitle">Advanced Mode (beta) — global “when this happens, do that” workflows across every source.</p>
        <div className="ae-tabs">
          <button className={`ae-tab ${view === 'automations' ? 'is-active' : ''}`} onClick={() => setView('automations')}>Automations</button>
          <button className={`ae-tab ${view === 'variables' ? 'is-active' : ''}`} onClick={() => setView('variables')}>Variables</button>
        </div>
        {view === 'automations' ? <AutomationsList /> : <VariablesList />}
      </div>
    </div>
  );
}

// ─── Automations ─────────────────────────────────────────────────────────────

function AutomationsList() {
  const [items, setItems] = useState<Automation[]>([]);
  const [editing, setEditing] = useState<Automation | 'new' | null>(null);
  const [browsing, setBrowsing] = useState(false);
  const [runsFor, setRunsFor] = useState<Automation | null>(null);
  const [traceFor, setTraceFor] = useState<Automation | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try { setItems(await apiService.get<Automation[]>('/api/automations')); setError(null); }
    catch (e: any) { setError(e?.message ?? 'Failed to load'); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const toggle = async (a: Automation) => { await apiService.post(`/api/automations/${a.id}/${a.enabled ? 'disable' : 'enable'}`); void load(); };
  const remove = async (a: Automation) => { if (!confirm(`Delete automation “${a.name}”?`)) return; await apiService.delete(`/api/automations/${a.id}`); void load(); };
  const exportOne = async (a: Automation) => {
    const data = await apiService.get(`/api/automations/${a.id}/export`);
    await navigator.clipboard?.writeText(JSON.stringify(data, null, 2));
    alert('Exported JSON copied to clipboard.');
  };

  if (editing) return <AutomationEditor automation={editing} onClose={() => { setEditing(null); void load(); }} />;
  if (browsing) return (
    <TemplateGallery
      onClose={() => setBrowsing(false)}
      onInstalled={(rows: InstalledAutomationRow[]) => {
        setBrowsing(false);
        void load();
        // Installed automations always land disabled (see TemplateGallery) — open
        // the first one so the user reviews it before flipping it on. `createdAt`/
        // `updatedAt` aren't part of the /import response shape; the editor doesn't
        // read them, so a Date.now() placeholder is fine.
        if (rows.length > 0) {
          const row = rows[0];
          setEditing({
            id: row.id,
            name: row.name,
            description: row.description,
            enabled: row.enabled,
            config: row.config,
            createdAt: row.createdAt ?? Date.now(),
            updatedAt: row.updatedAt ?? Date.now(),
          });
        }
      }}
    />
  );
  if (runsFor) return <RunLog automation={runsFor} onClose={() => setRunsFor(null)} />;
  if (traceFor) return (
    <div>
      <button className="ae-btn ae-btn--ghost" onClick={() => setTraceFor(null)} style={{ marginBottom: '0.75rem' }}><UiIcon name="back" size={15} /> Back</button>
      <LiveTracePanel automationId={traceFor.id} automationName={traceFor.name} enabled={traceFor.enabled} onClose={() => setTraceFor(null)} />
    </div>
  );

  return (
    <div>
      <div className="ae-btn-row" style={{ marginBottom: '1rem' }}>
        <button className="ae-btn ae-btn--primary" onClick={() => setEditing('new')}>+ New automation</button>
        <button className="ae-btn" onClick={() => setBrowsing(true)}>Browse templates</button>
      </div>
      {error && <div className="ae-error-list">{error}</div>}
      {items.length === 0 && <div className="ae-empty">No automations yet. Create one to get started.</div>}
      {items.map((a) => (
        <div className="ae-card" key={a.id}>
          <div className="ae-row">
            <div className="ae-row-main">
              <div className="ae-row-title">{a.name}<span className="ae-chip">{triggerLabel(a)}</span></div>
              {a.description && <div className="ae-muted">{a.description}</div>}
            </div>
            <div className="ae-btn-row">
              <label className="ae-switch"><input type="checkbox" checked={a.enabled} onChange={() => toggle(a)} /> Enabled</label>
              <button className="ae-btn" onClick={() => setEditing(a)}>Edit</button>
              <button className="ae-btn" onClick={() => setRunsFor(a)}>Runs</button>
              <button className="ae-btn" onClick={() => setTraceFor(a)} title="Live debug trace of this rule">Trace</button>
              <button className="ae-btn" onClick={() => exportOne(a)}>Export</button>
              <button className="ae-btn ae-btn--danger" onClick={() => remove(a)}>Delete</button>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

function triggerLabel(a: Automation): string {
  try {
    const t = (JSON.parse(a.config).nodes ?? []).find((n: any) => String(n.type).startsWith('trigger.'));
    return t ? String(t.type).replace('trigger.', '') : '';
  } catch { return ''; }
}

function AutomationEditor({ automation, onClose }: { automation: Automation | 'new'; onClose: () => void }) {
  const isNew = automation === 'new';
  const initial = isNew ? null : (automation as Automation);
  const [name, setName] = useState(initial?.name ?? '');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [enabled, setEnabled] = useState(initial?.enabled ?? false);
  const [variables, setVariables] = useState<VariableOption[]>([]);
  const [sources, setSources] = useState<SourceOption[]>([]);
  const [channels, setChannels] = useState<UnifiedChannelOption[]>([]);
  const [scripts, setScripts] = useState<ScriptOption[]>([]);
  const [regions, setRegions] = useState<string[]>([]);
  const [nodes, setNodes] = useState<NodeMultiOption[]>([]);

  // Decide builder vs JSON from the existing config.
  const parsedInitial = (() => { try { return initial ? decompile(JSON.parse(initial.config)) : DEFAULT_FORM; } catch { return null; } })();
  const [mode, setMode] = useState<'builder' | 'json'>(parsedInitial ? 'builder' : 'json');
  const [form, setForm] = useState<WorkflowForm>(parsedInitial ?? DEFAULT_FORM);
  const [jsonText, setJsonText] = useState(() => initial ? pretty(initial.config) : JSON.stringify(compile(DEFAULT_FORM), null, 2));
  const [errors, setErrors] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [showTest, setShowTest] = useState(false);
  const [resettingHomes, setResettingHomes] = useState(false);
  const [resetHomesMsg, setResetHomesMsg] = useState<string | null>(null);
  const [runningNow, setRunningNow] = useState(false);
  const [runNowMsg, setRunNowMsg] = useState<string | null>(null);

  /** Compile the current editor state → graph config for the Test panel. */
  const getTestConfig = () => {
    try {
      const config: any = mode === 'builder' ? compile(form) : JSON.parse(jsonText);
      const trig = (config.nodes ?? []).find((n: any) => String(n.type).startsWith('trigger.'));
      return { ok: true, config, triggerType: trig?.type as string | undefined };
    } catch (e: any) {
      return { ok: false, error: e?.message ?? 'invalid config' };
    }
  };

  useEffect(() => {
    apiService.get<Variable[]>('/api/automations/variables')
      .then((vs) => setVariables(vs.map((v) => ({ name: v.name, type: v.type }))))
      .catch(() => setVariables([]));
    apiService.get<Array<{ id: string; name: string; type?: string; enabled?: boolean; radio?: { txEnabled?: boolean; canTransmit?: boolean } }>>('/api/sources')
      // `canTransmit` includes the UDP-broadcast relay path — a TX-disabled radio
      // with UDP Broadcast on still delivers automation sends (#4394). The
      // builder prefers it and falls back to `txEnabled` on older servers.
      .then((ss) => setSources(ss.map((s) => ({
        id: s.id,
        name: s.name,
        type: s.type,
        enabled: s.enabled,
        txEnabled: s.radio?.txEnabled,
        canTransmit: s.radio?.canTransmit,
      }))))
      .catch(() => setSources([]));
    apiService.get<UnifiedChannelOption[]>('/api/automations/channels')
      .then((cs) => setChannels(cs))
      .catch(() => setChannels([]));
    apiService.get<{ scripts: Array<{ filename: string; name?: string }> }>('/api/scripts')
      .then((r) => setScripts((r.scripts ?? []).map((s) => ({ value: s.filename, label: s.name || s.filename }))))
      .catch(() => setScripts([]));
    apiService.get<{ regions: Array<{ name: string }> }>('/api/automations/regions')
      .then((r) => setRegions((r.regions ?? []).map((x) => x.name)))
      .catch(() => setRegions([]));
    apiService.get<Array<{
      nodeNum: number;
      longName?: string;
      shortName?: string;
      nodeId?: string;
      mobile?: number;
      isMobile?: boolean;
      user?: { id?: string; longName?: string; shortName?: string };
    }>>('/api/nodes')
      .then((list) => {
        const rows = Array.isArray(list) ? list : [];
        setNodes(rows
          .filter((n) => {
            const num = Number(n.nodeNum);
            // Drop broadcast / unset MeshCore stubs from the hand-picker.
            return Number.isFinite(num) && num > 0 && num !== 0xffffffff;
          })
          .map((n) => {
            const nodeNum = Number(n.nodeNum);
            const nodeId = n.nodeId || n.user?.id || `!${(nodeNum >>> 0).toString(16).padStart(8, '0')}`;
            return {
              nodeNum,
              longName: n.longName || n.user?.longName,
              shortName: n.shortName || n.user?.shortName,
              nodeId,
              mobile: n.mobile,
              isMobile: n.isMobile,
            };
          }));
      })
      .catch(() => setNodes([]));
  }, []);

  const switchToJson = () => { setJsonText(JSON.stringify(compile(form), null, 2)); setMode('json'); };
  const switchToBuilder = () => {
    try {
      const f = decompile(JSON.parse(jsonText));
      if (!f) { setErrors(['This workflow is too advanced for the builder (branches/fanout) — edit it as JSON.']); return; }
      setForm(f); setErrors([]); setMode('builder');
    } catch { setErrors(['Invalid JSON.']); }
  };

  const save = async () => {
    setSaving(true); setErrors([]);
    let config: unknown;
    if (mode === 'builder') {
      const formErrors = validateForm(form);
      if (formErrors.length > 0) { setErrors(formErrors); setSaving(false); return; }
      config = compile(form);
    } else {
      try { config = JSON.parse(jsonText); } catch { setErrors(['Config is not valid JSON']); setSaving(false); return; }
    }
    try {
      const body = { name, description, enabled, config };
      if (isNew) await apiService.post('/api/automations', body);
      else await apiService.put(`/api/automations/${(automation as Automation).id}`, body);
      onClose();
    } catch (e: any) {
      const details = e?.details ?? e?.body?.details;
      setErrors(Array.isArray(details) ? details : [e?.message ?? 'Save failed']);
    } finally { setSaving(false); }
  };

  const resetHomes = async () => {
    if (isNew || !initial?.id) return;
    if (form.trigger.type !== 'trigger.leftHome' && mode === 'builder') {
      setResetHomesMsg('Switch the WHEN trigger to “Left home” (and save) before resetting homes.');
      return;
    }
    setResettingHomes(true);
    setResetHomesMsg(null);
    try {
      // Persist current builder config first so watched nodes / threshold match the reset.
      if (mode === 'builder') {
        const formErrors = validateForm(form);
        if (formErrors.length > 0) { setErrors(formErrors); setResettingHomes(false); return; }
        await apiService.put(`/api/automations/${initial.id}`, {
          name, description, enabled, config: compile(form),
        });
      }
      const res = await apiService.post<{
        reset: number; seeded: number;
        results: Array<{ nodeNum: number; seeded: boolean; sampleCount?: number; inlierCount?: number }>;
      }>(`/api/automations/${initial.id}/reset-homes`, {});
      const pending = (res.results ?? []).filter((r) => !r.seeded).map((r) => r.nodeNum);
      setResetHomesMsg(
        pending.length === 0
          ? `Reset ${res.reset} home(s); seeded ${res.seeded} from position history.`
          : `Reset ${res.reset} home(s); seeded ${res.seeded} from history. No history yet for node #(s) ${pending.join(', ')} — next live fix will set those.`,
      );
    } catch (e) {
      setResetHomesMsg(e instanceof Error ? e.message : 'Failed to reset homes');
    } finally {
      setResettingHomes(false);
    }
  };

  /**
   * Fire the SAVED automation's real actions right now (#4827). Live execution,
   * so it is gated behind an explicit confirm — distinct from the safe "Test"
   * dry-run. The engine runs the persisted config (not the unsaved editor draft)
   * and honors the rule's cooldown / rate limits without touching its schedule.
   */
  const runNow = async () => {
    if (isNew || !initial?.id) return;
    const proceed = window.confirm(
      "Run this automation now?\n\n"
      + "This fires the SAVED automation's real actions immediately. It can send "
      + "messages to the mesh, reboot nodes, or trigger notifications. This is NOT "
      + "a dry run.\n\n"
      + "It still respects the rule's cooldown and rate limits, and does not change "
      + "its schedule.\n\nContinue?",
    );
    if (!proceed) return;
    setRunningNow(true);
    setRunNowMsg(null);
    try {
      const r = await apiService.runAutomationNow(initial.id);
      if (r.ran) {
        const n = r.actions?.length ?? 0;
        setRunNowMsg(`Fired: ${r.status ?? 'completed'} (${n} action${n === 1 ? '' : 's'} dispatched).`);
      } else if (r.reason === 'cooldown' || r.reason === 'ratelimited') {
        setRunNowMsg(`Did not fire: ${r.detail ?? r.reason}.`);
      } else {
        setRunNowMsg(`Did not fire: ${r.reason ?? 'unknown reason'}.`);
      }
    } catch (e) {
      setRunNowMsg(e instanceof Error ? e.message : 'Failed to run automation');
    } finally {
      setRunningNow(false);
    }
  };

  const showResetHomes = !isNew && (
    (mode === 'builder' && form.trigger.type === 'trigger.leftHome')
    || (mode === 'json' && jsonText.includes('trigger.leftHome'))
  );

  return (
    <div>
      <div className="ae-btn-row" style={{ marginBottom: '0.75rem' }}>
        <button className="ae-btn ae-btn--ghost" onClick={onClose}><UiIcon name="back" size={15} /> Back</button>
        <span style={{ marginLeft: 'auto' }} />
        {mode === 'builder'
          ? <button className="ae-btn" onClick={switchToJson}>Advanced (JSON)</button>
          : <button className="ae-btn" onClick={switchToBuilder}>Use builder</button>}
      </div>
      <h2 className="ae-title" style={{ fontSize: '1.25rem' }}>{isNew ? 'New automation' : `Edit: ${initial?.name}`}</h2>

      <div className="ae-card">
        <div className="ae-grid2">
          <div className="ae-field"><label className="ae-field-label">Name</label>
            <input className="ae-input" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Ping responder" /></div>
          <div className="ae-field"><label className="ae-field-label">Description</label>
            <input className="ae-input" value={description ?? ''} onChange={(e) => setDescription(e.target.value)} /></div>
        </div>
        <label className="ae-switch"><input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> Enabled</label>
      </div>

      {mode === 'builder'
        ? <AutomationBuilder form={form} variables={variables} sources={sources} channels={channels} scripts={scripts} regions={regions} nodes={nodes} onChange={setForm} />
        : (
          <div className="ae-field">
            <label className="ae-field-label">Workflow graph (JSON)</label>
            <textarea className="ae-textarea ae-textarea--code" value={jsonText} spellCheck={false} onChange={(e) => setJsonText(e.target.value)} />
          </div>
        )}

      {errors.length > 0 && <ul className="ae-error-list">{errors.map((er, i) => <li key={i}>{er}</li>)}</ul>}
      <div className="ae-btn-row" style={{ marginTop: '0.75rem' }}>
        <button className="ae-btn ae-btn--primary" disabled={saving} onClick={save}>{saving ? 'Saving…' : 'Save automation'}</button>
        <button className="ae-btn" onClick={() => setShowTest((s) => !s)}>{!showTest && <UiIcon name="play" size={15} />} {showTest ? 'Hide test' : 'Test'}</button>
        {!isNew && (
          <button
            className="ae-btn"
            disabled={runningNow}
            onClick={runNow}
            title="Fire this automation's real actions now (live execution, not a dry run)"
          >
            {runningNow ? 'Running…' : <><UiIcon name="zap" size={15} /> Run now</>}
          </button>
        )}
        {showResetHomes && (
          <button
            className="ae-btn"
            disabled={resettingHomes}
            onClick={resetHomes}
            title="Delete stored home anchors and re-seed each watched node from its position-history cluster (outliers dropped)"
          >
            {resettingHomes ? 'Resetting homes…' : 'Reset homes from history'}
          </button>
        )}
      </div>
      {resetHomesMsg && <div className="ae-muted" style={{ marginTop: '0.4rem' }}>{resetHomesMsg}</div>}
      {runNowMsg && <div className="ae-muted" style={{ marginTop: '0.4rem' }}>{runNowMsg}</div>}

      {showTest && <AutomationTester getConfig={getTestConfig} variables={variables} sources={sources} />}
    </div>
  );
}

/**
 * One persisted run. Leads with what a human debugging the rule actually needs
 * (#4711) — when it fired, which node, which channel, and the triggering message
 * itself — and tucks the step trace and raw payload behind `<details>`.
 */
function RunRow({ run }: { run: Run }) {
  const summary = summarizeTriggerEvent(parseJsonColumn<Record<string, unknown>>(run.triggerEvent));
  const steps = parseJsonColumn<TraceStep[]>(run.log);
  const statusColor = run.status === 'completed' ? 'var(--color-success)' : run.status === 'failed' ? 'var(--color-error)' : 'inherit';
  return (
    <div className="ae-card">
      <div className="ae-row">
        <div className="ae-row-main">
          <span style={{ fontWeight: 700, color: statusColor }}>{run.status}</span>
          <span className="ae-chip">{run.sourceId ?? '—'}</span>
        </div>
        <span className="ae-muted">{new Date(run.startedAt).toLocaleString()}</span>
      </div>

      {(summary.node || summary.channel || summary.detail) && (
        <div className="ae-run-meta">
          {summary.node && <span className="ae-run-fact"><UiIcon name="user" size={13} /> {summary.node}</span>}
          {summary.channel && <span className="ae-run-fact"><UiIcon name="channels" size={13} /> {summary.channel}</span>}
          {summary.detail && <span className="ae-run-fact"><UiIcon name="info" size={13} /> {summary.detail}</span>}
        </div>
      )}
      {summary.text && <div className="ae-run-text">{summary.text}</div>}

      {steps && steps.length > 0 && (
        <details className="ae-trace-steps-wrap">
          <summary className="ae-muted">execution trace ({steps.length} steps)</summary>
          <StepList steps={steps} />
        </details>
      )}
      {/* Unparseable log — show it raw rather than dropping the only diagnostic. */}
      {!steps && run.log && (
        <pre className="ae-muted ae-run-raw">{run.log}</pre>
      )}
      {run.triggerEvent && (
        <details className="ae-trace-steps-wrap">
          <summary className="ae-muted">trigger payload</summary>
          {/* Stored minified; `pretty` falls back to the raw string if it won't parse. */}
          <pre className="ae-muted ae-run-raw">{pretty(run.triggerEvent)}</pre>
        </details>
      )}
    </div>
  );
}

function RunLog({ automation, onClose }: { automation: Automation; onClose: () => void }) {
  const [runs, setRuns] = useState<Run[]>([]);
  useEffect(() => { apiService.get<Run[]>(`/api/automations/${automation.id}/runs`).then(setRuns).catch(() => setRuns([])); }, [automation.id]);
  return (
    <div>
      <button className="ae-btn ae-btn--ghost" onClick={onClose} style={{ marginBottom: '0.75rem' }}><UiIcon name="back" size={15} /> Back</button>
      <h2 className="ae-title" style={{ fontSize: '1.25rem' }}>Runs: {automation.name}</h2>
      {runs.length === 0 && <div className="ae-empty">No runs yet.</div>}
      {runs.map((r) => <RunRow run={r} key={r.id} />)}
    </div>
  );
}

// ─── Variables ───────────────────────────────────────────────────────────────

function VariablesList() {
  const [items, setItems] = useState<Variable[]>([]);
  const [name, setName] = useState('');
  const [type, setType] = useState<Variable['type']>('integer');
  const [scope, setScope] = useState<Variable['scope']>('global');
  const [readonly, setReadonly] = useState(false);
  const [defaultValue, setDefaultValue] = useState('');
  const [flagDuration, setFlagDuration] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);

  const load = useCallback(async () => {
    try { setItems(await apiService.get<Variable[]>('/api/automations/variables')); }
    catch (e: any) { setError(e?.message ?? 'Failed to load'); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const create = async () => {
    setError(null);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      setError('Name must be a letters/digits/underscore identifier (no dots or spaces) — needed so {{ var.name.field }} can index JSON.');
      return;
    }
    const config: Record<string, unknown> = {};
    if (defaultValue !== '') config.defaultValue = (type === 'integer' || type === 'float') ? Number(defaultValue) : defaultValue;
    if (type === 'flag' && flagDuration !== '') config.flagDurationSeconds = Number(flagDuration);
    try {
      await apiService.post('/api/automations/variables', { name, type, scope, readonly, config });
      setName(''); setDefaultValue(''); setFlagDuration(''); void load();
    } catch (e: any) { setError(e?.message ?? 'Create failed'); }
  };
  const remove = async (v: Variable) => { if (!confirm(`Delete variable “${v.name}”?`)) return; await apiService.delete(`/api/automations/variables/${v.id}`); void load(); };

  return (
    <div>
      <div className="ae-card">
        <div className="ae-row" style={{ marginBottom: '0.6rem' }}>
          <strong>New variable</strong>
          <button className="ae-btn ae-btn--ghost" onClick={() => setHelpOpen(true)}>What are types &amp; scopes? <span className="ae-help-icon">?</span></button>
        </div>
        <div className="ae-grid2">
          <div className="ae-field"><label className="ae-field-label">Name</label>
            <input className="ae-input" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. lowBatteryThreshold" /></div>
          <div className="ae-field">
            <label className="ae-field-label">Type <button className="ae-help-icon" onClick={() => setHelpOpen(true)} title="Explain types">?</button></label>
            <select className="ae-select" value={type} onChange={(e) => setType(e.target.value as Variable['type'])}>
              {VARIABLE_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </div>
          <div className="ae-field">
            <label className="ae-field-label">Scope <button className="ae-help-icon" onClick={() => setHelpOpen(true)} title="Explain scopes">?</button></label>
            <select className="ae-select" value={scope} onChange={(e) => setScope(e.target.value as Variable['scope'])}>
              {VARIABLE_SCOPES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
            </select>
          </div>
          <div className="ae-field"><label className="ae-field-label">Default value {readonly ? '(constant)' : ''}</label>
            <input className="ae-input" value={defaultValue} onChange={(e) => setDefaultValue(e.target.value)} /></div>
          {type === 'flag' && (
            <div className="ae-field"><label className="ae-field-label">Flag auto-clear (seconds)</label>
              <input className="ae-input" value={flagDuration} onChange={(e) => setFlagDuration(e.target.value)} placeholder="e.g. 86400" /></div>
          )}
          <div className="ae-field" style={{ alignSelf: 'end' }}>
            <label className="ae-switch"><input type="checkbox" checked={readonly} onChange={(e) => setReadonly(e.target.checked)} /> Constant (read-only to automations)</label>
          </div>
        </div>
        <button className="ae-btn ae-btn--primary" disabled={!name} onClick={create}>Create variable</button>
        {error && <div className="ae-error-list">{error}</div>}
      </div>

      {items.length === 0 && <div className="ae-empty">No variables yet.</div>}
      {items.map((v) => (
        <div className="ae-card" key={v.id}>
          <div className="ae-row">
            <div className="ae-row-main">
              <div className="ae-row-title">{v.name}<span className="ae-chip">{v.type} · {scopeLabel(v.scope)}{v.readonly ? ' · constant' : ''}</span></div>
              {v.config && v.config !== '{}' && <div className="ae-muted">{v.config}</div>}
            </div>
            <button className="ae-btn ae-btn--danger" onClick={() => remove(v)}>Delete</button>
          </div>
        </div>
      ))}

      {helpOpen && <VariablesHelpDrawer onClose={() => setHelpOpen(false)} />}
    </div>
  );
}

function scopeLabel(s: Variable['scope']): string {
  return VARIABLE_SCOPES.find((x) => x.value === s)?.label ?? s;
}

function VariablesHelpDrawer({ onClose }: { onClose: () => void }) {
  return (
    <>
      <div className="ae-drawer-overlay" onClick={onClose} />
      <div className="ae-drawer">
        <button className="ae-btn ae-btn--ghost ae-drawer-close" onClick={onClose} aria-label="Close variables help"><UiIcon name="close" size={16} /></button>
        <h2>Variables</h2>
        <p className="ae-muted">Reusable values you can read and write from automations, referenced as <code>{'{{ var.name }}'}</code>.</p>

        <h3>Types</h3>
        <dl>
          <dt>string</dt><dd>Free text — e.g. a node name or the last message received.</dd>
          <dt>integer</dt><dd>A whole number — e.g. a counter, or a threshold like 20.</dd>
          <dt>float</dt><dd>A decimal number — e.g. a temperature.</dd>
          <dt>boolean</dt><dd>True / false.</dd>
          <dt>flag</dt><dd>A boolean that <strong>automatically clears itself</strong> after a set duration. The anti-spam primitive — e.g. “have I welcomed this node in the last 24h?”. Raise it after acting; it lowers itself when the timer elapses.</dd>
        </dl>

        <h3>Scopes</h3>
        <p className="ae-muted">A scope decides how many separate values a variable holds.</p>
        <dl>
          <dt>Global</dt><dd>One shared value for the whole system.</dd>
          <dt>Per Source</dt><dd>A separate value for each connection/source.</dd>
          <dt>Per Node</dt><dd>A separate value for each node, shared across every source that hears it.</dd>
          <dt>Per Source + Node</dt><dd>A separate value for each node within each source — the most granular.</dd>
        </dl>
        <p className="ae-muted">For node-scoped variables, automations read/write the value for the trigger’s subject node (e.g. the message sender) automatically.</p>

        <h3>Constant (read-only)</h3>
        <p className="ae-muted">Tick <strong>Constant</strong> to make a value you set here and reference as a threshold/config. Automations can read it but never overwrite it.</p>

        <p className="ae-muted" style={{ marginTop: '1.25rem' }}>Full documentation will be published at <a href="https://meshmonitor.org" target="_blank" rel="noreferrer">meshmonitor.org</a>.</p>
      </div>
    </>
  );
}

function pretty(jsonStr: string): string { try { return JSON.stringify(JSON.parse(jsonStr), null, 2); } catch { return jsonStr; } }
