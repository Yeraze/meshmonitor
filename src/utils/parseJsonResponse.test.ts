import { describe, it, expect } from 'vitest';
import { parseJsonResponse } from './parseJsonResponse';

function makeResponse(opts: { contentType?: string; status?: number; json?: unknown }): Response {
  const headers = new Headers();
  if (opts.contentType) headers.set('content-type', opts.contentType);
  return {
    status: opts.status ?? 200,
    headers,
    json: () => Promise.resolve(opts.json),
  } as unknown as Response;
}

describe('parseJsonResponse (#5268)', () => {
  it('parses a normal JSON response', async () => {
    const response = makeResponse({ contentType: 'application/json', json: { success: true } });
    await expect(parseJsonResponse(response)).resolves.toEqual({ success: true });
  });

  it('parses when content-type is absent', async () => {
    const response = makeResponse({ json: { success: true } });
    await expect(parseJsonResponse(response)).resolves.toEqual({ success: true });
  });

  it('parses JSON served as text/plain', async () => {
    const response = makeResponse({ contentType: 'text/plain', json: { success: true } });
    await expect(parseJsonResponse(response)).resolves.toEqual({ success: true });
  });

  it('throws a descriptive error for an HTML body instead of a raw JSON.parse failure', async () => {
    const response = makeResponse({ contentType: 'text/html; charset=utf-8', status: 502 });
    await expect(parseJsonResponse(response, '/api/sources/1/meshcore/admin/cli')).rejects.toThrow(
      /Expected JSON from \/api\/sources\/1\/meshcore\/admin\/cli but received HTML \(status 502, "text\/html; charset=utf-8"\)/
    );
  });

  it('includes status and content-type without a context label when none is given', async () => {
    const response = makeResponse({ contentType: 'text/html', status: 524 });
    await expect(parseJsonResponse(response)).rejects.toThrow(/Expected JSON but received HTML \(status 524/);
  });
});
