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
import { CliConsoleBody, DANGER_COMMAND_PATTERN } from './CliConsoleBody';

// Mirrors the server-side DANGER_COMMAND_PATTERN suite in meshcoreRoutes.test.ts.
// If this drifts from the server pattern, the client's confirm modal and the
// server's defense-in-depth guard can disagree about what's destructive (#4025).
describe('CliConsoleBody — DANGER_COMMAND_PATTERN', () => {
  it.each([
    ['reboot'],
    ['Reboot'],
    ['erase'],
    ['clkreboot'],
    ['factory reset'],
    ['set factory mode'],
  ])('flags danger command %s', (cmd) => {
    expect(DANGER_COMMAND_PATTERN.test(cmd)).toBe(true);
  });

  it.each([
    ['get reboot.interval'],
    ['get erase.enabled'],
    ['get clkreboot.retries'],
    ['get factory.mode'],
    ['set reboot.interval 30'],
    ['ver'],
    ['stats'],
  ])('does not flag non-danger command %s', (cmd) => {
    expect(DANGER_COMMAND_PATTERN.test(cmd)).toBe(false);
  });
});

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
