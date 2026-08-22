/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import ToolbarMenu, { ToolbarMenuItem } from './ToolbarMenu';
import { Eye } from 'lucide-react';

describe('ToolbarMenu', () => {
  it('is closed by default and opens on trigger click', () => {
    render(
      <ToolbarMenu label="View" icon={<Eye size={16} />}>
        <ToolbarMenuItem icon={<Eye size={16} />} label="Follow" active={false} onToggle={() => {}} />
      </ToolbarMenu>,
    );
    expect(screen.queryByRole('menu')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /view/i }));
    expect(screen.getByRole('menu')).toBeInTheDocument();
    expect(screen.getByRole('menuitemcheckbox', { name: 'Follow' })).toBeInTheDocument();
  });

  it('closes on outside mousedown and on Escape', () => {
    render(
      <ToolbarMenu label="View" icon={<Eye size={16} />}>
        <ToolbarMenuItem icon={<Eye size={16} />} label="Follow" active={false} onToggle={() => {}} />
      </ToolbarMenu>,
    );
    const btn = screen.getByRole('button', { name: /view/i });
    fireEvent.click(btn);
    expect(screen.getByRole('menu')).toBeInTheDocument();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole('menu')).toBeNull();

    fireEvent.click(btn);
    expect(screen.getByRole('menu')).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('renders an active-count badge only when activeCount > 0', () => {
    const { rerender } = render(<ToolbarMenu label="View" icon={<Eye size={16} />} activeCount={0}>x</ToolbarMenu>);
    expect(screen.queryByText('2')).toBeNull();
    rerender(<ToolbarMenu label="View" icon={<Eye size={16} />} activeCount={2}>x</ToolbarMenu>);
    expect(screen.getByText('2')).toBeInTheDocument();
  });
});

describe('ToolbarMenuItem', () => {
  it('fires onToggle on click, but not when disabled', () => {
    const onToggle = vi.fn();
    const { rerender } = render(
      <ToolbarMenuItem icon={<Eye size={16} />} label="Follow" active={false} onToggle={onToggle} />,
    );
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'Follow' }));
    expect(onToggle).toHaveBeenCalledTimes(1);

    rerender(<ToolbarMenuItem icon={<Eye size={16} />} label="Follow" active={false} onToggle={onToggle} disabled />);
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'Follow' }));
    expect(onToggle).toHaveBeenCalledTimes(1); // unchanged
  });

  it('reflects active via aria-checked', () => {
    render(<ToolbarMenuItem icon={<Eye size={16} />} label="Follow" active onToggle={() => {}} />);
    expect(screen.getByRole('menuitemcheckbox', { name: 'Follow' })).toHaveAttribute('aria-checked', 'true');
  });

  it('renders a lookback select that changes without toggling the row', () => {
    const onToggle = vi.fn();
    const onLookbackChange = vi.fn();
    render(
      <ToolbarMenuItem
        icon={<Eye size={16} />}
        label="Heatmap"
        active
        onToggle={onToggle}
        lookbackHours={24}
        lookbackOptions={[1, 6, 24]}
        onLookbackChange={onLookbackChange}
      />,
    );
    const select = screen.getByLabelText('Heatmap lookback') as HTMLSelectElement;
    expect(select.value).toBe('24');
    fireEvent.change(select, { target: { value: '6' } });
    expect(onLookbackChange).toHaveBeenCalledWith(6);
    // Interacting with the select must not toggle the row.
    fireEvent.click(select);
    expect(onToggle).not.toHaveBeenCalled();
  });

  it('maps the "Last" option to a null lookback', () => {
    const onLookbackChange = vi.fn();
    render(
      <ToolbarMenuItem
        icon={<Eye size={16} />}
        label="SNR Overlay"
        active
        onToggle={() => {}}
        lookbackHours={null}
        lookbackOptions={[null, 1, 6]}
        onLookbackChange={onLookbackChange}
      />,
    );
    const select = screen.getByLabelText('SNR Overlay lookback') as HTMLSelectElement;
    expect(select.value).toBe('last');
    fireEvent.change(select, { target: { value: '1' } });
    expect(onLookbackChange).toHaveBeenCalledWith(1);
  });
});
