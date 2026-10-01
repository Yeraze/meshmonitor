/**
 * @vitest-environment jsdom
 *
 * Discover Path feedback (#5508): countdown, reply detection, "no response"
 * on expiry, and cleanup on contact switch / unmount.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { MeshCoreContactDetailPanel } from './MeshCoreContactDetailPanel';
import type { MeshCoreContact } from '../../utils/meshcoreHelpers';

vi.mock('react-i18next', async () => {
  const { createReactI18nextMock } = await import('../../test/mockI18n');
  const interpolate = (text: string, opts?: Record<string, unknown>) =>
    text.replace(/\{\{(\w+)\}\}/g, (_m, k: string) => String(opts?.[k] ?? ''));
  const t = (key: string, a?: string | Record<string, unknown>, b?: Record<string, unknown>) => {
    if (key === 'node_details.hops' && typeof a === 'object') {
      return `${a.count} ${a.count === 1 ? 'hop' : 'hops'}`;
    }
    if (typeof a === 'string') return interpolate(a, b);
    return key;
  };
  return createReactI18nextMock(t);
});

vi.mock('../../contexts/SettingsContext', () => ({
  useNodeListStyle: () => 'monochrome',
  useSettings: () => ({ timeFormat: '24', dateFormat: 'MM/DD/YYYY' }),
}));

vi.mock('../../contexts/SourceContext', () => ({
  useSource: () => ({ sourceId: 'test-source', sourceName: 'Test' }),
}));

vi.mock('../../services/api', () => ({
  default: {
    get: vi.fn().mockRejectedValue(new Error('no stub configured')),
    setBaseUrl: vi.fn(),
  },
}));

const PK_A = 'a'.repeat(64);
const PK_B = 'b'.repeat(64);

const contactA: MeshCoreContact = {
  publicKey: PK_A,
  advName: 'Alice',
  advType: 1,
  pathLen: 2,
  outPath: 'a3,7f',
};
const contactB: MeshCoreContact = { publicKey: PK_B, advName: 'Bob', advType: 1 };

function renderPanel(contact: MeshCoreContact, onDiscoverPath: ReturnType<typeof vi.fn>) {
  const props = { canWriteNodes: true, onDiscoverPath };
  const utils = render(
    <MeshCoreContactDetailPanel contact={contact} publicKey={contact.publicKey} {...props} />,
  );
  const rerenderWith = (next: MeshCoreContact) =>
    utils.rerender(
      <MeshCoreContactDetailPanel contact={next} publicKey={next.publicKey} {...props} />,
    );
  return { ...utils, rerenderWith };
}

/** Click Discover Path and let the resolved send settle. */
async function clickDiscover() {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Discover Path' }));
  });
}

