import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import MapRepeatersOnlyToggle from './MapRepeatersOnlyToggle';

describe('MapRepeatersOnlyToggle (#5891)', () => {
  it('aria-pressed follows active', () => {
    const { rerender } = render(<MapRepeatersOnlyToggle active={false} onChange={() => {}} />);
    expect(screen.getByRole('button').getAttribute('aria-pressed')).toBe('false');
    rerender(<MapRepeatersOnlyToggle active onChange={() => {}} />);
    expect(screen.getByRole('button').getAttribute('aria-pressed')).toBe('true');
  });

  it('click calls onChange with the opposite value', () => {
    const onChange = vi.fn();
    const { rerender } = render(<MapRepeatersOnlyToggle active={false} onChange={onChange} />);
    fireEvent.click(screen.getByRole('button'));
    expect(onChange).toHaveBeenLastCalledWith(true);
    rerender(<MapRepeatersOnlyToggle active onChange={onChange} />);
    fireEvent.click(screen.getByRole('button'));
    expect(onChange).toHaveBeenLastCalledWith(false);
  });

  it('renders an svg icon and no emoji', () => {
    const { container } = render(<MapRepeatersOnlyToggle active={false} onChange={() => {}} />);
    expect(container.querySelector('svg')).not.toBeNull();
    expect(container.textContent ?? '').not.toMatch(/\p{Extended_Pictographic}/u);
  });
});
