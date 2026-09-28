/**
 * @vitest-environment jsdom
 *
 * MeshCore Settings — message filters section (#5408).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: string | Record<string, unknown>) => {
      if (typeof opts === 'string') return opts;
      return key;
    },
  }),
}));

const { hasPermission, api } = vi.hoisted(() => ({
  hasPermission: vi.fn((_r: string, _a: string) => true),
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() },
}));
vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({ hasPermission }),
}));

vi.mock('../../services/api', () => ({ default: api }));

import { MeshCoreMessageFiltersSection } from './MeshCoreMessageFiltersSection';

const RULE = {
  id: 'r1', sourceId: 'src-a', mode: 'block', matchType: 'wildcard', pattern: '*spam*',
  caseSensitive: false, fields: 'both', enabled: true, createdAt: 1, createdBy: null,
  hitCount: 7, lastHitAt: null,
};

function renderSection() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <QueryClientProvider client={client}>
      <MeshCoreMessageFiltersSection sourceId="src-a" />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  hasPermission.mockReturnValue(true);
  api.get.mockResolvedValue({ success: true, data: [RULE] });
});

describe('MeshCoreMessageFiltersSection', () => {
  it('lists rules with their hit counts', async () => {
    renderSection();
    expect(await screen.findByText('*spam*')).toBeTruthy();
    expect(screen.getByText('7')).toBeTruthy();
    expect(api.get).toHaveBeenCalledWith('/api/sources/src-a/meshcore/message-filters');
  });

  it('shows the server RE2 error inline and keeps the form open', async () => {
    api.post.mockRejectedValue(new Error('Invalid regular expression: invalid perl operator: (?='));
    renderSection();
    await screen.findByText('*spam*');
    fireEvent.click(screen.getByText('Add filter'));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '(?=x)' } });
    fireEvent.change(screen.getAllByRole('combobox')[0], { target: { value: 'regex' } });
    fireEvent.click(screen.getByText('Save'));
    expect((await screen.findByRole('alert')).textContent).toMatch(/Invalid regular expression/);
    expect(api.post).toHaveBeenCalledWith('/api/sources/src-a/meshcore/message-filters', expect.objectContaining({
      pattern: '(?=x)', matchType: 'regex', mode: 'ignore', fields: 'both', caseSensitive: false, enabled: true,
    }));
    expect(screen.getByRole('textbox')).toBeTruthy();
  });

  it('toggles a rule on and off', async () => {
    api.put.mockResolvedValue({ success: true, data: { ...RULE, enabled: false } });
    renderSection();
    await screen.findByText('*spam*');
    fireEvent.click(screen.getByRole('checkbox'));
    await waitFor(() => expect(api.put).toHaveBeenCalledWith('/api/sources/src-a/meshcore/message-filters/r1', { enabled: false }));
  });

  it('hides write controls without messages:write', async () => {
    hasPermission.mockImplementation((_r: string, action: string) => action === 'read');
    renderSection();
    await screen.findByText('*spam*');
    expect(screen.queryByText('Add filter')).toBeNull();
    expect((screen.getByRole('checkbox') as HTMLInputElement).disabled).toBe(true);
  });
});
