import { describe, it, expect } from 'vitest';
import { parseJsonResponse } from './parseJsonResponse';

function makeResponse(opts: {
  contentType?: string;
  status?: number;
  url?: string;
  json?: unknown;
  jsonThrows?: Error;
}): Response {
  const headers = new Headers();
  if (opts.contentType) headers.set('content-type', opts.contentType);
  return {
    status: opts.status ?? 200,
    url: opts.url ?? '',
    headers,
    json: () => (opts.jsonThrows ? Promise.reject(opts.jsonThrows) : Promise.resolve(opts.json)),
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
    await expect(
      parseJsonResponse(response, { context: '/api/sources/1/meshcore/admin/cli' })
    ).rejects.toThrow(
      /Expected JSON from \/api\/sources\/1\/meshcore\/admin\/cli \(status 502, "text\/html; charset=utf-8"\) but received HTML/
    );
  });

  it('includes status and content-type without a label when neither context nor url is available', async () => {
    const response = makeResponse({ contentType: 'text/html', status: 524 });
    await expect(parseJsonResponse(response)).rejects.toThrow(
      /Expected JSON \(status 524, "text\/html"\) but received HTML/
    );
  });

  /*
   * Every one of the 57 MeshCore hook call sites passes no context, so without
   * this fallback the error would name no endpoint at all — which is most of
   * what makes it actionable. After a redirect `response.url` is the URL that
   * actually answered, so an access-proxy bounce names the login host.
   */
  it('falls back to response.url when no context is given', async () => {
    const response = makeResponse({
      contentType: 'text/html',
      status: 200,
      url: 'https://auth.example.com/cdn-cgi/access/login',
    });
    await expect(parseJsonResponse(response)).rejects.toThrow(
      /from https:\/\/auth\.example\.com\/cdn-cgi\/access\/login/
    );
  });

  it('prefers an explicit context over response.url', async () => {
    const response = makeResponse({
      contentType: 'text/html',
      url: 'https://auth.example.com/login',
    });
    await expect(parseJsonResponse(response, { context: '/api/thing' })).rejects.toThrow(
      /from \/api\/thing/
    );
  });

  /*
   * A content-type check alone only catches HTML. A gateway that answers with
   * plain text, or an empty body, still died on the opaque SyntaxError.
   */
  it('names the status when a non-HTML body fails to parse', async () => {
    const response = makeResponse({
      contentType: 'text/plain',
      status: 502,
      jsonThrows: new SyntaxError('Unexpected token B in JSON at position 0'),
    });
    await expect(parseJsonResponse(response)).rejects.toThrow(
      /Expected JSON \(status 502, "text\/plain"\) but the body could not be parsed: Unexpected token B/
    );
  });

  it('names the missing content-type when an empty body fails to parse', async () => {
    const response = makeResponse({
      status: 504,
      jsonThrows: new SyntaxError('Unexpected end of JSON input'),
    });
    await expect(parseJsonResponse(response)).rejects.toThrow(
      /\(status 504, "no content-type"\) but the body could not be parsed/
    );
  });

  it('throws the error type makeError builds, for both failure branches', async () => {
    class Custom extends Error {
      constructor(message: string, readonly status: number) {
        super(message);
      }
    }
    const makeError = (message: string, response: Response) => new Custom(message, response.status);

    const html = parseJsonResponse(makeResponse({ contentType: 'text/html', status: 503 }), { makeError });
    await expect(html).rejects.toBeInstanceOf(Custom);
    await expect(html).rejects.toMatchObject({ status: 503 });

    const unparseable = parseJsonResponse(
      makeResponse({ status: 504, jsonThrows: new SyntaxError('boom') }),
      { makeError }
    );
    await expect(unparseable).rejects.toBeInstanceOf(Custom);
    await expect(unparseable).rejects.toMatchObject({ status: 504 });
  });
});
