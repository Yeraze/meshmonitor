/**
 * @vitest-environment jsdom
 *
 * NodeInfoEnrichmentReport — cross-source NodeInfo enrichment analysis + apply
 * (#3837 Phase 2 WP-2). Covers loading/error/empty/populated states, per-row
 * Fix, Fix All, the push-to-NodeDB toggle, and apply-error surfacing.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// Override the global i18n mock (src/test/setup.ts) — that mock's `t(key, options)`
// signature doesn't understand this component's real i18next-style
// `t(key, defaultValue, options)` calls, so string assertions here need a
// local mock that returns the default value (with {{var}} interpolation from
// the options arg), matching the AutoPingSection.test.tsx precedent.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, defaultValue?: string, options?: Record<string, unknown>) => {
      let result = typeof defaultValue === 'string' ? defaultValue : key;
      if (options) {
        Object.entries(options).forEach(([k, v]) => {
          result = result.replace(`{{${k}}}`, String(v));
        });
      }
      return result;
    },
    i18n: { changeLanguage: vi.fn(), language: 'en' },
  }),
  Trans: ({ children }: { children: React.ReactNode }) => children,
  initReactI18next: { type: '3rdParty', init: vi.fn() },
}));

vi.mock('../../services/api', async (orig) => {
  const actual = await orig<typeof import('../../services/api')>();
  return {
    __esModule: true,
    default: { get: vi.fn(), post: vi.fn() },
    ApiError: actual.ApiError,
  };
});

import api, { ApiError } from '../../services/api';
import { ToastProvider } from '../ToastContainer';
import NodeInfoEnrichmentReport from './NodeInfoEnrichmentReport';

function renderReport() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <NodeInfoEnrichmentReport />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

const emptyAnalysis = {
  success: true,
  data: { nodes: [], summary: { nodeCount: 0, targetCount: 0, fieldCount: 0 } },
};

function oneNodeAnalysis() {
  return {
    success: true,
    data: {
      nodes: [
        {
          nodeNum: 123456,
          nodeId: '!0001e240',
          displayName: 'Base Station',
          targets: [
            {
              targetSourceId: 'src-b',
              targetSourceName: 'MQTT',
              fillableFields: ['longName', 'hwModel', 'role'],
              donorSourceId: 'src-a',
              donorSourceName: 'Primary TCP',
            },
          ],
        },
      ],
      summary: { nodeCount: 1, targetCount: 1, fieldCount: 3 },
    },
  };
}

function twoRowAnalysis() {
  return {
    success: true,
    data: {
      nodes: [
        {
          nodeNum: 111,
          nodeId: '!0000006f',
          displayName: 'Node A',
          targets: [
            {
              targetSourceId: 'src-b',
              targetSourceName: 'MQTT',
              fillableFields: ['longName'],
              donorSourceId: 'src-a',
              donorSourceName: 'Primary TCP',
            },
          ],
        },
        {
          nodeNum: 222,
          nodeId: '!000000de',
          displayName: 'Node B',
          targets: [
            {
              targetSourceId: 'src-c',
              targetSourceName: 'MeshCore',
              fillableFields: ['hwModel'],
              donorSourceId: 'src-a',
              donorSourceName: 'Primary TCP',
            },
          ],
        },
      ],
      summary: { nodeCount: 2, targetCount: 2, fieldCount: 2 },
    },
  };
}

describe('NodeInfoEnrichmentReport', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the loading banner while the analysis query is pending', async () => {
    vi.mocked(api.get).mockReturnValue(new Promise(() => {}));
    renderReport();
    expect(await screen.findByText(/Analyzing NodeInfo across sources/i)).toBeInTheDocument();
  });

  it('renders the empty state with the muted sign-in hint when there are no rows', async () => {
    vi.mocked(api.get).mockResolvedValue(emptyAnalysis);
    renderReport();
    expect(await screen.findByText(/No nodes need enrichment\./i)).toBeInTheDocument();
    expect(screen.getByText(/sign in to see more/i)).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('renders populated rows, field labels, source names, and summary counts', async () => {
    vi.mocked(api.get).mockResolvedValue(oneNodeAnalysis());
    const { container } = renderReport();

    expect(await screen.findByText('Base Station')).toBeInTheDocument();
    expect(screen.getByText('!0001e240')).toBeInTheDocument();
    expect(screen.getByText('Long Name')).toBeInTheDocument();
    expect(screen.getByText('Hardware Model')).toBeInTheDocument();
    expect(screen.getByText('Role')).toBeInTheDocument();
    expect(screen.getByText('MQTT')).toBeInTheDocument();
    expect(screen.getByText('Primary TCP')).toBeInTheDocument();

    // summary stats: 1 node / 1 target / 3 fillable fields
    const statValues = Array.from(container.querySelectorAll('.reports-stat__value')).map(
      (el) => el.textContent,
    );
    expect(statValues).toEqual(['1', '1', '3']);
  });

  it('Fix posts a single-item batch with pushToNodeDb:false by default and refetches on success', async () => {
    const user = userEvent.setup();
    vi.mocked(api.get).mockResolvedValue(oneNodeAnalysis());
    vi.mocked(api.post).mockResolvedValue({
      success: true,
      data: {
        applied: [
          {
            nodeNum: 123456,
            targetSourceId: 'src-b',
            donorSourceId: 'src-a',
            copiedFields: ['longName', 'hwModel', 'role'],
            pushedToDevice: false,
          },
        ],
        totalFieldsCopied: 3,
      },
    });

    renderReport();
    await screen.findByText('Base Station');

    await user.click(screen.getByRole('button', { name: /^Fix$/i }));

    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1));
    expect(api.post).toHaveBeenCalledWith('/api/nodes/enrichment/apply', {
      items: [{ nodeNum: 123456, targetSourceId: 'src-b', donorSourceId: 'src-a' }],
      pushToNodeDb: false,
    });

    expect(await screen.findByText(/Copied 3 field\(s\) across 1 target\(s\)/i)).toBeInTheDocument();
    // invalidation causes a refetch of the analysis query
    await waitFor(() => expect(api.get).toHaveBeenCalledTimes(2));
  });

  it('toggling the push option sends pushToNodeDb:true in the apply body', async () => {
    const user = userEvent.setup();
    vi.mocked(api.get).mockResolvedValue(oneNodeAnalysis());
    vi.mocked(api.post).mockResolvedValue({
      success: true,
      data: {
        applied: [
          {
            nodeNum: 123456,
            targetSourceId: 'src-b',
            donorSourceId: 'src-a',
            copiedFields: ['longName'],
            pushedToDevice: true,
          },
        ],
        totalFieldsCopied: 1,
      },
    });

    renderReport();
    await screen.findByText('Base Station');

    const toggle = screen.getByRole('checkbox', { name: /Also push to device NodeDB/i });
    expect(toggle).not.toBeChecked();
    await user.click(toggle);
    expect(toggle).toBeChecked();

    await user.click(screen.getByRole('button', { name: /^Fix$/i }));

    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1));
    expect(api.post).toHaveBeenCalledWith('/api/nodes/enrichment/apply', {
      items: [{ nodeNum: 123456, targetSourceId: 'src-b', donorSourceId: 'src-a' }],
      pushToNodeDb: true,
    });
  });

  it('Fix All posts every row item in one batch call', async () => {
    const user = userEvent.setup();
    vi.mocked(api.get).mockResolvedValue(twoRowAnalysis());
    vi.mocked(api.post).mockResolvedValue({
      success: true,
      data: {
        applied: [
          { nodeNum: 111, targetSourceId: 'src-b', donorSourceId: 'src-a', copiedFields: ['longName'], pushedToDevice: false },
          { nodeNum: 222, targetSourceId: 'src-c', donorSourceId: 'src-a', copiedFields: ['hwModel'], pushedToDevice: false },
        ],
        totalFieldsCopied: 2,
      },
    });

    renderReport();
    await screen.findByText('Node A');
    await screen.findByText('Node B');

    await user.click(screen.getByRole('button', { name: /Fix All/i }));

    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1));
    const [, body] = vi.mocked(api.post).mock.calls[0];
    expect(body.items).toHaveLength(2);
    expect(body.items).toEqual(
      expect.arrayContaining([
        { nodeNum: 111, targetSourceId: 'src-b', donorSourceId: 'src-a' },
        { nodeNum: 222, targetSourceId: 'src-c', donorSourceId: 'src-a' },
      ]),
    );
  });

  it('surfaces an apply error via toast and keeps the table intact', async () => {
    const user = userEvent.setup();
    vi.mocked(api.get).mockResolvedValue(oneNodeAnalysis());
    vi.mocked(api.post).mockRejectedValue(
      new ApiError('Insufficient permission', 403, { code: 'FORBIDDEN' }),
    );

    renderReport();
    await screen.findByText('Base Station');

    await user.click(screen.getByRole('button', { name: /^Fix$/i }));

    expect(await screen.findByText('Insufficient permission')).toBeInTheDocument();
    expect(screen.getByText('Base Station')).toBeInTheDocument();
  });

  it('renders the error banner when the analysis query rejects', async () => {
    vi.mocked(api.get).mockRejectedValue(new Error('network exploded'));
    renderReport();
    expect(await screen.findByText(/network exploded/i)).toBeInTheDocument();
  });
});
