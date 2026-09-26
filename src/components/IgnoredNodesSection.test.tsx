/**
 * @vitest-environment jsdom
 *
 * Ignored Nodes reason labels (#5364/#5365 Phase 2): the aircraft age-out
 * sweep's rows read "Aged-out aircraft", next to the existing Manual and Geo
 * filter labels.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import IgnoredNodesSection from './IgnoredNodesSection';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, def?: unknown, opts?: Record<string, unknown>) => {
      const text = typeof def === 'string' ? def : key;
      return text.replace(/\{\{(\w+)\}\}/g, (_m, n) => String(opts?.[n] ?? ''));
    },
  }),
}));
vi.mock('./ToastContainer', () => ({ useToast: () => ({ showToast: vi.fn() }) }));
vi.mock('../contexts/SourceContext', () => ({ useSource: () => ({ sourceId: 'src-1' }) }));

const rows = [
  { nodeNum: 1, sourceId: 'src-1', nodeId: '!00000001', longName: 'Plane', shortName: 'PL', ignoredAt: 1, ignoredBy: 'aircraft-age-out', reason: 'aircraft' },
  { nodeNum: 2, sourceId: 'src-1', nodeId: '!00000002', longName: 'Far', shortName: 'FA', ignoredAt: 1, ignoredBy: 'geo', reason: 'geo' },
  { nodeNum: 3, sourceId: 'src-1', nodeId: '!00000003', longName: 'Spam', shortName: 'SP', ignoredAt: 1, ignoredBy: 'admin', reason: 'manual' },
];
vi.mock('../hooks/useCsrfFetch', () => ({
  useCsrfFetch: () => vi.fn().mockResolvedValue({ ok: true, json: async () => rows }),
}));

describe('IgnoredNodesSection reason labels', () => {
  it('labels aircraft, geo and manual rows', async () => {
    render(<IgnoredNodesSection baseUrl="" />);
    expect(await screen.findByTestId('ignored-reason-1')).toHaveTextContent('Aged-out aircraft');
    expect(screen.getByTestId('ignored-reason-2')).toHaveTextContent('Geo filter');
    expect(screen.getByTestId('ignored-reason-3')).toHaveTextContent('Manual');
  });

  it('does not count aircraft rows as manual in the summary', async () => {
    render(<IgnoredNodesSection baseUrl="" />);
    await screen.findByTestId('ignored-reason-1');
    expect(screen.getByText(/3 ignored · 1 geo · 1 manual · 1 aged-out aircraft/)).toBeInTheDocument();
  });
});
