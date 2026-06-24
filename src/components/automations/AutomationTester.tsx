/**
 * AutomationTester (#3653) — in-app dry-run panel.
 *
 * Lets the author feed a synthetic trigger event (plus optional subject-node
 * facts and variable overrides) and see exactly what the workflow would do:
 * trigger match, per-condition verdicts, branch routing, fully-resolved action
 * params, and simulated variable writes. Calls POST /api/automations/test, which
 * performs NO mesh IO, NO Apprise dispatch, and NO persistence.
 */
import { useState, type ReactNode } from 'react';
import apiService from '../../services/api';
import type { VariableOption } from './AutomationBuilder';
import SubstitutionsHelpDrawer from './SubstitutionsHelp';

export interface SimResult {
  matched: boolean;
  status: 'completed' | 'failed' | 'skipped';
  triggerType: string;
  fields: Record<string, unknown>;
  conditionResults: Record<string, boolean>;
  actions: Array<{ nodeId: string; type: string; ok: boolean; resolvedParams?: unknown; error?: string }>;
  variableWrites: Array<{ name: string; op: string; value?: unknown }>;
  steps: Array<{ nodeId: string; type: string; outcome: string; error?: string }>;
}

interface Props {
  /** Compiles the current editor state → graph config (or an error). */
  getConfig: () => { ok: boolean; config?: unknown; error?: string; triggerType?: string };
  variables: VariableOption[];
}

const KIND_BY_TRIGGER: Record<string, string> = {
  'trigger.message': 'message',
  'trigger.telemetry': 'telemetry',
  'trigger.nodeUpdated': 'nodeUpdated',
  'trigger.nodeDiscovered': 'nodeDiscovered',
  'trigger.system': 'system',
  'trigger.geofence': 'geofence',
  'trigger.schedule': 'schedule',
};

type EventState = Record<string, string>;
type FactState = Record<string, string>;

