/**
 * MeshCore Analyzer Observer static-credential management (issue #4595).
 *
 * Wraps GET/PUT/DELETE /api/sources/:id/observer/credentials — the
 * username/password auth mode used by Analyzer brokers that don't verify the
 * Ed25519-signed token. Structural twin of `useObserverKey`, including the
 * envelope unwrap (those routes use `{success, data}` and neither
 * ApiService.request() nor csrfFetch unwraps `data`).
 *
 * The password is write-only: it is sent on PUT and NEVER returned by any
 * response, so nothing here ever holds it after the request resolves.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useCsrfFetch } from '../../../hooks/useCsrfFetch';
import { appBasename } from '../../../init';
import type { ObserverKeyError } from './useObserverKey';

/** Mirrors ObserverCredentialStatus from
 *  server/services/meshcoreObserverCredentialStore.ts. Re-declared here
 *  because the client/server boundary is plain JSON. */
export interface ObserverCredentialStatus {
  stored: boolean;
  /** NOT secret. The password is never present in this shape. */
  username: string | null;
  updatedAt: number | null;
  /** SESSION_SECRET changed since the password was stored — it is now
   *  undecryptable and must be re-entered. */
  keyRotated: boolean;
  /** false when SESSION_SECRET is auto-generated: storing is impossible. */
  canStore: boolean;
  reason: string | null;
}

export type ObserverCredentialAction = 'save' | 'clear';

export interface UseObserverCredentialsResult {
  status: ObserverCredentialStatus | null;
  loading: boolean;
  loadError: ObserverKeyError | null;
  busy: ObserverCredentialAction | null;
  actionError: ObserverKeyError | null;
  refresh: () => Promise<void>;
  saveCredentials: (username: string, password: string) => Promise<boolean>;
  clearCredentials: () => Promise<boolean>;
  clearActionError: () => void;
}

type EnvelopeResult =
  | { ok: true; data: ObserverCredentialStatus }
  | { ok: false; error: ObserverKeyError };

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
  return { ok: true, data: record.data as ObserverCredentialStatus };
}

type CsrfFetch = ReturnType<typeof useCsrfFetch>;

async function request(
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

export function useObserverCredentials(
  sourceId: string,
  opts?: { enabled?: boolean },
): UseObserverCredentialsResult {
  const enabled = opts?.enabled ?? true;
  const csrfFetch = useCsrfFetch();
  const base = useMemo(
    () => `${appBasename}/api/sources/${sourceId}/observer/credentials`,
    [sourceId],
  );

  const [status, setStatus] = useState<ObserverCredentialStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<ObserverKeyError | null>(null);
  const [busy, setBusy] = useState<ObserverCredentialAction | null>(null);
  const [actionError, setActionError] = useState<ObserverKeyError | null>(null);

  // Synchronous re-entry guard — see useObserverKey for why this is a ref.
  const busyRef = useRef<ObserverCredentialAction | null>(null);
  const cancelledRef = useRef(false);

  const refresh = useCallback(async (): Promise<void> => {
    setLoading(true);
    setLoadError(null);
    try {
      const result = await request(csrfFetch, base, 'GET');
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

  const saveCredentials = useCallback(
    async (username: string, password: string): Promise<boolean> => {
      if (busyRef.current) return false;
      busyRef.current = 'save';
      setBusy('save');
      setActionError(null);
      try {
        // Password sent verbatim — the server deliberately does NOT trim it
        // (whitespace can be part of the secret), so neither do we.
        const result = await request(
          csrfFetch,
          base,
          'PUT',
          JSON.stringify({ username, password }),
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
    },
    [base, csrfFetch],
  );

  const clearCredentials = useCallback(async (): Promise<boolean> => {
    if (busyRef.current) return false;
    busyRef.current = 'clear';
    setBusy('clear');
    setActionError(null);
    try {
      const result = await request(csrfFetch, base, 'DELETE');
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
    cancelledRef.current = false;
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
    saveCredentials,
    clearCredentials,
    clearActionError,
  };
}
