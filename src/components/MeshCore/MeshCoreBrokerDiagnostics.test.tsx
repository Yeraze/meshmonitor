/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

const get = vi.fn();
vi.mock('../../services/api', () => ({ default: { get: (...a: unknown[]) => get(...a) } }));
vi.mock('react-i18next', async () => {
  const { createReactI18nextMock } = await import('../../test/mockI18n');
  return createReactI18nextMock();
});

import { MeshCoreBrokerDiagnostics } from './MeshCoreBrokerDiagnostics';

const KEY = 'AB'.repeat(32);

describe('MeshCoreBrokerDiagnostics', () => {
  beforeEach(() => get.mockReset());

  it('shows each connection\'s last topic and a readable last reject reason', async () => {
    get.mockResolvedValue({
      data: {
        running: true,
        listening: true,
        port: 1884,
        clientCount: 1,
        lastError: null,
        limits: { maxClients: 50, maxMessagesPerSecond: 20, maxPayloadBytes: 65536 },
        totals: { received: 2, accepted: 1, rejected: 1, rateDropped: 0, authRejected: 0 },
        connections: [
          {
            clientId: 'c1',
            remoteAddress: null,
            authMode: 'token',
            observerKey: KEY,
            connectedAt: 1,
            received: 2,
            accepted: 1,
            rejected: 1,
            rateDropped: 0,
            lastTopic: `meshcore/SEA/${KEY}/packets`,
            lastRejectReason: 'missing_raw',
            lastRejectAt: 2,
          },
        ],
        recent: [],
        forwarding: [],
      },
    });
    render(<MeshCoreBrokerDiagnostics sourceId="s1" />);
    expect(await screen.findByText(`meshcore/SEA/${KEY}/packets`)).toBeTruthy();
    expect(screen.getByText('Dropped (raw is missing)')).toBeTruthy();
    expect(get).toHaveBeenCalledWith('/api/sources/s1/meshcore-broker/diagnostics');
  });

  it('says so when the broker is not running', async () => {
    get.mockResolvedValue({ data: { running: false } });
    render(<MeshCoreBrokerDiagnostics sourceId="s1" />);
    expect(await screen.findByText('The broker is not running.')).toBeTruthy();
  });
});
