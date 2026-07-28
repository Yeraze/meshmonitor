/**
 * Unit tests for the blog-to-news link absolutizer.
 *
 * Blog posts link with site-root-relative paths for VitePress. The news feed is
 * rendered inside MeshMonitor instances, where those paths resolve against the
 * instance's own base URL, so the generator must absolutize them.
 */
import { describe, it, expect } from 'vitest';
import { absolutizeLinks } from './blog-to-news.mjs';

describe('absolutizeLinks()', () => {
  it('rewrites a root-relative markdown link', () => {
    expect(absolutizeLinks('See the [ATAK guide](/features/atak) for setup.')).toBe(
      'See the [ATAK guide](https://meshmonitor.org/features/atak) for setup.'
    );
  });

  it('rewrites a root-relative image', () => {
    expect(absolutizeLinks('![shot](/images/blog/foo.png)')).toBe(
      '![shot](https://meshmonitor.org/images/blog/foo.png)'
    );
  });

  it('keeps the anchor on a path with a fragment', () => {
    expect(absolutizeLinks('[x](/configuration/updating#migrating)')).toBe(
      '[x](https://meshmonitor.org/configuration/updating#migrating)'
    );
  });

  it('rewrites href/src in raw HTML', () => {
    expect(absolutizeLinks('<a href="/faq">FAQ</a> <img src=\'/images/a.png\'>')).toBe(
      '<a href="https://meshmonitor.org/faq">FAQ</a> ' +
        "<img src='https://meshmonitor.org/images/a.png'>"
    );
  });

  it('rewrites reference-style definitions', () => {
    expect(absolutizeLinks('[guide]: /features/atak')).toBe(
      '[guide]: https://meshmonitor.org/features/atak'
    );
  });

  it('leaves absolute, protocol-relative, anchor, and mailto links alone', () => {
    const input = [
      '[changelog](https://github.com/Yeraze/meshmonitor/blob/main/CHANGELOG.md)',
      '[cdn](//cdn.example.com/a.js)',
      '[section](#why-it-matters)',
      '[mail](mailto:someone@example.com)',
      '[rel](relative/path.md)',
    ].join('\n');
    expect(absolutizeLinks(input)).toBe(input);
  });

  it('rewrites every occurrence in a multi-link document', () => {
    expect(absolutizeLinks('[a](/one) then [b](/two) and [c](/three)')).toBe(
      '[a](https://meshmonitor.org/one) then ' +
        '[b](https://meshmonitor.org/two) and ' +
        '[c](https://meshmonitor.org/three)'
    );
  });
});