function numOrUndef(v: string | undefined): number | undefined {
  if (v === undefined || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

export default function AutomationTester({ getConfig, variables }: Props) {
  const cfg = getConfig();
  const triggerType = cfg.triggerType ?? '';
  const kind = KIND_BY_TRIGGER[triggerType] ?? 'message';

  const [ev, setEv] = useState<EventState>({});
  const [facts, setFacts] = useState<FactState>({});
  const [varOverrides, setVarOverrides] = useState<Record<string, string>>({});
  const [result, setResult] = useState<SimResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [showHelp, setShowHelp] = useState(false);

  const setEvField = (k: string, v: string) => setEv((s) => ({ ...s, [k]: v }));
  const setFact = (k: string, v: string) => setFacts((s) => ({ ...s, [k]: v }));

  const buildEvent = (): Record<string, unknown> => {
    const base: Record<string, unknown> = { kind };
    switch (kind) {
      case 'message':
        return { ...base, text: ev.text ?? '', from: numOrUndef(ev.from), channel: numOrUndef(ev.channel),
          channelName: ev.channelName || undefined,
          hopStart: numOrUndef(ev.hopStart), hopLimit: numOrUndef(ev.hopLimit), packetId: numOrUndef(ev.packetId) ?? 1,
          snr: numOrUndef(ev.snr), rssi: numOrUndef(ev.rssi), viaMqtt: ev.viaMqtt === 'true' ? true : undefined };
      case 'telemetry':
        return { ...base, nodeNum: numOrUndef(ev.nodeNum), telemetryType: ev.telemetryType ?? 'batteryLevel', value: numOrUndef(ev.value) };
      case 'nodeUpdated':
      case 'nodeDiscovered':
        return { ...base, nodeNum: numOrUndef(ev.nodeNum), changed: (ev.changed ?? '').split(',').map((s) => s.trim()).filter(Boolean) };
      case 'system':
        return { ...base, event: ev.event || undefined, latestVersion: ev.latestVersion || undefined, currentVersion: ev.currentVersion || undefined, reason: ev.reason || undefined };
      case 'geofence':
        return { ...base, nodeNum: numOrUndef(ev.nodeNum) };
      default:
        return base; // schedule
    }
  };

  const buildNode = (): Record<string, unknown> | undefined => {
    const out: Record<string, unknown> = {};
    const numFact = (k: string) => { if (facts[k] !== undefined && facts[k] !== '') out[k] = Number(facts[k]); };
    numFact('batteryLevel'); numFact('voltage'); numFact('role'); numFact('hopsAway');
    numFact('channelUtilization'); numFact('airUtilTx'); numFact('snr'); numFact('altitude');
    if (facts.longName) out.longName = facts.longName;
    if (facts.shortName) out.shortName = facts.shortName;
    if (facts.latitude) out.latitude = Number(facts.latitude);
    if (facts.longitude) out.longitude = Number(facts.longitude);
    return Object.keys(out).length ? out : undefined;
  };

  const buildVars = (): Record<string, unknown> | undefined => {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(varOverrides)) {
      if (v === '') continue;
      const n = Number(v);
      out[k] = v === 'true' ? true : v === 'false' ? false : Number.isFinite(n) && v.trim() !== '' ? n : v;
    }
    return Object.keys(out).length ? out : undefined;
  };

  const run = async () => {
    setError(null); setResult(null);
    if (!cfg.ok || !cfg.config) { setError(cfg.error ?? 'Fix the workflow before testing.'); return; }
    setRunning(true);
    try {
      const res = await apiService.post<SimResult>('/api/automations/test', {
        config: cfg.config, event: buildEvent(), node: buildNode(), variables: buildVars(),
      });
      setResult(res);
    } catch (e: any) {
      setError(e?.details ? JSON.stringify(e.details) : (e?.message ?? 'Test failed'));
    } finally { setRunning(false); }
  };

  return (
    <div className="ae-card ae-test">
      <div className="ae-row" style={{ marginBottom: '0.5rem' }}>
        <strong>Test this workflow</strong>
        <span className="ae-muted" style={{ marginLeft: '0.5rem' }}>simulated — nothing is sent or saved</span>
        <button className="ae-help-icon" style={{ marginLeft: 'auto' }} title="All {{ }} substitutions" onClick={() => setShowHelp(true)}>?</button>
      </div>
      {showHelp && <SubstitutionsHelpDrawer triggerType={triggerType} variables={variables} onClose={() => setShowHelp(false)} />}

      <div className="ae-test-inputs">{renderEventInputs(kind, ev, setEvField)}</div>

      <button className="ae-btn ae-btn--ghost" style={{ marginTop: '0.4rem' }} onClick={() => setShowAdvanced((s) => !s)}>
        {showAdvanced ? '▾' : '▸'} Subject-node facts & variable overrides
      </button>
      {showAdvanced && (
        <div className="ae-test-advanced">
          <div className="ae-field-label" style={{ margin: '0.5rem 0 0.3rem' }}>Subject-node facts (optional)</div>
          <div className="ae-test-inputs">
            <Field label="Battery %" value={facts.batteryLevel} onChange={(v) => setFact('batteryLevel', v)} type="number" />
            <Field label="Voltage" value={facts.voltage} onChange={(v) => setFact('voltage', v)} type="number" />
            <Field label="Hops away" value={facts.hopsAway} onChange={(v) => setFact('hopsAway', v)} type="number" />
            <Field label="Role (#)" value={facts.role} onChange={(v) => setFact('role', v)} type="number" />
            <Field label="Channel util %" value={facts.channelUtilization} onChange={(v) => setFact('channelUtilization', v)} type="number" />
            <Field label="Air util TX %" value={facts.airUtilTx} onChange={(v) => setFact('airUtilTx', v)} type="number" />
            <Field label="SNR (node)" value={facts.snr} onChange={(v) => setFact('snr', v)} type="number" />
            <Field label="Altitude" value={facts.altitude} onChange={(v) => setFact('altitude', v)} type="number" />
            <Field label="Long name" value={facts.longName} onChange={(v) => setFact('longName', v)} />
            <Field label="Short name" value={facts.shortName} onChange={(v) => setFact('shortName', v)} />
            <Field label="Latitude" value={facts.latitude} onChange={(v) => setFact('latitude', v)} type="number" />
            <Field label="Longitude" value={facts.longitude} onChange={(v) => setFact('longitude', v)} type="number" />
          </div>
          {variables.length > 0 && (
            <>
              <div className="ae-field-label" style={{ margin: '0.6rem 0 0.3rem' }}>Variable overrides (optional)</div>
              <div className="ae-test-inputs">
                {variables.map((v) => (
                  <Field key={v.name} label={`${v.name} (${v.type})`} value={varOverrides[v.name] ?? ''}
                    onChange={(val) => setVarOverrides((s) => ({ ...s, [v.name]: val }))} />
                ))}
              </div>
            </>
          )}
        </div>
      )}

      <div className="ae-btn-row" style={{ marginTop: '0.6rem' }}>
        <button className="ae-btn ae-btn--primary" disabled={running} onClick={run}>{running ? 'Running…' : '▶ Run test'}</button>
      </div>

      {error && <div className="ae-error-list" style={{ marginTop: '0.5rem' }}>{error}</div>}
      {result && <TestResult result={result} />}
    </div>
  );
}

function Field({ label, value, onChange, type }: { label: string; value: string | undefined; onChange: (v: string) => void; type?: string }) {
  return (
    <div className="ae-field">
      <label className="ae-field-label">{label}</label>
      <input className="ae-input" type={type ?? 'text'} value={value ?? ''} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}

function renderEventInputs(kind: string, ev: EventState, set: (k: string, v: string) => void) {
  const f = (label: string, key: string, type?: string) => (
    <Field label={label} value={ev[key]} onChange={(v) => set(key, v)} type={type} key={key} />
  );
  switch (kind) {
    case 'message':
      return <>
        {f('Message text', 'text')}{f('From node #', 'from', 'number')}{f('Channel #', 'channel', 'number')}{f('Channel name', 'channelName')}
        {f('Hop start', 'hopStart', 'number')}{f('Hop limit', 'hopLimit', 'number')}
        {f('SNR', 'snr', 'number')}{f('RSSI', 'rssi', 'number')}
        <div className="ae-field">
          <label className="ae-field-label">Via MQTT</label>
          <label className="ae-switch" style={{ paddingTop: '0.35rem' }}>
            <input type="checkbox" checked={ev.viaMqtt === 'true'} onChange={(e) => set('viaMqtt', e.target.checked ? 'true' : '')} /> received over MQTT
          </label>
        </div>
      </>;
    case 'telemetry':
      return <>{f('Node #', 'nodeNum', 'number')}{f('Metric', 'telemetryType')}{f('Value', 'value', 'number')}</>;
    case 'nodeUpdated':
    case 'nodeDiscovered':
      return <>{f('Node #', 'nodeNum', 'number')}{f('Changed fields (csv)', 'changed')}</>;
    case 'system':
      return <>{f('Event', 'event')}{f('Latest version', 'latestVersion')}{f('Current version', 'currentVersion')}</>;
    case 'geofence':
      return <>{f('Node #', 'nodeNum', 'number')}<div className="ae-muted" style={{ alignSelf: 'end' }}>Set the node’s position under “Subject-node facts”.</div></>;
    default:
      return <div className="ae-muted">No event input needed — this trigger has no payload.</div>;
  }
}

const OUTCOME_META: Record<string, { icon: string; cls: string; label: string }> = {
  'condition:true': { icon: '✓', cls: 'ok', label: 'condition true' },
  'condition:false': { icon: '✗', cls: 'no', label: 'condition false' },
  'action:ok': { icon: '➜', cls: 'ok', label: 'action ran' },
  'action:error': { icon: '⚠', cls: 'err', label: 'action error' },
  'setVar:ok': { icon: '✎', cls: 'ok', label: 'variable set' },
  'setVar:error': { icon: '⚠', cls: 'err', label: 'variable error' },
  'activated': { icon: '•', cls: 'muted', label: 'activated' },
  'guard:maxActions': { icon: '⛔', cls: 'err', label: 'action cap hit' },
};

/** Human-readable "what would be sent" for one simulated action. */
function ActionView({ a }: { a: SimResult['actions'][number] }) {
  const p = (a.resolvedParams ?? {}) as Record<string, unknown>;
  let headline: string = a.type.replace('action.', '');
  let sent: ReactNode = null;
  if (a.type === 'action.sendMessage') {
    headline = `Send message → ${p.destination != null ? `DM to node ${p.destination}` : `channel ${p.channel ?? 0}`}`;
    sent = <div className="ae-test-sent">{String(p.text ?? '')}</div>;
  } else if (a.type === 'action.tapback') {
    headline = `Tapback → ${p.destination != null ? `DM to node ${p.destination}` : `channel ${p.channel ?? 0}`}`;
    sent = <div className="ae-test-sent">{String(p.emoji ?? '')}</div>;
  } else if (a.type === 'action.notify') {
    headline = 'Notify (Apprise)';
    sent = (
      <div className="ae-test-sent">
        {p.title ? <strong>{String(p.title)}</strong> : null}{p.title ? ' — ' : ''}{String(p.body ?? '')}
        {Array.isArray(p.urls) && (p.urls as unknown[]).length > 0 &&
          <div className="ae-muted" style={{ marginTop: '0.2rem' }}>→ {(p.urls as string[]).join(', ')}</div>}
      </div>
    );
  } else if (a.type === 'action.nodeManage') {
    headline = `Manage node → ${String(p.op ?? '')} ${p.nodeNum ?? ''}`.trim();
  }
  return (
    <div className={`ae-test-action ${a.ok ? '' : 'is-err'}`}>
      <strong>{headline}</strong>
      {a.error
        ? <span className="ae-test-badge ae-test-badge--err" style={{ marginLeft: '0.4rem' }}>{a.error}</span>
        : <>
            {sent}
            <details className="ae-test-raw"><summary className="ae-muted">resolved params</summary>
              <pre className="ae-muted ae-test-params">{JSON.stringify(a.resolvedParams, null, 2)}</pre>
            </details>
          </>}
    </div>
  );
}

function TestResult({ result }: { result: SimResult }) {
  const statusCls = result.status === 'completed' ? 'ok' : result.status === 'failed' ? 'err' : 'muted';
  return (
    <div className="ae-test-result">
      <div className="ae-row" style={{ marginTop: '0.6rem' }}>
        {result.matched
          ? <span className={`ae-test-badge ae-test-badge--${statusCls}`}>Trigger matched · {result.status}</span>
          : <span className="ae-test-badge ae-test-badge--no">Trigger filtered out — would not fire</span>}
      </div>

      {result.matched && (
        <>
          <div className="ae-field-label" style={{ margin: '0.6rem 0 0.3rem' }}>Execution trace</div>
          <div className="ae-trace">
            {result.steps.length === 0 && <div className="ae-muted">No steps.</div>}
            {result.steps.map((s, i) => {
              const m = OUTCOME_META[s.outcome] ?? { icon: '·', cls: 'muted', label: s.outcome };
              return (
                <div className={`ae-trace-step ae-trace-step--${m.cls}`} key={i}>
                  <span className="ae-trace-icon">{m.icon}</span>
                  <span className="ae-trace-type">{s.type}</span>
                  <span className="ae-muted">{m.label}{s.error ? ` — ${s.error}` : ''}</span>
                </div>
              );
            })}
          </div>

          {result.actions.length > 0 && (
            <>
              <div className="ae-field-label" style={{ margin: '0.6rem 0 0.3rem' }}>Actions (simulated — nothing is sent)</div>
              {result.actions.map((a, i) => <ActionView key={i} a={a} />)}
            </>
          )}
          {result.matched && result.actions.length === 0 && (
            <div className="ae-test-note" style={{ marginTop: '0.4rem' }}>
              No actions ran — every condition evaluated <strong>false</strong> (see the trace above), so no branch reached an action.
              {' '}Adjust the event inputs or “Subject-node facts” (e.g. set <code>Hops away</code> for a <code>node.hopsAway</code> check, or <code>Hop start/limit</code> for a <code>hops</code> check) so a condition passes.
            </div>
          )}

          {result.variableWrites.length > 0 && (
            <>
              <div className="ae-field-label" style={{ margin: '0.6rem 0 0.3rem' }}>Variable changes (simulated)</div>
              {result.variableWrites.map((w, i) => (
                <div className="ae-muted" key={i}>• {w.name}: {w.op}{w.value !== undefined ? ` = ${JSON.stringify(w.value)}` : ''}</div>
              ))}
            </>
          )}
        </>
      )}
    </div>
  );
}
