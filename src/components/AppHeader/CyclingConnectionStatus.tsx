import React, { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ConnectionStatus } from '../../types/ui';
import { UiIcon } from '../icons';

/** Local-node telemetry the badge can surface (all optional). */
export interface LocalNodeMetrics {
  batteryLevel?: number;
  voltage?: number;
  channelUtilization?: number;
  airUtilTx?: number;
}

interface CyclingConnectionStatusProps {
  connectionStatus: ConnectionStatus;
  /** Already-localized connection status label (e.g. "connected"). */
  connectionStatusText: string;
  webSocketConnected: boolean;
  /** Local node's device metrics, or undefined when unavailable. */
  metrics?: LocalNodeMetrics;
  onClick: () => void;
  title: string;
}

type Face = 'status' | 'battery' | 'airtime';

/** How long each face is shown before rotating to the next. */
const ROTATE_MS = 5000;

/** Firmware reports batteryLevel 101 for a mains-powered / plugged-in node. */
const PLUGGED_IN_LEVEL = 101;

const hasBattery = (m?: LocalNodeMetrics): boolean =>
  m?.batteryLevel != null || m?.voltage != null;

const hasAirtime = (m?: LocalNodeMetrics): boolean =>
  m?.channelUtilization != null || m?.airUtilTx != null;

/**
 * The header connection badge (#4917). When connected and local-node telemetry
 * is available, the middle label rotates through Connected → Battery → Airtime
 * on a timer; the colored status dot and the update-method (WebSocket/polling)
 * indicator stay fixed so the connection color is always readable. When there
 * is only one face to show (disconnected, or no telemetry — e.g. a MeshCore
 * source that doesn't report these), it renders exactly as before with no
 * rotation.
 */
export const CyclingConnectionStatus: React.FC<CyclingConnectionStatusProps> = ({
  connectionStatus,
  connectionStatusText,
  webSocketConnected,
  metrics,
  onClick,
  title,
}) => {
  const { t } = useTranslation();

  const faces = useMemo<Face[]>(() => {
    const list: Face[] = ['status'];
    if (connectionStatus === 'connected') {
      if (hasBattery(metrics)) list.push('battery');
      if (hasAirtime(metrics)) list.push('airtime');
    }
    return list;
  }, [connectionStatus, metrics]);

  const [index, setIndex] = useState(0);

  // Restart the rotation whenever the set of available faces changes, and stop
  // it entirely when there's nothing to rotate through.
  useEffect(() => {
    setIndex(0);
    if (faces.length <= 1) return;
    const id = setInterval(() => {
      setIndex(i => (i + 1) % faces.length);
    }, ROTATE_MS);
    return () => clearInterval(id);
  }, [faces.length]);

  // Guard against a transient out-of-range index if faces shrank this render.
  const face = faces[Math.min(index, faces.length - 1)];

  const renderFace = (): React.ReactNode => {
    if (face === 'battery' && metrics) {
      const plugged = metrics.batteryLevel === PLUGGED_IN_LEVEL;
      const parts: string[] = [];
      if (plugged) {
        parts.push(t('header.pluggedIn'));
      } else if (metrics.batteryLevel != null) {
        parts.push(`${metrics.batteryLevel}%`);
      }
      if (metrics.voltage != null) parts.push(`${metrics.voltage.toFixed(2)}V`);
      return (
        <span className="status-metric">
          <UiIcon name={plugged ? 'batteryCharging' : 'battery'} size={14} />
          {parts.join(' ')}
        </span>
      );
    }

    if (face === 'airtime' && metrics) {
      const parts: string[] = [];
      if (metrics.channelUtilization != null) {
        parts.push(`${t('header.chUtil')} ${metrics.channelUtilization.toFixed(1)}%`);
      }
      if (metrics.airUtilTx != null) {
        parts.push(`${t('header.airUtil')} ${metrics.airUtilTx.toFixed(1)}%`);
      }
      return (
        <span className="status-metric">
          <UiIcon name="zap" size={14} />
          {parts.join(' · ')}
        </span>
      );
    }

    return <span>{connectionStatusText}</span>;
  };

  return (
    <div className="connection-status" onClick={onClick} title={title}>
      <span
        className={`status-indicator ${
          connectionStatus === 'user-disconnected' ? 'disconnected' : connectionStatus
        }`}
      ></span>
      {/* keying on `face` restarts the fade-in each rotation */}
      <span className="connection-status-label" key={face}>
        {renderFace()}
      </span>
      <span
        className={`update-method-indicator ${webSocketConnected ? 'websocket' : 'polling'}`}
        title={webSocketConnected ? 'Real-time via WebSocket' : 'Polling every 5 seconds'}
      >
        <UiIcon name={webSocketConnected ? 'zap' : 'refresh'} size={15} />
      </span>
    </div>
  );
};

export default CyclingConnectionStatus;
