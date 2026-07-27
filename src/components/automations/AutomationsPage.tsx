/**
 * Automation Engine page (#3653) — Phase 1a management UI.
 *
 * Styled to the app theme. Automations are edited with an IFTTT/Maintainerr-style
 * structured builder (AutomationBuilder) over the graph model, with a raw-JSON
 * "advanced" fallback for imported/complex graphs. Variables have a help drawer
 * explaining types and scopes.
 */
import { useCallback, useEffect, useState } from 'react';
import { isValidCron } from 'cron-validator';
import { appBasename } from '../../init';
import apiService from '../../services/api';
import AutomationBuilder, { type VariableOption, type SourceOption, type UnifiedChannelOption, type ScriptOption } from './AutomationBuilder';
import AutomationTester from './AutomationTester';
import LiveTracePanel from './LiveTracePanel';
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
interface Run { id: string; status: string; sourceId: string | null; startedAt: number; log: string | null; }

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
  return (
    <div className="ae-page">
      <div className="ae-container">
        <div className="ae-topbar">
          <button className="ae-btn ae-btn--ghost" onClick={() => { window.location.href = `${appBasename}/`; }}><UiIcon name="back" size={15} /> Dashboard</button>
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

  // Decide builder vs JSON from the existing config.
  const parsedInitial = (() => { try { return initial ? decompile(JSON.parse(initial.config)) : DEFAULT_FORM; } catch { return null; } })();
  const [mode, setMode] = useState<'builder' | 'json'>(parsedInitial ? 'builder' : 'json');
  const [form, setForm] = useState<WorkflowForm>(parsedInitial ?? DEFAULT_FORM);
  const [jsonText, setJsonText] = useState(() => initial ? pretty(initial.config) : JSON.stringify(compile(DEFAULT_FORM), null, 2));
  const [errors, setErrors] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [showTest, setShowTest] = useState(false);

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
    apiService.get<Array<{ id: string; name: string; type?: string; enabled?: boolean; radio?: { txEnabled?: boolean } }>>('/api/sources')
      .then((ss) => setSources(ss.map((s) => ({ id: s.id, name: s.name, type: s.type, enabled: s.enabled, txEnabled: s.radio?.txEnabled }))))
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
        ? <AutomationBuilder form={form} variables={variables} sources={sources} channels={channels} scripts={scripts} regions={regions} onChange={setForm} />
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
      </div>

      {showTest && <AutomationTester getConfig={getTestConfig} variables={variables} sources={sources} />}
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
      {runs.map((r) => (
        <div className="ae-card" key={r.id}>
          <div className="ae-row">
            <div className="ae-row-main">
              <span style={{ fontWeight: 700, color: r.status === 'completed' ? 'var(--ctp-green)' : r.status === 'failed' ? 'var(--ctp-red)' : 'inherit' }}>{r.status}</span>
              <span className="ae-chip">{r.sourceId ?? '—'}</span>
            </div>
            <span className="ae-muted">{new Date(r.startedAt).toLocaleString()}</span>
          </div>
          {r.log && <pre className="ae-muted" style={{ overflowX: 'auto', marginBottom: 0, fontSize: '0.72rem' }}>{r.log}</pre>}
        </div>
      ))}
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
