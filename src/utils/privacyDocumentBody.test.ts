/**
 * stripDuplicateHeading (#5156).
 *
 * The page renders the stored title as its <h1>; an operator's Markdown very
 * often repeats that title as its own leading `# Heading`. These cases are the
 * ones that showed up in the deployed container — including the API-created
 * document that the earlier upload-time fix did not cover.
 */
import { describe, it, expect } from 'vitest';
import { stripDuplicateHeading } from './privacyDocumentBody';

describe('stripDuplicateHeading', () => {
  it('drops a leading H1 that repeats the title', () => {
    const out = stripDuplicateHeading('# Privacy Policy\n\nWe store packets.\n', 'Privacy Policy');
    expect(out).toBe('We store packets.\n');
  });

  it('keeps a leading H1 that says something else', () => {
    const content = '# Scope and Purpose\n\nBody.\n';
    expect(stripDuplicateHeading(content, 'Privacy Policy')).toBe(content);
  });

  it('matches case-insensitively and ignores whitespace differences', () => {
    expect(stripDuplicateHeading('#   privacy   policy  \n\nBody.\n', 'Privacy Policy'))
      .toBe('Body.\n');
  });

  it('leaves content with no heading alone', () => {
    const content = 'Just a paragraph.\n';
    expect(stripDuplicateHeading(content, 'Privacy Policy')).toBe(content);
  });

  it('only considers a LEADING heading, not one further down', () => {
    // A repeat mid-document is the operator's own structure, not our artifact.
    const content = 'Intro.\n\n# Privacy Policy\n\nBody.\n';
    expect(stripDuplicateHeading(content, 'Privacy Policy')).toBe(content);
  });

  it('ignores an H2 that repeats the title', () => {
    const content = '## Privacy Policy\n\nBody.\n';
    expect(stripDuplicateHeading(content, 'Privacy Policy')).toBe(content);
  });

  it('handles a document that is nothing but the duplicate heading', () => {
    expect(stripDuplicateHeading('# Privacy Policy', 'Privacy Policy')).toBe('');
  });
});
