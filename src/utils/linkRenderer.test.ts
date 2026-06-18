import { describe, it, expect, vi, beforeEach } from 'vitest';

// fetchLinkPreview must delegate to the statically-imported api service. A
// previous dynamic `import('../services/api')` produced a Vite lazy chunk whose
// preload URL dropped the runtime BASE_URL prefix and 404'd, throwing and
// silently disabling link previews on pages where that chunk wasn't preloaded
// (notably the MeshCore views). These tests lock in the delegate-and-fallback
// contract.
const apiFetchLinkPreview = vi.fn();
vi.mock('../services/api', () => ({
  default: { fetchLinkPreview: (...args: unknown[]) => apiFetchLinkPreview(...args) },
}));

import { fetchLinkPreview, extractUrls } from './linkRenderer';

describe('linkRenderer.fetchLinkPreview', () => {
  beforeEach(() => {
    apiFetchLinkPreview.mockReset();
  });

  it('returns the metadata the api service resolves', async () => {
    const meta = { url: 'https://example.com', title: 'Example', image: 'https://example.com/og.png' };
    apiFetchLinkPreview.mockResolvedValue(meta);

    await expect(fetchLinkPreview('https://example.com')).resolves.toEqual(meta);
    expect(apiFetchLinkPreview).toHaveBeenCalledWith('https://example.com');
  });

  it('resolves to null (does not throw) when the api call rejects', async () => {
    apiFetchLinkPreview.mockRejectedValue(new Error('network down'));

    await expect(fetchLinkPreview('https://example.com')).resolves.toBeNull();
  });
});

describe('linkRenderer.extractUrls', () => {
  it('extracts http(s) URLs including query strings', () => {
    expect(
      extractUrls('watch https://www.youtube.com/live/eVo288DAH4U?is=oNPL4NWX1J_dNjAp now'),
    ).toEqual(['https://www.youtube.com/live/eVo288DAH4U?is=oNPL4NWX1J_dNjAp']);
  });

  it('normalizes bare www. URLs to https://', () => {
    expect(extractUrls('see www.discord.gg/floridamesh')).toEqual(['https://www.discord.gg/floridamesh']);
  });

  it('returns an empty array when there is no URL', () => {
    expect(extractUrls('just a plain message')).toEqual([]);
  });
});
