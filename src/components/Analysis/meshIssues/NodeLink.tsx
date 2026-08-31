/**
 * NodeLink — clickable node reference that opens the target node on its
 * source's Nodes tab.
 *
 * A nodeNum can exist on 1..N sources. The click handler resolves that at
 * runtime via `GET /api/nodes/:nodeNum/sources`:
 *  - 1 source → drop the nodeId into sessionStorage and navigate straight
 *    to `/source/<sid>/nodes`.
 *  - >1 sources → render a small inline picker anchored under the trigger.
 *  - 0 sources / API failure → fall back to `fallbackSourceIds` (usually the
 *    parent finding's `sourceIds`) with the same 1-vs-many logic.
 *
 * The handoff to the destination Nodes tab uses sessionStorage
 * (`meshmonitor.pendingSelectedNodeId`) rather than a URL param so the
 * existing routes stay unchanged; `NodesTab` reads and clears the key on
 * mount.
 *
 * Renders a real `<button>` so keyboard focus and screen readers work.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import apiService from '../../../services/api';
import { hexNodeId } from '../meshIssueTypes';
import styles from './meshIssues.module.css';

/** Storage key read by `NodesTab` on mount to auto-select the node. */
export const PENDING_SELECTED_NODE_STORAGE_KEY = 'meshmonitor.pendingSelectedNodeId';

interface NodeSourceEntry {
  sourceId: string;
  sourceName: string;
  nodeName: string | null;
}

interface NodeLinkProps {
  nodeNum: number;
  /** Text to render. Defaults to `hexNodeId(nodeNum)`. */
  name?: string | null;
  /** Sources known from the parent finding (usually `finding.sourceIds`).
   *  Used when the API call fails or before it returns. */
  fallbackSourceIds?: string[];
  /** Optional label overrides for fallback sources (nodeName by source).
   *  Rarely used — supplied by tests. */
  fallbackSourceNames?: Record<string, string>;
  className?: string;
  children?: React.ReactNode;
}

/**
 * Navigate to `/source/<sourceId>/nodes` and prime NodesTab to auto-select
 * this node. Exported so callers that already know the exact source can
 * bypass the picker entirely.
 */
// eslint-disable-next-line react-refresh/only-export-components -- pure helper co-located with NodeLink; used by NodeLink and other callers that already know the source
export function openNodeOnSource(navigate: (path: string) => void, sourceId: string, nodeNum: number): void {
  try {
    sessionStorage.setItem(PENDING_SELECTED_NODE_STORAGE_KEY, hexNodeId(nodeNum));
  } catch {
    // Private-browsing / storage-quota — the destination just won't
    // auto-select; that's fine, better than a hard failure.
  }
  navigate(`/source/${encodeURIComponent(sourceId)}/nodes`);
}

const NodeLink: React.FC<NodeLinkProps> = ({
  nodeNum,
  name,
  fallbackSourceIds,
  fallbackSourceNames,
  className,
  children,
}) => {
  const navigate = useNavigate();
  const [pickerSources, setPickerSources] = useState<NodeSourceEntry[] | null>(null);
  const [loading, setLoading] = useState(false);
  const anchorRef = useRef<HTMLSpanElement | null>(null);

  const label = children ?? name ?? hexNodeId(nodeNum);

  const closePicker = useCallback(() => setPickerSources(null), []);

  useEffect(() => {
    if (!pickerSources) return undefined;
    const onDown = (ev: MouseEvent) => {
      if (anchorRef.current && !anchorRef.current.contains(ev.target as Node)) closePicker();
    };
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') closePicker();
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [pickerSources, closePicker]);

  const fallbackList = useCallback((): NodeSourceEntry[] => {
    if (!fallbackSourceIds || fallbackSourceIds.length === 0) return [];
    return fallbackSourceIds.map((sid) => ({
      sourceId: sid,
      sourceName: fallbackSourceNames?.[sid] ?? sid,
      nodeName: null,
    }));
  }, [fallbackSourceIds, fallbackSourceNames]);

  const handleClick = useCallback(
    async (ev: React.MouseEvent) => {
      ev.preventDefault();
      ev.stopPropagation();
      if (loading) return;
      setLoading(true);
      let sources: NodeSourceEntry[];
      try {
        const res = await apiService.get<{ success: boolean; data?: { sources: NodeSourceEntry[] } }>(
          `/api/nodes/${nodeNum}/sources`,
        );
        sources = res?.data?.sources ?? [];
      } catch {
        sources = fallbackList();
      }
      if (sources.length === 0) sources = fallbackList();
      setLoading(false);

      if (sources.length === 0) {
        // Nothing we can navigate to. Silently no-op — the user got no worse
        // outcome than clicking a plain span.
        return;
      }
      if (sources.length === 1) {
        openNodeOnSource(navigate, sources[0].sourceId, nodeNum);
        return;
      }
      setPickerSources(sources);
    },
    [nodeNum, loading, fallbackList, navigate],
  );

  return (
    <span ref={anchorRef} className={styles.pickerAnchor}>
      <button
        type="button"
        className={`${styles.nodeLink}${className ? ` ${className}` : ''}`}
        onClick={handleClick}
        disabled={loading}
        aria-haspopup={pickerSources ? 'menu' : undefined}
        aria-expanded={pickerSources ? true : undefined}
      >
        {label}
      </button>
      {pickerSources && pickerSources.length > 1 && (
        <div className={styles.picker} role="menu" aria-label="Choose source">
          <div className={styles.pickerHeader}>Open on source</div>
          {pickerSources.map((s) => (
            <button
              key={s.sourceId}
              type="button"
              role="menuitem"
              className={styles.pickerItem}
              onClick={(ev) => {
                ev.preventDefault();
                ev.stopPropagation();
                closePicker();
                openNodeOnSource(navigate, s.sourceId, nodeNum);
              }}
            >
              <span className={styles.pickerItemSource}>{s.sourceName}</span>
              <span className={styles.pickerItemName}>{s.nodeName ?? hexNodeId(nodeNum)}</span>
            </button>
          ))}
        </div>
      )}
    </span>
  );
};

export default NodeLink;
