/**
 * @vitest-environment jsdom
 *
 * Regression for #3752: after sending a command, keyboard focus must return to
 * the command input so an operator can fire commands back-to-back without
 * re-clicking the field. The input is disabled while a command is in flight
 * (which drops focus); the console restores it once the send completes.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { CliConsoleBody } from './CliConsoleBody';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string | Record<string, unknown>) =>
      typeof fallback === 'string' ? fallback : key,
  }),
}));

describe('CliConsoleBody — command input focus (#3752)', () => {
  it('returns focus to the command input after a command is sent', async () => {
    const runCommand = vi.fn().mockResolvedValue({ ok: true, reply: 'pong' });
    render(
      <CliConsoleBody
        targetId="t1"
        targetName="Repeater"
        runCommand={runCommand}
        actionCatalog={[]}
      />,
    );

    const input = screen.getByPlaceholderText(/Type a command/) as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'ver' } });
    fireEvent.click(screen.getByText('Send'));

    await waitFor(() => expect(runCommand).toHaveBeenCalledWith('ver', undefined));
    // Once the send resolves and the input re-enables, focus is back on it.
    await waitFor(() => expect(document.activeElement).toBe(input));
    // And the field was cleared, ready for the next command.
    expect(input.value).toBe('');
  });
});
