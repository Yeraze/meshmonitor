/**
 * MeshBeacon offer ingestion (#4723).
 *
 * Persists received beacons into `mesh_beacon_offers` so the invitation card
 * has something to render and a dismissal has somewhere to live. Subscribes to
 * the same `meshbeacon:received` data event the automation engine consumes —
 * deliberately a separate subscriber rather than a hook inside the engine, so
 * persistence keeps working when no automation references beacons at all.
 *
 * Best-effort by design: a failed write logs and returns. Losing one beacon row
 * is harmless because beacons rebroadcast, whereas throwing here would
 * propagate into the shared data-event fan-out and disturb every other
 * subscriber.
 */
import databaseService from '../../services/database.js';
import { dataEventEmitter, type DataEvent, type MeshBeaconReceivedData } from './dataEventEmitter.js';
import { logger } from '../../utils/logger.js';

/**
 * Persist one received beacon. Exported for tests and for any caller that has
 * the beacon in hand already.
 *
 * A beacon with no `sourceId` is dropped: the table is per-source and its PK
 * requires one, and an offer we cannot attribute is an offer we could never
 * act on (accepting is a per-source device write).
 */
export async function recordMeshBeaconOffer(
  data: MeshBeaconReceivedData,
  sourceId: string | undefined,
  now: number = Date.now(),
): Promise<void> {
  if (!sourceId) {
    logger.debug('[MeshBeaconOffers] dropping beacon with no sourceId');
    return;
  }
  if (!Number.isFinite(data?.nodeNum)) {
    logger.debug('[MeshBeaconOffers] dropping beacon with no usable nodeNum');
    return;
  }

  try {
    await databaseService.meshBeaconOffers.recordBeacon(
      sourceId,
      Number(data.nodeNum),
      {
        message: data.message ?? null,
        offerChannelName: data.offerChannelName ?? null,
        // `?? null` rather than `|| null`: region/preset 0 are valid enum
        // values, and coercing them away would turn a real offer into "no offer".
        offerRegion: data.offerRegion ?? null,
        offerPreset: data.offerPreset ?? null,
      },
      now,
    );
  } catch (e) {
    logger.warn(`[MeshBeaconOffers] failed to record beacon from ${data?.nodeNum}: ${e instanceof Error ? e.message : e}`);
  }
}

let started = false;

/** Subscribe to beacon events. Idempotent — a second call is a no-op. */
export function startMeshBeaconOfferIngestion(): void {
  if (started) return;
  started = true;

  dataEventEmitter.on('data', (event: DataEvent) => {
    if (event.type !== 'meshbeacon:received') return;
    void recordMeshBeaconOffer(event.data as MeshBeaconReceivedData, event.sourceId, event.timestamp);
  });

  logger.debug('[MeshBeaconOffers] ingestion started');
}

/** Test seam — lets a suite re-subscribe against a fresh emitter. */
export function __resetMeshBeaconOfferIngestionForTests(): void {
  started = false;
}
