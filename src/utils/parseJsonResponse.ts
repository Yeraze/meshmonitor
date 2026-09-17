/**
 * JSON response parsing guard for `fetch`-based hooks (#5268).
 *
 * Mirrors the SPA-fallback guard already in `ApiService.request()` (#5078):
 * a request that lands on the static catch-all, an edge/proxy error page, or
 * a session-redirect-to-login gets back `<!DOCTYPE html>` instead of JSON,
 * and a bare `response.json()` throws an opaque `Unexpected token '<'`
 * SyntaxError that is meaningless far from the endpoint that actually
 * failed. Checking content-type first turns that into a message naming the
 * status and content-type actually received.
 *
 * Deliberately narrow: only `text/html` is rejected. An absent header, an
 * absent `headers` object, or a handler that returns JSON as `text/plain`
 * are all legitimate and must pass through untouched.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- generic default mirrors response.json()'s own untyped Promise<any>, preserving existing call-site typing across all 57 sites (#5268)
export async function parseJsonResponse<T = any>(response: Response, context?: string): Promise<T> {
  const contentType = response.headers?.get?.('content-type') || '';
  if (contentType.includes('text/html')) {
    const label = context ? ` from ${context}` : '';
    throw new Error(
      `Expected JSON${label} but received HTML (status ${response.status}, "${contentType}"). ` +
      'This usually means a proxy/edge error page or a session redirect was returned instead of an API response.'
    );
  }
  return response.json();
}
