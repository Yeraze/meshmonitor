/**
 * Free-text "Send as" input with a datalist of the sender names allowed on
 * every MeshCore source (#6341 P4). The text is a literal, saved as typed
 * (syntax is checked by the server); a source that does not allow the name
 * sends under its own name at run time. A failed read leaves the list empty.
 */
import { useCommonSenderNames } from './useCommonSenderNames';
import type { SourceOption } from './AutomationBuilder';

interface Props {
  value: unknown;
  onChange: (v: unknown) => void;
  sources: SourceOption[];
  placeholder?: string;
}

export default function SenderNameFieldInput({ value, onChange, sources, placeholder }: Props) {
  const ids = sources.filter((s) => s.type === 'meshcore' && s.enabled !== false).map((s) => s.id);
  const names = useCommonSenderNames(ids);
  return (
    <>
      <input className="ae-input" list="ae-sender-names" value={(value ?? '') as string}
        placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
      <datalist id="ae-sender-names">
        {names.map((n) => <option key={n} value={n} />)}
      </datalist>
    </>
  );
}
