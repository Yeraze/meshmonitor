/**
 * Automation Engine page (#3653) — Phase 1a management UI.
 *
 * Functional management surface (the visual node-graph builder is Phase 2): list
 * and toggle automations, edit their trigger/condition/action graph as validated
 * JSON, manage user-defined variables, import/export, and inspect run-logs.
 */
import { useCallback, useEffect, useState, type CSSProperties } from 'react';
import apiService from '../../services/api';

interface Automation {
  id: string;
  name: string;
  description: string | null;
  enabled: boolean;
  config: string;
  createdAt: number;
  updatedAt: number;
}

interface Variable {
  id: string;
  name: string;
  description: string | null;
  type: 'string' | 'integer' | 'float' | 'boolean' | 'flag';
  scope: 'global' | 'source' | 'node' | 'sourceNode';
  readonly: boolean;
  config: string;
}

interface Run {
  id: string;
  status: string;
  sourceId: string | null;
  startedAt: number;
  log: string | null;
}

const VARIABLE_TYPES = ['string', 'integer', 'float', 'boolean', 'flag'] as const;
const VARIABLE_SCOPES = ['global', 'source', 'node', 'sourceNode'] as const;

const TEMPLATE = {
  version: 1,
  nodes: [
    { id: 't', type: 'trigger.message', params: { textContains: 'ping' } },
    { id: 'a', type: 'action.tapback', params: { emoji: '👍' } },
  ],
  edges: [{ from: 't', to: 'a' }],
};

const card: CSSProperties = {
  border: '1px solid var(--border-color, #333)', borderRadius: 8, padding: '0.75rem 1rem',
  marginBottom: '0.75rem', background: 'var(--bg-secondary, #1c1c1c)',
};
const btn: CSSProperties = {
  padding: '0.35rem 0.7rem', marginRight: '0.4rem', borderRadius: 6, cursor: 'pointer',
  border: '1px solid var(--border-color, #444)', background: 'var(--bg-tertiary, #2a2a2a)', color: 'inherit',
};
const input: CSSProperties = {
  width: '100%', padding: '0.4rem', borderRadius: 6, marginBottom: '0.5rem',
  border: '1px solid var(--border-color, #444)', background: 'var(--bg-primary, #111)', color: 'inherit',
};

export default function AutomationsPage() {
  const [view, setView] = useState<'automations' | 'variables'>('automations');

  return (
    <div style={{ padding: '1rem', maxWidth: 1000, margin: '0 auto', overflowY: 'auto', height: '100dvh' }}>
      <button style={{ ...btn, marginBottom: '0.75rem' }} onClick={() => { window.location.href = import.meta.env.BASE_URL || '/'; }}>← Dashboard</button>
      <h1 style={{ marginTop: 0 }}>Automation Engine</h1>
      <p style={{ opacity: 0.7, marginTop: '-0.5rem' }}>
        Advanced Mode (beta) — define global trigger → condition → action workflows.
      </p>
      <div style={{ marginBottom: '1rem' }}>
        <button style={{ ...btn, fontWeight: view === 'automations' ? 700 : 400 }} onClick={() => setView('automations')}>Automations</button>
        <button style={{ ...btn, fontWeight: view === 'variables' ? 700 : 400 }} onClick={() => setView('variables')}>Variables</button>
      </div>
      {view === 'automations' ? <AutomationsList /> : <VariablesList />}
    </div>
  );
}

// ─── Automations ─────────────────────────────────────────────────────────────

