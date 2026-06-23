/**
 * AutomationBuilder (#3653) — IFTTT/Maintainerr-style structured editor.
 *
 * WHEN one trigger → a list of RULES (the trigger fans out to each: IF conditions
 * → THEN actions) → an optional FINALLY combine step (reduce: run actions if
 * ANY/ALL/NONE of the rules matched). Compiles to the graph model in compile.ts.
 */
import { TRIGGERS, CONDITIONS, ACTIONS, TRIGGER_FIELDS, BLOCK_BY_TYPE, type BlockDef, type FieldDef } from './catalog';
import type { WorkflowForm, FormBlock, Rule } from './compile';

export interface VariableOption { name: string; type: string; }

interface Props {
  form: WorkflowForm;
  variables: VariableOption[];
  onChange: (form: WorkflowForm) => void;
}

/** Seed a block's params with each select field's first option (a never-touched
 *  <select> shows its default but fires no onChange until changed). */
function defaultParams(type: string, triggerType: string): Record<string, unknown> {
  const def = BLOCK_BY_TYPE[type];
  if (!def) return {};
  const params: Record<string, unknown> = {};
  for (const f of def.fields) {
    if (f.kind !== 'select') continue;
    const opts = f.name === 'field' && (f.options?.length ?? 0) === 0
      ? (TRIGGER_FIELDS[triggerType] ?? [])
      : (f.options ?? []);
    if (opts.length > 0 && opts[0].value !== '') params[f.name] = opts[0].value;
  }
  return params;
}

function FieldInput({ field, value, onChange, variables }: {
  field: FieldDef; value: unknown; onChange: (v: unknown) => void; variables: VariableOption[];
}) {
  let control;
  switch (field.kind) {
    case 'number':
      control = <input className="ae-input" type="number" value={(value ?? '') as string} placeholder={field.placeholder}
        onChange={(e) => onChange(e.target.value === '' ? '' : Number(e.target.value))} />;
      break;
    case 'textarea':
      control = <textarea className="ae-textarea" value={(value ?? '') as string} placeholder={field.placeholder} onChange={(e) => onChange(e.target.value)} />;
      break;
    case 'select':
      control = (
        <select className="ae-select" value={(value ?? '') as string} onChange={(e) => onChange(e.target.value)}>
          {(field.options ?? []).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      );
      break;
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
    default:
      control = <input className="ae-input" value={(value ?? '') as string} placeholder={field.placeholder} onChange={(e) => onChange(e.target.value)} />;
  }
  return (
    <div className="ae-field">
      <label className="ae-field-label">{field.label}</label>
      {control}
      {field.help && <div className="ae-help-text">{field.help}</div>}
    </div>
  );
}

function BlockFields({ block, triggerType, variables, onParams }: {
  block: FormBlock; triggerType: string; variables: VariableOption[]; onParams: (p: Record<string, unknown>) => void;
}) {
  const def = BLOCK_BY_TYPE[block.type];
  if (!def) return null;
  return (
    <>
      {def.fields.map((f) => {
        const field = f.name === 'field' && (f.options?.length ?? 0) === 0
          ? { ...f, options: TRIGGER_FIELDS[triggerType] ?? [] }
          : f;
        return <FieldInput key={f.name} field={field} value={block.params[f.name]} variables={variables}
          onChange={(v) => onParams({ ...block.params, [f.name]: v })} />;
      })}
    </>
  );
}

/** A list of condition/action blocks with add / remove / type-change. */
function BlockListEditor({ blocks, options, triggerType, variables, onChange, addLabel }: {
  blocks: FormBlock[]; options: BlockDef[]; triggerType: string; variables: VariableOption[];
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
            <button className="ae-btn ae-btn--ghost" onClick={() => onChange(blocks.filter((_, j) => j !== i))}>✕</button>
          </div>
          <BlockFields block={b} triggerType={triggerType} variables={variables} onParams={(p) => update(i, { ...b, params: p })} />
        </div>
      ))}
      <button className="ae-btn" onClick={() => onChange([...blocks, { type: options[0].type, params: defaultParams(options[0].type, triggerType) }])}>{addLabel}</button>
    </>
  );
}

export default function AutomationBuilder({ form, variables, onChange }: Props) {
  const triggerType = form.trigger.type;
  const setTrigger = (type: string) => onChange({ ...form, trigger: { type, params: defaultParams(type, type) } });
  const setTriggerParams = (params: Record<string, unknown>) => onChange({ ...form, trigger: { ...form.trigger, params } });

  const updateRule = (i: number, rule: Rule) => { const r = [...form.rules]; r[i] = rule; onChange({ ...form, rules: r }); };
  const addRule = () => onChange({ ...form, rules: [...form.rules, { conditions: [], actions: [{ type: ACTIONS[0].type, params: defaultParams(ACTIONS[0].type, triggerType) }] }] });
  const removeRule = (i: number) => onChange({ ...form, rules: form.rules.filter((_, j) => j !== i) });

  const setCombine = (combine: WorkflowForm['combine']) => onChange({ ...form, combine });

  return (
    <div>
      {/* WHEN */}
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
          <BlockFields block={form.trigger} triggerType={triggerType} variables={variables} onParams={setTriggerParams} />
        </div>
      </div>

      {/* RULES (fanout) */}
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
            <BlockListEditor blocks={rule.conditions} options={CONDITIONS} triggerType={triggerType} variables={variables}
              onChange={(c) => updateRule(i, { ...rule, conditions: c })} addLabel="+ Add condition" />
            <div className="ae-field-label" style={{ margin: '0.9rem 0 0.4rem' }}>THEN — do this</div>
            <BlockListEditor blocks={rule.actions} options={ACTIONS} triggerType={triggerType} variables={variables}
              onChange={(a) => updateRule(i, { ...rule, actions: a })} addLabel="+ Add action" />
          </div>
        </div>
      ))}
      <div className="ae-btn-row" style={{ marginBottom: '1rem' }}>
        <button className="ae-btn" onClick={addRule}>+ Add rule</button>
      </div>

      {/* FINALLY (collapse / reduce) */}
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
              </select>
              <div className="ae-help-text">“Matched” means a rule’s IF conditions passed.</div>
            </div>
            <div className="ae-field-label" style={{ margin: '0.6rem 0 0.4rem' }}>THEN — do this</div>
            <BlockListEditor blocks={form.combine.actions} options={ACTIONS} triggerType={triggerType} variables={variables}
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
