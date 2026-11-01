/**
 * ReticulumConnectionsGraph — the position-free "Connections" topology view
 * for the Reticulum Map page (#6119).
 *
 * Most Reticulum clients share no location, so the Locations map shows few
 * peers. This draws the mesh *topology* straight from the path table instead:
 * the local instance at the centre, a direct edge to every directly-reachable
 * destination, and a relay edge through the via/next hop for the rest.
 *
 * Lightweight by design — a self-contained SVG with a deterministic two-ring
 * radial layout (destinations on the outer ring, relays on an inner ring), no
 * force-simulation dependency. The graph *shape* is computed by the pure
 * `buildReticulumConnectionGraph` (tested separately); this component only
 * lays it out and handles selection. Clicking a node that resolves to a known
 * destination opens the shared destination details.
 */
import React, { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ReticulumDestinationRow, ReticulumPathRow } from '../../types/reticulum';
import {
  buildReticulumConnectionGraph,
  LOCAL_NODE_ID,
  type ReticulumGraphNode,
} from './reticulumConnectionGraph';
import { ReticulumDestinationDetail } from './ReticulumDestinationDetail';
import { UiIcon } from '../icons';
import styles from './ReticulumConnectionsGraph.module.css';

export interface ReticulumConnectionsGraphProps {
  paths: ReticulumPathRow[];
  destinations: ReticulumDestinationRow[];
  loading?: boolean;
}

const VIEW = 600; // SVG viewBox square (user units)
const CENTER = VIEW / 2;
const RELAY_RADIUS = VIEW * 0.24;
const DEST_RADIUS = VIEW * 0.42;

interface Placed {
  node: ReticulumGraphNode;
  x: number;
  y: number;
}

/** Evenly place `n` nodes on a ring, starting at the top (-90°). */
function ringPosition(index: number, count: number, radius: number, offset = 0): { x: number; y: number } {
  const angle = (index / Math.max(1, count)) * Math.PI * 2 - Math.PI / 2 + offset;
  return { x: CENTER + radius * Math.cos(angle), y: CENTER + radius * Math.sin(angle) };
}

export const ReticulumConnectionsGraph: React.FC<ReticulumConnectionsGraphProps> = ({
  paths,
  destinations,
  loading = false,
}) => {
  const { t } = useTranslation();
  const [selected, setSelected] = useState<ReticulumGraphNode | null>(null);

  const graph = useMemo(
    () => buildReticulumConnectionGraph(paths, destinations, {
      localLabel: t('reticulum.connections.local', 'This instance'),
    }),
    [paths, destinations, t],
  );

  const placedById = useMemo(() => {
    const map = new Map<string, Placed>();
    map.set(LOCAL_NODE_ID, { node: graph.nodes[0] ?? { id: LOCAL_NODE_ID, kind: 'local', hash: null, label: '', destination: null }, x: CENTER, y: CENTER });
    const relays = graph.nodes.filter(n => n.kind === 'relay');
    const dests = graph.nodes.filter(n => n.kind === 'destination');
    relays.forEach((node, i) => {
      const { x, y } = ringPosition(i, relays.length, RELAY_RADIUS, Math.PI / relays.length);
      map.set(node.id, { node, x, y });
    });
    dests.forEach((node, i) => {
      const { x, y } = ringPosition(i, dests.length, DEST_RADIUS);
      map.set(node.id, { node, x, y });
    });
    return map;
  }, [graph]);

  const isEmpty = graph.nodes.length === 0;

  const handleNodeClick = (node: ReticulumGraphNode) => {
    if (node.destination) setSelected(node);
  };

  return (
    <div className={styles.graphPane} data-testid="reticulum-connections-graph">
      {!isEmpty && (
        <svg
          className={styles.svg}
          viewBox={`0 0 ${VIEW} ${VIEW}`}
          preserveAspectRatio="xMidYMid meet"
          role="img"
          aria-label={t('reticulum.connections.aria', 'Reticulum connection topology')}
        >
          {/* Edges first so nodes draw on top. */}
          <g>
            {graph.edges.map(edge => {
              const a = placedById.get(edge.from);
              const b = placedById.get(edge.to);
              if (!a || !b) return null;
              return (
                <line
                  key={edge.id}
                  x1={a.x} y1={a.y} x2={b.x} y2={b.y}
                  className={edge.kind === 'direct' ? styles.edgeDirect : styles.edgeRelay}
                />
              );
            })}
          </g>
          <g>
            {graph.nodes.map(node => {
              const p = placedById.get(node.id);
              if (!p) return null;
              const clickable = Boolean(node.destination);
              const nodeClass =
                node.kind === 'local' ? styles.nodeLocal
                  : node.kind === 'relay' ? styles.nodeRelay
                    : styles.nodeDest;
              return (
                <g
                  key={node.id}
                  transform={`translate(${p.x} ${p.y})`}
                  className={`${styles.node} ${clickable ? styles.clickable : ''}`}
                  onClick={clickable ? () => handleNodeClick(node) : undefined}
                  role={clickable ? 'button' : undefined}
                  tabIndex={clickable ? 0 : undefined}
                  onKeyDown={clickable ? e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleNodeClick(node); } } : undefined}
                  aria-label={clickable ? node.label : undefined}
                  data-testid={`reticulum-graph-node-${node.id}`}
                  data-kind={node.kind}
                >
                  <circle r={node.kind === 'local' ? 14 : node.kind === 'relay' ? 9 : 11} className={nodeClass} />
                  <text className={styles.nodeLabel} y={node.kind === 'local' ? 30 : 24} textAnchor="middle">
                    {node.label}
                  </text>
                </g>
              );
            })}
          </g>
        </svg>
      )}

      {!isEmpty && (
        <div className={styles.legend} aria-hidden="true">
          <span className={styles.legendItem}>
            <svg width="22" height="10" className={styles.legendSwatch}><line x1="1" y1="5" x2="21" y2="5" className={styles.edgeDirect} /></svg>
            {t('reticulum.connections.legend_direct', 'Direct link')}
          </span>
          <span className={styles.legendItem}>
            <svg width="22" height="10" className={styles.legendSwatch}><line x1="1" y1="5" x2="21" y2="5" className={styles.edgeRelay} /></svg>
            {t('reticulum.connections.legend_relay', 'Through a relay')}
          </span>
          <span className={styles.legendItem}>
            <svg width="16" height="16" className={styles.legendSwatch}><circle cx="8" cy="8" r="6" className={styles.nodeRelay} /></svg>
            {t('reticulum.connections.legend_relay_node', 'Relay node')}
          </span>
        </div>
      )}

      {selected?.destination && (
        <div className={styles.detailPanel} role="dialog" aria-label={selected.label} data-testid="reticulum-connections-detail">
          <button
            type="button"
            className={styles.detailClose}
            onClick={() => setSelected(null)}
            aria-label={t('common.close', 'Close')}
          >
            <UiIcon name="close" size={14} />
          </button>
          <ReticulumDestinationDetail destination={selected.destination} name={selected.label} />
        </div>
      )}

      {!loading && isEmpty && (
        <div className={styles.emptyState} role="status">
          {t('reticulum.connections.empty', 'No paths reported yet, so there is nothing to graph.')}
        </div>
      )}
    </div>
  );
};

export default ReticulumConnectionsGraph;
