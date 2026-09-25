/**
 * @vitest-environment jsdom
 *
 * See the WP1-dependency banner atop ShowCoverageLink.tsx: the component
 * uses a local, spec-matching implementation of `buildCoverageReportPath` /
 * `parseCoverageDeepLink` (WP1's real module isn't resolvable in this
 * worktree and, under jsdom, a missing static import breaks Vitest's
 * collection step even when mocked). These tests exercise that real
 * behaviour directly rather than mocking it away.
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ShowCoverageLink } from './ShowCoverageLink';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, def?: string) => def ?? key }),
}));

vi.mock('../../init', () => ({ appBasename: '/meshmonitor' }));

const MESHCORE_PUBKEY = 'a'.repeat(64);

describe('ShowCoverageLink', () => {
  it('renders a react-router Link inside a Router, pointing at the coverage deep link', () => {
    render(
      <MemoryRouter>
        <ShowCoverageLink senderId="!a1b2c3d4" />
      </MemoryRouter>,
    );
    const link = screen.getByRole('link', { name: /show coverage/i });
    expect(decodeURIComponent(link.getAttribute('href') ?? '')).toBe(
      '/reports?report=coverage&sender=!a1b2c3d4&range=24h',
    );
    expect(link).toHaveAttribute(
      'title',
      'Open the Coverage Report for this node (last 24 hours)',
    );
  });

  it('accepts a lowercased 64-hex MeshCore pubkey as the sender', () => {
    render(
      <MemoryRouter>
        <ShowCoverageLink senderId={MESHCORE_PUBKEY} />
      </MemoryRouter>,
    );
    const link = screen.getByRole('link', { name: /show coverage/i });
    expect(decodeURIComponent(link.getAttribute('href') ?? '')).toContain(
      `sender=${MESHCORE_PUBKEY}`,
    );
  });

  it('accepts an uppercase-mixed MeshCore pubkey by lowercasing it', () => {
    render(
      <MemoryRouter>
        <ShowCoverageLink senderId={MESHCORE_PUBKEY.toUpperCase()} />
      </MemoryRouter>,
    );
    const link = screen.getByRole('link', { name: /show coverage/i });
    expect(decodeURIComponent(link.getAttribute('href') ?? '')).toContain(
      `sender=${MESHCORE_PUBKEY}`,
    );
  });

  it('falls back to a plain basename-prefixed <a href> when rendered outside a Router', () => {
    render(<ShowCoverageLink senderId="!a1b2c3d4" />);
    const link = screen.getByRole('link', { name: /show coverage/i });
    expect(link.tagName).toBe('A');
    expect(decodeURIComponent(link.getAttribute('href') ?? '')).toBe(
      '/meshmonitor/reports?report=coverage&sender=!a1b2c3d4&range=24h',
    );
  });

  it('renders nothing for a sender id the deep link would reject', () => {
    const { container } = render(<ShowCoverageLink senderId="not-a-valid-id" />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing for an empty sender id', () => {
    const { container } = render(<ShowCoverageLink senderId="" />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing for a too-short Meshtastic-looking id', () => {
    const { container } = render(<ShowCoverageLink senderId="!abc123" />);
    expect(container).toBeEmptyDOMElement();
  });
});
