import { useMapAnalysisCtx } from './MapAnalysisContext';

/**
 * Toolbar text input that filters map markers to nodes matching the term
 * (issue #3399). Non-matching nodes are hidden; the term also constrains which
 * traceroute link endpoints render.
 */
export default function NodeSearchControl() {
  const { nodeFilter, setNodeFilter } = useMapAnalysisCtx();

  return (
    <div className="map-analysis-node-search">
      <input
        type="text"
        className="map-analysis-node-search-input"
        placeholder="Search nodes…"
        aria-label="Search nodes"
        value={nodeFilter}
        onChange={(e) => setNodeFilter(e.target.value)}
      />
      {nodeFilter && (
        <button
          type="button"
          className="map-analysis-node-search-clear"
          aria-label="Clear node search"
          onClick={() => setNodeFilter('')}
        >
          ×
        </button>
      )}
    </div>
  );
}
