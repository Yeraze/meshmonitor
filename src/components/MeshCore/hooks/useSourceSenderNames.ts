/** Load the sender names usable on a source, for automation editors (#6341 P4). */
import { useEffect, useState } from 'react';
import { useCsrfFetch } from '../../../hooks/useCsrfFetch';

/** Fetch the names usable on a source. Empty on any failure or when off. */
export function useSourceSenderNames(baseUrl: string, sourceId: string): string[] {
  const csrfFetch = useCsrfFetch();
  const [names, setNames] = useState<string[]>([]);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await csrfFetch(`${baseUrl}/api/sources/${sourceId}/meshcore/sender-names`);
        if (!res.ok) return;
        const body = await res.json();
        const d = body?.data;
        if (cancelled || !d || d.enabled !== true || d.firmwareSupported !== true || !Array.isArray(d.allowedNames)) return;
        setNames(d.allowedNames.filter((n: unknown): n is string => typeof n === 'string'));
      } catch {
        // No grant or network failure: leave the picker hidden.
      }
    })();
    return () => { cancelled = true; };
  }, [baseUrl, sourceId, csrfFetch]);
  return names;
}
