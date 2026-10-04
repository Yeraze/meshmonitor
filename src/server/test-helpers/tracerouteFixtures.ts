/**
 * Traceroute rows for tests, written through the REAL write path in both
 * stored orientations (see `src/utils/tracerouteOrientation.ts`).
 *
 * A hand-made row proves only that a reader agrees with the fixture's author.
 * These helpers make the same two `DatabaseService` calls the app makes
 * (`sendTraceroute` -> `recordTracerouteRequestAsync`; `processTracerouteMessage`
 * -> `insertTracerouteAsync` with the reply packet), so a reader is tested
 * against what is really on disk.
 */
import databaseService from '../../services/database.js';
import { localNodeNumSettingKey } from '../utils/localNodeNums.js';

export const nodeIdFor = (num: number): string => `!${num.toString(16).padStart(8, '0')}`;

export interface TracerouteRunSpec {
  sourceId: string;
  /** The node that asked. */
  requester: number;
  /** The node that answered. */
  responder: number;
  /** Hops from requester toward responder. */
  route?: number[];
  /** Hops from responder back to requester. */
  routeBack?: number[];
  /** Raw firmware SNR (dB x 4), one per forward hop arrival. */
  snrTowards?: number[];
  snrBack?: number[];
  packetId?: number | null;
  transportMechanism?: number | null;
  timestamp?: number;
  channel?: number | null;
}

export type StoredForm = 'sent' | 'replyOnly';
export const STORED_FORMS: StoredForm[] = ['sent', 'replyOnly'];

/** Tell the database which radio a source owns, as its manager does on connect. */
export async function setSourceLocalNode(sourceId: string, nodeNum: number): Promise<void> {
  await databaseService.settings.setSetting(localNodeNumSettingKey(sourceId), String(nodeNum));
}

export async function clearSourceLocalNode(sourceId: string): Promise<void> {
  await databaseService.settings.deleteSetting(localNodeNumSettingKey(sourceId)).catch(() => {});
}

/** The reply packet as `processTracerouteMessage` hands it over: `from` answered. */
function replyRecord(spec: TracerouteRunSpec) {
  const ts = spec.timestamp ?? Date.now();
  return {
    fromNodeNum: spec.responder,
    toNodeNum: spec.requester,
    fromNodeId: nodeIdFor(spec.responder),
    toNodeId: nodeIdFor(spec.requester),
    route: JSON.stringify(spec.route ?? []),
    routeBack: JSON.stringify(spec.routeBack ?? []),
    snrTowards: JSON.stringify(spec.snrTowards ?? []),
    snrBack: JSON.stringify(spec.snrBack ?? []),
    routePositions: '{}',
    channel: spec.channel ?? 0,
    packetId: spec.packetId ?? null,
    transportMechanism: spec.transportMechanism ?? null,
    timestamp: ts,
    createdAt: ts,
  };
}

/**
 * A run sent from MeshMonitor: a pending row, then the reply fills it in.
 * Stored `{ from: requester, to: responder }`. The source's local node must
 * be the requester (see {@link setSourceLocalNode}), as it is in the app.
 */
export async function writeSentRun(spec: TracerouteRunSpec): Promise<void> {
  await databaseService.recordTracerouteRequestAsync(spec.requester, spec.responder, spec.sourceId);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- DbTraceroute's two declarations disagree on nullability
  await databaseService.insertTracerouteAsync(replyRecord(spec) as any, spec.sourceId);
}

/**
 * A reply with no pending row (sent from a phone app, heard over MQTT, or
 * the pending row timed out). Stored `{ from: responder, to: requester }`.
 */
export async function writeReplyOnlyRun(spec: TracerouteRunSpec): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- as above
  await databaseService.insertTracerouteAsync(replyRecord(spec) as any, spec.sourceId);
}

export function writeRun(form: StoredForm, spec: TracerouteRunSpec): Promise<void> {
  return form === 'sent' ? writeSentRun(spec) : writeReplyOnlyRun(spec);
}

/**
 * Rows AS STORED, oldest first, bypassing the repository's orientation. For
 * asserting what a writer put on disk; readers under test must use the
 * repository or a route.
 */
export async function storedTracerouteRows(sourceId: string): Promise<Array<Record<string, unknown>>> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- reaching the repository's protected Drizzle handles
  const repo = databaseService.traceroutes as any;
  const { traceroutes } = repo.tables;
  const rows: Array<Record<string, unknown>> = await repo.db.select().from(traceroutes);
  return rows
    .filter((r) => r.sourceId === sourceId)
    .sort((a, b) => Number(a.id) - Number(b.id));
}
