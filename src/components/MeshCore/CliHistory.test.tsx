/**
 * MeshCore CLI history UI (#5892): the console History panel and the unified
 * CLI activity view.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import { CliHistoryPanel } from './CliHistoryPanel';
import { MeshCoreCliActivity } from './MeshCoreCliActivity';
import apiService from '../../services/api';

vi.mock('../../services/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/api')>();
  return { ...actual, default: { get: vi.fn() } };
});

const KEY = 'ab'.repeat(32);
const entry = (over: Record<string, unknown> = {}) => ({
  id: 1,
  sourceId: 'src-a',
  timestamp: 1_700_000_000_000,
  targetKind: 'remote',
  targetPublicKey: KEY,
  targetName: 'Hill Repeater',
  origin: 'user',
  userId: 2,
  username: 'alice',
  command: 'ver',
  outcome: 'ok',
  reply: 'v1.9.0',
  error: null,
  elapsedMs: 420,
  ipAddress: null,
  ...over,
});

const get = apiService.get as unknown as ReturnType<typeof vi.fn>;

describe('CliHistoryPanel', () => {
  beforeEach(() => get.mockReset());

  it('loads nothing until opened, then shows this target\'s rows', async () => {
    get.mockResolvedValue({ success: true, data: { entries: [entry()], nextBefore: null } });
    render(<CliHistoryPanel sourceId="src-a" target={KEY} />);
    expect(get).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /meshcore\.cliHistory\.title/ }));
    await waitFor(() => expect(screen.getByText('ver')).toBeInTheDocument());
    expect(get).toHaveBeenCalledWith(`/api/sources/src-a/meshcore/cli-history?target=${KEY}&limit=25`);
    expect(screen.getByText('alice')).toBeInTheDocument();
    expect(screen.getByText('meshcore.cliHistory.outcome_ok')).toBeInTheDocument();

    // Expanding a row shows its reply.
    fireEvent.click(screen.getByText('ver'));
    expect(screen.getByText('v1.9.0')).toBeInTheDocument();
  });

  it('pages back with Load more', async () => {
    get
      .mockResolvedValueOnce({ success: true, data: { entries: [entry({ id: 1, command: 'one', timestamp: 500 })], nextBefore: 500 } })
      .mockResolvedValueOnce({ success: true, data: { entries: [entry({ id: 2, command: 'two', timestamp: 400 })], nextBefore: null } });
    render(<CliHistoryPanel sourceId="src-a" target="local" />);
    fireEvent.click(screen.getByRole('button', { name: /meshcore\.cliHistory\.title/ }));
    await waitFor(() => expect(screen.getByText('one')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /meshcore\.cliHistory\.load_more/ }));
    await waitFor(() => expect(screen.getByText('two')).toBeInTheDocument());
    expect(get).toHaveBeenLastCalledWith('/api/sources/src-a/meshcore/cli-history?target=local&limit=25&before=500');
    expect(screen.getByText('one')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /meshcore\.cliHistory\.load_more/ })).toBeNull();
  });

  it('shows the empty state', async () => {
    get.mockResolvedValue({ success: true, data: { entries: [], nextBefore: null } });
    render(<CliHistoryPanel sourceId="src-a" target="local" />);
    fireEvent.click(screen.getByRole('button', { name: /meshcore\.cliHistory\.title/ }));
    await waitFor(() => expect(screen.getByText('meshcore.cliHistory.empty')).toBeInTheDocument());
  });
});

describe('MeshCoreCliActivity', () => {
  beforeEach(() => get.mockReset());

  it('lists rows across sources with source names and a VN client label', async () => {
    get.mockResolvedValue({
      success: true,
      data: {
        entries: [
          entry({ id: 1, sourceId: 'src-a', command: 'ver' }),
          entry({ id: 2, sourceId: 'src-b', origin: 'vn', username: 'vn:abc', ipAddress: '10.0.0.9', command: 'get name' }),
        ],
        nextBefore: null,
        sources: [{ id: 'src-a', name: 'Alpha' }, { id: 'src-b', name: 'Bravo' }],
      },
    });
    render(<MeshCoreCliActivity />);
    await waitFor(() => expect(screen.getByText('get name')).toBeInTheDocument());
    expect(get).toHaveBeenCalledWith('/api/meshcore/cli-history?limit=50');
    expect(screen.getByText('meshcore.cliHistory.vn_client (10.0.0.9)')).toBeInTheDocument();
    expect(screen.getAllByText('Bravo').length).toBeGreaterThan(0);
  });

  it('re-queries when the source filter changes', async () => {
    get.mockResolvedValue({
      success: true,
      data: { entries: [], nextBefore: null, sources: [{ id: 'src-a', name: 'Alpha' }] },
    });
    render(<MeshCoreCliActivity />);
    await waitFor(() => expect(screen.getByRole('option', { name: 'Alpha' })).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText('meshcore.cliHistory.filter_source'), { target: { value: 'src-a' } });
    await waitFor(() => expect(get).toHaveBeenLastCalledWith('/api/meshcore/cli-history?limit=50&source=src-a'));
  });
});
