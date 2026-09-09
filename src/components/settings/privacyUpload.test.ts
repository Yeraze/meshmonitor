/**
 * @vitest-environment node
 *
 * `seedFromUpload` (#5156) — how an uploaded Markdown file becomes a title
 * plus a body.
 *
 * The page renders the stored title as its `<h1>`, so a document that also
 * opens with `# Same Thing` shows the title twice. This is the seam that
 * prevents that, and these cases are the ones that made it necessary.
 */
import { describe, it, expect } from 'vitest';
import { seedFromUpload } from './privacyUpload';

describe('seedFromUpload', () => {
  it('takes the leading H1 as the title and removes it from the body', () => {
    const { title, content } = seedFromUpload(
      '# Privacy Policy\n\nWe store packets.\n',
      '',
      'privacy',
    );

    expect(title).toBe('Privacy Policy');
    expect(content).toBe('We store packets.\n');
    expect(content).not.toContain('# Privacy Policy');
  });

  it('keeps a title the operator already typed, and leaves the body untouched', () => {
    const text = '# Their Heading\n\nBody.\n';
    const { title, content } = seedFromUpload(text, 'My Title', 'privacy');

    expect(title).toBe('My Title');
    // We only strip a heading we actually consumed.
    expect(content).toBe(text);
  });

  it('falls back to the generic label when the file has no H1', () => {
    const text = 'Just a paragraph, no heading.\n';
    const { title, content } = seedFromUpload(text, '', 'terms');

    expect(title).toBe('Terms of Service');
    expect(content).toBe(text);
  });

  it('ignores an H2 — only a real H1 becomes the title', () => {
    const text = '## Section\n\nBody.\n';
    const { title, content } = seedFromUpload(text, '', 'contact');

    expect(title).toBe('Contact');
    expect(content).toBe(text);
  });

  it('does not treat a hash inside the body as the title', () => {
    const text = 'Intro paragraph.\n\n# Real Heading\n\nMore.\n';
    const { title } = seedFromUpload(text, '', 'privacy');

    // The first H1 anywhere is still the document's heading — but the intro
    // must survive.
    expect(title).toBe('Real Heading');
    expect(seedFromUpload(text, '', 'privacy').content).toContain('Intro paragraph.');
  });

  it('trims leading blank lines left behind by the removed heading', () => {
    const { content } = seedFromUpload('# Title\n\n\n\nBody.\n', '', 'privacy');
    expect(content.startsWith('Body.')).toBe(true);
  });

  it('treats a whitespace-only operator title as unset', () => {
    const { title } = seedFromUpload('# From File\n\nBody.\n', '   ', 'privacy');
    expect(title).toBe('From File');
  });
});
