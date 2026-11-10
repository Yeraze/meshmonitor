/**
 * Localise the server's INVALID_MQTT_ROOT refusal (#6338). The server sends
 * `{ code: 'INVALID_MQTT_ROOT', reason, error }`, which `ApiService` throws as
 * an `ApiError` carrying `code` and `body`; the reason picks the
 * `mqtt_root_finder.validation.<reason>` string, and the English `error` is
 * the fallback.
 *
 * Read by shape rather than `instanceof ApiError`, so a test that mocks the
 * api module without the class still gets the plain message.
 */
import type { TFunction } from 'i18next';

export const INVALID_MQTT_ROOT = 'INVALID_MQTT_ROOT';

/** The localised message for a refused root, or null when `error` is something else. */
export function mqttRootErrorMessage(error: unknown, t: TFunction): string | null {
  if (!(error instanceof Error)) return null;
  const { code, body } = error as Error & { code?: unknown; body?: unknown };
  if (code !== INVALID_MQTT_ROOT) return null;
  const reason = (body as { reason?: unknown } | undefined)?.reason;
  if (typeof reason !== 'string' || !reason) return error.message;
  return t(`mqtt_root_finder.validation.${reason}`, { defaultValue: error.message });
}
