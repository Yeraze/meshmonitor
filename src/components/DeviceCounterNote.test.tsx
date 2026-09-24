/**
 * @vitest-environment jsdom
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import DeviceCounterNote from './DeviceCounterNote';

describe('DeviceCounterNote (#5101 P3 WP2)', () => {
  it('renders the given text', () => {
    render(<DeviceCounterNote text="Device counter: all transports combined" />);
    expect(screen.getByText('Device counter: all transports combined')).toBeInTheDocument();
  });

  it('renders the given data-testid', () => {
    render(<DeviceCounterNote text="note text" testId="my-device-note" />);
    const el = screen.getByTestId('my-device-note');
    expect(el).toHaveTextContent('note text');
    expect(el.tagName).toBe('P');
  });

  it('renders without a testid when none is given', () => {
    const { container } = render(<DeviceCounterNote text="note text" />);
    const p = container.querySelector('p');
    expect(p).not.toBeNull();
    expect(p).not.toHaveAttribute('data-testid');
  });
});
