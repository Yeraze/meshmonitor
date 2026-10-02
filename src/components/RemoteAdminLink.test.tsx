/**
 * @vitest-environment jsdom
 *
 * Exercises the real `adminDeepLink` builder/parser rather than mocking it.
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { RemoteAdminLink } from './RemoteAdminLink';

vi.mock('react-i18next', async () => {
  const { createReactI18nextMock } = await import('../test/mockI18n');
  return createReactI18nextMock();
});

vi.mock('../init', () => ({ appBasename: '/meshmonitor' }));

describe('RemoteAdminLink', () => {
  it('renders a react-router Link inside a Router, pointing at the admin deep link, when enabled', () => {
    render(
      <MemoryRouter>
        <RemoteAdminLink nodeId="!aabbccdd" nodeName="Test Node" enabled>
          <span>badge</span>
        </RemoteAdminLink>
      </MemoryRouter>,
    );
    const link = screen.getByRole('link', { name: /open remote admin for test node/i });
    expect(decodeURIComponent(link.getAttribute('href') ?? '')).toBe('/admin?node=!aabbccdd');
    expect(screen.getByText('badge')).toBeInTheDocument();
  });

  it('falls back to a plain basename-prefixed <a href> when rendered outside a Router', () => {
    render(
      <RemoteAdminLink nodeId="!aabbccdd" nodeName="Test Node" enabled>
        <span>badge</span>
      </RemoteAdminLink>,
    );
    const link = screen.getByRole('link', { name: /open remote admin for test node/i });
    expect(link.tagName).toBe('A');
    expect(decodeURIComponent(link.getAttribute('href') ?? '')).toBe('/meshmonitor/admin?node=!aabbccdd');
  });

  it('renders children unwrapped (no link) when not enabled', () => {
    render(
      <MemoryRouter>
        <RemoteAdminLink nodeId="!aabbccdd" nodeName="Test Node" enabled={false}>
          <span>badge</span>
        </RemoteAdminLink>
      </MemoryRouter>,
    );
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(screen.getByText('badge')).toBeInTheDocument();
  });

  it('renders children unwrapped for a node id the deep link would reject, even when enabled', () => {
    render(
      <MemoryRouter>
        <RemoteAdminLink nodeId="not-a-valid-id" nodeName="Test Node" enabled>
          <span>badge</span>
        </RemoteAdminLink>
      </MemoryRouter>,
    );
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(screen.getByText('badge')).toBeInTheDocument();
  });

  it('renders children unwrapped for an empty node id', () => {
    render(
      <MemoryRouter>
        <RemoteAdminLink nodeId="" nodeName="Test Node" enabled>
          <span>badge</span>
        </RemoteAdminLink>
      </MemoryRouter>,
    );
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });
});
