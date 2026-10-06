/**
 * AutomationBuilder (#3653) — IFTTT/Maintainerr-style structured editor.
 *
 * WHEN one trigger → a list of RULES (the trigger fans out to each: IF conditions
 * → THEN actions) → an optional FINALLY combine step (ANY/ALL/NONE). Compiles to
 * the graph model in compile.ts.
 */
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { TRIGGERS, CONDITIONS, ACTIONS, BLOCK_BY_TYPE, fieldsFor, fieldVisible, fieldPlaceholder, type BlockDef, type FieldDef } from './catalog';
import { compile, blockNodeId, formOutputNames, type WorkflowForm, type FormBlock, type Rule, type BlockLocation } from './compile';
import type { StepTokenScope } from './tokenHints';
import { STEP_OUTPUT_NAME_PATTERN, stepOutputScopes } from '../../types/automation';
import SubstitutionsHelpDrawer from './SubstitutionsHelp';
import GeofenceFieldInput from './GeofenceFieldInput';
import NodeMultiFieldInput, { type NodeMultiOption } from './NodeMultiFieldInput';
import AutomationIdFieldInput, { type AutomationOption } from './AutomationIdFieldInput';
import TokenTextField from './TokenTextField';
import { NumberInput } from '../common/NumberInput';
import type { GeofenceShape } from '../auto-responder/types';
import { UiIcon } from '../icons';
import { parseNodeNumInput } from '../../utils/nodeHelpers';

export interface VariableOption { name: string; type: string; }
export interface SourceOption {
  id: string;
  name: string;
  type?: string;
  enabled?: boolean;
  /** Raw radio TX flag. */
  txEnabled?: boolean;
  /** `txEnabled || udpRelayEnabled` — the real "can this source send?" answer (#4394). */
  canTransmit?: boolean;
}
export interface UnifiedChannelOption {
  name: string; protocol?: string; encryption?: string;
  sources?: Array<{ sourceId: string; sourceName?: string; slot: number }>;
}
export interface ScriptOption { value: string; label: string; }
export type { NodeMultiOption, AutomationOption };

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

/**
 * Does a source match a field's `protocolFilter`? MeshCore is the explicit side
 * (`type === 'meshcore'`); everything else — native Meshtastic AND MQTT
 * bridge/broker sources — is Meshtastic-protocol. So `'meshtastic'` means "not
 * MeshCore" rather than a `startsWith('meshtastic')` check, which would wrongly
 * drop MQTT sources.
 */
const sourceMatchesProtocol = (s: SourceOption, filter?: 'meshtastic' | 'meshcore'): boolean => {
  if (!filter) return true;
  const isMeshCore = String(s.type ?? '') === 'meshcore';
  return filter === 'meshcore' ? isMeshCore : !isMeshCore;
};

/** Channel counterpart of {@link sourceMatchesProtocol}, keyed off `UnifiedChannelOption.protocol`. */
const channelMatchesProtocol = (c: UnifiedChannelOption, filter?: 'meshtastic' | 'meshcore'): boolean => {
  if (!filter) return true;
  const isMeshCore = String(c.protocol ?? '') === 'meshcore';
  return filter === 'meshcore' ? isMeshCore : !isMeshCore;
};

