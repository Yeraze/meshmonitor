/**
 * @vitest-environment jsdom
 *
 * MeshCoreAdvertButtons — zero-hop is the primary one-click action; a flood
 * advert opens an in-app dialog that states its airtime cost first.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { MeshCoreAdvertButtons } from './MeshCoreAdvertButtons';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string | Record<string, unknown>) => (typeof fallback === 'string' ? fallback : key),
  }),
}));

const dialog = () => screen.queryByRole('dialog');

describe('MeshCoreAdvertButtons', () => {
  afterEach(() => vi.restoreAllMocks());

  it('sends a zero-hop advert straight away, with no dialog', () => {
    const onSend = vi.fn();
    render(<MeshCoreAdvertButtons onSend={onSend} />);
    fireEvent.click(screen.getByRole('button', { name: 'Advert (nearby, zero-hop)' }));
    expect(onSend).toHaveBeenCalledWith('zero_hop');
    expect(dialog()).toBeNull();
  });

  it('never uses window.confirm (webviews can suppress it)', () => {
    const confirm = vi.spyOn(window, 'confirm');
    render(<MeshCoreAdvertButtons onSend={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Flood advert' }));
    expect(confirm).not.toHaveBeenCalled();
  });

  it('opens a dialog stating the cost and sends nothing until confirmed', () => {
    const onSend = vi.fn();
    render(<MeshCoreAdvertButtons onSend={onSend} />);
    fireEvent.click(screen.getByRole('button', { name: 'Flood advert' }));
    const d = screen.getByRole('dialog');
    expect(d).toHaveTextContent('Send a flood advert?');
    expect(d).toHaveTextContent(/every repeater within 8 hops/);
    expect(d).toHaveTextContent(/20 repeaters in reach/);
    expect(d).toHaveTextContent(/9 s \(US\) \/ 25 s \(EU\)/);
    expect(onSend).not.toHaveBeenCalled();
  });

  it('Cancel closes the dialog without sending', () => {
    const onSend = vi.fn();
    render(<MeshCoreAdvertButtons onSend={onSend} />);
    fireEvent.click(screen.getByRole('button', { name: 'Flood advert' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }));
    expect(dialog()).toBeNull();
    expect(onSend).not.toHaveBeenCalled();
  });

  it('Escape closes the dialog without sending', () => {
    const onSend = vi.fn();
    render(<MeshCoreAdvertButtons onSend={onSend} />);
    fireEvent.click(screen.getByRole('button', { name: 'Flood advert' }));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(dialog()).toBeNull();
    expect(onSend).not.toHaveBeenCalled();
  });

  it('"Send flood advert" sends the flood once and closes the dialog', () => {
    const onSend = vi.fn();
    render(<MeshCoreAdvertButtons onSend={onSend} />);
    fireEvent.click(screen.getByRole('button', { name: 'Flood advert' }));
    fireEvent.click(screen.getByRole('button', { name: 'Send flood advert' }));
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend).toHaveBeenCalledWith('flood');
    expect(dialog()).toBeNull();
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
