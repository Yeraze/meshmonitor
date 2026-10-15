/**
 * Per-source "Show MQTT/Bridge Messages" persistence (#5824).
 *
 * The server copy (`user_map_preferences.show_mqtt_messages_by_source`) is the
 * source of truth for signed-in users, so the value follows them to a fresh
 * browser. localStorage keeps a per-source cache for the first paint and for
 * anonymous users, who cannot save to the server.
 *
 * The old single key `showMqttMessages` is still read as a fallback, so nobody
 * loses their choice on upgrade; it is never written again.
 */
import api from '../services/api';

const LEGACY_KEY = 'showMqttMessages';

export function localKey(sourceId: string): string {
  return `showMqttMessages:${sourceId}`;
}

function safeGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** Initial value: this source's cached value, then the legacy global key, then hidden. */
export function readLocalShowMqttMessages(sourceId: string | undefined): boolean {
  const perSource = sourceId ? safeGet(localKey(sourceId)) : null;
  const saved = perSource ?? safeGet(LEGACY_KEY);
  return saved === 'true';
}

export function writeLocalShowMqttMessages(sourceId: string | undefined, value: boolean): void {
  if (!sourceId) return;
  try {
    localStorage.setItem(localKey(sourceId), String(value));
  } catch {
    // Storage blocked (private mode); the server copy still applies.
  }
}

/** The server value for this source, or undefined when none is stored or the caller is anonymous. */
export async function fetchServerShowMqttMessages(sourceId: string): Promise<boolean | undefined> {
  const res = await api.get<{ preferences: { showMqttMessagesBySource?: Record<string, boolean> } | null }>(
    '/api/user/map-preferences',
  );
  const value = res?.preferences?.showMqttMessagesBySource?.[sourceId];
  return typeof value === 'boolean' ? value : undefined;
}

export async function saveServerShowMqttMessages(sourceId: string, value: boolean): Promise<void> {
  await api.post('/api/user/map-preferences', { showMqttMessages: value, sourceId });
}
