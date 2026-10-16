/**
 * @vitest-environment jsdom
 *
 * Unified Messages remembers the last channel picked in this browser (#5792).
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('react-i18next', async () => {
  const { createReactI18nextMock } = await import('../test/mockI18n');
  return createReactI18nextMock();
});

vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({
    authStatus: { authenticated: true, user: { isAdmin: true } },
    hasPermission: () => true,
  }),
}));

const apiGet = vi.fn();
vi.mock('../services/api', () => ({
  default: { get: (...args: unknown[]) => apiGet(...args) },
}));

vi.mock('../components/LinkPreview', () => ({ default: () => null }));
vi.mock('../components/MessageExportDialog/MessageExportDialog', () => ({ default: () => null }));

import UnifiedMessagesPage from './UnifiedMessagesPage';
import { UNIFIED_CHANNEL_STORAGE_KEY } from './unifiedChannelPreference';

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <UnifiedMessagesPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function channelSelect(): HTMLSelectElement {
  return screen.getByLabelText('unified.messages.channel_aria') as HTMLSelectElement;
}

describe('UnifiedMessagesPage remembers the selected channel (#5792)', () => {
  beforeEach(() => {
    localStorage.clear();
    apiGet.mockReset();
    apiGet.mockImplementation(async (url: string) => {
      if (url.startsWith('/api/unified/channels')) {
        return [
          { name: '#Public', sources: [{ sourceId: 'a', sourceName: 'a', channelNumber: 0 }] },
          { name: '#test', sources: [{ sourceId: 'a', sourceName: 'a', channelNumber: 1 }] },
        ];
      }
      if (url.startsWith('/api/unified/messages')) return [];
      return {};
    });
  });

  it('opens the built-in default when nothing is stored', async () => {
    renderPage();
    await waitFor(() => expect(channelSelect().value).toBe('#Public'));
    // The automatic pick is not remembered.
    expect(localStorage.getItem(UNIFIED_CHANNEL_STORAGE_KEY)).toBeNull();
  });

  it('restores All Channels', async () => {
    localStorage.setItem(UNIFIED_CHANNEL_STORAGE_KEY, '__all__');
    renderPage();
    await waitFor(() => expect(channelSelect().value).toBe('__all__'));
  });

  it('falls back when the stored channel no longer exists', async () => {
    localStorage.setItem(UNIFIED_CHANNEL_STORAGE_KEY, '#gone');
    renderPage();
    await waitFor(() => expect(channelSelect().value).toBe('#Public'));
  });

  it('stores a manual pick', async () => {
    renderPage();
    await waitFor(() => expect(channelSelect().value).toBe('#Public'));
    fireEvent.change(channelSelect(), { target: { value: '__all__' } });
    expect(localStorage.getItem(UNIFIED_CHANNEL_STORAGE_KEY)).toBe('__all__');
  });
});
