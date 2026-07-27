/**
 * AutomationBuilder (#3653) — IFTTT/Maintainerr-style structured editor.
 *
 * WHEN one trigger → a list of RULES (the trigger fans out to each: IF conditions
 * → THEN actions) → an optional FINALLY combine step (ANY/ALL/NONE). Compiles to
 * the graph model in compile.ts.
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { TRIGGERS, CONDITIONS, ACTIONS, BLOCK_BY_TYPE, fieldsFor, type BlockDef, type FieldDef } from './catalog';
import type { WorkflowForm, FormBlock, Rule } from './compile';
import SubstitutionsHelpDrawer from './SubstitutionsHelp';
import GeofenceFieldInput from './GeofenceFieldInput';
import TokenTextField from './TokenTextField';
import type { GeofenceShape } from '../auto-responder/types';
import { UiIcon } from '../icons';

export interface VariableOption { name: string; type: string; }
export interface SourceOption { id: string; name: string; type?: string; enabled?: boolean; txEnabled?: boolean; }
export interface UnifiedChannelOption {
  name: string; protocol?: string; encryption?: string;
  sources?: Array<{ sourceId: string; sourceName?: string; slot: number }>;
}
export interface ScriptOption { value: string; label: string; }

/** Sendable = enabled and not an MQTT (receive-only) source. */
const isSendableSource = (s: SourceOption): boolean =>
  s.enabled !== false && !String(s.type ?? '').startsWith('mqtt');

/** Short protocol badge for a source type / channel protocol. */
const protoBadge = (proto?: string): 'MC' | 'MT' | null => {
  const t = String(proto ?? '');
  if (t === 'meshcore') return 'MC';
  if (t.startsWith('meshtastic')) return 'MT';
  return null;
};

interface Props {
  form: WorkflowForm;
  variables: VariableOption[];
  sources: SourceOption[];
  channels: UnifiedChannelOption[];
  scripts: ScriptOption[];
  regions: string[];
  onChange: (form: WorkflowForm) => void;
}

/** Seed a block's params with each select/fieldselect field's first option. */
function defaultParams(type: string, triggerType: string): Record<string, unknown> {
  const def = BLOCK_BY_TYPE[type];
  if (!def) return {};
  const params: Record<string, unknown> = {};
  for (const f of def.fields) {
    if (f.kind === 'fieldselect') {
      const first = fieldsFor(type, triggerType)[0]?.options[0]?.value;
      if (first) params[f.name] = first;
    } else if (f.kind === 'select') {
      const opts = f.options ?? [];
      if (opts.length > 0 && opts[0].value !== '') params[f.name] = opts[0].value;
    }
  }
  return params;
}

