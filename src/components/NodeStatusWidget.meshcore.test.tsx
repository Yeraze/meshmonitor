/**
 * @vitest-environment jsdom
 *
 * NodeStatusWidget renders a MeshCore-adapted node and never asks the
 * Meshtastic-only telemetry route for a voltage (#6263 S6).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { render, screen } from '@testing-library/react';

vi.mock('@dnd-kit/sortable', () => ({
  useSortable: () => ({ attributes: {}, listeners: {}, setNodeRef: vi.fn(), transform: null, transition: null, isDragging: false }),
}));
vi.mock('@dnd-kit/utilities', () => ({ CSS: { Transform: { toString: () => null } } }));
vi.mock('react-i18next', async () => {
  const { createReactI18nextMock } = await import('../test/mockI18n');
  return createReactI18nextMock((key: string) => key);
});
const useNodeVoltages = vi.fn((_o: { nodeIds: string[] }) => new Map<string, number>());
vi.mock('../hooks/useTelemetry', () => ({
  useNodeVoltages: (o: { nodeIds: string[] }) => useNodeVoltages(o),
}));

import NodeStatusWidget from './NodeStatusWidget';
import { meshcoreDashboardSource } from './Dashboard/dataSources';
import api from '../services/api';

vi.mock('../services/api', () => ({ default: { get: vi.fn() } }));

const KEY = 'ab'.repeat(32);

describe('NodeStatusWidget with a MeshCore node', () => {
  beforeEach(() => {
    useNodeVoltages.mockClear();
  });

  async function adapted() {
    (api.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      data: [{ publicKey: KEY, name: 'Hill Repeater', advType: 2, lastHeard: Date.now() - 120_000, pathLen: 2, batteryMv: 3900, uptimeSecs: 3700, snr: 4, rssi: -100 }],
    });
    const list = await meshcoreDashboardSource.fetchNodes('s');
    return new Map(list.map((n) => [n.user!.id as string, n]));
  }

  it('shows name, hops, voltage and uptime from the adapted row', async () => {
    const nodes = await adapted();
    render(
      <NodeStatusWidget id="w" nodeIds={[KEY]} nodes={nodes as never} baseUrl="" onRemove={vi.fn()} onAddNode={vi.fn()} onRemoveNode={vi.fn()} voltageFallback={false} />,
    );
    expect(screen.getByText('Hill Repeater')).toBeTruthy();
    expect(screen.getByText(/3\.9/)).toBeTruthy();
    expect(screen.getByText(/1h 1m/)).toBeTruthy();
    expect(screen.getByText('common.minutes_ago:2'.replace(':2', ''), { exact: false })).toBeTruthy();
  });

  it('asks for no fallback voltages when voltageFallback is off', async () => {
    const nodes = await adapted();
    nodes.get(KEY)!.hopsAway = undefined;
    (nodes.get(KEY) as { deviceMetrics?: unknown }).deviceMetrics = undefined;
    render(
      <NodeStatusWidget id="w" nodeIds={[KEY]} nodes={nodes as never} baseUrl="" onRemove={vi.fn()} onAddNode={vi.fn()} onRemoveNode={vi.fn()} voltageFallback={false} />,
    );
    expect(useNodeVoltages).toHaveBeenLastCalledWith(expect.objectContaining({ nodeIds: [] }));
  });

  it('still asks by default (Meshtastic)', async () => {
    const nodes = await adapted();
    (nodes.get(KEY) as { deviceMetrics?: unknown }).deviceMetrics = undefined;
    render(
      <NodeStatusWidget id="w" nodeIds={[KEY]} nodes={nodes as never} baseUrl="" onRemove={vi.fn()} onAddNode={vi.fn()} onRemoveNode={vi.fn()} />,
    );
    expect(useNodeVoltages).toHaveBeenLastCalledWith(expect.objectContaining({ nodeIds: [KEY] }));
  });
});
