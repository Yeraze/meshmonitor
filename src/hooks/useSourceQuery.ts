import { useSource } from '../contexts/SourceContext';

/**
 * Returns a query-string fragment (`?sourceId=<id>` or empty string) for the
 * currently selected Source. Use to scope `/api/settings` GET/POST calls so
 * each Source has independent automation/dashboard configuration.
 *
 * Example:
 *   const sourceQuery = useSourceQuery();
 *   await fetch(`${baseUrl}/api/settings${sourceQuery}`);
 */
export function useSourceQuery(): string {
  const { sourceId } = useSource();
  return sourceId ? `?sourceId=${encodeURIComponent(sourceId)}` : '';
}