function AutomationsList() {
  const [items, setItems] = useState<Automation[]>([]);
  const [editing, setEditing] = useState<Automation | 'new' | null>(null);
  const [runsFor, setRunsFor] = useState<Automation | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setItems(await apiService.get<Automation[]>('/api/automations'));
      setError(null);
    } catch (e: any) { setError(e?.message ?? 'Failed to load'); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const toggle = async (a: Automation) => {
    await apiService.post(`/api/automations/${a.id}/${a.enabled ? 'disable' : 'enable'}`);
    load();
  };
  const remove = async (a: Automation) => {
    if (!confirm(`Delete automation "${a.name}"?`)) return;
    await apiService.delete(`/api/automations/${a.id}`);
    load();
  };
  const exportOne = async (a: Automation) => {
    const data = await apiService.get(`/api/automations/${a.id}/export`);
    navigator.clipboard?.writeText(JSON.stringify(data, null, 2));
    alert('Exported JSON copied to clipboard.');
  };

  if (editing) return <AutomationEditor automation={editing} onClose={() => { setEditing(null); load(); }} />;
  if (runsFor) return <RunLog automation={runsFor} onClose={() => setRunsFor(null)} />;

  return (
    <div>
      <button style={{ ...btn, marginBottom: '0.75rem' }} onClick={() => setEditing('new')}>+ New automation</button>
      {error && <div style={{ color: 'tomato' }}>{error}</div>}
      {items.length === 0 && <p style={{ opacity: 0.6 }}>No automations yet.</p>}
      {items.map((a) => (
        <div key={a.id} style={card}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div>
              <strong>{a.name}</strong>{' '}
              <span style={{ fontSize: 12, opacity: 0.6 }}>{triggerOf(a)}</span>
              {a.description && <div style={{ fontSize: 13, opacity: 0.7 }}>{a.description}</div>}
            </div>
            <div>
              <label style={{ marginRight: '0.75rem', fontSize: 13 }}>
                <input type="checkbox" checked={a.enabled} onChange={() => toggle(a)} /> Enabled
              </label>
              <button style={btn} onClick={() => setEditing(a)}>Edit</button>
              <button style={btn} onClick={() => setRunsFor(a)}>Runs</button>
              <button style={btn} onClick={() => exportOne(a)}>Export</button>
              <button style={{ ...btn, color: 'tomato' }} onClick={() => remove(a)}>Delete</button>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

function triggerOf(a: Automation): string {
  try {
    const g = JSON.parse(a.config);
    const t = (g.nodes ?? []).find((n: any) => String(n.type).startsWith('trigger.'));
    return t ? t.type : '';
  } catch { return ''; }
}

function AutomationEditor({ automation, onClose }: { automation: Automation | 'new'; onClose: () => void }) {
  const isNew = automation === 'new';
  const initial = isNew ? null : (automation as Automation);
  const [name, setName] = useState(initial?.name ?? '');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [enabled, setEnabled] = useState(initial?.enabled ?? false);
  const [configText, setConfigText] = useState(
    initial ? pretty(initial.config) : JSON.stringify(TEMPLATE, null, 2),
  );
  const [errors, setErrors] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    setErrors([]);
    let config: unknown;
    try { config = JSON.parse(configText); }
    catch { setErrors(['Config is not valid JSON']); setSaving(false); return; }
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
      <button style={btn} onClick={onClose}>← Back</button>
      <h2>{isNew ? 'New automation' : `Edit: ${initial?.name}`}</h2>
      <label>Name</label>
      <input style={input} value={name} onChange={(e) => setName(e.target.value)} />
      <label>Description</label>
      <input style={input} value={description ?? ''} onChange={(e) => setDescription(e.target.value)} />
      <label style={{ display: 'block', margin: '0.25rem 0' }}>
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> Enabled
      </label>
      <label>Workflow graph (JSON)</label>
      <textarea
        style={{ ...input, height: 320, fontFamily: 'monospace', fontSize: 13 }}
        value={configText}
        onChange={(e) => setConfigText(e.target.value)}
        spellCheck={false}
      />
      {errors.length > 0 && (
        <ul style={{ color: 'tomato' }}>{errors.map((er, i) => <li key={i}>{er}</li>)}</ul>
      )}
      <button style={{ ...btn, background: 'var(--accent-color, #2563eb)' }} disabled={saving} onClick={save}>
        {saving ? 'Saving…' : 'Save'}
      </button>
    </div>
  );
}

function RunLog({ automation, onClose }: { automation: Automation; onClose: () => void }) {
  const [runs, setRuns] = useState<Run[]>([]);
  useEffect(() => {
    apiService.get<Run[]>(`/api/automations/${automation.id}/runs`).then(setRuns).catch(() => setRuns([]));
  }, [automation.id]);
  return (
    <div>
      <button style={btn} onClick={onClose}>← Back</button>
      <h2>Runs: {automation.name}</h2>
      {runs.length === 0 && <p style={{ opacity: 0.6 }}>No runs yet.</p>}
      {runs.map((r) => (
        <div key={r.id} style={card}>
          <div>
            <span style={{ color: r.status === 'completed' ? 'limegreen' : r.status === 'failed' ? 'tomato' : 'inherit' }}>
              {r.status}
            </span>{' '}
            <span style={{ fontSize: 12, opacity: 0.6 }}>{new Date(r.startedAt).toLocaleString()} · {r.sourceId ?? '—'}</span>
          </div>
          {r.log && <pre style={{ fontSize: 11, opacity: 0.8, overflowX: 'auto', margin: '0.4rem 0 0' }}>{r.log}</pre>}
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

  const load = useCallback(async () => {
    try { setItems(await apiService.get<Variable[]>('/api/automations/variables')); }
    catch (e: any) { setError(e?.message ?? 'Failed to load'); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const create = async () => {
    setError(null);
    const config: Record<string, unknown> = {};
    if (defaultValue !== '') config.defaultValue = type === 'integer' || type === 'float' ? Number(defaultValue) : defaultValue;
    if (type === 'flag' && flagDuration !== '') config.flagDurationSeconds = Number(flagDuration);
    try {
      await apiService.post('/api/automations/variables', { name, type, scope, readonly, config });
      setName(''); setDefaultValue(''); setFlagDuration('');
      load();
    } catch (e: any) { setError(e?.message ?? 'Create failed'); }
  };
  const remove = async (v: Variable) => {
    if (!confirm(`Delete variable "${v.name}"?`)) return;
    await apiService.delete(`/api/automations/variables/${v.id}`);
    load();
  };

  return (
    <div>
      <div style={card}>
        <strong>New variable</strong>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.5rem', marginTop: '0.5rem' }}>
          <div>
            <label>Name</label>
            <input style={input} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. lowBatteryThreshold" />
          </div>
          <div>
            <label>Type</label>
            <select style={input} value={type} onChange={(e) => setType(e.target.value as Variable['type'])}>
              {VARIABLE_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </div>
          <div>
            <label>Scope</label>
            <select style={input} value={scope} onChange={(e) => setScope(e.target.value as Variable['scope'])}>
              {VARIABLE_SCOPES.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
          <div>
            <label>Default value {readonly ? '(constant)' : ''}</label>
            <input style={input} value={defaultValue} onChange={(e) => setDefaultValue(e.target.value)} />
          </div>
          {type === 'flag' && (
            <div>
              <label>Flag auto-clear (seconds)</label>
              <input style={input} value={flagDuration} onChange={(e) => setFlagDuration(e.target.value)} placeholder="e.g. 86400" />
            </div>
          )}
          <div style={{ alignSelf: 'end' }}>
            <label style={{ fontSize: 13 }}>
              <input type="checkbox" checked={readonly} onChange={(e) => setReadonly(e.target.checked)} /> Constant (read-only to automations)
            </label>
          </div>
        </div>
        <button style={{ ...btn, marginTop: '0.5rem' }} disabled={!name} onClick={create}>Create</button>
        {error && <div style={{ color: 'tomato', marginTop: '0.5rem' }}>{error}</div>}
      </div>

      {items.map((v) => (
        <div key={v.id} style={card}>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <div>
              <strong>{v.name}</strong>{' '}
              <span style={{ fontSize: 12, opacity: 0.6 }}>{v.type} · {v.scope}{v.readonly ? ' · constant' : ''}</span>
              <div style={{ fontSize: 12, opacity: 0.6 }}>{v.config}</div>
            </div>
            <button style={{ ...btn, color: 'tomato' }} onClick={() => remove(v)}>Delete</button>
          </div>
        </div>
      ))}
    </div>
  );
}

function pretty(jsonStr: string): string {
  try { return JSON.stringify(JSON.parse(jsonStr), null, 2); } catch { return jsonStr; }
}