describe('MeshCoreContactDetailPanel — Discover Path feedback (#5508)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    localStorage.clear();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows a countdown that decrements and keeps the button disabled', async () => {
    const onDiscoverPath = vi.fn().mockResolvedValue({ suggestedTimeoutMs: 0, discoveryTimeoutMs: 25_000 });
    renderPanel(contactA, onDiscoverPath);

    await clickDiscover();

    const button = screen.getByRole('button', { name: 'Discover Path' });
    expect(onDiscoverPath).toHaveBeenCalledWith(PK_A);
    expect(button.textContent).toContain('Discovering… 25s');
    expect((button as HTMLButtonElement).disabled).toBe(true);

    act(() => { vi.advanceTimersByTime(3_000); });
    expect(button.textContent).toContain('Discovering… 22s');
    expect((button as HTMLButtonElement).disabled).toBe(true);
  });

  it('shows success with the hop count when a new path arrives before expiry', async () => {
    const onDiscoverPath = vi.fn().mockResolvedValue({ suggestedTimeoutMs: 0, discoveryTimeoutMs: 30_000 });
    const { rerenderWith } = renderPanel(contactA, onDiscoverPath);

    await clickDiscover();
    act(() => { vi.advanceTimersByTime(5_000); });

    rerenderWith({ ...contactA, outPath: 'a3,7f,02', pathLen: 3 });

    expect(screen.getByText('Path updated — 3 hops')).toBeTruthy();
    const button = screen.getByRole('button', { name: 'Discover Path' }) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    expect(button.textContent).toContain('Discover Path');

    // The expiry timer is gone: no "no response" later.
    act(() => { vi.advanceTimersByTime(60_000); });
    expect(screen.queryByText(/No response from/)).toBeNull();
  });

  it('counts a stamped reply that returns the same path, and reports direct for 0 hops', async () => {
    const direct: MeshCoreContact = { ...contactA, pathLen: 0, outPath: null };
    const onDiscoverPath = vi.fn().mockResolvedValue({ suggestedTimeoutMs: 0, discoveryTimeoutMs: 30_000 });
    const { rerenderWith } = renderPanel(direct, onDiscoverPath);

    await clickDiscover();
    // Unrelated update (same path, no stamp) is not a reply.
    rerenderWith({ ...direct, snr: 5 });
    expect(screen.queryByText(/Path updated/)).toBeNull();

    rerenderWith({ ...direct, pathDiscoveredAt: 1_700_000_000_000 });
    expect(screen.getByText('Path updated — Direct')).toBeTruthy();
  });

  it('shows "No response" when the countdown expires', async () => {
    const onDiscoverPath = vi.fn().mockResolvedValue({ suggestedTimeoutMs: 0, discoveryTimeoutMs: 20_000 });
    renderPanel(contactA, onDiscoverPath);

    await clickDiscover();
    act(() => { vi.advanceTimersByTime(20_000); });

    expect(screen.getByText('No response from Alice')).toBeTruthy();
    const button = screen.getByRole('button', { name: 'Discover Path' }) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
  });

  it('returns to the plain button when the send fails', async () => {
    const onDiscoverPath = vi.fn().mockResolvedValue(null);
    renderPanel(contactA, onDiscoverPath);

    await clickDiscover();

    const button = screen.getByRole('button', { name: 'Discover Path' }) as HTMLButtonElement;
    expect(button.textContent).toContain('Discover Path');
    expect(button.disabled).toBe(false);
    act(() => { vi.advanceTimersByTime(60_000); });
    expect(screen.queryByText(/No response from/)).toBeNull();
  });

  it('clears the countdown when the user switches contacts', async () => {
    const onDiscoverPath = vi.fn().mockResolvedValue({ suggestedTimeoutMs: 0, discoveryTimeoutMs: 20_000 });
    const { rerenderWith } = renderPanel(contactA, onDiscoverPath);

    await clickDiscover();
    rerenderWith(contactB);

    const button = screen.getByRole('button', { name: 'Discover Path' }) as HTMLButtonElement;
    expect(button.textContent).toContain('Discover Path');
    expect(button.disabled).toBe(false);
    act(() => { vi.advanceTimersByTime(30_000); });
    expect(screen.queryByText(/No response from/)).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('drops a send that resolves after the user switched contacts', async () => {
    let resolveSend: (v: unknown) => void = () => {};
    const onDiscoverPath = vi.fn().mockImplementation(() => new Promise((r) => { resolveSend = r; }));
    const { rerenderWith } = renderPanel(contactA, onDiscoverPath);

    await clickDiscover();
    rerenderWith(contactB);
    await act(async () => { resolveSend({ suggestedTimeoutMs: 0, discoveryTimeoutMs: 20_000 }); });

    const button = screen.getByRole('button', { name: 'Discover Path' }) as HTMLButtonElement;
    expect(button.textContent).toContain('Discover Path');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('leaves no timers behind on unmount', async () => {
    const onDiscoverPath = vi.fn().mockResolvedValue({ suggestedTimeoutMs: 0, discoveryTimeoutMs: 20_000 });
    const { unmount } = renderPanel(contactA, onDiscoverPath);

    await clickDiscover();
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
