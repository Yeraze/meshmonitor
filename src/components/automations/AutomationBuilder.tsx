/**
 * AutomationBuilder (#3653) — IFTTT/Maintainerr-style structured editor.
 *
 * Edits a WorkflowForm (one trigger → AND-chain of conditions → sequence of
 * actions) via dropdowns + param fields driven by the catalog. The parent owns
 * the form state and compiles it to graph JSON on save.
 */
import { TRIGGERS, CONDITIONS, ACTIONS, TRIGGER_FIELDS, BLOCK_BY_TYPE, type FieldDef } from './catalog';
import type { WorkflowForm, FormBlock } from './compile';

export interface VariableOption { name: string; type: string; }

interface Props {
  form: WorkflowForm;
  variables: VariableOption[];
  onChange: (form: WorkflowForm) => void;
}

function FieldInput({ field, value, onChange, variables }: {
  field: FieldDef; value: unknown; onChange: (v: unknown) => void; variables: VariableOption[];
}) {
  const common = { className: 'ae-input', value: (value ?? '') as string, onChange: (e: any) => onChange(e.target.value) };
  let control;
  switch (field.kind) {
    case 'number':
      control = <input {...common} className="ae-input" type="number" placeholder={field.placeholder}
        onChange={(e) => onChange(e.target.value === '' ? '' : Number(e.target.value))} />;
      break;
    case 'textarea':
      control = <textarea className="ae-textarea" value={(value ?? '') as string} placeholder={field.placeholder}
        onChange={(e) => onChange(e.target.value)} />;
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
      control = <input {...common} placeholder={field.placeholder} />;
  }
  return (
    <div className="ae-field">
      <label className="ae-field-label">{field.label}</label>
      {control}
      {field.help && <div className="ae-help-text">{field.help}</div>}
    </div>
  );
}

/** Render the param fields for a block, resolving dynamic options (field lists). */
function BlockFields({ block, triggerType, variables, onParams }: {
  block: FormBlock; triggerType: string; variables: VariableOption[]; onParams: (p: Record<string, unknown>) => void;
}) {
  const def = BLOCK_BY_TYPE[block.type];
  if (!def) return null;
  const setField = (name: string, v: unknown) => onParams({ ...block.params, [name]: v });
  return (
    <>
      {def.fields.map((f) => {
        // numeric/string condition "field" options come from the trigger
        const field = f.name === 'field' && (f.options?.length ?? 0) === 0
          ? { ...f, options: TRIGGER_FIELDS[triggerType] ?? [] }
          : f;
        return <FieldInput key={f.name} field={field} value={block.params[f.name]} variables={variables}
          onChange={(v) => setField(f.name, v)} />;
      })}
    </>
  );
}

export default function AutomationBuilder({ form, variables, onChange }: Props) {
  const setTrigger = (type: string) => onChange({ ...form, trigger: { type, params: {} } });
  const setTriggerParams = (params: Record<string, unknown>) => onChange({ ...form, trigger: { ...form.trigger, params } });

  const updateList = (key: 'conditions' | 'actions', i: number, block: FormBlock) => {
    const list = [...form[key]]; list[i] = block; onChange({ ...form, [key]: list });
  };
  const addBlock = (key: 'conditions' | 'actions', defaultType: string) =>
    onChange({ ...form, [key]: [...form[key], { type: defaultType, params: {} }] });
  const removeBlock = (key: 'conditions' | 'actions', i: number) =>
    onChange({ ...form, [key]: form[key].filter((_, j) => j !== i) });

  return (
    <div>
      {/* WHEN */}
      <div className="ae-section">
        <div className="ae-section-head">
          <span className="ae-section-kw">WHEN</span>
          <span className="ae-section-hint">this happens</span>
        </div>
        <div className="ae-section-body">
          <div className="ae-field">
            <label className="ae-field-label">Trigger</label>
            <select className="ae-select" value={form.trigger.type} onChange={(e) => setTrigger(e.target.value)}>
              {TRIGGERS.map((tr) => <option key={tr.type} value={tr.type}>{tr.label}</option>)}
            </select>
            <div className="ae-help-text">{BLOCK_BY_TYPE[form.trigger.type]?.description}</div>
          </div>
          <BlockFields block={form.trigger} triggerType={form.trigger.type} variables={variables} onParams={setTriggerParams} />
        </div>
      </div>

      {/* IF */}
      <div className="ae-section">
        <div className="ae-section-head">
          <span className="ae-section-kw ae-section-kw--if">IF</span>
          <span className="ae-section-hint">all of these are true (optional)</span>
        </div>
        <div className="ae-section-body">
          {form.conditions.length === 0 && <div className="ae-muted">No conditions — runs every time the trigger fires.</div>}
          {form.conditions.map((c, i) => (
            <div className="ae-block" key={i}>
              <div className="ae-block-head">
                <select className="ae-select" style={{ maxWidth: 220 }} value={c.type}
                  onChange={(e) => updateList('conditions', i, { type: e.target.value, params: {} })}>
                  {CONDITIONS.map((cd) => <option key={cd.type} value={cd.type}>{cd.label}</option>)}
                </select>
                <button className="ae-btn ae-btn--ghost" onClick={() => removeBlock('conditions', i)}>✕</button>
              </div>
              <BlockFields block={c} triggerType={form.trigger.type} variables={variables}
                onParams={(p) => updateList('conditions', i, { ...c, params: p })} />
            </div>
          ))}
          <button className="ae-btn" onClick={() => addBlock('conditions', CONDITIONS[0].type)}>+ Add condition</button>
        </div>
      </div>

      {/* THEN */}
      <div className="ae-section">
        <div className="ae-section-head">
          <span className="ae-section-kw ae-section-kw--then">THEN</span>
          <span className="ae-section-hint">do this</span>
        </div>
        <div className="ae-section-body">
          {form.actions.length === 0 && <div className="ae-muted">Add at least one action.</div>}
          {form.actions.map((a, i) => (
            <div className="ae-block" key={i}>
              <div className="ae-block-head">
                <select className="ae-select" style={{ maxWidth: 240 }} value={a.type}
                  onChange={(e) => updateList('actions', i, { type: e.target.value, params: {} })}>
                  {ACTIONS.map((ac) => <option key={ac.type} value={ac.type}>{ac.label}</option>)}
                </select>
                <button className="ae-btn ae-btn--ghost" onClick={() => removeBlock('actions', i)}>✕</button>
              </div>
              <BlockFields block={a} triggerType={form.trigger.type} variables={variables}
                onParams={(p) => updateList('actions', i, { ...a, params: p })} />
            </div>
          ))}
          <button className="ae-btn" onClick={() => addBlock('actions', ACTIONS[0].type)}>+ Add action</button>
        </div>
      </div>
    </div>
  );
}
