/**
 * useMeshTxQueuedAction (#6493)
 *
 * Reads one slot (action + node + variant) of `meshTxQueueStore` and exposes
 * `run`. State lives in the store, not the component, so it survives a node
 * switch and a remount.
 */

import { useCallback, useSyncExternalStore } from 'react';
import {
  getMeshTxEntries,
  getMeshTxEntry,
  makeSlot,
  runMeshTxAction,
  subscribeMeshTxQueue,
  type MeshTxAction,
  type MeshTxEntry,
  type MeshTxPhase,
  type MeshTxResult,
  type MeshTxRunOptions,
} from './meshTxQueueStore';

export interface UseMeshTxQueuedAction {
  /** Start the action. Resolves with the final answer, or null if already busy. */
  run: (opts: Omit<MeshTxRunOptions, 'sourceId' | 'action' | 'publicKey' | 'variant'>) => Promise<MeshTxResult | null>;
  phase: MeshTxPhase;
  secondsLeft: number | null;
  /** 1-based place in the queue while `queued`. */
  position: number | null;
  result: MeshTxResult | null;
  /** The earlier queued action this one replaced. */
  replaced: MeshTxEntry['replaced'];
  /** The action that replaced a superseded one, when the server named it. */
  supersededBy: MeshTxEntry['supersededBy'];
  /** True while the button of this action must stay disabled. */
  busy: boolean;
}

export function useMeshTxQueuedAction(
  sourceId: string,
  action: MeshTxAction,
  publicKey: string,
  variant = '',
): UseMeshTxQueuedAction {
  const slot = makeSlot(action, publicKey, variant);
  // The list identity changes on any store update, which is what we need to rerender.
  useSyncExternalStore(
    subscribeMeshTxQueue,
    () => getMeshTxEntries(sourceId),
    () => getMeshTxEntries(sourceId),
  );
  const entry = getMeshTxEntry(sourceId, slot);

  const run = useCallback<UseMeshTxQueuedAction['run']>(
    (opts) => runMeshTxAction({ ...opts, sourceId, action, publicKey, variant }),
    [sourceId, action, publicKey, variant],
  );

  const phase: MeshTxPhase = entry?.phase ?? 'idle';
  return {
    run,
    phase,
    secondsLeft: entry?.secondsLeft ?? null,
    position: entry?.position ?? null,
    result: entry?.result ?? null,
    replaced: entry?.replaced ?? null,
    supersededBy: entry?.supersededBy ?? null,
    busy: phase === 'queued' || phase === 'sending' || phase === 'cooldown',
  };
}
