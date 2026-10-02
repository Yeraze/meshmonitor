/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('../../services/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/api')>();
  return {
    ...actual,
    default: { exportMessagesCsv: vi.fn() },
  };
});

import apiService, { buildMessageExportQuery } from '../../services/api';
import MessageExportDialog from './MessageExportDialog';

const channels = [
  { name: 'LongFast', sources: [{ sourceId: 'a', sourceName: 'Alpha' }, { sourceId: 'b', sourceName: 'Bravo' }] },
  { name: 'ARES', sources: [{ sourceId: 'a', sourceName: 'Alpha' }] },
];

const exportMock = () => apiService.exportMessagesCsv as unknown as ReturnType<typeof vi.fn>;

describe('MessageExportDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    exportMock().mockResolvedValue(undefined);
  });

  it('exports every source and channel by default, omitting the lists', async () => {
    const onClose = vi.fn();
    render(<MessageExportDialog isOpen onClose={onClose} channels={channels} />);
    expect(screen.getByLabelText('Alpha')).toBeChecked();
    expect(screen.getByLabelText('Bravo')).toBeChecked();

    fireEvent.click(screen.getByText('unified.messages.export.submit'));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    const params = exportMock().mock.calls[0][0];
    expect(params.sources).toBeUndefined();
    expect(params.channels).toBeUndefined();
    expect(params.include).toEqual([]);
    expect(params.tz).toBeTruthy();
  });

  it('sends the chosen filters: sources, channel, keywords, dates in UTC ms', async () => {
    render(<MessageExportDialog isOpen onClose={vi.fn()} channels={channels} initialChannel="ARES" />);
    fireEvent.click(screen.getByLabelText('Bravo'));
    expect(screen.getByLabelText('ARES')).toBeChecked();

    fireEvent.change(screen.getByLabelText('unified.messages.export.include'), { target: { value: ' net , ICS-213,, ' } });
    fireEvent.change(screen.getByLabelText('unified.messages.export.exclude'), { target: { value: 'test' } });
    fireEvent.change(screen.getByLabelText('unified.messages.export.start'), { target: { value: '2026-10-03T08:00' } });
    fireEvent.change(screen.getByLabelText('unified.messages.export.end'), { target: { value: '2026-10-03T20:00' } });
    fireEvent.change(screen.getByLabelText('unified.messages.export.type'), { target: { value: 'channels' } });
    fireEvent.click(screen.getByLabelText('unified.messages.export.include_reactions'));

    fireEvent.click(screen.getByText('unified.messages.export.submit'));
    await waitFor(() => expect(exportMock()).toHaveBeenCalled());
    const params = exportMock().mock.calls[0][0];
    expect(params).toMatchObject({
      sources: ['a'],
      channels: ['ARES'],
      include: ['net', 'ICS-213'],
      exclude: ['test'],
      type: 'channels',
      includeReactions: true,
      start: new Date(2026, 9, 3, 8, 0).getTime(),
      end: new Date(2026, 9, 3, 20, 0).getTime(),
    });
  });

  it('blocks export with no source or a reversed range', () => {
    render(<MessageExportDialog isOpen onClose={vi.fn()} channels={channels} />);
    const submit = screen.getByText('unified.messages.export.submit').closest('button')!;
    fireEvent.change(screen.getByLabelText('unified.messages.export.start'), { target: { value: '2026-10-03T20:00' } });
    fireEvent.change(screen.getByLabelText('unified.messages.export.end'), { target: { value: '2026-10-03T08:00' } });
    expect(submit).toBeDisabled();
    expect(screen.getByText('unified.messages.export.range_invalid')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('unified.messages.export.end'), { target: { value: '' } });
    expect(submit).not.toBeDisabled();
    fireEvent.click(screen.getByLabelText('Alpha'));
    fireEvent.click(screen.getByLabelText('Bravo'));
    expect(submit).toBeDisabled();
  });

  it('shows the error and stays open when the export fails', async () => {
    exportMock().mockRejectedValue(new Error('Too many message exports'));
    const onClose = vi.fn();
    render(<MessageExportDialog isOpen onClose={onClose} channels={channels} />);
    fireEvent.click(screen.getByText('unified.messages.export.submit'));
    expect(await screen.findByRole('alert')).toHaveTextContent('unified.messages.export.error');
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe('buildMessageExportQuery', () => {
  it('repeats list keys and skips defaults', () => {
    const q = new URLSearchParams(buildMessageExportQuery({
      sources: ['a', 'b'],
      channels: ['Long, Fast'],
      include: ['net', '100%'],
      type: 'all',
      start: 1,
      includeReactions: false,
      tz: 'America/New_York',
    }));
    expect(q.getAll('source')).toEqual(['a', 'b']);
    expect(q.getAll('channel')).toEqual(['Long, Fast']);
    expect(q.getAll('include')).toEqual(['net', '100%']);
    expect(q.has('type')).toBe(false);
    expect(q.get('start')).toBe('1');
    expect(q.has('includeReactions')).toBe(false);
    expect(q.get('tz')).toBe('America/New_York');
  });
});
