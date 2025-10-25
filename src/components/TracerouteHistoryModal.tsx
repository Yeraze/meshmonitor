import React, { useEffect, useState } from 'react';
import ApiService from '../services/api';
import { DbTraceroute } from '../services/database';
import { formatDateTime } from '../utils/datetime';
import { formatDistance } from '../utils/distance';
import { calculateDistance } from '../utils/distance';
import { DeviceInfo } from '../types/device';
import { useSettings } from '../contexts/SettingsContext';

interface TracerouteHistoryModalProps {
  fromNodeNum: number;
  toNodeNum: number;
  fromNodeName: string;
  toNodeName: string;
  nodes: DeviceInfo[];
  onClose: () => void;
}

interface TracerouteWithHops extends DbTraceroute {
  hopCount: number;
}

const TracerouteHistoryModal: React.FC<TracerouteHistoryModalProps> = ({
  fromNodeNum,
  toNodeNum,
  fromNodeName,
  toNodeName,
  nodes,
  onClose,
}) => {
  const [traceroutes, setTraceroutes] = useState<TracerouteWithHops[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const { timeFormat, dateFormat, distanceUnit } = useSettings();

  useEffect(() => {
    const fetchHistory = async () => {
      try {
        setLoading(true);
        const data = await ApiService.getTracerouteHistory(fromNodeNum, toNodeNum);
        setTraceroutes(data);
        setError(null);
      } catch (err) {
        console.error('Failed to fetch traceroute history:', err);
        setError('Failed to load traceroute history');
      } finally {
        setLoading(false);
      }
    };

    fetchHistory();
  }, [fromNodeNum, toNodeNum]);

  const formatTracerouteRoute = (route: string | null, snr: string | null, fromNum?: number, toNum?: number) => {
    // Handle pending/null routes
    if (!route || route === 'null') {
      return '(No response received)';
    }

    try {
      const routeArray = JSON.parse(route || '[]');
      const snrArray = JSON.parse(snr || '[]');

      const pathNodes: string[] = [];
      const nodeNums: number[] = [];
      let totalDistanceKm = 0;

      // Build the complete path: source -> hops -> destination
      const fullPath = fromNum ? [fromNum, ...routeArray.slice().reverse(), toNum] : [...routeArray.slice().reverse()];

      fullPath.forEach((nodeNum, idx) => {
        if (typeof nodeNum !== 'number') return;

        const node = nodes.find(n => n.nodeNum === nodeNum);
        const nodeName = node?.user?.shortName || node?.user?.longName || `!${nodeNum.toString(16)}`;

        // Get SNR for this hop (SNR array corresponds to hops between nodes)
        const snrValue = snrArray[idx] !== undefined ? snrArray[idx] : null;
        const snrDisplay = snrValue !== null ? ` (${snrValue} dB)` : '';

        pathNodes.push(`${nodeName}${snrDisplay}`);
        nodeNums.push(nodeNum);

        // Calculate distance to next node if positions are available
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

      const pathStr = pathNodes.join(' → ');
      const distanceStr = totalDistanceKm > 0 ? ` [${formatDistance(totalDistanceKm, distanceUnit)}]` : '';

      return `${pathStr}${distanceStr}`;
    } catch (error) {
      console.error('Error formatting traceroute:', error);
      return 'Error parsing route';
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" onClick={(e) => e.stopPropagation()} style={{ maxWidth: '900px', maxHeight: '80vh' }}>
        <div className="modal-header">
          <h2>Traceroute History</h2>
          <button className="modal-close" onClick={onClose}>×</button>
        </div>

        <div className="modal-body" style={{ padding: '1.5rem', overflowY: 'auto', maxHeight: 'calc(80vh - 100px)' }}>
          <div style={{ marginBottom: '1.5rem' }}>
            <strong>From:</strong> {fromNodeName} → <strong>To:</strong> {toNodeName}
          </div>

          {loading && (
            <div style={{ textAlign: 'center', padding: '2rem' }}>
              <div className="spinner"></div>
              <p>Loading traceroute history...</p>
            </div>
          )}

          {error && (
            <div style={{ padding: '1rem', background: 'var(--ctp-red)', color: 'var(--ctp-base)', borderRadius: '4px' }}>
              {error}
            </div>
          )}

          {!loading && !error && traceroutes.length === 0 && (
            <div style={{ textAlign: 'center', padding: '2rem', color: 'var(--ctp-subtext0)' }}>
              No traceroute history found for this node pair.
            </div>
          )}

          {!loading && !error && traceroutes.length > 0 && (
            <div>
              <p style={{ marginBottom: '1rem', color: 'var(--ctp-subtext0)' }}>
                Showing {traceroutes.length} traceroute{traceroutes.length !== 1 ? 's' : ''}
              </p>

              {traceroutes.map((tr, index) => {
                const age = Math.floor((Date.now() - tr.timestamp) / (1000 * 60));
                const ageStr = age < 60 ? `${age}m ago` : age < 1440 ? `${Math.floor(age / 60)}h ago` : `${Math.floor(age / 1440)}d ago`;

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
                        <strong>#{traceroutes.length - index}</strong>
                        <span style={{ marginLeft: '1rem', color: 'var(--ctp-subtext0)' }}>
                          {formatDateTime(new Date(tr.timestamp), timeFormat, dateFormat)}
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

export default TracerouteHistoryModal;
