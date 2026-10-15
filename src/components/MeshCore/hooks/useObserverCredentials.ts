/**
 * MeshCore Analyzer Observer static-credential management (issue #4595,
 * per-broker since #5825).
 *
 * Wraps GET/PUT/DELETE /api/sources/:id/observer/credentials — the
 * username/password auth mode used by Analyzer brokers that don't verify the
 * Ed25519-signed token. Structural twin of `useObserverKey`, including the
 * envelope unwrap (those routes use `{success, data}` and neither
 * ApiService.request() nor csrfFetch unwraps `data`).
 *
 * Every set and clear names a broker by its `brokerKey` (#5825). The server
 * still accepts a PUT with no key (it stores a shared "legacy" credential that
 * only a broker matching the old `brokerUrl` reads), but nothing here sends
 * one: that credential was invisible to most brokers, and the old key-less
 * DELETE wiped every broker's credential at once. The only key-less request
 * left is `clearLegacyCredential`, which sends `?legacy=1` and removes the old
 * shared credential alone.
 *
 * The password is write-only: it is sent on PUT and NEVER returned by any
 * response, so nothing here ever holds it after the request resolves.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useCsrfFetch } from '../../../hooks/useCsrfFetch';
import { appBasename } from '../../../init';
import type { ObserverKeyError } from './useObserverKey';

/** Mirrors the GET /observer/credentials body built in
 *  server/routes/sourceObserverRoutes.ts. Re-declared here because the
 *  client/server boundary is plain JSON. */
export interface ObserverCredentialStatus {
  /** A credential row exists at all (any broker, or the legacy entry). */
  stored: boolean;
  /** NOT secret. The password is never present in this shape. */
  username: string | null;
  updatedAt: number | null;
  /** SESSION_SECRET changed since the row was stored — every password in it
   *  is now undecryptable and must be re-entered. */
  keyRotated: boolean;
  /** false when SESSION_SECRET is auto-generated: storing is impossible. */
  canStore: boolean;
  reason: string | null;
  /** One entry per broker with a stored credential. */
  brokers: Array<{ brokerKey: string; username: string | null }>;
  /** The pre-#5014 shared credential, when one is still stored. Absent on a
   *  server older than #5825. */
  legacy?: { username: string | null } | null;
}

export type ObserverCredentialAction = 'save' | 'clear' | 'clearLegacy';

export interface ObserverCredentialBusy {
  action: ObserverCredentialAction;
  /** null for `clearLegacy`. */
  brokerKey: string | null;
}

export interface ObserverCredentialActionError {
  error: ObserverKeyError;
  /** The broker the failed action targeted; null for `clearLegacy`. */
  brokerKey: string | null;
}

export interface UseObserverCredentialsResult {
  status: ObserverCredentialStatus | null;
  loading: boolean;
  loadError: ObserverKeyError | null;
  busy: ObserverCredentialBusy | null;
  actionError: ObserverCredentialActionError | null;
  refresh: () => Promise<void>;
  saveCredentials: (brokerKey: string, username: string, password: string) => Promise<boolean>;
  clearCredentials: (brokerKey: string) => Promise<boolean>;
  clearLegacyCredential: () => Promise<boolean>;
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
  const data = (record.data ?? {}) as ObserverCredentialStatus;
  return { ok: true, data: { ...data, brokers: Array.isArray(data.brokers) ? data.brokers : [] } };
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
  const [busy, setBusy] = useState<ObserverCredentialBusy | null>(null);
  const [actionError, setActionError] = useState<ObserverCredentialActionError | null>(null);

  // Synchronous re-entry guard — see useObserverKey for why this is a ref.
  // One request at a time across ALL brokers: the store is read-modify-write
  // over a single row, so two concurrent writes can lose one (see
  // meshcoreObserverCredentialStore.storeForBroker).
  const busyRef = useRef<ObserverCredentialBusy | null>(null);
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

  const run = useCallback(
    async (next: ObserverCredentialBusy, url: string, method: string, body?: string): Promise<boolean> => {
      if (busyRef.current) return false;
      busyRef.current = next;
      setBusy(next);
      setActionError(null);
      try {
        const result = await request(csrfFetch, url, method, body);
        if (cancelledRef.current) return false;
        if (result.ok) {
          setStatus(result.data);
          return true;
        }
        setActionError({ error: result.error, brokerKey: next.brokerKey });
        return false;
      } finally {
        busyRef.current = null;
        if (!cancelledRef.current) setBusy(null);
      }
    },
    [csrfFetch],
  );

  const saveCredentials = useCallback(
    (brokerKey: string, username: string, password: string): Promise<boolean> =>
      // Password sent verbatim — the server deliberately does NOT trim it
      // (whitespace can be part of the secret), so neither do we.
      run({ action: 'save', brokerKey }, base, 'PUT', JSON.stringify({ brokerKey, username, password })),
    [base, run],
  );

  const clearCredentials = useCallback(
    (brokerKey: string): Promise<boolean> =>
      run({ action: 'clear', brokerKey }, `${base}?brokerKey=${encodeURIComponent(brokerKey)}`, 'DELETE'),
    [base, run],
  );

  const clearLegacyCredential = useCallback(
    (): Promise<boolean> => run({ action: 'clearLegacy', brokerKey: null }, `${base}?legacy=1`, 'DELETE'),
    [base, run],
  );

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
    clearLegacyCredential,
    clearActionError,
  };
}
