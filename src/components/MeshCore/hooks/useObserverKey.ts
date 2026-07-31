/**
 * MeshCore Analyzer Observer signing-key management (#4457 Phase 3).
 *
 * Wraps GET/POST/PUT/DELETE /api/sources/:id/observer/key. Those four routes
 * use the {success, data} response envelope (Phase 1 spec §7), and neither
 * ApiService.request() nor csrfFetch unwraps `data` — THIS HOOK DOES. Reading
 * the body directly yields an object with no `stored` field, which renders as
 * "no key stored" forever.
 *
 * Returns RAW server values (e.g. `updatedAt` in milliseconds, no seconds/ms
 * conversion here) — any unit conversion belongs in the consuming component,
 * not this hook.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useCsrfFetch } from '../../../hooks/useCsrfFetch';
import { appBasename } from '../../../init';

/** Mirrors ObserverKeyStatus from server/services/meshcoreObserverKeyStore.ts.
 *  Deliberately re-declared here (client/server boundary is plain JSON). */
export interface ObserverKeyStatus {
  stored: boolean;
  publicKey: string | null;
  origin: 'device' | 'manual' | null;
  updatedAt: number | null;
  /** SESSION_SECRET changed since the key was stored — the key is now
   *  undecryptable. `publicKey` survives (clear column) and stays displayable. */
  keyRotated: boolean;
  /** false when SESSION_SECRET is auto-generated: storing a key is impossible. */
  canStore: boolean;
  /** Human-readable reason accompanying canStore:false. */
  reason: string | null;
}

export interface ObserverKeyError {
  /** Server machine code, e.g. 'SOURCE_NOT_CONNECTED'. null on a transport failure. */
  code: string | null;
  /** Server-supplied message; a last-resort fallback for unmapped codes. */
  message: string | null;
}

export type ObserverKeyAction = 'import' | 'manual' | 'clear';

export interface UseObserverKeyResult {
  status: ObserverKeyStatus | null;
  loading: boolean;
  loadError: ObserverKeyError | null;
  /** Which mutation is in flight, or null. Drives per-button spinners. */
  busy: ObserverKeyAction | null;
  /** Result of the last mutation attempt; cleared when a new one starts. */
  actionError: ObserverKeyError | null;
  refresh: () => Promise<void>;
  importFromDevice: () => Promise<boolean>;
  setManualKey: (privateKeyHex: string) => Promise<boolean>;
  clearKey: () => Promise<boolean>;
  clearActionError: () => void;
}

type EnvelopeResult =
  | { ok: true; data: ObserverKeyStatus }
  | { ok: false; error: ObserverKeyError };

/**
 * Unwraps the `{success, data}` envelope (D-5) and maps a non-2xx response
 * onto `ObserverKeyError`. Module-level and closes over nothing React-y, so
 * it carries no hook dependency-array weight.
 */
async function readEnvelope(res: Response): Promise<EnvelopeResult> {
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    /* empty/non-JSON body */
  }
  const record = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  if (!res.ok) {
    return {
      ok: false,
      error: {
        code: typeof record.code === 'string' ? record.code : null,
        message: typeof record.error === 'string' ? record.error : null,
      },
    };
  }
  return { ok: true, data: record.data as ObserverKeyStatus };
}

type CsrfFetch = ReturnType<typeof useCsrfFetch>;

/** Issues one request and reduces it to an `EnvelopeResult`, never throwing —
 *  a network/transport failure is reported as a `code: null` error so callers
 *  never need a try/catch of their own. */
async function requestObserverKey(
  csrfFetch: CsrfFetch,
  url: string,
  method: string,
  body?: string,
): Promise<EnvelopeResult> {
  try {
    const res = await csrfFetch(
      url,
      body !== undefined
        ? { method, headers: { 'Content-Type': 'application/json' }, body }
        : { method },
    );
    return await readEnvelope(res);
  } catch {
    return { ok: false, error: { code: null, message: null } };
  }
}