interface Props {
  form: WorkflowForm;
  variables: VariableOption[];
  sources: SourceOption[];
  channels: UnifiedChannelOption[];
  scripts: ScriptOption[];
  regions: string[];
  nodes?: NodeMultiOption[];
  /** Existing automations for action.setAutomationEnabled's picker (#5445). */
  automations?: AutomationOption[];
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

/**
 * Node-number field that accepts a decimal (`1018373854`) OR a Meshtastic hex id
 * (`!3ca956de`), storing the decimal node number either way (#4826). A plain
 * `<input type="number">` silently dropped `!hex`, so this is a text input that
 * parses on change and surfaces a validation message rather than vanishing.
 */
function NodeNumFieldInput({ value, onChange, placeholder }: {
  value: unknown; onChange: (v: unknown) => void; placeholder?: string;
}) {
  const { t } = useTranslation();
  const [text, setText] = useState<string>(() =>
    value === undefined || value === null || value === '' ? '' : String(value));

  // Re-sync when the parent value changes to something this input didn't produce
  // (e.g. loading a different automation into a reused builder instance). Guarded
  // against clobbering in-progress hex typing: `!3ca956de` canonicalises to the
  // same decimal the parent stores back, so no reset fires mid-edit.
  useEffect(() => {
    const incoming = value === undefined || value === null || value === '' ? '' : String(value);
    const parsedNow = parseNodeNumInput(text);
    const canonical = parsedNow.ok
      ? (parsedNow.value === null ? '' : String(parsedNow.value))
      : text;
    if (incoming !== canonical) setText(incoming);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- #4826 sync on external value only; `text` is intentionally excluded to avoid a self-reset loop.
  }, [value]);

  const parsed = parseNodeNumInput(text);
  const handle = (raw: string) => {
    setText(raw);
    const r = parseNodeNumInput(raw);
    // Valid → store the decimal node number (or '' for a blank/clear). Invalid →
    // keep the raw text in the param so it survives and server-side validation flags it.
    onChange(r.ok ? (r.value === null ? '' : r.value) : raw);
  };

  return (
    <>
      <input className="ae-input" value={text} placeholder={placeholder}
        onChange={(e) => handle(e.target.value)} />
      {!parsed.ok && (
        <div className="ae-field-error">
          {t('automation.nodeNum.invalid',
            'Enter a node number as a decimal (1017730782) or a hex id (!3ca956de).')}
        </div>
      )}
    </>
  );
}

export interface FieldInputProps {
  field: FieldDef; value: unknown; onChange: (v: unknown) => void; variables: VariableOption[]; sources: SourceOption[]; channels: UnifiedChannelOption[]; scripts: ScriptOption[]; regions: string[]; nodes: NodeMultiOption[]; triggerType: string;
  /** Optional so existing callers (TemplateGallery, tests) need no change (#5445). */
  automations?: AutomationOption[];
  /** The whole block's params, for a field that edits more than one (#5636). */
  params?: Record<string, unknown>;
  /** Merge a patch into the block's params; an `undefined` value removes the key (#5636). */
  onPatch?: (patch: Record<string, unknown>) => void;
  /** Run outputs this block can read through `{{ steps.* }}` (#5636). */
  steps?: StepTokenScope;
  /** Run-output names used by more than one step in the form (#5636). */
  duplicateOutputNames?: ReadonlySet<string>;
}

/**
 * Text for a `{{ }}` token field. A graph written as JSON or imported can hold
 * a number there (a numeric condition's `value: 0`), and the highlighter needs
 * a string.
 */
const tokenText = (value: unknown): string => (value == null ? '' : String(value));

/** The select value that stands for "This run only". Never stored in params. */
const RUN_ONLY = '::run-only::';

/**
 * "Store result in" for Run a script (#5636): nowhere, a saved variable
 * (`params.resultVariable`), or this run only (`params.outputName`, with a
 * name box). The two params are separate on purpose — picking one clears the
 * other, and neither is overloaded with a marker value.
 */
function ResultTargetInput({ params, onPatch, variables, duplicateOutputNames }: {
  params: Record<string, unknown>;
  onPatch: (patch: Record<string, unknown>) => void;
  variables: VariableOption[];
  duplicateOutputNames?: ReadonlySet<string>;
}) {
  const { t } = useTranslation();
  const runOnly = typeof params.outputName === 'string';
  const name = runOnly ? (params.outputName as string) : '';
  const variable = typeof params.resultVariable === 'string' ? params.resultVariable : '';
  const choose = (v: string) => {
    if (v === RUN_ONLY) onPatch({ resultVariable: undefined, outputName: name });
    else onPatch({ resultVariable: v === '' ? undefined : v, outputName: undefined });
  };
  const badName = runOnly && name !== '' && !STEP_OUTPUT_NAME_PATTERN.test(name);
  const duplicate = runOnly && !badName && name !== '' && duplicateOutputNames?.has(name);
  return (
    <>
      <select className="ae-select" value={runOnly ? RUN_ONLY : variable} onChange={(e) => choose(e.target.value)}
        aria-label={t('automation.stepOutput.target_label', 'Store result in')}>
        <option value="">{t('automation.stepOutput.none', '— do not store —')}</option>
        <option value={RUN_ONLY}>{t('automation.stepOutput.run_only', 'This run only')}</option>
        {variables.map((v) => <option key={v.name} value={v.name}>{v.name} ({v.type})</option>)}
        {variable && !variables.some((v) => v.name === variable) && <option value={variable}>{variable}</option>}
      </select>
      {runOnly && (
        <div style={{ marginTop: '0.35rem' }}>
          <input className="ae-input" value={name} maxLength={32} spellCheck={false}
            placeholder={t('automation.stepOutput.name_placeholder', 'name, e.g. joke')}
            aria-label={t('automation.stepOutput.name_label', 'Name for this run')}
            onChange={(e) => onPatch({ outputName: e.target.value })} />
          {name === '' && (
            <div className="ae-field-error">{t('automation.stepOutput.name_required', 'Give the result a name.')}</div>
          )}
          {badName && (
            <div className="ae-field-error">
              {t('automation.stepOutput.name_invalid', 'Start with a lower-case letter; then lower-case letters, digits or _ (32 characters at most).')}
            </div>
          )}
          {duplicate && (
            <div className="ae-field-error">
              {t('automation.stepOutput.name_duplicate', 'Another step already uses this name. Each name must be unique.')}
            </div>
          )}
          {name !== '' && !badName && (
            <div className="ae-help-text">
              {t('automation.stepOutput.usage', 'Later steps read it as')}{' '}
              <code>{`{{ steps.${name}.output }}`}</code>
            </div>
          )}
        </div>
      )}
    </>
  );
}

/** A stored number param as the field's value: '' / absent / junk shows blank. */
function numberParamValue(value: unknown): number | null {
  if (value === '' || value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function FieldInput({ field, value, onChange, variables, sources, channels, scripts, regions, nodes, triggerType, automations = [], params, onPatch, steps, duplicateOutputNames }: FieldInputProps) {
  const { t } = useTranslation();
  let control;
  const varNames = variables.map((v) => v.name);
  const placeholder = fieldPlaceholder(field, triggerType);
  // A `{{ var.* }}`-only field refuses step outputs whatever the block could read.
  const stepScope: StepTokenScope | undefined = field.varsOnly ? 'refused' : steps;
  switch (field.kind) {
    case 'resultTarget':
      control = (
        <ResultTargetInput
          params={params ?? { [field.name]: value }}
          onPatch={onPatch ?? ((patch) => { if (field.name in patch) onChange(patch[field.name] ?? ''); })}
          variables={variables}
          duplicateOutputNames={duplicateOutputNames}
        />
      );
      break;
    case 'number':
      // Every catalog number param is optional: blank is stored as '' and the
      // server falls back to its default. Only numbers are ever emitted.
      control = <NumberInput className="ae-input" value={numberParamValue(value)} placeholder={placeholder}
        step="any" allowEmpty onChange={(v) => onChange(v === null ? '' : v)} />;
      break;
    case 'nodeNum':
      control = <NodeNumFieldInput value={value} onChange={onChange} placeholder={placeholder} />;
      break;
    case 'textarea':
      control = field.tokens
        ? <TokenTextField multiline value={tokenText(value)} placeholder={placeholder}
            triggerType={triggerType} variableNames={varNames} steps={stepScope} onChange={onChange} />
        : <textarea className="ae-textarea" value={(value ?? '') as string} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />;
      break;
    case 'select': {
      const effective = (value ?? field.absentValue ?? '') as string;
      const warning = field.warningByValue?.[effective] ?? field.warning;
      control = (
        <>
          <select className="ae-select" value={effective} onChange={(e) => onChange(e.target.value)}>
            {(field.options ?? []).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
          {warning && (
            <div className="ae-field-warn" role="note">
              <UiIcon name="alert" size={14} /> <span>{warning}</span>
            </div>
          )}
        </>
      );
      break;
    }
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
      const visible = sources.filter((s) => sourceMatchesProtocol(s, field.protocolFilter));
      control = (
        <div>
          {visible.length === 0 && <div className="ae-muted">No sources available.</div>}
          {visible.map((s) => (
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
      // #4722: `sources` is needed for the waypoint-anchor mode — waypoints are
      // per-source, so the fence has to name which source's waypoint it means.
      control = <GeofenceFieldInput value={value as GeofenceShape | undefined} sources={sources} onChange={onChange} />;
      break;
    case 'nodeMulti':
      control = <NodeMultiFieldInput value={value} onChange={onChange} nodes={nodes} />;
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
    case 'automationSelect':
      control = <AutomationIdFieldInput value={value} onChange={onChange} automations={automations}
        triggerType={triggerType} variableNames={varNames} steps={stepScope} />;
      break;
    case 'regionSelect':
      // Editable combobox: pick a saved region or type any region name (incl. a
      // {{ trigger.scopeName }} token). Not a hard <select> so users can target
      // a region not yet in the saved catalog — the manager accepts any name.
      control = (
        <>
          <input className="ae-input" list="ae-regions" value={(value ?? '') as string}
            placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
          <datalist id="ae-regions">
            {regions.map((r) => <option key={r} value={r} />)}
          </datalist>
        </>
      );
      break;
    case 'sendSourceMulti': {
      const sel = Array.isArray(value) ? (value as string[]) : [];
      const sendable = sources
        .filter(isSendableSource)
        .filter((s) => sourceMatchesProtocol(s, field.protocolFilter));
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
                {/* Prefer canTransmit: a TX-disabled radio with UDP Broadcast on
                    still delivers, so it must not be flagged (#4394). Older
                    servers omit the field — fall back to the raw radio flag. */}
                {(s.canTransmit ?? s.txEnabled) === false && (
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
    case 'meshtasticSourceSelect': {
      // #5482: one native Meshtastic radio (waypoints are Meshtastic-only and
      // need a node to own and send them; MQTT and MeshCore sources cannot).
      const options = sources.filter((s) => s.enabled !== false && s.type === 'meshtastic_tcp');
      const current = typeof value === 'string' ? value : '';
      const chosen = options.find((s) => s.id === current);
      const txWarning = t(
        'tx_disabled.automation_source_warning',
        'Transmit is disabled on this source — messages sent through it will be skipped.',
      );
      control = (
        <>
          <select className="ae-select" value={current} onChange={(e) => onChange(e.target.value)}>
            <option value="">{t('automation.meshtasticSource.placeholder', '— select a Meshtastic source —')}</option>
            {options.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            {current && !chosen && <option value={current}>{current}</option>}
          </select>
          {options.length === 0 && (
            <div className="ae-muted">{t('automation.meshtasticSource.none', 'No Meshtastic sources.')}</div>
          )}
          {chosen && (chosen.canTransmit ?? chosen.txEnabled) === false && (
            <div className="ae-field-warn" role="note">
              <UiIcon name="alert" size={14} /> <span>{txWarning}</span>
            </div>
          )}
        </>
      );
      break;
    }
    case 'forwardingSourceSelect': {
      // #5537: one Meshtastic or MeshCore source (MQTT sources have no
      // forwarding). Must be a literal pick: the save route checks the user's
      // Automation write permission on it.
      const options = sources.filter(isSendableSource);
      const current = typeof value === 'string' ? value : '';
      const chosen = options.find((s) => s.id === current);
      control = (
        <>
          <select className="ae-select" value={current} onChange={(e) => onChange(e.target.value)}>
            <option value="">{t('automation.forwardingSource.placeholder', '— select a source —')}</option>
            {options.map((s) => {
              const badge = protoBadge(s.type);
              return <option key={s.id} value={s.id}>{badge ? `${s.name} (${badge})` : s.name}</option>;
            })}
            {current && !chosen && <option value={current}>{current}</option>}
          </select>
          {options.length === 0 && (
            <div className="ae-muted">{t('automation.forwardingSource.none', 'No Meshtastic or MeshCore sources.')}</div>
          )}
        </>
      );
      break;
    }
    case 'channelMulti': {
      const sel = Array.isArray(value) ? (value as Array<{ name: string; protocol?: string }>) : [];
      const same = (a: { name: string; protocol?: string }, c: UnifiedChannelOption) =>
        a.name === c.name && (a.protocol ?? '') === (c.protocol ?? '');
      const isSel = (c: UnifiedChannelOption) => sel.some((x) => same(x, c));
      const visible = channels.filter((c) => channelMatchesProtocol(c, field.protocolFilter));
      control = (
        <div>
          {visible.length === 0 && <div className="ae-muted">No channels found on sendable sources.</div>}
          {visible.map((c) => (
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
        ? <TokenTextField value={tokenText(value)} placeholder={placeholder}
            triggerType={triggerType} variableNames={varNames} steps={stepScope} onChange={onChange} />
        : <input className="ae-input" value={(value ?? '') as string} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />;
  }
  return (
    <div className="ae-field">
      <label className="ae-field-label">{field.label}</label>
      {control}
      {field.help && <div className="ae-help-text">{field.help}</div>}
    </div>
  );
}

/** What the builder knows about run outputs (#5636), threaded down to each field. */
interface StepOutputInfo {
  scopeAt: (loc: BlockLocation | null) => StepTokenScope;
  duplicates: ReadonlySet<string>;
}

function BlockFields({ block, triggerType, variables, sources, channels, scripts, regions, nodes, automations, onParams, steps, duplicateOutputNames }: {
  block: FormBlock; triggerType: string; variables: VariableOption[]; sources: SourceOption[]; channels: UnifiedChannelOption[]; scripts: ScriptOption[]; regions: string[]; nodes: NodeMultiOption[]; automations: AutomationOption[]; onParams: (p: Record<string, unknown>) => void;
  steps: StepTokenScope; duplicateOutputNames: ReadonlySet<string>;
}) {
  const def = BLOCK_BY_TYPE[block.type];
  if (!def) return null;
  const patch = (changes: Record<string, unknown>) => {
    const next: Record<string, unknown> = { ...block.params };
    for (const [k, v] of Object.entries(changes)) {
      if (v === undefined) delete next[k];
      else next[k] = v;
    }
    onParams(next);
  };
  return (
    <>
      {def.fields.filter((f) => fieldVisible(f, block.params)).map((f) => {
        const field = f.kind === 'fieldselect' ? { ...f, groups: fieldsFor(block.type, triggerType) } : f;
        return <FieldInput key={f.name} field={field} value={block.params[f.name]} variables={variables} sources={sources} channels={channels} scripts={scripts} regions={regions} nodes={nodes} automations={automations} triggerType={triggerType}
          params={block.params} onPatch={patch} steps={steps} duplicateOutputNames={duplicateOutputNames}
          onChange={(v) => onParams({ ...block.params, [f.name]: v })} />;
      })}
    </>
  );
}

function BlockListEditor({ blocks, options, triggerType, variables, sources, channels, scripts, regions, nodes, automations, onChange, addLabel, stepInfo, locate }: {
  blocks: FormBlock[]; options: BlockDef[]; triggerType: string; variables: VariableOption[]; sources: SourceOption[]; channels: UnifiedChannelOption[]; scripts: ScriptOption[]; regions: string[]; nodes: NodeMultiOption[]; automations: AutomationOption[];
  onChange: (b: FormBlock[]) => void; addLabel: string;
  stepInfo: StepOutputInfo; locate: (index: number) => BlockLocation;
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
          <BlockFields block={b} triggerType={triggerType} variables={variables} sources={sources} channels={channels} scripts={scripts} regions={regions} nodes={nodes} automations={automations} onParams={(p) => update(i, { ...b, params: p })}
            steps={stepInfo.scopeAt(locate(i))} duplicateOutputNames={stepInfo.duplicates} />
        </div>
      ))}
      <button className="ae-btn" onClick={() => onChange([...blocks, { type: options[0].type, params: defaultParams(options[0].type, triggerType) }])}>{addLabel}</button>
    </>
  );
}

const NO_NAMES: ReadonlySet<string> = new Set<string>();

export default function AutomationBuilder({ form, variables, sources, channels, scripts, regions, nodes = [], automations = [], onChange }: Props) {
  const triggerType = form.trigger.type;
  const [showHelp, setShowHelp] = useState(false);
  const setTrigger = (type: string) => onChange({ ...form, trigger: { type, params: defaultParams(type, type) } });
  const setTriggerParams = (params: Record<string, unknown>) => onChange({ ...form, trigger: { ...form.trigger, params } });

  const updateRule = (i: number, rule: Rule) => { const r = [...form.rules]; r[i] = rule; onChange({ ...form, rules: r }); };
  const addRule = () => onChange({ ...form, rules: [...form.rules, { conditions: [], actions: [{ type: ACTIONS[0].type, params: defaultParams(ACTIONS[0].type, triggerType) }] }] });
  const removeRule = (i: number) => onChange({ ...form, rules: form.rules.filter((_, j) => j !== i) });
  const setCombine = (combine: WorkflowForm['combine']) => onChange({ ...form, combine });

  // #5636: which run outputs each block can read. Worked out on the compiled
  // graph (ancestry, not list order), so the builder flags exactly what the
  // engine would leave empty.
  const stepInfo = useMemo<StepOutputInfo>(() => {
    const names = formOutputNames(form);
    const all = new Set(names);
    const duplicates = new Set(names.filter((n, i) => names.indexOf(n) !== i));
    const scopes = stepOutputScopes(compile(form));
    return {
      duplicates,
      scopeAt: (loc) => {
        const scope = loc ? scopes.get(blockNodeId(form, loc)) : undefined;
        return { guaranteed: scope?.guaranteed ?? NO_NAMES, possible: scope?.possible ?? NO_NAMES, all };
      },
    };
  }, [form]);
  const stepNames = useMemo(() => [...new Set(formOutputNames(form))], [form]);

  return (
    <div>
      {showHelp && <SubstitutionsHelpDrawer triggerType={triggerType} variables={variables} stepNames={stepNames} onClose={() => setShowHelp(false)} />}
      <div className="ae-row ae-builder-hint" style={{ marginBottom: '0.6rem' }}>
        <span className="ae-muted">Tip: insert <code>{'{{ trigger.* }}'}</code> / <code>{'{{ var.* }}'}</code> / <code>{'{{ steps.* }}'}</code> tokens in any message or notification text.</span>
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
          <BlockFields block={form.trigger} triggerType={triggerType} variables={variables} sources={sources} channels={channels} scripts={scripts} regions={regions} nodes={nodes} automations={automations} onParams={setTriggerParams}
            steps={stepInfo.scopeAt(null)} duplicateOutputNames={stepInfo.duplicates} />
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
            <BlockListEditor blocks={rule.conditions} options={CONDITIONS} triggerType={triggerType} variables={variables} sources={sources} channels={channels} scripts={scripts} regions={regions} nodes={nodes} automations={automations}
              stepInfo={stepInfo} locate={(k) => ({ section: 'condition', rule: i, index: k })}
              onChange={(c) => updateRule(i, { ...rule, conditions: c })} addLabel="+ Add condition" />
            <div className="ae-field-label" style={{ margin: '0.9rem 0 0.4rem' }}>THEN — do this</div>
            <BlockListEditor blocks={rule.actions} options={ACTIONS} triggerType={triggerType} variables={variables} sources={sources} channels={channels} scripts={scripts} regions={regions} nodes={nodes} automations={automations}
              stepInfo={stepInfo} locate={(k) => ({ section: 'action', rule: i, index: k })}
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
            <BlockListEditor blocks={form.combine.actions} options={ACTIONS} triggerType={triggerType} variables={variables} sources={sources} channels={channels} scripts={scripts} regions={regions} nodes={nodes} automations={automations}
              stepInfo={stepInfo} locate={(k) => ({ section: 'finally', index: k })}
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