function FieldInput({ field, value, onChange, variables, sources, channels, scripts, regions, triggerType }: {
  field: FieldDef; value: unknown; onChange: (v: unknown) => void; variables: VariableOption[]; sources: SourceOption[]; channels: UnifiedChannelOption[]; scripts: ScriptOption[]; regions: string[]; triggerType: string;
}) {
  const { t } = useTranslation();
  let control;
  const varNames = variables.map((v) => v.name);
  switch (field.kind) {
    case 'number':
      control = <input className="ae-input" type="number" value={(value ?? '') as string} placeholder={field.placeholder}
        onChange={(e) => onChange(e.target.value === '' ? '' : Number(e.target.value))} />;
      break;
    case 'textarea':
      control = field.tokens
        ? <TokenTextField multiline value={(value ?? '') as string} placeholder={field.placeholder}
            triggerType={triggerType} variableNames={varNames} onChange={onChange} />
        : <textarea className="ae-textarea" value={(value ?? '') as string} placeholder={field.placeholder} onChange={(e) => onChange(e.target.value)} />;
      break;
    case 'select':
      control = (
        <select className="ae-select" value={(value ?? '') as string} onChange={(e) => onChange(e.target.value)}>
          {(field.options ?? []).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      );
      break;
    case 'fieldselect':
      control = (
        <select className="ae-select" value={(value ?? '') as string} onChange={(e) => onChange(e.target.value)}>
          {(field.groups ?? []).map((g) => (
            <optgroup key={g.label} label={g.label}>
              {g.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </optgroup>
          ))}
        </select>
      );
      break;
    case 'sourceMulti': {
      const sel = Array.isArray(value) ? (value as string[]) : [];
      control = (
        <div>
          {sources.length === 0 && <div className="ae-muted">No sources available.</div>}
          {sources.map((s) => (
            <label key={s.id} className="ae-switch" style={{ display: 'block', marginBottom: '0.2rem' }}>
              <input type="checkbox" checked={sel.includes(s.id)} onChange={(e) =>
                onChange(e.target.checked ? [...sel, s.id] : sel.filter((x) => x !== s.id))} /> {s.name}
            </label>
          ))}
        </div>
      );
      break;
    }
    case 'checkbox':
      control = <input type="checkbox" checked={!!value} onChange={(e) => onChange(e.target.checked)} />;
      break;
    case 'variable':
      control = (
        <select className="ae-select" value={(value ?? '') as string} onChange={(e) => onChange(e.target.value)}>
          <option value="">— select variable —</option>
          {variables.map((v) => <option key={v.name} value={v.name}>{v.name} ({v.type})</option>)}
        </select>
      );
      break;
    case 'geofence':
      control = <GeofenceFieldInput value={value as GeofenceShape | undefined} onChange={onChange} />;
      break;
    case 'scriptselect':
      control = (
        <select className="ae-select" value={(value ?? '') as string} onChange={(e) => onChange(e.target.value)}>
          <option value="">— select a script —</option>
          {scripts.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
          {scripts.length === 0 && <option value="" disabled>No scripts in the scripts folder</option>}
        </select>
      );
      break;
    case 'regionSelect':
      // Editable combobox: pick a saved region or type any region name (incl. a
      // {{ trigger.scopeName }} token). Not a hard <select> so users can target
      // a region not yet in the saved catalog — the manager accepts any name.
      control = (
        <>
          <input className="ae-input" list="ae-regions" value={(value ?? '') as string}
            placeholder={field.placeholder} onChange={(e) => onChange(e.target.value)} />
          <datalist id="ae-regions">
            {regions.map((r) => <option key={r} value={r} />)}
          </datalist>
        </>
      );
      break;
    case 'sendSourceMulti': {
      const sel = Array.isArray(value) ? (value as string[]) : [];
      const sendable = sources.filter(isSendableSource);
      control = (
        <div>
          {sendable.length === 0 && <div className="ae-muted">No sendable (non-MQTT) sources.</div>}
          {sendable.map((s) => {
            const badge = protoBadge(s.type);
            const txWarning = t(
              'tx_disabled.automation_source_warning',
              'Transmit is disabled on this source — messages sent through it will be skipped.',
            );
            return (
              <label key={s.id} className="ae-switch" style={{ display: 'block', marginBottom: '0.2rem' }}>
                <input type="checkbox" checked={sel.includes(s.id)} onChange={(e) =>
                  onChange(e.target.checked ? [...sel, s.id] : sel.filter((x) => x !== s.id))} />
                {' '}{s.name}{badge ? <span className="ae-chip">{badge}</span> : null}
                {s.txEnabled === false && (
                  <span className="ae-tx-warn" title={txWarning}>
                    <UiIcon name="alert" size={14} /> {txWarning}
                  </span>
                )}
              </label>
            );
          })}
        </div>
      );
      break;
    }
    case 'channelMulti': {
      const sel = Array.isArray(value) ? (value as Array<{ name: string; protocol?: string }>) : [];
      const same = (a: { name: string; protocol?: string }, c: UnifiedChannelOption) =>
        a.name === c.name && (a.protocol ?? '') === (c.protocol ?? '');
      const isSel = (c: UnifiedChannelOption) => sel.some((x) => same(x, c));
      control = (
        <div>
          {channels.length === 0 && <div className="ae-muted">No channels found on sendable sources.</div>}
          {channels.map((c) => (
            <label key={`${c.protocol}/${c.name}`} className="ae-switch" style={{ display: 'block', marginBottom: '0.2rem' }}>
              <input type="checkbox" checked={isSel(c)} onChange={(e) =>
                onChange(e.target.checked
                  ? [...sel, { name: c.name, protocol: c.protocol }]
                  : sel.filter((x) => !same(x, c)))} />
              {' '}{c.name || '(Primary)'}
              {protoBadge(c.protocol) ? <span className="ae-chip">{protoBadge(c.protocol)}</span> : null}
              {c.encryption ? <span className="ae-chip">{c.encryption}</span> : null}
              {c.sources && c.sources.length > 1 ? <span className="ae-chip">{c.sources.length} sources</span> : null}
            </label>
          ))}
        </div>
      );
      break;
    }
    default:
      control = field.tokens
        ? <TokenTextField value={(value ?? '') as string} placeholder={field.placeholder}
            triggerType={triggerType} variableNames={varNames} onChange={onChange} />
        : <input className="ae-input" value={(value ?? '') as string} placeholder={field.placeholder} onChange={(e) => onChange(e.target.value)} />;
  }
  return (
    <div className="ae-field">
      <label className="ae-field-label">{field.label}</label>
      {control}
      {field.help && <div className="ae-help-text">{field.help}</div>}
    </div>
  );
}

function BlockFields({ block, triggerType, variables, sources, channels, scripts, regions, onParams }: {
  block: FormBlock; triggerType: string; variables: VariableOption[]; sources: SourceOption[]; channels: UnifiedChannelOption[]; scripts: ScriptOption[]; regions: string[]; onParams: (p: Record<string, unknown>) => void;
}) {
  const def = BLOCK_BY_TYPE[block.type];
  if (!def) return null;
  return (
    <>
      {def.fields.map((f) => {
        const field = f.kind === 'fieldselect' ? { ...f, groups: fieldsFor(block.type, triggerType) } : f;
        return <FieldInput key={f.name} field={field} value={block.params[f.name]} variables={variables} sources={sources} channels={channels} scripts={scripts} regions={regions} triggerType={triggerType}
          onChange={(v) => onParams({ ...block.params, [f.name]: v })} />;
      })}
    </>
  );
}

function BlockListEditor({ blocks, options, triggerType, variables, sources, channels, scripts, regions, onChange, addLabel }: {
  blocks: FormBlock[]; options: BlockDef[]; triggerType: string; variables: VariableOption[]; sources: SourceOption[]; channels: UnifiedChannelOption[]; scripts: ScriptOption[]; regions: string[];
  onChange: (b: FormBlock[]) => void; addLabel: string;
}) {
  const update = (i: number, b: FormBlock) => { const l = [...blocks]; l[i] = b; onChange(l); };
  return (
    <>
      {blocks.map((b, i) => (
        <div className="ae-block" key={i}>
          <div className="ae-block-head">
            <select className="ae-select" style={{ maxWidth: 240 }} value={b.type}
              onChange={(e) => update(i, { type: e.target.value, params: defaultParams(e.target.value, triggerType) })}>
              {options.map((o) => <option key={o.type} value={o.type}>{o.label}</option>)}
            </select>
            <button className="ae-btn ae-btn--ghost" onClick={() => onChange(blocks.filter((_, j) => j !== i))} aria-label="Remove block"><UiIcon name="close" size={15} /></button>
          </div>
          <BlockFields block={b} triggerType={triggerType} variables={variables} sources={sources} channels={channels} scripts={scripts} regions={regions} onParams={(p) => update(i, { ...b, params: p })} />
        </div>
      ))}
      <button className="ae-btn" onClick={() => onChange([...blocks, { type: options[0].type, params: defaultParams(options[0].type, triggerType) }])}>{addLabel}</button>
    </>
  );
}

export default function AutomationBuilder({ form, variables, sources, channels, scripts, regions, onChange }: Props) {
  const triggerType = form.trigger.type;
  const [showHelp, setShowHelp] = useState(false);
  const setTrigger = (type: string) => onChange({ ...form, trigger: { type, params: defaultParams(type, type) } });
  const setTriggerParams = (params: Record<string, unknown>) => onChange({ ...form, trigger: { ...form.trigger, params } });

  const updateRule = (i: number, rule: Rule) => { const r = [...form.rules]; r[i] = rule; onChange({ ...form, rules: r }); };
  const addRule = () => onChange({ ...form, rules: [...form.rules, { conditions: [], actions: [{ type: ACTIONS[0].type, params: defaultParams(ACTIONS[0].type, triggerType) }] }] });
  const removeRule = (i: number) => onChange({ ...form, rules: form.rules.filter((_, j) => j !== i) });
  const setCombine = (combine: WorkflowForm['combine']) => onChange({ ...form, combine });

  return (
    <div>
      {showHelp && <SubstitutionsHelpDrawer triggerType={triggerType} variables={variables} onClose={() => setShowHelp(false)} />}
      <div className="ae-row ae-builder-hint" style={{ marginBottom: '0.6rem' }}>
        <span className="ae-muted">Tip: insert <code>{'{{ trigger.* }}'}</code> / <code>{'{{ var.* }}'}</code> tokens in any message or notification text.</span>
        <button className="ae-help-icon" style={{ marginLeft: '0.4rem' }} title="All available substitutions" onClick={() => setShowHelp(true)}>?</button>
      </div>

      <div className="ae-section">
        <div className="ae-section-head"><span className="ae-section-kw">WHEN</span><span className="ae-section-hint">this happens</span></div>
        <div className="ae-section-body">
          <div className="ae-field">
            <label className="ae-field-label">Trigger</label>
            <select className="ae-select" value={triggerType} onChange={(e) => setTrigger(e.target.value)}>
              {TRIGGERS.map((tr) => <option key={tr.type} value={tr.type}>{tr.label}</option>)}
            </select>
            <div className="ae-help-text">{BLOCK_BY_TYPE[triggerType]?.description}</div>
          </div>
          <BlockFields block={form.trigger} triggerType={triggerType} variables={variables} sources={sources} channels={channels} scripts={scripts} regions={regions} onParams={setTriggerParams} />
        </div>
      </div>

      {form.rules.map((rule, i) => (
        <div className="ae-section" key={i}>
          <div className="ae-section-head">
            <span className="ae-section-kw ae-section-kw--if">RULE {i + 1}</span>
            <span className="ae-section-hint">if this, then that</span>
            {form.rules.length > 1 && <button className="ae-btn ae-btn--ghost" style={{ marginLeft: 'auto' }} onClick={() => removeRule(i)}>Remove rule</button>}
          </div>
          <div className="ae-section-body">
            <div className="ae-field-label" style={{ marginBottom: '0.4rem' }}>IF — all of these are true (optional)</div>
            {rule.conditions.length === 0 && <div className="ae-muted" style={{ marginBottom: '0.5rem' }}>No conditions — runs every time the trigger fires.</div>}
            <BlockListEditor blocks={rule.conditions} options={CONDITIONS} triggerType={triggerType} variables={variables} sources={sources} channels={channels} scripts={scripts} regions={regions}
              onChange={(c) => updateRule(i, { ...rule, conditions: c })} addLabel="+ Add condition" />
            <div className="ae-field-label" style={{ margin: '0.9rem 0 0.4rem' }}>THEN — do this</div>
            <BlockListEditor blocks={rule.actions} options={ACTIONS} triggerType={triggerType} variables={variables} sources={sources} channels={channels} scripts={scripts} regions={regions}
              onChange={(a) => updateRule(i, { ...rule, actions: a })} addLabel="+ Add action" />
          </div>
        </div>
      ))}
      <div className="ae-btn-row" style={{ marginBottom: '1rem' }}>
        <button className="ae-btn" onClick={addRule}>+ Add rule</button>
      </div>

      {form.combine ? (
        <div className="ae-section">
          <div className="ae-section-head">
            <span className="ae-section-kw ae-section-kw--then">FINALLY</span>
            <span className="ae-section-hint">combine the rules above</span>
            <button className="ae-btn ae-btn--ghost" style={{ marginLeft: 'auto' }} onClick={() => setCombine(null)}>Remove</button>
          </div>
          <div className="ae-section-body">
            <div className="ae-field">
              <label className="ae-field-label">Run when…</label>
              <select className="ae-select" value={form.combine.mode}
                onChange={(e) => setCombine({ ...form.combine!, mode: e.target.value as any })}>
                <option value="ANY">ANY of the rules above matched</option>
                <option value="ALL">ALL of the rules above matched</option>
                <option value="NONE">NONE of the rules above matched</option>
                <option value="ALWAYS">ALWAYS — run no matter what</option>
              </select>
              <div className="ae-help-text">“Matched” means a rule’s IF conditions passed.</div>
            </div>
            <div className="ae-field-label" style={{ margin: '0.6rem 0 0.4rem' }}>THEN — do this</div>
            <BlockListEditor blocks={form.combine.actions} options={ACTIONS} triggerType={triggerType} variables={variables} sources={sources} channels={channels} scripts={scripts} regions={regions}
              onChange={(a) => setCombine({ ...form.combine!, actions: a })} addLabel="+ Add action" />
          </div>
        </div>
      ) : (
        <button className="ae-btn ae-btn--ghost" onClick={() => setCombine({ mode: 'ANY', actions: [{ type: ACTIONS[0].type, params: defaultParams(ACTIONS[0].type, triggerType) }] })}>
          + Add a FINALLY step (combine rules with ANY / ALL / NONE)
        </button>
      )}
    </div>
  );
}
