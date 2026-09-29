/**
 * @vitest-environment jsdom
 *
 * Node Details Ignore / Block controls (#5408).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('react-i18next', async () => {
  const { createReactI18nextMock } = await import('../../test/mockI18n');
  return createReactI18nextMock();
});

import { MeshCoreIgnoreBlockControls } from './MeshCoreIgnoreBlockControls';

const KEY = 'ab'.repeat(32);

afterEach(() => {
  vi.restoreAllMocks();
});

describe('MeshCoreIgnoreBlockControls', () => {
  it('offers Ignore and Block when the node has no entry', async () => {
    const onSet = vi.fn().mockResolvedValue(undefined);
    render(<MeshCoreIgnoreBlockControls publicKey={KEY} mode={null} canWrite onSet={onSet} onRemove={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /Ignore/ }));
    await waitFor(() => expect(onSet).toHaveBeenCalledWith('ignore'));
  });

  it('asks before blocking, and does nothing when cancelled', async () => {
    const onSet = vi.fn().mockResolvedValue(undefined);
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);
    render(<MeshCoreIgnoreBlockControls publicKey={KEY} mode={null} canWrite onSet={onSet} onRemove={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /Block/ }));
    expect(onSet).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /Block/ }));
    await waitFor(() => expect(onSet).toHaveBeenCalledWith('block'));
    expect(confirm).toHaveBeenCalledTimes(2);
  });

  it('shows the status and a remove button for a listed node', async () => {
    const onRemove = vi.fn().mockResolvedValue(undefined);
    render(<MeshCoreIgnoreBlockControls publicKey={KEY} mode="block" canWrite onSet={vi.fn()} onRemove={onRemove} />);
    expect(screen.getByRole('status').textContent).toContain('Blocked');
    expect(screen.queryByRole('button', { name: /^Ignore$/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Remove from ignore\/block list/ }));
    await waitFor(() => expect(onRemove).toHaveBeenCalled());
  });

  it('shows the save error inline', async () => {
    const onSet = vi.fn().mockRejectedValue(new Error('nope'));
    render(<MeshCoreIgnoreBlockControls publicKey={KEY} mode={null} canWrite onSet={onSet} onRemove={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /Ignore/ }));
    expect((await screen.findByRole('alert')).textContent).toBe('nope');
  });

  it('renders nothing for a read-only user when the node has no entry', () => {
    const { container } = render(<MeshCoreIgnoreBlockControls publicKey={KEY} mode={null} canWrite={false} onSet={vi.fn()} onRemove={vi.fn()} />);
    expect(container.innerHTML).toBe('');
  });
});
