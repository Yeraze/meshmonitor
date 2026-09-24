/**
 * @vitest-environment jsdom
 *
 * MeshCoreAdvertButtons — zero-hop is the primary one-click action; a flood
 * advert asks for confirmation that states its airtime cost first.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MeshCoreAdvertButtons } from './MeshCoreAdvertButtons';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string | Record<string, unknown>) => (typeof fallback === 'string' ? fallback : key),
  }),
}));

describe('MeshCoreAdvertButtons', () => {
  afterEach(() => vi.restoreAllMocks());

  it('sends a zero-hop advert with no confirmation', () => {
    const onSend = vi.fn();
    const confirm = vi.spyOn(window, 'confirm');
    render(<MeshCoreAdvertButtons onSend={onSend} />);
    fireEvent.click(screen.getByRole('button', { name: 'Advert (nearby, zero-hop)' }));
    expect(onSend).toHaveBeenCalledWith('zero_hop');
    expect(confirm).not.toHaveBeenCalled();
  });

  it('asks before a flood advert, stating the cost, and sends nothing on cancel', () => {
    const onSend = vi.fn();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(<MeshCoreAdvertButtons onSend={onSend} />);
    fireEvent.click(screen.getByRole('button', { name: 'Flood advert' }));
    expect(confirm).toHaveBeenCalledTimes(1);
    const msg = confirm.mock.calls[0][0] as string;
    expect(msg).toMatch(/every repeater within 8 hops/);
    expect(msg).toMatch(/20 repeaters in reach/);
    expect(msg).toMatch(/9 s \(US\) \/ 25 s \(EU\)/);
    expect(onSend).not.toHaveBeenCalled();
  });

  it('sends a flood advert once confirmed', () => {
    const onSend = vi.fn();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<MeshCoreAdvertButtons onSend={onSend} />);
    fireEvent.click(screen.getByRole('button', { name: 'Flood advert' }));
    expect(onSend).toHaveBeenCalledWith('flood');
  });

  it('disables both buttons and shows the disabled reason', () => {
    render(<MeshCoreAdvertButtons onSend={vi.fn()} disabled disabledTitle="Receive-only" />);
    for (const name of ['Advert (nearby, zero-hop)', 'Flood advert']) {
      const btn = screen.getByRole('button', { name });
      expect(btn).toBeDisabled();
      expect(btn).toHaveAttribute('title', 'Receive-only');
    }
  });
});
