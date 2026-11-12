/**
 * NodeMultiFieldInput — searchable multi-select of mesh nodes for automation
 * triggers (becameMobile / leftHome). Stationary nodes (mobile === 0 / !isMobile)
 * are listed first with a Stationary badge.
 *
 * @vitest-environment jsdom
 */
import { useMemo, useState } from 'react';
import { labelOf } from './nodeLabel';

export interface NodeMultiOption {
  nodeNum: number;
  longName?: string;
  shortName?: string;
  nodeId?: string;
  /** MeshMonitor mobility flag: 0/false = stationary, 1/true = mobile. */
  mobile?: number | boolean;
  isMobile?: boolean;
  /** Tracked asset (#5354); forces the node into the Mobile chip. */
  asset?: { retentionDays: number } | null;
}

interface Props {
  value: unknown;
  onChange: (v: number[]) => void;
  nodes: NodeMultiOption[];
}

function isStationary(n: NodeMultiOption): boolean {
  // A tracked asset (#5354) is always mobile, whatever the heuristic says.
  if (n.asset) return false;
  if (n.isMobile === true) return false;
  if (n.isMobile === false) return true;
  if (n.mobile === 1 || n.mobile === true) return false;
  return true; // unknown / 0 / false → treat as stationary candidate
}

/** Secondary identity chip — prefer short name when long name is shown, else node id. */
function secondaryOf(n: NodeMultiOption): string | null {
  const long = (n.longName || '').trim();
  const short = (n.shortName || '').trim();
  if (long && short && short !== long) return short;
  if (n.nodeId && labelOf(n) !== n.nodeId) return n.nodeId;
  return null;
}

/** The node id shown to tell same-named rows apart (`!a1b2c3d4`). */
function idOf(n: NodeMultiOption): string {
  return n.nodeId || `!${(Number(n.nodeNum) >>> 0).toString(16).padStart(8, '0')}`;
}

/** What a row reads as without the id: label plus secondary chip. */
function rowTextOf(n: NodeMultiOption): string {
  return `${labelOf(n)}\u0000${secondaryOf(n) ?? ''}`.toLowerCase();
}

export default function NodeMultiFieldInput({ value, onChange, nodes }: Props) {
  const [search, setSearch] = useState('');
  const selected = useMemo(() => {
    if (!Array.isArray(value)) return [] as number[];
    return value.map((x) => Number(x)).filter((n) => Number.isInteger(n));
  }, [value]);

  const sorted = useMemo(() => {
    const term = search.trim().toLowerCase();
    const filtered = !term
      ? nodes
      : nodes.filter((n) => {
          const hay = `${labelOf(n)} ${n.shortName ?? ''} ${n.nodeId ?? ''} ${n.nodeNum}`.toLowerCase();
          return hay.includes(term);
        });
    return [...filtered].sort((a, b) => {
      const sa = isStationary(a) ? 0 : 1;
      const sb = isStationary(b) ? 0 : 1;
      if (sa !== sb) return sa - sb;
      // Named nodes before id-only fallbacks within the same mobility group.
      const na = (a.longName || a.shortName) ? 0 : 1;
      const nb = (b.longName || b.shortName) ? 0 : 1;
      if (na !== nb) return na - nb;
      return labelOf(a).localeCompare(labelOf(b), undefined, { sensitivity: 'base' });
    });
  }, [nodes, search]);

  // Rows that would read the same (same name and short name) also show their
  // node id, so two nodes with one name can be told apart (#4173 review L28).
  const ambiguous = useMemo(() => {
    const counts = new Map<string, number>();
    for (const n of nodes) counts.set(rowTextOf(n), (counts.get(rowTextOf(n)) ?? 0) + 1);
    return counts;
  }, [nodes]);

  const toggle = (nodeNum: number, checked: boolean) => {
    onChange(checked ? [...selected, nodeNum] : selected.filter((n) => n !== nodeNum));
  };

  const selectStationary = () => {
    const stationaryNums = nodes.filter(isStationary).map((n) => n.nodeNum);
    const merged = Array.from(new Set([...selected, ...stationaryNums]));
    onChange(merged);
  };

  return (
    <div>
      <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '0.4rem', flexWrap: 'wrap' }}>
        <input
          className="ae-input"
          value={search}
          placeholder="Search by name or node id…"
          onChange={(e) => setSearch(e.target.value)}
          style={{ flex: 1, minWidth: '10rem' }}
        />
        <button type="button" className="ae-btn" onClick={selectStationary}>
          Select all stationary
        </button>
        {selected.length > 0 && (
          <button type="button" className="ae-btn" onClick={() => onChange([])}>
            Clear ({selected.length})
          </button>
        )}
      </div>
      {nodes.length === 0 && <div className="ae-muted">No nodes loaded yet.</div>}
      <div style={{ maxHeight: '14rem', overflowY: 'auto', border: '1px solid var(--border-color, #444)', borderRadius: 4, padding: '0.35rem 0.5rem' }}>
        {sorted.map((n) => {
          const stationary = isStationary(n);
          const secondary = secondaryOf(n);
          const showId = (ambiguous.get(rowTextOf(n)) ?? 0) > 1 && secondary !== idOf(n);
          return (
            <label key={n.nodeNum} className="ae-switch" style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', marginBottom: '0.25rem', flexWrap: 'wrap' }}>
              <input
                type="checkbox"
                checked={selected.includes(n.nodeNum)}
                onChange={(e) => toggle(n.nodeNum, e.target.checked)}
              />
              <span style={{ fontWeight: 600 }}>{labelOf(n)}</span>
              {secondary ? <span className="ae-chip">{secondary}</span> : null}
              {showId ? <span className="ae-chip" data-testid="node-multi-id">{idOf(n)}</span> : null}
              {stationary
                ? <span className="ae-chip" title="MeshMonitor marks this node stationary (mobile = 0)">Stationary</span>
                : <span className="ae-chip" title="MeshMonitor marks this node mobile">Mobile</span>}
            </label>
          );
        })}
        {sorted.length === 0 && nodes.length > 0 && <div className="ae-muted">No matches.</div>}
      </div>
    </div>
  );
}
