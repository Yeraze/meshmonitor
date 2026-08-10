/**
 * NodeMultiFieldInput — searchable multi-select of mesh nodes for automation
 * triggers (becameMobile / leftHome). Stationary nodes (mobile === 0 / !isMobile)
 * are listed first with a Stationary badge.
 */
import { useMemo, useState } from 'react';

export interface NodeMultiOption {
  nodeNum: number;
  longName?: string;
  shortName?: string;
  nodeId?: string;
  /** MeshMonitor mobility flag: 0/false = stationary, 1/true = mobile. */
  mobile?: number | boolean;
  isMobile?: boolean;
}

interface Props {
  value: unknown;
  onChange: (v: number[]) => void;
  nodes: NodeMultiOption[];
}

function isStationary(n: NodeMultiOption): boolean {
  if (n.isMobile === true) return false;
  if (n.isMobile === false) return true;
  if (n.mobile === 1 || n.mobile === true) return false;
  return true; // unknown / 0 / false → treat as stationary candidate
}

function labelOf(n: NodeMultiOption): string {
  return n.longName || n.shortName || n.nodeId || String(n.nodeNum);
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
          const hay = `${labelOf(n)} ${n.nodeId ?? ''} ${n.nodeNum}`.toLowerCase();
          return hay.includes(term);
        });
    return [...filtered].sort((a, b) => {
      const sa = isStationary(a) ? 0 : 1;
      const sb = isStationary(b) ? 0 : 1;
      if (sa !== sb) return sa - sb;
      return labelOf(a).localeCompare(labelOf(b));
    });
  }, [nodes, search]);

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
          placeholder="Search nodes…"
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
          return (
            <label key={n.nodeNum} className="ae-switch" style={{ display: 'block', marginBottom: '0.2rem' }}>
              <input
                type="checkbox"
                checked={selected.includes(n.nodeNum)}
                onChange={(e) => toggle(n.nodeNum, e.target.checked)}
              />
              {' '}
              {labelOf(n)}
              <span className="ae-chip">#{n.nodeNum}</span>
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
