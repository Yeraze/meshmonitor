/**
 * Saved MQTT broker presets (#5794): the admin-curated list behind the
 * "My saved presets" chips in the three Meshtastic MQTT forms.
 *
 * A small module-level store, not TanStack Query: the selector sits inside
 * forms whose tests mock the query client, and the list is tiny. Every form
 * shares one copy; it loads on first use and reloads after each change made
 * here. A caller who may not read presets (no login, or no grant to edit a
 * source or device config) gets an empty list and `canManage: false`, never
 * an error: the chips simply do not appear.
 *
 * The routes answer `ok(res, …)`; `ApiService` returns the raw body, so
 * `data` is unwrapped here.
 */
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import apiService from '../services/api';

export interface SavedBrokerPreset {
  id: number;
  name: string;
  host: string;
  port: number;
  tls: boolean;
  rootTopic: string | null;
  hasUsername: boolean;
  hasPassword: boolean;
  /** Present only for admins. */
  username?: string | null;
  /** Present only for admins. */
  password?: string | null;
}

export interface SavedBrokerPresetList {
  canManage: boolean;
  presets: SavedBrokerPreset[];
}

export interface SavedBrokerPresetBody {
  name: string;
  host: string;
  port: number;
  tls: boolean;
  username: string | null;
  /** Left out on an edit: keep the stored password. */
  password?: string | null;
  rootTopic: string | null;
}

const EMPTY: SavedBrokerPresetList = { canManage: false, presets: [] };
const BASE = '/api/mqtt-broker-presets';
/** A reload older than this is repeated when another form mounts. */
const STALE_MS = 30_000;

let snapshot: SavedBrokerPresetList = EMPTY;
let loadedAt = 0;
let inflight: Promise<void> | null = null;
const listeners = new Set<() => void>();

function emit(next: SavedBrokerPresetList): void {
  snapshot = next;
  for (const l of listeners) l();
}

/** Fetch the list again. Never throws. */
export function reloadBrokerPresets(): Promise<void> {
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const body = await apiService.get<{ data?: SavedBrokerPresetList }>(BASE);
      const data = body?.data;
      emit(data && Array.isArray(data.presets) ? { canManage: data.canManage === true, presets: data.presets } : EMPTY);
    } catch {
      emit(EMPTY);
    } finally {
      loadedAt = Date.now();
      inflight = null;
    }
  })();
  return inflight;
}

/** Tests only: forget the shared list. */
export function resetBrokerPresetsForTests(): void {
  snapshot = EMPTY;
  loadedAt = 0;
  inflight = null;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useMqttBrokerPresets(): SavedBrokerPresetList {
  const list = useSyncExternalStore(subscribe, () => snapshot, () => EMPTY);
  useEffect(() => {
    if (Date.now() - loadedAt > STALE_MS) void reloadBrokerPresets();
  }, []);
  return list;
}

function unwrap<T>(body: { data?: T } | undefined): T {
  return body?.data as T;
}

/** One admin change at a time, with its pending flag; the list reloads after it. */
function useBrokerPresetAction<A, R>(run: (arg: A) => Promise<R>): {
  mutateAsync: (arg: A) => Promise<R>;
  isPending: boolean;
} {
  const [isPending, setPending] = useState(false);
  const mutateAsync = useCallback(
    async (arg: A) => {
      setPending(true);
      try {
        const result = await run(arg);
        await reloadBrokerPresets();
        return result;
      } finally {
        setPending(false);
      }
    },
    [run],
  );
  return { mutateAsync, isPending };
}

const createPreset = async (body: SavedBrokerPresetBody) =>
  unwrap<SavedBrokerPreset>(await apiService.post<{ data?: SavedBrokerPreset }>(BASE, body));
const updatePreset = async ({ id, body }: { id: number; body: SavedBrokerPresetBody }) =>
  unwrap<SavedBrokerPreset>(await apiService.put<{ data?: SavedBrokerPreset }>(`${BASE}/${id}`, body));
const deletePreset = async (id: number) => {
  await apiService.delete(`${BASE}/${id}`);
};

export function useCreateBrokerPreset() {
  return useBrokerPresetAction(createPreset);
}

export function useUpdateBrokerPreset() {
  return useBrokerPresetAction(updatePreset);
}

export function useDeleteBrokerPreset() {
  return useBrokerPresetAction(deletePreset);
}
