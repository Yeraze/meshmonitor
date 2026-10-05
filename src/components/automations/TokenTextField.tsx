/**
 * Text/textarea with live `{{ }}` token highlighting (#3653 follow-up).
 *
 * A highlight backdrop renders the same text with `{{ trigger.* }}`/`{{ var.* }}`
 * tokens colored — blue when recognized, red+wavy when not — while a transparent
 * textarea/input sits on top for editing. Unrecognized tokens (typos) are also
 * listed inline below the field.
 *
 * Outside the Automation builder (#5593, notification templates) pass
 * `validTokens`: the field then accepts exactly that set, with no trigger or
 * variable namespaces, and every other token is flagged as unrecognized.
 */
import { useMemo, useRef } from 'react';
import { tokenize, diagnoseTokens, validTokenSet, type TokenDiag, type TokenSegment, type StepTokenScope } from './tokenHints';
import { UiIcon } from '../icons';
import './TokenTextField.css';

export default function TokenTextField({
  value, onChange, multiline, placeholder, triggerType = '', variableNames, validTokens, steps,
  fieldClassName, id, maxLength, ariaLabel,
}: {
  value: string;
  onChange: (v: string) => void;
  multiline?: boolean;
  placeholder?: string;
  /** Automation builder: the trigger whose `trigger.*` tokens are valid. */
  triggerType?: string;
  /** Automation builder: defined `var.*` names. */
  variableNames?: string[];
  /** Exact set of valid token paths. Overrides `triggerType`/`variableNames`. */
  validTokens?: ReadonlySet<string>;
  /** Automation builder: the run outputs this field's step can read (#5636). */
  steps?: StepTokenScope;
  /** Field chrome class for backdrop + input. Defaults to `ae-input`/`ae-textarea`. */
  fieldClassName?: string;
  id?: string;
  maxLength?: number;
  ariaLabel?: string;
}) {
  const backdropRef = useRef<HTMLDivElement>(null);
  const valid = useMemo(
    () => (validTokens ? new Set(validTokens) : validTokenSet(triggerType, variableNames ?? [])),
    [validTokens, triggerType, variableNames],
  );
  const strict = validTokens !== undefined;
  const segs = useMemo<TokenSegment[]>(() => {
    const out = tokenize(value, valid, steps);
    // A fixed token set has no "belongs to another trigger" tier.
    return strict ? out.map((s) => (s.status === 'foreign' ? { ...s, status: 'bad' as const } : s)) : out;
  }, [value, valid, strict, steps]);
  const diags = useMemo<TokenDiag[]>(() => {
    const out = diagnoseTokens(value, valid, steps);
    return strict
      ? out.map((d) => ({ token: d.token, severity: 'error' as const, detail: 'is not a recognized token' }))
      : out;
  }, [value, valid, strict, steps]);

  const cls = fieldClassName ?? (multiline ? 'ae-textarea' : 'ae-input');
  const markClass = (status: string) =>
    status === 'bad' ? 'ae-token-bad' : status === 'foreign' ? 'ae-token-foreign' : 'ae-token-ok';
  const syncScroll = (el: HTMLTextAreaElement | HTMLInputElement) => {
    if (backdropRef.current) {
      backdropRef.current.scrollTop = el.scrollTop;
      backdropRef.current.scrollLeft = el.scrollLeft;
    }
  };

  const highlighted = segs.map((s, i) =>
    s.token
      ? <mark key={i} className={markClass(s.status)}>{s.text}</mark>
      : <span key={i}>{s.text}</span>,
  );

  return (
    <>
    {/* Field box = backdrop + transparent input ONLY. The diagnostics bar must
        stay OUTSIDE this box: the backdrop is position:absolute inset:0 with an
        opaque background and would otherwise paint over (hide) the bar. */}
    <div className={`ae-tokenfield ${multiline ? 'ae-tokenfield--multiline' : ''}`}>
      <div ref={backdropRef} className={`${cls} ae-tokenfield-backdrop`} aria-hidden="true">
        {highlighted}
        {/* trailing zero-width space keeps a final newline's line visible in the backdrop */}
        {'\u200b'}
      </div>
      {multiline ? (
        <textarea
          id={id}
          className={`${cls} ae-tokenfield-input`}
          value={value}
          placeholder={placeholder}
          spellCheck={false}
          maxLength={maxLength}
          aria-label={ariaLabel}
          onChange={(e) => onChange(e.target.value)}
          onScroll={(e) => syncScroll(e.currentTarget)}
        />
      ) : (
        <input
          id={id}
          className={`${cls} ae-tokenfield-input`}
          value={value}
          placeholder={placeholder}
          spellCheck={false}
          maxLength={maxLength}
          aria-label={ariaLabel}
          onChange={(e) => onChange(e.target.value)}
          onScroll={(e) => syncScroll(e.currentTarget)}
        />
      )}
    </div>
      {diags.length > 0 && (
        <div className="ae-token-bar">
          {diags.map((d) => (
            <div key={d.token} className={`ae-token-diag ae-token-diag--${d.severity}`}>
              <span className="ae-token-diag-icon"><UiIcon name={d.severity === 'error' ? 'error' : 'alert'} size={14} /></span>
              <code>{`{{ ${d.token} }}`}</code> {d.detail}
            </div>
          ))}
        </div>
      )}
    </>
  );
}
