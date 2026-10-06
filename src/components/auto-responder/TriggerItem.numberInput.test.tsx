/**
 * Auto-Responder trigger cooldown: the field issue #5649 was filed for.
 *
 * It showed 60 and could not be backspaced to type 120: the handler ran
 * `Math.max(0, parseInt(e.target.value) || 0)`, so the moment the field went
 * blank it became "0" and the next digits landed after it.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import TriggerItem from './TriggerItem';
import type { AutoResponderTrigger, TriggerItemProps } from './types';

vi.mock('react-i18next', async () => {
  const { createReactI18nextMock } = await import('../../test/mockI18n');
  return createReactI18nextMock((key: string) => key);
});
vi.mock('../ScriptTestModal', () => ({ default: () => null }));
vi.mock('./AutoResponderDialog', () => ({ default: () => null }));

const trigger: AutoResponderTrigger = {
  id: 't1',
  trigger: 'ping',
  responseType: 'text',
  response: 'pong',
  channels: ['dm'],
  cooldownSeconds: 60,
};

function renderEditing(overrides: Partial<TriggerItemProps> = {}) {
  const onSaveEdit = vi.fn();
  render(
    <TriggerItem
      trigger={trigger}
      isEditing
      localEnabled
      availableScripts={[]}
      channels={[]}
      baseUrl=""
      onStartEdit={vi.fn()}
      onCancelEdit={vi.fn()}
      onSaveEdit={onSaveEdit}
      onRemove={vi.fn()}
      showToast={vi.fn()}
      {...overrides}
    />,
  );
  return { onSaveEdit };
}

const cooldown = () => screen.getByRole('spinbutton') as HTMLInputElement;
const save = () => screen.getByRole('button', { name: 'common.save' }) as HTMLButtonElement;
/** The cooldown is the last argument of onSaveEdit. */
const savedCooldown = (fn: ReturnType<typeof vi.fn>) => fn.mock.calls[0][7];

describe('TriggerItem cooldown (#5649)', () => {
  it('60 -> backspace, backspace -> 120: the field goes blank, then saves 120', async () => {
    const user = userEvent.setup();
    const { onSaveEdit } = renderEditing();
    expect(cooldown().value).toBe('60');
    expect(save().disabled).toBe(false);

    await user.click(cooldown());
    await user.keyboard('{Backspace}');
    expect(cooldown().value).toBe('6');
    await user.keyboard('{Backspace}');

    // Blank and outlined; no "0" appears, and Save is off.
    expect(cooldown().value).toBe('');
    expect(cooldown()).toHaveAttribute('aria-invalid', 'true');
    expect(save().disabled).toBe(true);

    await user.keyboard('120');
    expect(cooldown().value).toBe('120');
    expect(cooldown()).not.toHaveAttribute('aria-invalid');
    expect(save().disabled).toBe(false);

    await user.click(save());
    expect(onSaveEdit).toHaveBeenCalledTimes(1);
    expect(savedCooldown(onSaveEdit)).toBe(120);
    expect(typeof savedCooldown(onSaveEdit)).toBe('number');
  });

  it('a blank cooldown stays blank on blur and keeps Save off', async () => {
    const user = userEvent.setup();
    const { onSaveEdit } = renderEditing();
    await user.clear(cooldown());
    await user.tab();
    expect(cooldown().value).toBe('');
    expect(save().disabled).toBe(true);
    await user.click(save());
    expect(onSaveEdit).not.toHaveBeenCalled();
  });

  it('refuses a negative or fractional cooldown instead of rewriting it', async () => {
    const user = userEvent.setup();
    const { onSaveEdit } = renderEditing();
    for (const bad of ['-5', '1.5', '86401']) {
      await user.clear(cooldown());
      await user.type(cooldown(), bad);
      expect(cooldown().value).toBe(bad);
      expect(cooldown()).toHaveAttribute('aria-invalid', 'true');
      expect(save().disabled).toBe(true);
    }
    expect(onSaveEdit).not.toHaveBeenCalled();
  });

  it('0 is still a legal cooldown and saves as "no cooldown"', async () => {
    const user = userEvent.setup();
    const { onSaveEdit } = renderEditing();
    await user.clear(cooldown());
    await user.type(cooldown(), '0');
    expect(save().disabled).toBe(false);
    await user.click(save());
    expect(savedCooldown(onSaveEdit)).toBeUndefined();
  });
});
