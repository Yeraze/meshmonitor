/**
 * Automations builder number fields and "Save automation" (#5649).
 *
 * Every catalog number param is optional: a blank Cooldown means "no cooldown"
 * and is stored as '' exactly as before, so blank must NOT block Save here.
 * What must hold: a typed value is saved as a number, and text the browser
 * cannot read as a number ("-", "1e") blocks Save instead of being saved as ''
 * behind the user's back (the old handler stored '' for it, silently dropping
 * a cooldown the user thought they were setting).
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import AutomationsPage from './AutomationsPage';
import { compile, type WorkflowForm } from './compile';

vi.mock('react-i18next', async () => {
  const { createReactI18nextMock } = await import('../../test/mockI18n');
  return createReactI18nextMock();
});

vi.mock('../../services/api', () => ({
  default: {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
    setBaseUrl: vi.fn(),
    runAutomationNow: vi.fn(),
  },
}));

import apiService from '../../services/api';

const mockedGet = apiService.get as unknown as ReturnType<typeof vi.fn>;
const mockedPut = apiService.put as unknown as ReturnType<typeof vi.fn>;

const FORM: WorkflowForm = {
  trigger: { type: 'trigger.message', params: { cooldownSeconds: 60 } },
  rules: [{ conditions: [], actions: [{ type: 'action.nothing', params: {} }] }],
  combine: null,
};

const AUTOMATION = {
  id: 'auto-1',
  name: 'Reply once a minute',
  description: null,
  enabled: true,
  config: JSON.stringify(compile(FORM)),
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
};

beforeEach(() => {
  mockedGet.mockReset();
  mockedPut.mockReset();
  mockedPut.mockResolvedValue({});
  mockedGet.mockImplementation((url: string) =>
    Promise.resolve(url === '/api/automations' ? [AUTOMATION] : []));
});

async function openEditor() {
  render(<MemoryRouter><AutomationsPage /></MemoryRouter>);
  await userEvent.click(await screen.findByRole('button', { name: 'Edit' }));
  await screen.findByRole('button', { name: 'Save automation' });
}

function cooldown(): HTMLInputElement {
  const field = screen.getByText('Cooldown (seconds)').closest('.ae-field');
  return field!.querySelector('input') as HTMLInputElement;
}
const save = () => screen.getByRole('button', { name: 'Save automation' }) as HTMLButtonElement;

/** The trigger node's cooldown in the config the page PUT. */
function savedCooldown(): unknown {
  const body = mockedPut.mock.calls[0][1] as { config: { nodes: Array<{ type: string; params: Record<string, unknown> }> } };
  return body.config.nodes.find((n) => n.type === 'trigger.message')!.params.cooldownSeconds;
}

describe('AutomationsPage builder number fields (#5649)', () => {
  it('60 -> clear -> 120 saves the cooldown as the number 120', async () => {
    const user = userEvent.setup();
    await openEditor();
    expect(cooldown().value).toBe('60');

    await user.click(cooldown());
    await user.keyboard('{Backspace}{Backspace}');
    expect(cooldown().value).toBe('');
    await user.keyboard('120');
    expect(cooldown().value).toBe('120');
    expect(save().disabled).toBe(false);

    await user.click(save());
    expect(mockedPut).toHaveBeenCalledTimes(1);
    expect(mockedPut.mock.calls[0][0]).toBe('/api/automations/auto-1');
    expect(savedCooldown()).toBe(120);
  });

  it('a blank cooldown is legal: not outlined, Save stays on, no number is invented', async () => {
    const user = userEvent.setup();
    await openEditor();
    await user.clear(cooldown());

    expect(cooldown().value).toBe('');
    expect(cooldown()).not.toHaveAttribute('aria-invalid');
    expect(save().disabled).toBe(false);

    await user.click(save());
    expect(mockedPut).toHaveBeenCalledTimes(1);
    // Blank = "no cooldown", as before. Never 0-for-blank, never NaN.
    const saved = savedCooldown();
    expect(saved === '' || saved === undefined).toBe(true);
  });

  it('blocks Save while a number field holds text that is not a number, and re-enables it when fixed', async () => {
    const user = userEvent.setup();
    await openEditor();
    const input = cooldown();

    // What a browser reports for a half-typed "-" or "1e": value '' plus
    // validity.badInput. jsdom never sets badInput, so stand in for it.
    Object.defineProperty(input, 'validity', { configurable: true, value: { badInput: true } });
    fireEvent.change(input, { target: { value: '' } });

    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(save().disabled).toBe(true);
    fireEvent.click(save());
    expect(mockedPut).not.toHaveBeenCalled();

    Object.defineProperty(input, 'validity', { configurable: true, value: { badInput: false } });
    fireEvent.change(input, { target: { value: '45' } });
    expect(input).not.toHaveAttribute('aria-invalid');
    expect(save().disabled).toBe(false);

    await user.click(save());
    expect(savedCooldown()).toBe(45);
  });
});
