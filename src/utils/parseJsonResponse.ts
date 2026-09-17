/**
 * JSON response parsing guard for `fetch` callers (#5078, #5268).
 *
 * A `fetch` that does not come back as JSON produces `Unexpected token '<'`
 * from `response.json()` — a parse error naming neither the endpoint nor the
 * HTTP status, and so meaningless far from the call that failed. Three real
 * deployments of that: a request path missing its `/api` prefix falls through
 * to the SPA catch-all and gets `index.html` with a 200 (#5078); a proxy or
 * edge error page is returned instead of the API reply; or an access-proxy
 * session expires and `fetch` follows the redirect to an HTML login page,
 * which also arrives as a 200 (#5268).
 *
 * This checks the content-type first and, failing that, catches the parse
 * error, so either way the caller gets a message naming the endpoint, the
 * status, and the content-type actually received.
 *
 * Deliberately narrow on the content-type check: only `text/html` is rejected
 * up front. An absent header, an absent `headers` object, and a handler that
 * returns JSON as `text/plain` are all legitimate and must pass through.
 */

export interface ParseJsonResponseOptions {
  /**
   * Label for the request in the error message. Defaults to `response.url`,
   * which after a redirect holds the URL actually served — naming, for
   * example, the access-proxy login host that answered instead of us.
   */
  context?: string;
  /**
   * Builds the thrown error. Defaults to a plain `Error`; `ApiService` passes
   * one that returns an `ApiError` carrying the status.
   */
  makeError?: (message: string, response: Response) => Error;
}

const CAUSES =
  'This usually means the request path is missing its /api prefix and was served the SPA shell, ' +
  'or that a proxy/edge error page or a session redirect was returned instead of an API response.';

function describeResponse(response: Response, context: string | undefined, contentType: string): string {
  const label = context ?? response.url;
  const from = label ? ` from ${label}` : '';
  return `${from} (status ${response.status}, "${contentType || 'no content-type'}")`;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- generic default mirrors response.json()'s own untyped Promise<any>, preserving existing call-site typing across all 57 sites (#5268)
export async function parseJsonResponse<T = any>(
  response: Response,
  options: ParseJsonResponseOptions = {}
): Promise<T> {
  const { context, makeError } = options;
  const contentType = response.headers?.get?.('content-type') || '';
  const build = (message: string) => (makeError ? makeError(message, response) : new Error(message));

  if (contentType.includes('text/html')) {
    throw build(
      `Expected JSON${describeResponse(response, context, contentType)} but received HTML. ${CAUSES}`
    );
  }

  try {
    return await response.json();
  } catch (error) {
    // Not HTML, but still not JSON: a plain-text gateway error, an empty 502
    // body, a truncated response. Without this branch the opaque SyntaxError
    // is all the caller ever sees.
    const detail = error instanceof Error ? error.message : String(error);
    throw build(
      `Expected JSON${describeResponse(response, context, contentType)} but the body could not be parsed: ${detail}. ${CAUSES}`
    );
  }
}
