/**
 * Add or remove one telemetry favorite on one source (#5896).
 *
 * Favorites stay per source: a JSON `[{ nodeId, telemetryType }]` list under
 * that source's `telemetryFavorites` setting, shared by every user of the
 * source. The cross-source dashboard shows the union of those lists and
 * writes each change to the list of the source it belongs to, which needs
 * `settings:write` there. Read-modify-write, like `useToggleFavorite`.
 */
import apiService from './api.js';

interface FavoriteEntry {
  nodeId: string;
  telemetryType: string;
}

function parseFavorites(raw: unknown): FavoriteEntry[] {
  if (typeof raw !== 'string' || raw === '') return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (f): f is FavoriteEntry =>
        !!f && typeof f === 'object'
        && typeof (f as FavoriteEntry).nodeId === 'string'
        && typeof (f as FavoriteEntry).telemetryType === 'string',
    );
  } catch {
    return [];
  }
}

export async function setTelemetryFavorite(
  sourceId: string,
  nodeId: string,
  telemetryType: string,
  favorite: boolean,
): Promise<void> {
  const query = `?sourceId=${encodeURIComponent(sourceId)}`;
  const settings = await apiService.get<Record<string, unknown>>(`/api/settings${query}`);
  const list = parseFavorites(settings?.telemetryFavorites)
    .filter((f) => !(f.nodeId === nodeId && f.telemetryType === telemetryType));
  if (favorite) list.push({ nodeId, telemetryType });
  await apiService.post(`/api/settings${query}`, { telemetryFavorites: JSON.stringify(list) });
}
