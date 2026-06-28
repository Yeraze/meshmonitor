import { useState, useEffect } from 'react';
import { useCsrfFetch } from '../../hooks/useCsrfFetch';

/**
 * Shared MeshCore scope/region selector for the Automations tab (#3833).
 *
 * Lets an automation choose which region a sent message floods to — the only
 * per-message propagation lever in MeshCore (repeaters only forward a scoped
 * flood for regions they carry). The mode maps to the backend's `scopeOverride`
 * contract: inherit = channel/source default, unscoped = flood with no region,
 * named = a specific region, trigger = the triggering message's own scope.
 *
 * `allowTrigger` is true only for reply automations that have a triggering
 * message (auto-responder, auto-ack); scheduled senders (announce, timer) omit it.
 */
export type ScopeMode = 'inherit' | 'trigger' | 'unscoped' | 'named';

export interface ScopeValue {
  scopeMode?: ScopeMode;
  scopeName?: string;
}

interface ScopeSelectFieldProps {
  baseUrl: string;
  sourceId: string;
  value: ScopeValue;
  onChange: (value: ScopeValue) => void;
  /** Show the "Respond on the triggering message's scope" option. */
  allowTrigger?: boolean;
  /** Unique-ish id prefix so multiple instances don't collide on the datalist. */
  idPrefix?: string;
}

export function ScopeSelectField({
  baseUrl,
  sourceId,
  value,
  onChange,
  allowTrigger = false,
  idPrefix = 'mc-scope',
}: ScopeSelectFieldProps) {
  const csrfFetch = useCsrfFetch();
  const [regions, setRegions] = useState<string[]>([]);
  const mode: ScopeMode = value.scopeMode ?? 'inherit';
  const listId = `${idPrefix}-regions`;

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await csrfFetch(`${baseUrl}/api/sources/${sourceId}/meshcore/saved-regions`);
        if (!res.ok) return; // e.g. no configuration:read — degrade to free-text entry
        const data = await res.json();
        const names: string[] = Array.isArray(data?.regions)
          ? data.regions.map((r: { name?: string }) => r?.name).filter((n: unknown): n is string => typeof n === 'string' && n.length > 0)
          : [];
        if (!cancelled) setRegions(names);
      } catch {
        // Network/permission failure → leave the catalog empty; the combobox
        // still accepts any typed region name.
      }
    })();
    return () => { cancelled = true; };
  }, [baseUrl, sourceId, csrfFetch]);

  return (
    <div className="meshcore-scope-field" style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem', alignItems: 'center' }}>
      <label style={{ fontWeight: 500 }}>Scope</label>
      <select
        value={mode}
        onChange={(e) => onChange({ ...value, scopeMode: e.target.value as ScopeMode })}
        aria-label="MeshCore scope mode"
      >
        <option value="inherit">Inherit (channel / source default)</option>
        {allowTrigger && <option value="trigger">Respond on the triggering message&apos;s scope</option>}
        <option value="unscoped">Unscoped (flood, no region)</option>
        <option value="named">A specific region…</option>
      </select>
      {mode === 'named' && (
        <>
          <input
            type="text"
            list={listId}
            value={value.scopeName ?? ''}
            placeholder="region name (e.g. paris)"
            onChange={(e) => onChange({ ...value, scopeName: e.target.value })}
            aria-label="MeshCore region name"
          />
          <datalist id={listId}>
            {regions.map((r) => <option key={r} value={r} />)}
          </datalist>
        </>
      )}
    </div>
  );
}

export default ScopeSelectField;
