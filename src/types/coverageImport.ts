/**
 * Types for importing Coverage Report files (#5891 Phase 3).
 * Spec: docs/internal/dev-notes/WALKABOUT_P3_SPEC.md §3.4.
 * Frontend-safe: no server imports.
 */

export type CoverageImportKind = 'coverage_report';
export type CoverageImportFormat = 'csv' | 'geojson';
export type CoverageImportedMode = 'include' | 'exclude' | 'only';

export interface CoverageImportDto {
  id: string;
  sourceId: string;
  kind: CoverageImportKind;
  format: CoverageImportFormat;
  filename: string;
  status: 'importing' | 'complete';
  importedAt: number;
  /** Never the user id. */
  importedByMe: boolean;
  rowCount: number;
  insertedCount: number;
  duplicateCount: number;
  skippedCount: number;
  firstReceivedAt: number | null;
  lastReceivedAt: number | null;
  sourceTruncated: boolean;
}

export interface CoverageImportResult {
  import: CoverageImportDto;
  skipped: { protocolMismatch: number; gapFeatures: number; bogusPositions?: number };
}

/** `row` = CSV record line or GeoJSON feature index, 1-based. */
export interface CoverageImportRowError {
  row: number;
  field: string | null;
  message: string;
}

/** One validated row, ready for the repository (sourceId/importId added by the service). */
export interface ParsedCoverageImportRow {
  protocol: 'meshtastic' | 'meshcore';
  receiverKind: 'local' | 'mqtt_gateway';
  receiverId: string;
  receiverNodeNum: number | null;
  receiverLatitude: number | null;
  receiverLongitude: number | null;
  senderId: string;
  senderNodeNum: number | null;
  packetKey: string;
  packetId: number | null;
  pathKey: string;
  latitude: number;
  longitude: number;
  altitude: number | null;
  precisionBits: number | null;
  snr: number | null;
  rssi: number | null;
  hopStart: number | null;
  hopLimit: number | null;
  hopsAway: number | null;
  relayNode: number | null;
  channel: number | null;
  receivedAt: number;
}

export type ParseCoverageImportResult =
  | {
      ok: true;
      format: CoverageImportFormat;
      rows: ParsedCoverageImportRow[];
      gapFeatures: number;
      sourceTruncated: boolean;
      /** Valid rows dropped because the fix or receiver position is bogus (Null Island). */
      skippedBogusPositions: number;
    }
  | {
      ok: false;
      code:
        | 'IMPORT_UNSUPPORTED_FILE'
        | 'IMPORT_NOT_MESHMONITOR'
        | 'IMPORT_SCHEMA_MISMATCH'
        | 'IMPORT_INVALID_ROWS'
        | 'IMPORT_TOO_MANY_ROWS'
        | 'IMPORT_EMPTY';
      message: string;
      errors: CoverageImportRowError[];
    };
