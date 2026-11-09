/**
 * Debounced MQTT broker-link alerts (#6307 S7).
 *
 * One implementation for every source that holds an upstream broker link
 * (`meshcore_mqtt` ingest and the Meshtastic `mqtt_bridge` subscriber). The
 * embedded `mqtt_broker` has no upstream link, so it never attaches one.
 *
 * Rules:
 *  - `connect` goes to `notifyNodeConnected(..., 'broker')`. That service
 *    already stays silent on the first connect and sends "restored" only after
 *    a loss it notified.
 *  - `close` / `offline` start ONE grace timer. A `connect` before it fires
 *    cancels it silently, so a flapping link (backoff runs 1 s to 60 s) never
 *    alerts. When it fires, `notifyNodeDisconnected(..., 'broker')` runs.
 *  - `auth-stopped` / `eviction-stopped` alert at once: no retry is coming.
 *  - `dispose()` clears the timer and detaches, silently. A settings save
 *    builds a new manager, so it must never read as an outage.
 *
 * Payloads carry the source name only: the broker URL is redacted per viewer.
 * Nothing here sends or retries on the broker; it only decides whether to tell
 * people.
 */
import { serverEventNotificationService } from './serverEventNotificationService.js';
import { logger } from '../../utils/logger.js';

/** Longer than the 60 s maximum reconnect backoff, so one full retry cycle is silent. */
export const BROKER_LINK_GRACE_MS = 120_000;

/** The slice of `MqttBrokerClient` (an EventEmitter) this needs. */
export interface BrokerLinkEmitter {
  on(event: string, listener: (...args: any[]) => void): unknown;
  off(event: string, listener: (...args: any[]) => void): unknown;
}

export interface BrokerLinkNotifierOptions {
  sourceId: string;
  sourceName: string;
  graceMs?: number;
}

export interface BrokerLinkNotifier {
  dispose(): void;
}

export function attachBrokerLinkNotifier(
  client: BrokerLinkEmitter,
  { sourceId, sourceName, graceMs = BROKER_LINK_GRACE_MS }: BrokerLinkNotifierOptions,
): BrokerLinkNotifier {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  const clearTimer = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const lost = () => {
    if (disposed) return;
    void serverEventNotificationService
      .notifyNodeDisconnected(sourceId, sourceName, 'broker')
      .catch((err) => logger.error('[BrokerLink] disconnect alert failed:', err));
  };

  const onConnect = () => {
    if (disposed) return;
    clearTimer();
    void serverEventNotificationService
      .notifyNodeConnected(sourceId, sourceName, 'broker')
      .catch((err) => logger.error('[BrokerLink] reconnect alert failed:', err));
  };

  const onDown = () => {
    if (disposed || timer) return; // one timer per outage
    timer = setTimeout(() => {
      timer = null;
      lost();
    }, graceMs);
    timer.unref?.();
  };

  const onStopped = () => {
    if (disposed) return;
    clearTimer();
    lost();
  };

  client.on('connect', onConnect);
  client.on('close', onDown);
  client.on('offline', onDown);
  client.on('auth-stopped', onStopped);
  client.on('eviction-stopped', onStopped);

  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      clearTimer();
      client.off('connect', onConnect);
      client.off('close', onDown);
      client.off('offline', onDown);
      client.off('auth-stopped', onStopped);
      client.off('eviction-stopped', onStopped);
    },
  };
}
