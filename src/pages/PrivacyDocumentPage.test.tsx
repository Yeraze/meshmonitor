/**
 * @vitest-environment jsdom
 *
 * PrivacyDocumentPage (#5156) — the standalone view for an operator-hosted
 * policy document.
 *
 * The load-bearing test here is the XSS one. This page renders operator-
 * supplied Markdown to anonymous visitors and to people arriving from a
 * tokenless embed. `react-markdown` without `rehype-raw` escapes raw HTML
 * rather than executing it, and that — not the write-path HTML check — is what
 * actually makes the page safe. If someone ever adds `rehype-raw` or switches
 * to `dangerouslySetInnerHTML`, that test is what should stop them.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import PrivacyDocumentPage from './PrivacyDocumentPage';
import apiService from '../services/api';

vi.mock('../services/api', () => ({
  default: { getPrivacyDocument: vi.fn() },
}));

const renderAt = (path: string) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/privacy/:slug" element={<PrivacyDocumentPage />} />
      </Routes>
    </MemoryRouter>,
  );

const doc = (content: string, title = 'Privacy Policy') => ({
  slug: 'privacy' as const,
  title,
  content,
  updatedAt: 1_800_000_000_000,
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe('PrivacyDocumentPage', () => {
  it('renders the operator document title and Markdown body', async () => {
    vi.mocked(apiService.getPrivacyDocument).mockResolvedValue(
      doc('# Heading\n\nWe store **packets**.'),
    );
    renderAt('/privacy/privacy');

    expect(await screen.findByRole('heading', { name: 'Heading' })).toBeInTheDocument();
    expect(screen.getByText('packets')).toBeInTheDocument();
    expect(screen.getByText('Privacy Policy')).toBeInTheDocument();
  });

  it('escapes raw HTML in the document instead of executing it', async () => {
    // The whole reason the column stores Markdown. Do not "fix" this by
    // adding rehype-raw.
    vi.mocked(apiService.getPrivacyDocument).mockResolvedValue(
      doc('# Policy\n\n<script>window.__pwned = true;</script>\n\n<img src=x onerror="window.__pwned = true">'),
    );
    const { container } = renderAt('/privacy/privacy');

    await screen.findByRole('heading', { name: 'Policy' });

    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('img')).toBeNull();
    expect((window as unknown as { __pwned?: boolean }).__pwned).toBeUndefined();
    // The tags survive as visible text, which is the honest rendering.
    expect(container.textContent).toContain('<script>');
  });

  it('does not render the title twice when the body repeats it', async () => {
    // Found by driving the deployed container: the page renders the stored
    // title as its <h1>, and an operator's policy almost always opens with the
    // same title as its own '# Heading'.
    vi.mocked(apiService.getPrivacyDocument).mockResolvedValue(
      doc('# Privacy Policy\n\nWe store packets.\n', 'Privacy Policy'),
    );
    const { container } = renderAt('/privacy/privacy');

    await screen.findByText('We store packets.');
    const headings = [...container.querySelectorAll('h1')].map((h) => h.textContent);
    expect(headings).toEqual(['Privacy Policy']);
  });

  it('keeps a leading heading that is not the title', async () => {
    vi.mocked(apiService.getPrivacyDocument).mockResolvedValue(
      doc('# Scope\n\nBody.\n', 'Privacy Policy'),
    );
    const { container } = renderAt('/privacy/privacy');

    await screen.findByText('Body.');
    const headings = [...container.querySelectorAll('h1')].map((h) => h.textContent);
    expect(headings).toEqual(['Privacy Policy', 'Scope']);
  });

  it('renders GFM tables, not literal pipes', async () => {
    // Without remark-gfm, react-markdown renders a table as a single line of
    // "| Data | Retention |" text. A retention table is the first thing an
    // operator reaches for in a privacy policy, so this is not cosmetic.
    vi.mocked(apiService.getPrivacyDocument).mockResolvedValue(
      doc('| Data | Retention |\n| --- | --- |\n| Packets | 90 days |\n'),
    );
    const { container } = renderAt('/privacy/privacy');

    await waitFor(() => expect(container.querySelector('table')).not.toBeNull());
    expect(screen.getByRole('columnheader', { name: 'Retention' })).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: '90 days' })).toBeInTheDocument();
    expect(container.textContent).not.toContain('| Data |');
  });

  it('renders GFM strikethrough', async () => {
    vi.mocked(apiService.getPrivacyDocument).mockResolvedValue(doc('We ~~sell~~ keep data.'));
    const { container } = renderAt('/privacy/privacy');

    await waitFor(() => expect(container.querySelector('del')).not.toBeNull());
  });

  it('opens links in the document in a new tab, safely', async () => {
    vi.mocked(apiService.getPrivacyDocument).mockResolvedValue(
      doc('Read [more](https://example.org/more).'),
    );
    renderAt('/privacy/privacy');

    const link = await screen.findByRole('link', { name: 'more' });
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('shows a not-found page when the document was never published', async () => {
    vi.mocked(apiService.getPrivacyDocument).mockRejectedValue(new Error('404'));
    renderAt('/privacy/terms');

    expect(await screen.findByText('privacy.not_found_title')).toBeInTheDocument();
  });

  it('shows a not-found page for an unknown slug without calling the API', async () => {
    renderAt('/privacy/passwd');

    expect(await screen.findByText('privacy.not_found_title')).toBeInTheDocument();
    expect(apiService.getPrivacyDocument).not.toHaveBeenCalled();
  });

  it('does not distinguish "unpublished" from "server error" to a visitor', async () => {
    // Both read as "there is no document here"; telling them apart would only
    // leak whether the operator has one configured.
    vi.mocked(apiService.getPrivacyDocument).mockRejectedValue(new Error('500'));
    renderAt('/privacy/privacy');

    expect(await screen.findByText('privacy.not_found_title')).toBeInTheDocument();
  });

  it('sets the document title from the operator document', async () => {
    vi.mocked(apiService.getPrivacyDocument).mockResolvedValue(doc('body', 'Our Rules'));
    renderAt('/privacy/privacy');

    await waitFor(() => expect(document.title).toBe('Our Rules — MeshMonitor'));
  });
});