export function useObserverKey(
  sourceId: string,
  opts?: { enabled?: boolean },
): UseObserverKeyResult {
  const enabled = opts?.enabled ?? true;
  const csrfFetch = useCsrfFetch();
  const base = useMemo(() => `${appBasename}/api/sources/${sourceId}/observer/key`, [sourceId]);

  const [status, setStatus] = useState<ObserverKeyStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<ObserverKeyError | null>(null);
  const [busy, setBusy] = useState<ObserverKeyAction | null>(null);
  const [actionError, setActionError] = useState<ObserverKeyError | null>(null);

  // Guards re-entry synchronously (checked/set before the first await), so
  // rapid double-clicks cannot both pass the check — a ref, not the `busy`
  // state value, since state updates are not visible until the next render.
  const busyRef = useRef<ObserverKeyAction | null>(null);
  // Set on unmount; checked before every setState that follows an `await` so
  // an in-flight request never updates state on an unmounted hook instance.
  const cancelledRef = useRef(false);

  const refresh = useCallback(async (): Promise<void> => {
    setLoading(true);
    setLoadError(null);
    try {
      const result = await requestObserverKey(csrfFetch, base, 'GET');
      if (cancelledRef.current) return;
      if (result.ok) {
        setStatus(result.data);
      } else {
        setLoadError(result.error);
      }
    } finally {
      if (!cancelledRef.current) setLoading(false);
    }
  }, [base, csrfFetch]);

  const importFromDevice = useCallback(async (): Promise<boolean> => {
    if (busyRef.current) return false;
    busyRef.current = 'import';
    setBusy('import');
    setActionError(null);
    try {
      const result = await requestObserverKey(csrfFetch, `${base}/import`, 'POST');
      if (cancelledRef.current) return false;
      if (result.ok) {
        setStatus(result.data);
        return true;
      }
      setActionError(result.error);
      return false;
    } finally {
      busyRef.current = null;
      if (!cancelledRef.current) setBusy(null);
    }
  }, [base, csrfFetch]);

  const setManualKey = useCallback(async (privateKeyHex: string): Promise<boolean> => {
    if (busyRef.current) return false;
    busyRef.current = 'manual';
    setBusy('manual');
    setActionError(null);
    try {
      // Sent verbatim — no trim, no `0x` strip. The server does both
      // (sourceObserverRoutes.ts), so this stays the single source of truth.
      const result = await requestObserverKey(
        csrfFetch,
        base,
        'PUT',
        JSON.stringify({ privateKey: privateKeyHex }),
      );
      if (cancelledRef.current) return false;
      if (result.ok) {
        setStatus(result.data);
        return true;
      }
      setActionError(result.error);
      return false;
    } finally {
      busyRef.current = null;
      if (!cancelledRef.current) setBusy(null);
    }
  }, [base, csrfFetch]);

  const clearKey = useCallback(async (): Promise<boolean> => {
    if (busyRef.current) return false;
    busyRef.current = 'clear';
    setBusy('clear');
    setActionError(null);
    try {
      // No confirmation here — confirming a destructive action is the
      // component's job (window.confirm), matching MeshCoreDeviceManagement.
      const result = await requestObserverKey(csrfFetch, base, 'DELETE');
      if (cancelledRef.current) return false;
      if (result.ok) {
        setStatus(result.data);
        return true;
      }
      setActionError(result.error);
      return false;
    } finally {
      busyRef.current = null;
      if (!cancelledRef.current) setBusy(null);
    }
  }, [base, csrfFetch]);

  const clearActionError = useCallback(() => setActionError(null), []);

  useEffect(() => {
    if (enabled) {
      void refresh();
    }
    return () => {
      cancelledRef.current = true;
    };
  }, [refresh, enabled]);

  return {
    status,
    loading,
    loadError,
    busy,
    actionError,
    refresh,
    importFromDevice,
    setManualKey,
    clearKey,
    clearActionError,
  };
}
