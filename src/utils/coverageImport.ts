/**
 * Coverage Report import: constants and pure parser/validator
 * (#5891 Phase 3). Frontend-safe: no DB, no `src/server` imports.
 * Spec: docs/internal/dev-notes/WALKABOUT_P3_SPEC.md §3.4, §3.5.
 *
 * `src/utils/**` is in `tsconfig.server.json`'s include set, so relative
 * imports need an explicit `.js` extension (#4596).
 */
import type {
  CoverageImportFormat,
  CoverageImportRowError,
  ParsedCoverageImportRow,
  ParseCoverageImportResult,
} from '../types/coverageImport.js';

export const COVERAGE_IMPORT_MAX_BYTES = 32 * 1024 * 1024; // Q5
export const COVERAGE_IMPORT_MAX_ROWS = 10_000; // Q5 (= export cap and client display cap)
export const COVERAGE_IMPORT_MAX_PER_SOURCE = 50; // Q5, batches
export const COVERAGE_IMPORT_MAX_ROWS_PER_SOURCE = 200_000; // Q5, inserted rows across batches
export const COVERAGE_IMPORT_FILENAME_MAX = 200;
export const COVERAGE_IMPORT_MAX_ERRORS = 20;
export const COVERAGE_IMPORT_INSERT_CHUNK = 500;
export const COVERAGE_IMPORT_LIST_LIMIT = 200;
export const COVERAGE_IMPORT_EARLIEST_MS = Date.UTC(2020, 0, 1);
export const COVERAGE_IMPORT_FUTURE_SKEW_MS = 5 * 60_000;
export const COVERAGE_IMPORT_WRITE_GRANT = { resource: 'nodes', action: 'write' } as const; // Q3
export const COVERAGE_IMPORT_READ_GRANT = { resource: 'nodes', action: 'read' } as const;
export const COVERAGE_EXPORT_FORMAT = 'meshmonitor-coverage-report';
export const COVERAGE_EXPORT_VERSION = 1;

// WP1 bodies. Stubs keep the final signatures so parallel packages compile.

export function detectCoverageImportFormat(_filename: string, _text: string): CoverageImportFormat | null {
  throw new Error('not implemented');
}

/** Inverse of `guardFormulaInjection`. */
export function unguardFormulaInjection(_value: string): string {
  throw new Error('not implemented');
}

export function validateCoverageImportRow(
  _raw: Record<string, unknown>,
  _nowMs: number,
): { row: ParsedCoverageImportRow } | { errors: Array<Omit<CoverageImportRowError, 'row'>> } {
  throw new Error('not implemented');
}

export function parseCoverageImport(_filename: string, _text: string, _nowMs?: number): ParseCoverageImportResult {
  throw new Error('not implemented');
}

/** null = reticulum / unsupported source type. */
export function coverageImportProtocolFor(_sourceType: string): 'meshtastic' | 'meshcore' | null {
  throw new Error('not implemented');
}

export function sanitizeImportFilename(_raw: string): string | null {
  throw new Error('not implemented');
}
