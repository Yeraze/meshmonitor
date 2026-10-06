/**
 * Auto-Announce interval and the SaveBar (#5649).
 *
 * The announce interval arms a mesh-wide broadcast timer; the server clamps it
 * to 3-24 hours. The field can now be cleared and retyped, so this pins what
 * must still hold: a blank or below-minimum interval blocks Save, is never
 * sent, and is never replaced by 0 or by the minimum. Before #5649 a blank
 * field put `NaN` in state and posted `autoAnnounceIntervalHours: null`.
 *
 * Uses the real SaveBar and useSaveBar, so "blocked" means the button a user
 * would click is disabled.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import AutoAnnounceSection from './AutoAnnounceSection';
import { SaveBarProvider } from '../contexts/SaveBarContext';
import { SaveBar } from './SaveBar';
import type { Channel } from '../types/device';

vi.mock('react-i18next', async () => {
  const { createReactI18nextMock } = await import('../test/mockI18n');
  return createReactI18nextMock((key: string) => key);
});

const mockCsrfFetch = vi.fn();
vi.mock('../hooks/useCsrfFetch', () => ({ useCsrfFetch: () => mockCsrfFetch }));
vi.mock('./ToastContainer', () => ({ useToast: () => ({ showToast: vi.fn() }) }));
vi.mock('../hooks/useSourceQuery', () => ({ useSourceQuery: () => '' }));
vi.mock('../services/api', () => ({
  default: { get: vi.fn().mockResolvedValue({}), post: vi.fn().mockResolvedValue({}) },
}));

const channels: Channel[] = [
  { id: 0, name: 'Primary', psk: 'x', uplinkEnabled: true, downlinkEnabled: true, createdAt: 0, updatedAt: 0 },
];

const onIntervalChange = vi.fn();

function renderSection() {
  const noop = vi.fn();
  return render(
    <SaveBarProvider>
      <AutoAnnounceSection
        enabled
        intervalHours={6}
        message="hello"
        channelIndexes={[0]}
        announceOnStart={false}
        useSchedule={false}
        schedule="0 */6 * * *"
        channels={channels}
        baseUrl=""
        onEnabledChange={noop}
        onIntervalChange={onIntervalChange}
        onMessageChange={noop}
        onChannelIndexesChange={noop}
        onAnnounceOnStartChange={noop}
        onUseScheduleChange={noop}
        onScheduleChange={noop}
      />
      <SaveBar />
    </SaveBarProvider>,
  );
}

const interval = () => document.getElementById('announceInterval') as HTMLInputElement;
const saveButton = () => screen.queryByRole('button', { name: 'common.save' }) as HTMLButtonElement | null;
const postedBodies = () => mockCsrfFetch.mock.calls
  .filter(([, init]) => init?.method === 'POST')
  .map(([, init]) => JSON.parse(init.body as string));

describe('AutoAnnounceSection announce interval (#5649)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCsrfFetch.mockResolvedValue({ ok: true, json: async () => ({}) });
    global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }) as unknown as typeof fetch;
  });

  it('can be cleared and retyped, and saves the new interval as an integer', async () => {
    const user = userEvent.setup();
    renderSection();
    expect(interval().value).toBe('6');

    await user.click(interval());
    await user.keyboard('{Backspace}');
    expect(interval().value).toBe('');
    expect(interval()).toHaveAttribute('aria-invalid', 'true');

    await user.keyboard('12');
    expect(interval().value).toBe('12');
    expect(interval()).not.toHaveAttribute('aria-invalid');

    await waitFor(() => expect(saveButton()).not.toBeNull());
    expect(saveButton()!.disabled).toBe(false);
    await user.click(saveButton()!);

    await waitFor(() => expect(postedBodies()).toHaveLength(1));
    const body = postedBodies()[0];
    expect(body.autoAnnounceIntervalHours).toBe(12);
    expect(Number.isInteger(body.autoAnnounceIntervalHours)).toBe(true);
    expect(onIntervalChange).toHaveBeenCalledWith(12);
  });

  it('blocks Save while the interval is blank', async () => {
    const user = userEvent.setup();
    renderSection();

    // Make the section dirty through another field so the SaveBar is up.
    await user.type(screen.getByDisplayValue('hello'), '!');
    await waitFor(() => expect(saveButton()).not.toBeNull());
    expect(saveButton()!.disabled).toBe(false);

    await user.clear(interval());
    expect(interval().value).toBe('');
    expect(saveButton()!.disabled).toBe(true);
    expect(screen.getByRole('status')).toHaveTextContent('savebar.fix_invalid_fields');

    await user.click(saveButton()!);
    expect(postedBodies()).toHaveLength(0);
    expect(onIntervalChange).not.toHaveBeenCalled();

    await user.type(interval(), '8');
    expect(saveButton()!.disabled).toBe(false);
  });

  it('blocks an interval under the 3-hour floor: never sent, never 0, never the minimum', async () => {
    const user = userEvent.setup();
    renderSection();
    await user.type(screen.getByDisplayValue('hello'), '!');
    await waitFor(() => expect(saveButton()).not.toBeNull());

    for (const tooLow of ['1', '0', '2']) {
      await user.clear(interval());
      await user.type(interval(), tooLow);
      // The text is left as typed; nothing rewrites it to 3.
      expect(interval().value).toBe(tooLow);
      expect(interval()).toHaveAttribute('aria-invalid', 'true');
      expect(saveButton()!.disabled).toBe(true);
      await user.click(saveButton()!);
    }
    // Above the 24-hour ceiling is refused the same way.
    await user.clear(interval());
    await user.type(interval(), '25');
    expect(saveButton()!.disabled).toBe(true);
    await user.click(saveButton()!);

    expect(postedBodies()).toHaveLength(0);
    expect(onIntervalChange).not.toHaveBeenCalled();

    // Leaving the field does not swap in a legal value either.
    await user.tab();
    expect(interval().value).toBe('25');
    expect(saveButton()!.disabled).toBe(true);
  });

  it('Dismiss puts the saved interval back in a blank field', async () => {
    const user = userEvent.setup();
    renderSection();
    await user.type(screen.getByDisplayValue('hello'), '!');
    await waitFor(() => expect(saveButton()).not.toBeNull());
    await user.clear(interval());
    expect(interval().value).toBe('');

    await user.click(screen.getByRole('button', { name: 'common.dismiss' }));
    expect(interval().value).toBe('6');
    expect(interval()).not.toHaveAttribute('aria-invalid');
  });
});
