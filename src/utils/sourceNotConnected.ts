/**
 * "Source not connected" detection (#4173 review N5).
 *
 * A source that is enabled but has no running manager (never connected, or
 * autoConnect off) has nothing to answer device or manager-backed routes.
 * The server says so with `code: 'SOURCE_NOT_CONNECTED'`; the client keys its
 * empty state off that code, never off the message text.
 *
 * Pure, no React, no I/O beyond reading a Response body — imported by both the
 * server and the client.
 */

export const SOURCE_NOT_CONNECTED_CODE = 'SOURCE_NOT_CONNECTED';

/** True when a thrown ApiError, or any `{ code }`-shaped value, means the source is not connected. */
export function isSourceNotConnectedError(err: unknown): boolean {
  return (
    typeof err === 'object' && err !== null &&
    (err as { code?: unknown }).code === SOURCE_NOT_CONNECTED_CODE
  );
}

/**
 * An Error that carries the server's machine code, for `fetch` call sites
 * that build their own error from a non-ok response.
 */
export class CodedHttpError extends Error {
  readonly status: number;
  readonly code?: string;

  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = 'CodedHttpError';
    this.status = status;
    this.code = code;
  }
}

/**
 * Build a `CodedHttpError` from a non-ok `Response`, reading `code` from the
 * JSON body when there is one. The message stays `HTTP <status>`.
 */
export async function codedHttpError(res: Response): Promise<CodedHttpError> {
  let code: string | undefined;
  try {
    const body: unknown = await res.json();
    const c = (body as { code?: unknown } | null)?.code;
    if (typeof c === 'string') code = c;
  } catch {
    // Not JSON: keep the bare status.
  }
  return new CodedHttpError(`HTTP ${res.status}`, res.status, code);
}
