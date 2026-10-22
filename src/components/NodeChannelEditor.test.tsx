// @vitest-environment jsdom
/**
 * NodeChannelEditor (#5923): set, clear and lock a node's channel.
 * The test i18n mock returns keys, so queries use them.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import NodeChannelEditor from './NodeChannelEditor';

const CHANNELS = [
  { id: 0, name: 'LongFast' },
  { id: 2, name: 'Private' },
];

describe('NodeChannelEditor', () => {
  it('shows the channel and a lock badge only when locked', () => {
    const { rerender } = render(
      <NodeChannelEditor channel={2} locked={false} channels={CHANNELS} onSave={vi.fn()} />,
    );
    expect(screen.getByText('2 (Private)')).toBeTruthy();
    expect(screen.queryByText('node_details.channel_locked')).toBeNull();

    rerender(<NodeChannelEditor channel={2} locked channels={CHANNELS} onSave={vi.fn()} />);
    expect(screen.getByText('node_details.channel_locked')).toBeTruthy();
  });

  it('shows None when no channel is recorded', () => {
    render(<NodeChannelEditor channel={undefined} locked={false} channels={CHANNELS} onSave={vi.fn()} />);
    expect(screen.getByText('node_details.channel_none')).toBeTruthy();
  });

  it('clears the channel and locks it', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<NodeChannelEditor channel={2} locked={false} channels={CHANNELS} onSave={onSave} />);
    fireEvent.click(screen.getByText('common.edit'));
    fireEvent.change(screen.getByLabelText('node_details.channel'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByText('common.save'));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith(null, true));
    await waitFor(() => expect(screen.queryByRole('checkbox')).toBeNull());
  });

  it('sets a channel number', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<NodeChannelEditor channel={2} locked channels={CHANNELS} onSave={onSave} />);
    fireEvent.click(screen.getByText('common.edit'));
    expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(true);
    fireEvent.change(screen.getByLabelText('node_details.channel'), { target: { value: '0' } });
    fireEvent.click(screen.getByText('common.save'));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith(0, true));
  });

  it('offers a stored channel the source no longer lists', () => {
    render(<NodeChannelEditor channel={5} locked={false} channels={CHANNELS} onSave={vi.fn()} />);
    fireEvent.click(screen.getByText('common.edit'));
    const values = Array.from((screen.getByLabelText('node_details.channel') as HTMLSelectElement).options).map(o => o.value);
    expect(values).toEqual(['', '0', '2', '5']);
  });

  it('keeps the editor open and shows the error when saving fails', async () => {
    const onSave = vi.fn().mockRejectedValue(new Error('Forbidden'));
    render(<NodeChannelEditor channel={2} locked={false} channels={CHANNELS} onSave={onSave} />);
    fireEvent.click(screen.getByText('common.edit'));
    fireEvent.click(screen.getByText('common.save'));
    await waitFor(() => expect(screen.getByText('Forbidden')).toBeTruthy());
    expect(screen.getByRole('checkbox')).toBeTruthy();
  });

  it('cancel discards the draft', () => {
    const onSave = vi.fn();
    render(<NodeChannelEditor channel={2} locked={false} channels={CHANNELS} onSave={onSave} />);
    fireEvent.click(screen.getByText('common.edit'));
    fireEvent.change(screen.getByLabelText('node_details.channel'), { target: { value: '0' } });
    fireEvent.click(screen.getByText('common.cancel'));
    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByText('2 (Private)')).toBeTruthy();
  });
});
