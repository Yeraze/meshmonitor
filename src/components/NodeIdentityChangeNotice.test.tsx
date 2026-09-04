/**
 * NodeIdentityChangeNotice + useNodeIdentityChanges (#5032).
 *
 * Covers the two things the Node Details notice must get right: it renders for
 * BOTH halves of a pair with the wording flipped, and it renders nothing at all
 * for every other node — a notice that appears on unrelated nodes would push
 * operators toward merging histories that were never related.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { NodeIdentityChangeNotice } from './NodeIdentityChangeNotice';
import apiService from '../services/api';
import type { IdentityChangeDetection, IdentityChangeReport } from '../types/nodeIdentityChange';

vi.mock('../services/api', () => ({
  default: { getNodeIdentityChanges: vi.fn() },
}));

const OLD_NUM = 0x433d1ba4;
const NEW_NUM = 3649751816;

const detection: IdentityChangeDetection = {
  successor: {
    nodeNum: NEW_NUM,
    nodeId: '!d992eb08',
    longName: 'Base Station',
    shortName: 'BASE',
    hwModel: 43,
    firmwareVersion: '2.8.0.47db0e3',
    lastHeard: 1000,
    createdAt: 900,
    hasPublicKey: true,
  },
  predecessor: {
    nodeNum: OLD_NUM,
    nodeId: '!433d1ba4',
    longName: 'Base Station',
    shortName: 'BASE',
    hwModel: 43,
    firmwareVersion: '2.7.11',
    lastHeard: 500,
    createdAt: 100,
    hasPublicKey: true,
  },
  basis: 'derivedNodeNum',
  confidence: 'high',
  derivedFromPredecessorKey: true,
  successorNodeNumIsKeyDerived: true,
  predecessorNodeNumIsKeyDerived: false,
  publicKeyMatches: true,
  nameMatches: true,
  hwModelMatches: true,
  successorFirmwareIs28OrLater: true,
  predecessorQuietForSeconds: 2 * 86400,
  handoverGapSeconds: 400,
  otherCandidateCount: 0,
};

const report: IdentityChangeReport = {
  sourceId: 'src-a',
  detections: [detection],
  truncated: false,
  options: { appearWindowSeconds: 1, quietLookbackSeconds: 1, graceSeconds: 1, minQuietSeconds: 1 },
};

function renderNotice(nodeNum: number | null, sourceId: string | null = 'src-a') {
  // A fresh client per render: the hook caches by sourceId, and a shared cache
  // would let one test's data satisfy the next one's assertions.
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <NodeIdentityChangeNotice nodeNum={nodeNum} sourceId={sourceId} />
    </QueryClientProvider>,
  );
}

describe('NodeIdentityChangeNotice', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(apiService.getNodeIdentityChanges).mockResolvedValue(report);
  });

  it('explains the change on the NEW node, pointing back at the old one', async () => {
    renderNotice(NEW_NUM);
    const notice = await screen.findByTestId('node-identity-change-notice');
    expect(notice).toHaveAttribute('data-role', 'successor');
  });

  it('explains the change on the OLD node too, pointing forward', async () => {
    // Half the point of the feature: the operator is looking at the node that
    // went dark, not the new one.
    renderNotice(OLD_NUM);
    const notice = await screen.findByTestId('node-identity-change-notice');
    expect(notice).toHaveAttribute('data-role', 'predecessor');
  });

  it('renders nothing for an unrelated node', async () => {
    renderNotice(999999);
    await waitFor(() => expect(apiService.getNodeIdentityChanges).toHaveBeenCalled());
    expect(screen.queryByTestId('node-identity-change-notice')).not.toBeInTheDocument();
  });

  it('offers no action — it must not be one click from merging two histories', async () => {
    renderNotice(NEW_NUM);
    await screen.findByTestId('node-identity-change-notice');
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('does not query without a source — detection never crosses sources', () => {
    renderNotice(NEW_NUM, null);
    expect(apiService.getNodeIdentityChanges).not.toHaveBeenCalled();
    expect(screen.queryByTestId('node-identity-change-notice')).not.toBeInTheDocument();
  });

  it('renders nothing when the report is empty', async () => {
    vi.mocked(apiService.getNodeIdentityChanges).mockResolvedValue({ ...report, detections: [] });
    renderNotice(NEW_NUM);
    await waitFor(() => expect(apiService.getNodeIdentityChanges).toHaveBeenCalled());
    expect(screen.queryByTestId('node-identity-change-notice')).not.toBeInTheDocument();
  });

  it('stays silent when the request fails rather than guessing', async () => {
    vi.mocked(apiService.getNodeIdentityChanges).mockRejectedValue(new Error('403'));
    renderNotice(NEW_NUM);
    await waitFor(() => expect(apiService.getNodeIdentityChanges).toHaveBeenCalled());
    expect(screen.queryByTestId('node-identity-change-notice')).not.toBeInTheDocument();
  });
});
