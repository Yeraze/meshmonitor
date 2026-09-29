/**
 * @vitest-environment jsdom
 *
 * MeshCoreForwardingSection — receive-only mode (#5446). Mirrors
 * MeshCoreAutoResponderSection.receiveOnly.test.tsx, except that Forwarding
 * goes read-only (maintainer decision): the rules stay visible, editing is
 * disabled, and the paused note explains why.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

vi.mock('react-i18next', async () => {
  const { createReactI18nextMock } = await import('../../test/mockI18n');
  return createReactI18nextMock();
});

const { hasPermissionMock } = vi.hoisted(() => ({ hasPermissionMock: vi.fn() }));
vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({ hasPermission: hasPermissionMock }),
}));

vi.mock('../ToastContainer', () => ({
  useToast: () => ({ showToast: vi.fn() }),
}));

const { csrfFetchMock } = vi.hoisted(() => ({ csrfFetchMock: vi.fn() }));
vi.mock('../../hooks/useCsrfFetch', () => ({
  useCsrfFetch: () => csrfFetchMock,
}));

vi.mock('../../hooks/useSaveBar', () => ({ useSaveBar: () => {} }));

import { MeshCoreForwardingSection } from './MeshCoreForwardingSection';

const PHONE = 'aa11bb22cc33dd44ee55ff6600112233aa11bb22cc33dd44ee55ff6600112233';
const RULES = [{
  id: 'r1', name: 'DMs to phone', enabled: true,
  match: { isDM: true }, forwardTo: { destinationNodeId: PHONE }, prefix: '',
}];

describe('MeshCoreForwardingSection receive-only', () => {
  beforeEach(() => {
    hasPermissionMock.mockReset().mockReturnValue(true);
    csrfFetchMock.mockReset().mockImplementation((url: string) => {
      if (url.includes('/forwarding')) {
        return Promise.resolve({ ok: true, json: async () => ({ success: true, data: { rules: RULES } }) });
      }
      if (url.includes('/channels/all')) {
        return Promise.resolve({ ok: true, json: async () => ([{ id: 0, name: 'Public' }]) });
      }
      if (url.includes('/meshcore/contacts')) {
        return Promise.resolve({ ok: true, json: async () => ({ success: true, data: [{ publicKey: PHONE, advName: 'My Phone' }] }) });
      }
      return Promise.resolve({ ok: false, json: async () => ({}) });
    });
  });

  it('loads channels, contacts and rules for the source', async () => {
    render(<MeshCoreForwardingSection baseUrl="" sourceId="mc1" />);
    await screen.findByDisplayValue('DMs to phone');
    const urls = csrfFetchMock.mock.calls.map(c => c[0] as string);
    expect(urls).toContain('/api/sources/mc1/forwarding');
    expect(urls).toContain('/api/channels/all?sourceId=mc1');
    expect(urls).toContain('/api/sources/mc1/meshcore/contacts');
    await waitFor(() => expect(screen.getAllByText('My Phone').length).toBeGreaterThan(0));
  });

  it('renders the paused note when receiveOnly is true, and nothing when false', async () => {
    const { rerender } = render(<MeshCoreForwardingSection baseUrl="" sourceId="mc1" receiveOnly={false} />);
    await screen.findByDisplayValue('DMs to phone');
    expect(screen.queryByRole('status')).toBeNull();
    rerender(<MeshCoreForwardingSection baseUrl="" sourceId="mc1" receiveOnly />);
    expect(await screen.findByRole('status')).toHaveTextContent(/receive-only/i);
  });

  it('shows existing rules but disables editing when receive-only', async () => {
    render(<MeshCoreForwardingSection baseUrl="" sourceId="mc1" receiveOnly />);
    const name = await screen.findByDisplayValue('DMs to phone');
    expect(name).toBeDisabled();
    expect(screen.getByLabelText('Enable DMs to phone')).toBeDisabled();
  });
});
