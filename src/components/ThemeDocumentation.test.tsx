/**
 * @vitest-environment jsdom
 *
 * Regression coverage for the theme gallery's per-slot apply behavior
 * (PR #3344 review, issue #1).
 *
 * The gallery previously called the legacy `setTheme`, which forced
 * appearanceMode='dark' and overwrote BOTH the dark and light slots — silently
 * kicking a `system`-mode user into explicit dark mode and clobbering their
 * light theme. It now offers "Apply as Dark" / "Apply as Light" per card, each
 * updating only its slot and never touching the appearance mode.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ThemeDocumentation } from './ThemeDocumentation';

// Passthrough i18n so assertions can target the real i18n keys.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { changeLanguage: vi.fn(), language: 'en' },
  }),
}));

const setTheme = vi.fn();
const setAppearanceMode = vi.fn();
const setDarkTheme = vi.fn();
const setLightTheme = vi.fn();

vi.mock('../contexts/SettingsContext', () => ({
  useSettings: () => ({
    theme: 'mocha',
    appearanceMode: 'system',
    darkTheme: 'mocha',
    lightTheme: 'latte',
    setTheme,
    setAppearanceMode,
    setDarkTheme,
    setLightTheme,
  }),
}));

/** Find a theme card by its (hardcoded, non-i18n) heading name. */
function cardByName(name: string): HTMLElement {
  const heading = screen.getByRole('heading', { level: 3, name });
  // h3 → .theme-card-header → .theme-card
  const card = heading.closest('.theme-card');
  if (!card) throw new Error(`card not found for ${name}`);
  return card as HTMLElement;
}

describe('ThemeDocumentation gallery — per-slot apply', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('applies a theme to the dark slot only, without flipping appearance mode', async () => {
    const user = userEvent.setup();
    render(<ThemeDocumentation />);

    const nord = cardByName('Nord');
    await user.click(within(nord).getByRole('button', { name: 'theme_management.apply_dark' }));

    expect(setDarkTheme).toHaveBeenCalledWith('nord');
    expect(setLightTheme).not.toHaveBeenCalled();
    // The mode must not change, and the legacy clobbering setter must not run.
    expect(setAppearanceMode).not.toHaveBeenCalled();
    expect(setTheme).not.toHaveBeenCalled();
  });

  it('applies a theme to the light slot only, without flipping appearance mode', async () => {
    const user = userEvent.setup();
    render(<ThemeDocumentation />);

    const nord = cardByName('Nord');
    await user.click(within(nord).getByRole('button', { name: 'theme_management.apply_light' }));

    expect(setLightTheme).toHaveBeenCalledWith('nord');
    expect(setDarkTheme).not.toHaveBeenCalled();
    expect(setAppearanceMode).not.toHaveBeenCalled();
    expect(setTheme).not.toHaveBeenCalled();
  });

  it('disables the slot button for the theme already assigned to that slot', () => {
    render(<ThemeDocumentation />);

    // mocha is the dark slot, latte is the light slot (from the mocked context).
    const mocha = cardByName('Catppuccin Mocha');
    expect(within(mocha).getByRole('button', { name: 'theme_management.dark_active' })).toBeDisabled();
    expect(within(mocha).getByRole('button', { name: 'theme_management.apply_light' })).not.toBeDisabled();

    const latte = cardByName('Catppuccin Latte');
    expect(within(latte).getByRole('button', { name: 'theme_management.light_active' })).toBeDisabled();
    expect(within(latte).getByRole('button', { name: 'theme_management.apply_dark' })).not.toBeDisabled();
  });
});
