/**
 * Text/textarea with live `{{ }}` token highlighting (#3653 follow-up).
 *
 * A highlight backdrop renders the same text with `{{ trigger.* }}`/`{{ var.* }}`
 * tokens colored — blue when recognized, red+wavy when not — while a transparent
 * textarea/input sits on top for editing. Unrecognized tokens (typos) are also
 * listed inline below the field.
 */
import { useMemo, useRef } from 'react';
import { tokenize, unknownTokens, validTokenSet } from './tokenHints';

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
  const unknown = useMemo(() => unknownTokens(value, valid), [value, valid]);

  const cls = multiline ? 'ae-textarea' : 'ae-input';
  const syncScroll = (el: HTMLTextAreaElement | HTMLInputElement) => {
    if (backdropRef.current) {
      backdropRef.current.scrollTop = el.scrollTop;
      backdropRef.current.scrollLeft = el.scrollLeft;
    }
  };

  const highlighted = segs.map((s, i) =>
    s.token
      ? <mark key={i} className={s.known ? 'ae-token-ok' : 'ae-token-bad'}>{s.text}</mark>
      : <span key={i}>{s.text}</span>,
  );

  return (
    <div className={`ae-tokenfield ${multiline ? 'ae-tokenfield--multiline' : ''}`}>
      <div ref={backdropRef} className={`${cls} ae-tokenfield-backdrop`} aria-hidden="true">
        {highlighted}{'​'}
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
      {unknown.length > 0 && (
        <div className="ae-token-warn">
          Unrecognized token{unknown.length > 1 ? 's' : ''}: {unknown.map((t) => `{{ ${t} }}`).join(', ')} — check for typos.
        </div>
      )}
    </div>
  );
}
