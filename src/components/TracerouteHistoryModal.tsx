import React, { useEffect, useState, useMemo } from 'react';
import ApiService from '../services/api';
import { DbTraceroute } from '../services/database';
import { formatDateTime } from '../utils/datetime';
import { DeviceInfo } from '../types/device';
import { useSettings } from '../contexts/SettingsContext';
import { formatTracerouteRoute } from '../utils/traceroute';

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
  const [showFailedTraceroutes, setShowFailedTraceroutes] = useState(true);
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

  // Filter traceroutes based on the checkbox state
  const filteredTraceroutes = useMemo(() => {
    if (showFailedTraceroutes) {
      return traceroutes;
    }
    // Filter out failed traceroutes
    // null or 'null' = failed (no response received)
    // [] = successful with 0 hops (direct connection)
    // [hops] = successful with intermediate hops
    return traceroutes.filter(tr => {
      // Parse route data - null or 'null' string means no response (failed)
      let routeData = null;
      let routeBackData = null;

      try {
        if (tr.route && tr.route !== 'null') {
          routeData = JSON.parse(tr.route);
        }
        if (tr.routeBack && tr.routeBack !== 'null') {
          routeBackData = JSON.parse(tr.routeBack);
        }
      } catch (e) {
        // If parsing fails, treat as null (failed)
        console.error('Error parsing traceroute data:', e);
      }

      // A traceroute is successful if at least one direction has data (even if empty array)
      // Failed traceroutes have null in both directions
      const hasForwardData = routeData !== null;
      const hasReturnData = routeBackData !== null;

      return hasForwardData || hasReturnData;
    });
  }, [traceroutes, showFailedTraceroutes]);

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

          <div style={{ marginBottom: '1rem' }}>
            <label style={{ display: 'flex', alignItems: 'center', cursor: 'pointer', userSelect: 'none' }}>
              <input
                type="checkbox"
                checked={showFailedTraceroutes}
                onChange={(e) => setShowFailedTraceroutes(e.target.checked)}
                style={{ marginRight: '0.5rem', cursor: 'pointer' }}
              />
              Show failed traceroutes
            </label>
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

          {!loading && !error && filteredTraceroutes.length === 0 && (
            <div style={{ textAlign: 'center', padding: '2rem', color: 'var(--ctp-subtext0)' }}>
              {traceroutes.length === 0 ? 'No traceroute history found for this node pair.' : 'No traceroutes match the current filter.'}
            </div>
          )}

          {!loading && !error && filteredTraceroutes.length > 0 && (
            <div>
              <p style={{ marginBottom: '1rem', color: 'var(--ctp-subtext0)' }}>
                Showing {filteredTraceroutes.length} traceroute{filteredTraceroutes.length !== 1 ? 's' : ''}
                {!showFailedTraceroutes && traceroutes.length > filteredTraceroutes.length && (
                  <span> ({traceroutes.length - filteredTraceroutes.length} failed hidden)</span>
                )}
              </p>

              {filteredTraceroutes.map((tr: TracerouteWithHops, index: number) => {
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
                        <strong>#{filteredTraceroutes.length - index}</strong>
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
                        {formatTracerouteRoute(tr.route, tr.snrTowards, tr.fromNodeNum, tr.toNodeNum, nodes, distanceUnit)}
                      </span>
                    </div>

                    <div>
                      <strong style={{ color: 'var(--ctp-yellow)' }}>← Return:</strong>{' '}
                      <span style={{ fontFamily: 'monospace', fontSize: '0.95em' }}>
                        {formatTracerouteRoute(tr.routeBack, tr.snrBack, tr.toNodeNum, tr.fromNodeNum, nodes, distanceUnit)}
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
