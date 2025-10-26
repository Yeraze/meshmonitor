import React, { useMemo } from 'react';
import { DbTraceroute } from '../services/database';
import { formatDateTime } from '../utils/datetime';
import { DeviceInfo } from '../types/device';
import { useSettings } from '../contexts/SettingsContext';
import { formatNodeName, formatTracerouteRoute } from '../utils/traceroute';

interface RouteSegmentTraceroutesModalProps {
  nodeNum1: number;
  nodeNum2: number;
  traceroutes: DbTraceroute[];
  nodes: DeviceInfo[];
  onClose: () => void;
}

const RouteSegmentTraceroutesModal: React.FC<RouteSegmentTraceroutesModalProps> = ({
  nodeNum1,
  nodeNum2,
  traceroutes,
  nodes,
  onClose,
}) => {
  const { timeFormat, dateFormat, distanceUnit } = useSettings();

  const node1Name = formatNodeName(nodeNum1, nodes);
  const node2Name = formatNodeName(nodeNum2, nodes);

  // Filter traceroutes that contain this segment
  const relevantTraceroutes = useMemo(() => {
    return traceroutes.filter(tr => {
      try {
        if (!tr.route || tr.route === 'null' || !tr.routeBack || tr.routeBack === 'null') {
          return false;
        }

        const routeForward = JSON.parse(tr.route);
        const routeBack = JSON.parse(tr.routeBack);

        // Build full path sequences
        const forwardSequence = [tr.fromNodeNum, ...routeForward, tr.toNodeNum];
        const backSequence = [tr.toNodeNum, ...routeBack, tr.fromNodeNum];

        // Check if segment exists in forward path
        const segmentInForward = forwardSequence.some((num, idx) => {
          if (idx === forwardSequence.length - 1) return false;
          const next = forwardSequence[idx + 1];
          return (num === nodeNum1 && next === nodeNum2) || (num === nodeNum2 && next === nodeNum1);
        });

        // Check if segment exists in return path
        const segmentInBack = backSequence.some((num, idx) => {
          if (idx === backSequence.length - 1) return false;
          const next = backSequence[idx + 1];
          return (num === nodeNum1 && next === nodeNum2) || (num === nodeNum2 && next === nodeNum1);
        });

        return segmentInForward || segmentInBack;
      } catch (error) {
        return false;
      }
    });
  }, [traceroutes, nodeNum1, nodeNum2]);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" onClick={(e) => e.stopPropagation()} style={{ maxWidth: '900px', maxHeight: '80vh' }}>
        <div className="modal-header">
          <h2>Traceroutes Using Segment</h2>
          <button className="modal-close" onClick={onClose}>×</button>
        </div>

        <div className="modal-body" style={{ padding: '1.5rem', overflowY: 'auto', maxHeight: 'calc(80vh - 100px)' }}>
          <div style={{ marginBottom: '1.5rem' }}>
            <strong>Segment:</strong> {node1Name} ↔ {node2Name}
          </div>

          {relevantTraceroutes.length === 0 && (
            <div style={{ textAlign: 'center', padding: '2rem', color: 'var(--ctp-subtext0)' }}>
              No traceroutes found using this segment.
            </div>
          )}

          {relevantTraceroutes.length > 0 && (
            <div>
              <p style={{ marginBottom: '1rem', color: 'var(--ctp-subtext0)' }}>
                Showing {relevantTraceroutes.length} traceroute{relevantTraceroutes.length !== 1 ? 's' : ''} using this segment
              </p>

              {relevantTraceroutes.map((tr, index) => {
                const age = Math.floor((Date.now() - (tr.timestamp || tr.createdAt || Date.now())) / (1000 * 60));
                const ageStr = age < 60 ? `${age}m ago` : age < 1440 ? `${Math.floor(age / 60)}h ago` : `${Math.floor(age / 1440)}d ago`;

                const fromNode = nodes.find(n => n.nodeNum === tr.fromNodeNum);
                const toNode = nodes.find(n => n.nodeNum === tr.toNodeNum);
                const fromName = fromNode?.user?.longName || fromNode?.user?.shortName || tr.fromNodeId;
                const toName = toNode?.user?.longName || toNode?.user?.shortName || tr.toNodeId;

                return (
                  <div
                    key={tr.id || index}
                    style={{
                      marginBottom: '1.5rem',
                      padding: '1rem',
                      background: 'var(--ctp-surface0)',
                      border: '1px solid var(--ctp-surface2)',
                      borderRadius: '8px',
                    }}
                  >
                    <div style={{ marginBottom: '0.75rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <div>
                        <strong>#{relevantTraceroutes.length - index}</strong>{' '}
                        <span style={{ color: 'var(--ctp-subtext0)' }}>
                          {toName} → {fromName}
                        </span>
                        <span style={{ marginLeft: '1rem', color: 'var(--ctp-subtext0)' }}>
                          {formatDateTime(new Date(tr.timestamp || tr.createdAt || Date.now()), timeFormat, dateFormat)}
                        </span>
                      </div>
                      <span style={{ fontSize: '0.9em', color: 'var(--ctp-subtext0)' }}>
                        {ageStr}
                      </span>
                    </div>

                    <div style={{ marginBottom: '0.5rem' }}>
                      <strong style={{ color: 'var(--ctp-green)' }}>→ Forward:</strong>{' '}
                      <span style={{ fontFamily: 'monospace', fontSize: '0.95em' }}>
                        {formatTracerouteRoute(
                          tr.route,
                          tr.snrTowards,
                          tr.fromNodeNum,
                          tr.toNodeNum,
                          nodes,
                          distanceUnit,
                          {
                            highlightSegment: true,
                            highlightNodeNum1: nodeNum1,
                            highlightNodeNum2: nodeNum2
                          }
                        )}
                      </span>
                    </div>

                    <div>
                      <strong style={{ color: 'var(--ctp-yellow)' }}>← Return:</strong>{' '}
                      <span style={{ fontFamily: 'monospace', fontSize: '0.95em' }}>
                        {formatTracerouteRoute(
                          tr.routeBack,
                          tr.snrBack,
                          tr.toNodeNum,
                          tr.fromNodeNum,
                          nodes,
                          distanceUnit,
                          {
                            highlightSegment: true,
                            highlightNodeNum1: nodeNum1,
                            highlightNodeNum2: nodeNum2
                          }
                        )}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default RouteSegmentTraceroutesModal;
