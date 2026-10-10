/**
 * @vitest-environment jsdom
 */
/**
 * Node Details aircraft-mark menu entries (#5715): which entries show for a
 * node's state, the per-source permission gate, the excluded source types,
 * and what a click sends.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SourceProvider } from '../contexts/SourceContext';
import type { DeviceInfo } from '../types/device';

vi.mock('react-i18next', async () => {
  const { createReactI18nextMock } = await import('../test/mockI18n');
  return createReactI18nextMock();
});
const hasPermission = vi.fn();
vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ hasPermission, authStatus: { user: { id: 7 } } }),
}));
const showToast = vi.fn();
vi.mock('./ToastContainer', () => ({ useToast: () => ({ showToast }) }));
const post = vi.fn();
vi.mock('../services/api', () => ({ default: { post: (...a: unknown[]) => post(...a), setBaseUrl: vi.fn() } }));

import AircraftMarkMenuItems from './AircraftMarkMenuItems';

const node = (o: Partial<DeviceInfo> = {}): DeviceInfo => ({ nodeNum: 0x1234, user: { id: '!00001234' }, ...o } as DeviceInfo);

function renderItems(n: DeviceInfo, opts: { sourceId?: string | null; sourceType?: string } = {}) {
  const onDone = vi.fn();
  const qc = new QueryClient();
  render(
    <QueryClientProvider client={qc}>
      <SourceProvider sourceId={opts.sourceId === undefined ? 'src-a' : opts.sourceId} sourceType={opts.sourceType ?? 'meshtastic_tcp'}>
        <AircraftMarkMenuItems node={n} onDone={onDone} />
      </SourceProvider>
    </QueryClientProvider>,
  );
  return { onDone };
}

const shown = () => ({
  notAircraft: !!screen.queryByTestId('aircraft-mark-not-aircraft'),
  aircraft: !!screen.queryByTestId('aircraft-mark-aircraft'),
  clear: !!screen.queryByTestId('aircraft-mark-clear'),
});

beforeEach(() => {
  hasPermission.mockReset().mockReturnValue(true);
  post.mockReset().mockResolvedValue({ success: true });
  showToast.mockReset();
});

describe('AircraftMarkMenuItems — entries per state', () => {
  it('flagged node: "Mark as not aircraft" only', () => {
    renderItems(node({ likelyAircraft: true }));
    expect(shown()).toEqual({ notAircraft: true, aircraft: false, clear: false });
    expect(screen.getByText('Mark as not aircraft')).toBeTruthy();
  });

  it('flagged by hand: "Mark as not aircraft" and "Clear aircraft override"', () => {
    renderItems(node({ likelyAircraft: true, aircraftManualMark: 'aircraft' }));
    expect(shown()).toEqual({ notAircraft: true, aircraft: false, clear: true });
  });

  it('not flagged: "Mark as aircraft"; with any fixed mark, also "Clear"', () => {
    renderItems(node({ likelyAircraft: false }));
    expect(shown()).toEqual({ notAircraft: false, aircraft: true, clear: false });
  });

  it('marked not aircraft by hand: "Mark as aircraft" and "Clear"', () => {
    renderItems(node({ likelyAircraft: false, aircraftManualMark: 'not_aircraft', aircraftFixedAt: 1 }));
    expect(shown()).toEqual({ notAircraft: false, aircraft: true, clear: true });
  });

  it('never classified: nothing', () => {
    renderItems(node({}));
    expect(shown()).toEqual({ notAircraft: false, aircraft: false, clear: false });
  });
});

describe('AircraftMarkMenuItems — gates', () => {
  it('checks nodes:write on THIS source and hides everything without it', () => {
    hasPermission.mockReturnValue(false);
    renderItems(node({ likelyAircraft: true }));
    expect(hasPermission).toHaveBeenCalledWith('nodes', 'write', { sourceId: 'src-a' });
    expect(shown()).toEqual({ notAircraft: false, aircraft: false, clear: false });
  });

  it.each(['meshcore', 'meshcore_mqtt', 'reticulum'])('hides on a %s source', (type) => {
    renderItems(node({ likelyAircraft: true }), { sourceType: type });
    expect(shown().notAircraft).toBe(false);
  });

  it('hides outside a source', () => {
    renderItems(node({ likelyAircraft: true }), { sourceId: null });
    expect(shown().notAircraft).toBe(false);
  });
});

describe('AircraftMarkMenuItems — clicks', () => {
  it('posts the mode for this source and node, toasts, and closes the menu', async () => {
    const { onDone } = renderItems(node({ likelyAircraft: true }));
    fireEvent.click(screen.getByTestId('aircraft-mark-not-aircraft'));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(post).toHaveBeenCalledWith('/api/aircraft/mark', { sourceId: 'src-a', nodeNum: 0x1234, mode: 'not_aircraft' });
    expect(showToast).toHaveBeenCalledWith('Marked as not aircraft', 'success');
  });

  it('says why when the node has no position', async () => {
    post.mockRejectedValue(Object.assign(new Error('x'), { code: 'AIRCRAFT_NO_POSITION' }));
    const { onDone } = renderItems(node({ likelyAircraft: true }));
    fireEvent.click(screen.getByTestId('aircraft-mark-not-aircraft'));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(showToast.mock.calls[0][1]).toBe('error');
    expect(showToast.mock.calls[0][0]).toMatch(/no known position/);
  });

  it('clear sends mode "clear"', async () => {
    const { onDone } = renderItems(node({ likelyAircraft: false, aircraftFixedAt: 1 }));
    fireEvent.click(screen.getByTestId('aircraft-mark-clear'));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(post).toHaveBeenCalledWith('/api/aircraft/mark', { sourceId: 'src-a', nodeNum: 0x1234, mode: 'clear' });
  });
});
