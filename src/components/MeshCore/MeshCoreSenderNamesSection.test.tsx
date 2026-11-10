/**
 * MeshCoreSenderNamesSection (#6282): loads the policy, saves it only on Save,
 * is gated on configuration:write, refuses bad names before any write, and
 * never transmits.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MeshCoreSenderNamesSection } from './MeshCoreSenderNamesSection';

vi.mock('react-i18next', async () => {
  const { createReactI18nextMock } = await import('../../test/mockI18n');
  return createReactI18nextMock();
});
const showToast = vi.fn();
vi.mock('../ToastContainer', () => ({ useToast: () => ({ showToast }) }));

function makeActions(overrides: Record<string, unknown> = {}) {
  return {
    getSenderNamePolicy: vi.fn().mockResolvedValue({ enabled: true, allowedNames: ['Alerts Bot', 'Zoë'] }),
    setSenderNamePolicy: vi.fn().mockImplementation(async (p: unknown) => p),
    ...overrides,
  };
}

const renderSection = (actions = makeActions(), o: { connected?: boolean; canWriteConfig?: boolean } = {}) => {
  render(
    <MeshCoreSenderNamesSection
      connected={o.connected ?? true}
      actions={actions as never}
      canWriteConfig={o.canWriteConfig ?? true}
    />,
  );
  return actions;
};

const names = () => screen.getByRole('textbox', { name: 'Allowed names, one per line' }) as HTMLTextAreaElement;
const enable = () => screen.getByRole('checkbox', { name: 'Allow API callers to send under these names' }) as HTMLInputElement;
const save = () => screen.getByRole('button', { name: 'Save sender names' });

describe('MeshCoreSenderNamesSection', () => {
  it('loads the policy and writes nothing on mount', async () => {
    const actions = renderSection();
    await waitFor(() => expect(names().value).toBe('Alerts Bot\nZoë'));
    expect(enable().checked).toBe(true);
    expect(actions.setSenderNamePolicy).not.toHaveBeenCalled();
    expect(save()).toBeDisabled();
  });

  it('defaults to off with no names', async () => {
    const actions = renderSection(makeActions({ getSenderNamePolicy: vi.fn().mockResolvedValue({ enabled: false, allowedNames: [] }) }));
    await waitFor(() => expect(actions.getSenderNamePolicy).toHaveBeenCalled());
    expect(enable().checked).toBe(false);
    expect(names().value).toBe('');
  });

  it('saves the trimmed, de-duplicated list only when Save is pressed', async () => {
    const user = userEvent.setup();
    const actions = renderSection();
    await waitFor(() => expect(names().value).not.toBe(''));
    await user.clear(names());
    await user.type(names(), '  Alerts Bot  {Enter}Alerts Bot{Enter}{Enter}Night Desk');
    expect(actions.setSenderNamePolicy).not.toHaveBeenCalled();
    await user.click(save());
    expect(actions.setSenderNamePolicy).toHaveBeenCalledWith({ enabled: true, allowedNames: ['Alerts Bot', 'Night Desk'] });
  });

  it('toggling enable alone is a save', async () => {
    const user = userEvent.setup();
    const actions = renderSection();
    await waitFor(() => expect(enable().checked).toBe(true));
    await user.click(enable());
    await user.click(save());
    expect(actions.setSenderNamePolicy).toHaveBeenCalledWith({ enabled: false, allowedNames: ['Alerts Bot', 'Zoë'] });
  });

  it('refuses a bad name or too many names without calling the server', async () => {
    const user = userEvent.setup();
    const actions = renderSection();
    await waitFor(() => expect(names().value).not.toBe(''));
    await user.clear(names());
    await user.type(names(), 'a:b');
    await user.click(save());
    expect(actions.setSenderNamePolicy).not.toHaveBeenCalled();
    expect(showToast).toHaveBeenCalledWith('Invalid name: a:b', 'error');

    await user.clear(names());
    await user.type(names(), Array.from({ length: 17 }, (_, i) => `n${i}`).join('{Enter}'));
    await user.click(save());
    expect(actions.setSenderNamePolicy).not.toHaveBeenCalled();
    expect(showToast).toHaveBeenCalledWith('At most 16 names are allowed', 'error');
  });

  it('is read-only without configuration:write and while disconnected', async () => {
    renderSection(makeActions(), { canWriteConfig: false });
    expect(names()).toBeDisabled();
    expect(enable()).toBeDisabled();
    expect(save()).toBeDisabled();
  });

  it('reads nothing while disconnected', () => {
    const actions = renderSection(makeActions(), { connected: false });
    expect(actions.getSenderNamePolicy).not.toHaveBeenCalled();
  });

  it('shows the impersonation warning', () => {
    renderSection();
    expect(screen.getByText(/cannot prove who sent a channel message/)).toBeTruthy();
  });
});
