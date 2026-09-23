/**
 * @vitest-environment jsdom
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import TransportBreakdown from './TransportBreakdown';

describe('TransportBreakdown (#5101)', () => {
  it('renders RF and MQTT counts, omitting UDP when undefined', () => {
    render(<TransportBreakdown counts={{ rf: 3, mqtt: 1 }} testId="tb" />);
    const el = screen.getByTestId('tb');
    expect(el.textContent).toContain('3');
    expect(el.textContent).toContain('1');
    expect(el.textContent).not.toMatch(/transport\.udp/);
  });

  it('renders the UDP count when provided', () => {
    render(<TransportBreakdown counts={{ rf: 3, udp: 2, mqtt: 1 }} testId="tb" />);
    const el = screen.getByTestId('tb');
    expect(el.textContent).toMatch(/transport\.udp/);
    expect(el.textContent).toContain('2');
  });

  it('renders the label when provided', () => {
    render(<TransportBreakdown counts={{ rf: 1, mqtt: 0 }} label="Heard via" testId="tb" />);
    expect(screen.getByTestId('tb').textContent).toContain('Heard via');
  });

  it('omits the label when not provided', () => {
    render(<TransportBreakdown counts={{ rf: 1, mqtt: 0 }} testId="tb" />);
    expect(screen.getByTestId('tb').textContent).not.toContain('Heard via');
  });

  it('shows the note when provided', () => {
    render(<TransportBreakdown counts={{ rf: 1, mqtt: 1 }} note="overlap note" testId="tb" />);
    expect(screen.getByTestId('tb').textContent).toContain('overlap note');
  });

  it('hides the note when not provided', () => {
    render(<TransportBreakdown counts={{ rf: 1, mqtt: 1 }} testId="tb" />);
    expect(screen.getByTestId('tb').textContent).not.toContain('overlap note');
  });
});
