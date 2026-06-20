/**
 * DeviceNotificationToaster
 *
 * Bridges `client-notification` WebSocket events (forwarded from the connected
 * Meshtastic node's `FromRadio.ClientNotification`) to the toast UI. Rendered
 * inside ToastProvider so it can call `useToast()`; reads the shared socket from
 * WebSocketContext. Server-side policy (clientNotificationPolicy.ts) already
 * suppresses noisy/structured notifications and dedupes recurring ones, so this
 * component just maps level → severity and shows the toast.
 */

import { useEffect } from 'react';
import { useWebSocketContext } from '../contexts/WebSocketContext';
import { useToast } from './ToastContainer';

interface ClientNotificationEvent {
  level: number;
  message: string;
  replyId?: number;
  time?: number;
}

// LogRecord.Level: WARNING=30, ERROR=40, CRITICAL=50.
function toastTypeForLevel(level: number): 'error' | 'warning' | 'info' {
  if (level >= 40) return 'error';
  if (level >= 30) return 'warning';
  return 'info';
}

export default function DeviceNotificationToaster(): null {
  const { state } = useWebSocketContext();
  const { showToast } = useToast();
  const socket = state.socket;

  useEffect(() => {
    if (!socket) return;

    const handler = (data: ClientNotificationEvent) => {
      if (!data || typeof data.message !== 'string' || data.message.length === 0) return;
      showToast(data.message, toastTypeForLevel(data.level), 8000);
    };

    socket.on('client-notification', handler);
    return () => {
      socket.off('client-notification', handler);
    };
  }, [socket, showToast]);

  return null;
}
