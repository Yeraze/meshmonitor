/**
 * Text/textarea with live `{{ }}` token highlighting (#3653 follow-up).
 *
 * A highlight backdrop renders the same text with `{{ trigger.* }}`/`{{ var.* }}`
 * tokens colored — blue when recognized, red+wavy when not — while a transparent
 * textarea/input sits on top for editing. Unrecognized tokens (typos) are also
 * listed inline below the field.
 */
import { useMemo, useRef } from 'react';
import { tokenize, diagnoseTokens, validTokenSet } from './tokenHints';
import { UiIcon } from '../icons';

export default function TokenTextField({ value, onChange, multiline, placeholder, triggerType, variableNames }: {
  value: string;
  onChange: (v: string) => void;
  multiline?: boolean;
  placeholder?: string;
  triggerType: string;
  variableNames: string[];
}) {
  const backdropRef = useRef<HTMLDivElement>(null);
  const valid = useMemo(() => validTokenSet(triggerType, variableNames), [triggerType, variableNames]);
  const segs = useMemo(() => tokenize(value, valid), [value, valid]);
  const diags = useMemo(() => diagnoseTokens(value, valid), [value, valid]);

  const cls = multiline ? 'ae-textarea' : 'ae-input';
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
          className={`${cls} ae-tokenfield-input`}
          value={value}
          placeholder={placeholder}
          spellCheck={false}
          onChange={(e) => onChange(e.target.value)}
          onScroll={(e) => syncScroll(e.currentTarget)}
        />
      ) : (
        <input
          className={`${cls} ae-tokenfield-input`}
          value={value}
          placeholder={placeholder}
          spellCheck={false}
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
