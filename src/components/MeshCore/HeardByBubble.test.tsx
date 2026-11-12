/**
 * HeardByBubble (#6193): the shared heard-by antenna + expandable list.
 * The count beside the antenna is the number of GREEN ✓ rows only; required
 * repeaters are pinned at the top with ✓ (heard) or ✗ (not relayed yet).
 *
 * @vitest-environment jsdom
 */
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { HeardByBubble, HeardByList } from './HeardByBubble';

vi.mock('react-i18next', async () => {
  const { createReactI18nextMock } = await import('../../test/mockI18n');
  return createReactI18nextMock();
});

const REQ = 'bb'.repeat(32);   // relay, unique prefix 'bb'
const OTHER = 'cc'.repeat(32); // relay, unique prefix 'cc'
const relays = [
  { publicKey: REQ, advType: 2, name: 'Backbone' },
  { publicKey: OTHER, advType: 2, name: 'Nearby' },
];

const badge = () => screen.getByTestId('mc-heard-by-badge');
const items = () => Array.from(document.querySelectorAll('.mc-heard-by-item'));

describe('HeardByBubble (#6193)', () => {
  it('shows an antenna with count 0 when nothing is heard and nothing is required', () => {
    render(<HeardByBubble heardBy={[]} />);
    expect(badge().textContent).toContain('0');
    // Collapsed until clicked.
    expect(document.querySelector('.mc-heard-by-list')).toBeNull();
  });

  it('no required keys: count = heardBy length, all green', () => {
    render(<HeardByBubble heardBy={[{ hash: 'bb', hops: 0, snr: 4 }, { hash: 'cc', hops: 1, snr: 2 }]} repeaters={relays} />);
    expect(badge().textContent).toContain('2');
    fireEvent.click(badge());
    expect(items()).toHaveLength(2);
  });

  it('count = GREEN checks only — a required ✗ does not count', () => {
    // Only REQ heard ('bb'); OTHER required but not heard → ✗, not counted.
    render(
      <HeardByBubble
        heardBy={[{ hash: 'bb', hops: 0, snr: 4 }]}
        requiredKeys={[REQ, OTHER]}
        repeaters={relays}
      />,
    );
    expect(badge().textContent).toContain('1');
    fireEvent.click(badge());
    const rows = items();
    // Required pinned at top: REQ ✓, OTHER ✗.
    expect(rows[0].getAttribute('data-heard')).toBe('true');
    expect(within(rows[0] as HTMLElement).getByText('Backbone')).toBeTruthy();
    expect(rows[1].getAttribute('data-heard')).toBe('false');
    expect(within(rows[1] as HTMLElement).getByText('Nearby')).toBeTruthy();
    // The heard required row shows its hops.
    expect(rows[0].querySelector('.mc-heard-by-hops')!.textContent).toContain('0 hops');
  });

  it('lists other heard repeaters after the required ones, all green', () => {
    // REQ required + heard; an unknown relay 'dd' also heard → "other", green.
    render(
      <HeardByBubble
        heardBy={[{ hash: 'bb', hops: 0, snr: 4 }, { hash: 'dd', name: 'Stranger', hops: 2, snr: 1 }]}
        requiredKeys={[REQ]}
        repeaters={relays}
      />,
    );
    // Green = REQ (required heard) + Stranger (other) = 2.
    expect(badge().textContent).toContain('2');
    fireEvent.click(badge());
    const rows = items();
    expect(rows).toHaveLength(2);
    // Required pinned first.
    expect(rows[0].getAttribute('data-heard')).toBe('true');
    expect(within(rows[0] as HTMLElement).getByText('Backbone')).toBeTruthy();
    // Other hearing below, no data-heard marker on it.
    expect(rows[1].getAttribute('data-heard')).toBeNull();
    expect(within(rows[1] as HTMLElement).getByText('Stranger')).toBeTruthy();
  });

  it('a required repeater heard only via an ambiguous prefix stays ✗ (agrees with the gate)', () => {
    const decoy = 'bb00000000000000000000000000000000000000000000000000000000ffffff';
    render(
      <HeardByBubble
        heardBy={[{ hash: 'bb' }]}
        requiredKeys={[REQ]}
        repeaters={[{ publicKey: REQ, advType: 2, name: 'Backbone' }, { publicKey: decoy, advType: 2, name: 'Decoy' }]}
      />,
    );
    // 'bb' is ambiguous (REQ + decoy) → required not satisfied → ✗.
    fireEvent.click(badge());
    const rows = items();
    expect(rows[0].getAttribute('data-heard')).toBe('false');
    // But the hearing still shows as an "other" green row below.
    expect(badge().textContent).toContain('1');
  });

  it('controlled with renderList={false}: the badge reports state and leaves the list to the caller (#4173 L13)', () => {
    const onToggle = vi.fn();
    const { rerender } = render(
      <HeardByBubble heardBy={[{ hash: 'bb' }]} repeaters={relays} open={false} onToggle={onToggle} renderList={false} />,
    );
    fireEvent.click(badge());
    expect(onToggle).toHaveBeenCalledTimes(1);
    rerender(<HeardByBubble heardBy={[{ hash: 'bb' }]} repeaters={relays} open onToggle={onToggle} renderList={false} />);
    expect(badge().getAttribute('aria-expanded')).toBe('true');
    expect(document.querySelector('.mc-heard-by-list')).toBeNull();
  });

  it('HeardByList renders the same rows on its own', () => {
    render(<HeardByList heardBy={[{ hash: 'bb', hops: 0 }]} requiredKeys={[OTHER]} repeaters={relays} />);
    const rows = items();
    expect(rows).toHaveLength(2);
    expect(rows[0].getAttribute('data-heard')).toBe('false');
    expect(within(rows[1] as HTMLElement).getByText('bb')).toBeTruthy();
  });
});
