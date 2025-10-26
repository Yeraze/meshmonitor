import React, { useMemo } from 'react';
import { DbTraceroute } from '../services/database';
import { formatDateTime } from '../utils/datetime';
import { formatDistance } from '../utils/distance';
import { calculateDistance } from '../utils/distance';
import { DeviceInfo } from '../types/device';
import { useSettings } from '../contexts/SettingsContext';

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

  const node1 = nodes.find(n => n.nodeNum === nodeNum1);
  const node2 = nodes.find(n => n.nodeNum === nodeNum2);
  const node1Name = node1?.user?.longName || node1?.user?.shortName || `!${nodeNum1.toString(16)}`;
  const node2Name = node2?.user?.longName || node2?.user?.shortName || `!${nodeNum2.toString(16)}`;

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
        const forwardSequence = [tr.fromNodeNum, ...routeForward.slice().reverse(), tr.toNodeNum];
        const backSequence = [tr.toNodeNum, ...routeBack.slice().reverse(), tr.fromNodeNum];

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

  // Format a traceroute path with the segment highlighted
  const formatTracerouteRoute = (
    route: string | null,
    snr: string | null,
    fromNum: number,
    toNum: number,
    highlightSegment: boolean = true
  ): React.ReactNode => {
    if (!route || route === 'null') {
      return '(No response received)';
    }

    try {
      const routeArray = JSON.parse(route);
      const snrArray = JSON.parse(snr || '[]');

      const pathElements: React.ReactNode[] = [];
      let totalDistanceKm = 0;

      // Build the complete path
      const fullPath = [fromNum, ...routeArray.slice().reverse(), toNum];

      fullPath.forEach((nodeNum, idx) => {
        if (typeof nodeNum !== 'number') return;

        const node = nodes.find(n => n.nodeNum === nodeNum);
        const nodeName = node?.user?.shortName || node?.user?.longName || `!${nodeNum.toString(16)}`;

        // Get SNR for this hop
        const snrValue = snrArray[idx] !== undefined ? snrArray[idx] : null;
        const snrDisplay = snrValue !== null ? ` (${snrValue} dB)` : '';

        // Check if this segment should be highlighted
        const isSegmentStart = highlightSegment && idx < fullPath.length - 1 && (
          (nodeNum === nodeNum1 && fullPath[idx + 1] === nodeNum2) ||
          (nodeNum === nodeNum2 && fullPath[idx + 1] === nodeNum1)
        );

        if (idx > 0) {
          pathElements.push(' → ');
        }

        // Highlight the segment
        if (isSegmentStart) {
          const nextNode = nodes.find(n => n.nodeNum === fullPath[idx + 1]);
          const nextNodeName = nextNode?.user?.shortName || nextNode?.user?.longName || `!${fullPath[idx + 1].toString(16)}`;
          const nextSnrValue = snrArray[idx + 1] !== undefined ? snrArray[idx + 1] : null;
          const nextSnrDisplay = nextSnrValue !== null ? ` (${nextSnrValue} dB)` : '';

          pathElements.push(
            <span key={`highlight-${idx}`} style={{ background: 'var(--ctp-yellow)', color: 'var(--ctp-base)', padding: '0.1rem 0.3rem', borderRadius: '3px', fontWeight: 'bold' }}>
              {nodeName}{snrDisplay} → {nextNodeName}{nextSnrDisplay}
            </span>
          );

          // Skip the next node since we just rendered it
          fullPath.splice(idx + 1, 1);
          snrArray.splice(idx + 1, 1);
        } else {
          pathElements.push(
            <span key={idx}>{nodeName}{snrDisplay}</span>
          );
        }

        // Calculate distance to next node
        if (idx < fullPath.length - 1) {
          const nextNodeNum = fullPath[idx + 1];
          const nextNode = nodes.find(n => n.nodeNum === nextNodeNum);

          if (node?.position?.latitude && node?.position?.longitude &&
              nextNode?.position?.latitude && nextNode?.position?.longitude) {
            const segmentDistanceKm = calculateDistance(
              node.position.latitude,
              node.position.longitude,
              nextNode.position.latitude,
              nextNode.position.longitude
            );
            totalDistanceKm += segmentDistanceKm;
          }
        }
      });

      const distanceStr = totalDistanceKm > 0 ? ` [${formatDistance(totalDistanceKm, distanceUnit)}]` : '';

      return (
        <>
          {pathElements}
          {distanceStr}
        </>
      );
    } catch (error) {
      console.error('Error formatting traceroute:', error);
      return 'Error parsing route';
    }
  };

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
                          {fromName} → {toName}
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
                        {formatTracerouteRoute(tr.route, tr.snrTowards, tr.fromNodeNum, tr.toNodeNum)}
                      </span>
                    </div>

                    <div>
                      <strong style={{ color: 'var(--ctp-yellow)' }}>← Return:</strong>{' '}
                      <span style={{ fontFamily: 'monospace', fontSize: '0.95em' }}>
                        {formatTracerouteRoute(tr.routeBack, tr.snrBack, tr.toNodeNum, tr.fromNodeNum)}
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
