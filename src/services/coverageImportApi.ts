/**
 * Coverage import client (#5891 P3, WALKABOUT_P3_SPEC.md §3.10).
 * The routes use ok()/fail(), so list and delete read `body.data`. The upload
 * is raw bytes (`application/octet-stream`, like the GeoJSON layer upload), so
 * it goes through the CSRF fetch the caller hands in: no fetch lives in a
 * component.
 */
import api from './api.js';
import type {
  CoverageImportDto,
  CoverageImportResult,
  CoverageImportRowError,
} from '../types/coverageImport.js';

interface Envelope<T> {
  success: boolean;
  data: T;
}

export type CoverageCsrfFetch = (url: string, options?: RequestInit, signal?: AbortSignal) => Promise<Response>;

/** An upload the server refused; carries the machine code and the row errors. */
export class CoverageImportUploadError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code: string | null,
    public readonly errors: CoverageImportRowError[],
    public readonly errorCount: number,
  ) {
    super(message);
    this.name = 'CoverageImportUploadError';
  }
}

const base = (sourceId: string) => `/api/sources/${encodeURIComponent(sourceId)}/coverage/imports`;

export async function fetchCoverageImports(sourceId: string): Promise<CoverageImportDto[]> {
  const body = await api.get<Envelope<{ imports: CoverageImportDto[] }>>(base(sourceId));
  return body.data?.imports ?? [];
}

export async function deleteCoverageImport(sourceId: string, importId: string): Promise<void> {
  await api.delete<{ success: boolean }>(`${base(sourceId)}/${encodeURIComponent(importId)}`);
}

export async function uploadCoverageImport(
  csrfFetch: CoverageCsrfFetch,
  sourceId: string,
  file: File,
): Promise<CoverageImportResult> {
  const baseUrl = await api.getBaseUrl();
  const response = await csrfFetch(`${baseUrl}${base(sourceId)}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/octet-stream',
      'X-Filename': encodeURIComponent(file.name),
    },
    body: file,
  });
  const body = (await response.json().catch(() => null)) as
    | (Partial<Envelope<CoverageImportResult>> & {
        error?: string;
        code?: string;
        errors?: CoverageImportRowError[];
        errorCount?: number;
      })
    | null;
  if (!response.ok || !body || body.success === false || !body.data) {
    const errors = Array.isArray(body?.errors) ? body.errors : [];
    throw new CoverageImportUploadError(
      body?.error || `Upload failed with status ${response.status}`,
      response.status,
      body?.code ?? null,
      errors,
      typeof body?.errorCount === 'number' ? body.errorCount : errors.length,
    );
  }
  return body.data;
}

